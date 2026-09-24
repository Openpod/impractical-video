import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { lintSourceFiles } from "@/lib/lint";
import { buildSourceGraph, orderedClips } from "@/lib/source-graph";
import { createServerClient } from "@/lib/supabase";
import { isLocalAppMode } from "@/lib/app-mode";
import { isProjectSupportMetadataPath } from "@/lib/project-file-classification";

export type ProjectMeta = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceFile = {
  path: string;
  size: number;
  kind: "file" | "media";
  content?: string;
};

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  at: string;
  tools?: ChatToolCall[];
};

export type ChatToolCall = {
  name: string;
  ok?: boolean;
  summary?: string;
  durationMs?: number;
};

export type CheckIssue = {
  level: "error" | "warning" | "info";
  message: string;
  path?: string;
  rule?: string;
};

export type ProjectCheck = {
  ok: boolean;
  issues: CheckIssue[];
};

export type TimelineItem = {
  id: string;
  title: string;
  scene_id?: string | null;
  clip_id?: string | null;
  unit_id?: string | null;
  asset_id?: string | null;
  from_keyframe?: string | null;
  to_keyframe?: string | null;
  url?: string | null;
  local_path?: string | null;
  /** Generated/playback duration in seconds. */
  duration?: number | null;
  kind?: "image" | "video" | "audio" | "other";
};

export type ProjectSnapshot = {
  project: ProjectMeta;
  files: WorkspaceFile[];
  chat: ChatMessage[];
  check: ProjectCheck;
  timeline: TimelineItem[];
};

const DATA_ROOT =
  process.env.VIDEO_FS_DATA_ROOT?.trim() ||
  path.join(process.cwd(), "data", "projects");
const TRASH_ROOT = path.join(path.dirname(DATA_ROOT), "trash", "projects");
const TEXT_FILE_EXTENSIONS = new Set([".md", ".json", ".txt"]);
const MEDIA_FILE_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".mp3",
  ".wav",
  ".m4a",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
]);
const PROJECT_MEDIA_BUCKET = "project-media";

function shouldUseSupabaseWorkspace() {
  return Boolean(
    !isLocalAppMode() &&
      !process.env.VIDEO_FS_DATA_ROOT &&
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

function requireOwnerUserId(ownerUserId?: string | null) {
  if (!ownerUserId) {
    throw new Error("A signed-in Clerk user is required for Supabase workspace storage.");
  }
  return ownerUserId;
}

function dbProjectToMeta(project: {
  created_at: string;
  id: string;
  name: string;
  updated_at: string;
}): ProjectMeta {
  return {
    createdAt: project.created_at,
    id: project.id,
    name: project.name,
    updatedAt: project.updated_at,
  };
}

function mediaKindForPath(relativePath: string): WorkspaceFile["kind"] {
  return MEDIA_FILE_EXTENSIONS.has(path.extname(relativePath).toLowerCase())
    ? "media"
    : "file";
}

function contentTypeForPath(relativePath: string) {
  const ext = path.extname(relativePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".png") return "image/png";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".webm") return "video/webm";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function mediaCategoryForPath(relativePath: string): "audio" | "image" | "other" | "video" {
  const ext = path.extname(relativePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".webm"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".m4a"].includes(ext)) return "audio";
  return "other";
}

function mediaPathFromStoragePath(projectId: string, storagePath: string) {
  const prefix = `${projectId}/`;
  return storagePath.startsWith(prefix) ? storagePath.slice(prefix.length) : storagePath;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function nowIso() {
  return new Date().toISOString();
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function projectRoot(projectId: string) {
  const clean = projectId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!clean) throw new Error("Invalid project id.");
  return path.join(DATA_ROOT, clean);
}

async function localProjectExists(projectId: string) {
  const info = await stat(path.join(projectRoot(projectId), "project.json")).catch(() => null);
  return Boolean(info?.isFile());
}

async function readLocalProjectMeta(projectId: string): Promise<ProjectMeta> {
  return JSON.parse(await readFile(path.join(projectRoot(projectId), "project.json"), "utf8"));
}

export function safeRelativePath(input: string) {
  const normalized = path.posix
    .normalize(input.replaceAll("\\", "/"))
    .replace(/^\/+/, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes(".env")
  ) {
    throw new Error("Unsafe workspace path.");
  }
  return normalized;
}

function resolveProjectPath(projectId: string, relativePath: string) {
  const root = projectRoot(projectId);
  const safe = safeRelativePath(relativePath);
  const target = path.join(root, safe);
  if (!target.startsWith(root)) throw new Error("Unsafe workspace path.");
  return { safe, target };
}

export async function ensureProjectsRoot() {
  await mkdir(DATA_ROOT, { recursive: true });
}

async function writeAtomicText(target: string, content: string) {
  // A same-directory rename publishes the complete file in one step. Reads
  // during background work must never see writeFile's truncate/write window.
  const temporary = path.join(path.dirname(target), `.video-fs-write-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeText(projectId: string, relativePath: string, content: string) {
  if (shouldUseSupabaseWorkspace()) {
    await writeSupabaseText(projectId, relativePath, content);
    return;
  }
  const { target } = resolveProjectPath(projectId, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeAtomicText(target, content);
  await touchProject(projectId);
}

export async function touchProject(projectId: string) {
  if (shouldUseSupabaseWorkspace()) {
    await touchSupabaseProject(projectId);
    return;
  }
  const meta = await readProjectMeta(projectId).catch(() => null);
  if (!meta) return;
  await writeAtomicText(
    path.join(projectRoot(projectId), "project.json"),
    JSON.stringify({ ...meta, updatedAt: nowIso() }, null, 2),
  );
}

/** Rename a project (dual-write: project.json + the projects table). */
export async function renameProject(
  projectId: string,
  name: string,
  ownerUserId?: string | null,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  if (shouldUseSupabaseWorkspace()) {
    const resolvedProjectId = isUuid(projectId)
      ? projectId
      : await resolveSupabaseProjectId(projectId, ownerUserId);
    const supabase = createServerClient();
    const updatedAt = nowIso();
    const { data: project, error: readError } = await supabase
      .from("projects")
      .select("id,name,created_at,updated_at")
      .eq("id", resolvedProjectId)
      .maybeSingle();
    if (readError) throw new Error(`Failed to read project: ${readError.message}`);
    if (!project) return;
    const { error } = await supabase
      .from("projects")
      .update({ name: trimmed, updated_at: updatedAt })
      .eq("id", resolvedProjectId);
    if (error) throw new Error(`Failed to rename project: ${error.message}`);
    const meta = dbProjectToMeta({ ...project, name: trimmed, updated_at: updatedAt });
    await writeSupabaseText(resolvedProjectId, "project.json", `${JSON.stringify(meta, null, 2)}\n`, {
      touch: false,
    });
    return;
  }
  const meta = await readProjectMeta(projectId).catch(() => null);
  if (!meta) return;
  await writeAtomicText(
    path.join(projectRoot(projectId), "project.json"),
    JSON.stringify({ ...meta, name: trimmed, updatedAt: nowIso() }, null, 2),
  );
}

async function touchSupabaseProject(projectId: string) {
  const resolvedProjectId = isUuid(projectId)
    ? projectId
    : await resolveSupabaseProjectId(projectId);
  const supabase = createServerClient();
  const updatedAt = nowIso();
  const { data: project, error: readError } = await supabase
    .from("projects")
    .select("id,name,created_at,updated_at")
    .eq("id", resolvedProjectId)
    .maybeSingle();
  if (readError) throw new Error(`Failed to read project: ${readError.message}`);
  if (!project) return;

  const { error } = await supabase
    .from("projects")
    .update({ updated_at: updatedAt })
    .eq("id", resolvedProjectId);
  if (error) throw new Error(`Failed to touch project: ${error.message}`);

  const meta = dbProjectToMeta({ ...project, updated_at: updatedAt });
  await writeSupabaseText(
    resolvedProjectId,
    "project.json",
    `${JSON.stringify(meta, null, 2)}\n`,
    { touch: false },
  );
}

async function writeSupabaseText(
  projectId: string,
  relativePath: string,
  content: string,
  options: { touch?: boolean } = {},
) {
  const resolvedProjectId = isUuid(projectId)
    ? projectId
    : await resolveSupabaseProjectId(projectId);
  const safe = safeRelativePath(relativePath);
  const supabase = createServerClient();
  const { error } = await supabase.from("project_files").upsert(
    {
      content,
      path: safe,
      project_id: resolvedProjectId,
    },
    { onConflict: "project_id,path" },
  );
  if (error) throw new Error(`Failed to write workspace file: ${error.message}`);
  if (options.touch !== false) await touchSupabaseProject(resolvedProjectId);
}

async function readSupabaseText(projectId: string, relativePath: string) {
  const resolvedProjectId = isUuid(projectId)
    ? projectId
    : await resolveSupabaseProjectId(projectId);
  const safe = safeRelativePath(relativePath);
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("project_files")
    .select("content")
    .eq("project_id", resolvedProjectId)
    .eq("path", safe)
    .maybeSingle();
  if (error) throw new Error(`Failed to read workspace file: ${error.message}`);
  if (!data) throw new Error("Workspace file not found.");
  return data.content as string;
}

function initialSupabaseFiles(meta: ProjectMeta): Array<{ content: string; path: string }> {
  return [
    { path: "project.json", content: `${JSON.stringify(meta, null, 2)}\n` },
    { path: "timeline.json", content: "[]\n" },
    {
      path: "brief.md",
      content: withJsonFrontmatter(
        { id: "brief", type: "brief", version: 1 },
        "# Brief\n\nDescribe the video goal, audience, constraints, and success criteria here.\n",
      ),
    },
    {
      path: "references/_README.md",
      content: withJsonFrontmatter(
        { id: "references_readme", type: "note" },
        "# References\n\nRecurring characters, environments, props, and styles live here.\n",
      ),
    },
    {
      path: "keyframes/_README.md",
      content: withJsonFrontmatter(
        { id: "keyframes_readme", type: "note" },
        "# Keyframes\n\nKeyframes are shared visual state anchors for clips.\n",
      ),
    },
    {
      path: "scenes/_README.md",
      content: withJsonFrontmatter(
        { id: "scenes_readme", type: "note" },
        "# Scenes\n\nScenes group clips for ordering and meaning.\n",
      ),
    },
    {
      path: "clips/_README.md",
      content: withJsonFrontmatter(
        { id: "clips_readme", type: "note" },
        "# Clips\n\nClips connect keyframes and form the derived timeline.\n",
      ),
    },
    {
      path: "prompts/_README.md",
      content: withJsonFrontmatter(
        { id: "prompts_readme", type: "note" },
        "# Prompts\n\nInspectable generation prompts live here.\n",
      ),
    },
    {
      path: "findings/_README.md",
      content: withJsonFrontmatter(
        { id: "findings_readme", type: "note" },
        "# Findings\n\nReview findings live here until resolved.\n",
      ),
    },
  ];
}

export async function resolveSupabaseProjectId(
  projectId: string,
  ownerUserId?: string | null,
): Promise<string> {
  if (isUuid(projectId)) return projectId;
  const supabase = createServerClient();
  let query = supabase
    .from("projects")
    .select("id")
    .eq("legacy_id", projectId)
    .neq("status", "deleted");
  if (ownerUserId) query = query.eq("owner_user_id", ownerUserId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Failed to resolve legacy project: ${error.message}`);
  if (data?.id) return data.id as string;
  if (!(await localProjectExists(projectId))) {
    throw new Error("Project not found.");
  }
  const owner = requireOwnerUserId(ownerUserId);
  const imported = await importLocalProjectToSupabase(projectId, owner);
  return imported.id;
}

async function importLocalProjectsForOwner(ownerUserId: string) {
  await ensureProjectsRoot();
  const entries = await readdir(DATA_ROOT, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await importLocalProjectToSupabase(entry.name, ownerUserId).catch(() => null);
  }
}

async function importLocalProjectToSupabase(
  legacyId: string,
  ownerUserId: string,
): Promise<ProjectMeta> {
  const safeLegacyId = legacyId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeLegacyId || safeLegacyId !== legacyId) throw new Error("Invalid legacy project id.");
  const root = projectRoot(legacyId);
  const localMeta = await readLocalProjectMeta(legacyId);
  const supabase = createServerClient();
  const { data: existing, error: existingError } = await supabase
    .from("projects")
    .select("id,name,created_at,updated_at")
    .eq("legacy_id", legacyId)
    .eq("owner_user_id", ownerUserId)
    .neq("status", "deleted")
    .maybeSingle();
  if (existingError) throw new Error(`Failed to check legacy project: ${existingError.message}`);
  if (existing) return dbProjectToMeta(existing);

  const id = randomUUID();
  const now = nowIso();
  const meta: ProjectMeta = {
    createdAt: localMeta.createdAt ?? now,
    id,
    name: localMeta.name || legacyId,
    updatedAt: localMeta.updatedAt ?? now,
  };
  const { error: projectError } = await supabase.from("projects").insert({
    created_at: meta.createdAt,
    id,
    legacy_id: legacyId,
    name: meta.name,
    owner_user_id: ownerUserId,
    status: "active",
    updated_at: meta.updatedAt,
  });
  if (projectError) {
    const isLegacyDuplicate =
      projectError.code === "23505" && projectError.message.includes("projects_legacy_id_key");
    if (isLegacyDuplicate) {
      const { data: duplicate, error: duplicateError } = await supabase
        .from("projects")
        .select("id,name,created_at,updated_at,owner_user_id")
        .eq("legacy_id", legacyId)
        .neq("status", "deleted")
        .maybeSingle();
      if (duplicateError) {
        throw new Error(`Failed to resolve duplicate local project import: ${duplicateError.message}`);
      }
      if (duplicate?.owner_user_id === ownerUserId) {
        return dbProjectToMeta(duplicate);
      }
      throw new Error(
        "Failed to import local project: this legacy project id is already attached to a different user.",
      );
    }
    throw new Error(`Failed to import local project: ${projectError.message}`);
  }

  const files = await walkFiles(root);
  const textRows: Array<{ content: string; path: string; project_id: string }> = [];
  const mediaFiles: WorkspaceFile[] = [];
  for (const file of files) {
    if (file.path === "chat.json") continue;
    if (file.path === "project.json") {
      textRows.push({
        content: `${JSON.stringify(meta, null, 2)}\n`,
        path: file.path,
        project_id: id,
      });
      continue;
    }
    if (file.kind === "media") {
      mediaFiles.push(file);
      continue;
    }
    textRows.push({
      content: await readFile(path.join(root, file.path), "utf8"),
      path: file.path,
      project_id: id,
    });
  }
  if (textRows.length) {
    const { error } = await supabase.from("project_files").insert(textRows);
    if (error) throw new Error(`Failed to import local project files: ${error.message}`);
  }

  for (const file of mediaFiles) {
    const buffer = await readFile(path.join(root, file.path));
    await writeWorkspaceBinaryFile(id, file.path, buffer);
  }

  const chatRaw = await readFile(path.join(root, "chat.json"), "utf8").catch(() => "[]");
  const chat = JSON.parse(chatRaw) as ChatMessage[];
  const chatRows = chat
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      created_at: message.at || now,
      project_id: id,
      role: message.role,
      text: message.text ?? "",
      tools: message.tools ?? null,
    }));
  if (chatRows.length) {
    const { error } = await supabase.from("chat_messages").insert(chatRows);
    if (error) throw new Error(`Failed to import local chat: ${error.message}`);
  }

  await touchSupabaseProject(id);
  return readProjectMeta(id, ownerUserId);
}

export function withJsonFrontmatter(meta: Record<string, unknown>, body: string) {
  return `---\n${JSON.stringify(meta, null, 2)}\n---\n${body.trim()}\n`;
}

export function parseJsonFrontmatter(content: string): {
  body: string;
  meta: Record<string, unknown>;
} {
  if (!content.startsWith("---\n")) return { body: content, meta: {} };
  const end = content.indexOf("\n---", 4);
  if (end < 0) return { body: content, meta: {} };
  const raw = content.slice(4, end).trim();
  try {
    const parsed = JSON.parse(raw);
    return {
      body: content.slice(end + 5).trimStart(),
      meta: parsed && typeof parsed === "object" ? parsed : {},
    };
  } catch {
    return { body: content, meta: {} };
  }
}

export async function createProject(name: string, ownerUserId?: string | null): Promise<ProjectMeta> {
  if (shouldUseSupabaseWorkspace()) {
    const owner = requireOwnerUserId(ownerUserId);
    const id = randomUUID();
    const now = nowIso();
    const meta = {
      createdAt: now,
      id,
      name: name.trim() || "Untitled video",
      updatedAt: now,
    };
    const supabase = createServerClient();
    const { error: projectError } = await supabase.from("projects").insert({
      id,
      name: meta.name,
      owner_user_id: owner,
      status: "active",
      created_at: meta.createdAt,
      updated_at: meta.updatedAt,
    });
    if (projectError) throw new Error(`Failed to create project: ${projectError.message}`);

    const files = initialSupabaseFiles(meta).map((file) => ({
      content: file.content,
      path: file.path,
      project_id: id,
    }));
    const { error: filesError } = await supabase.from("project_files").insert(files);
    if (filesError) throw new Error(`Failed to scaffold project files: ${filesError.message}`);
    return meta;
  }

  await ensureProjectsRoot();
  const id = `${slugify(name) || "video"}-${randomUUID().slice(0, 8)}`;
  const root = projectRoot(id);
  await mkdir(root, { recursive: true });
  await Promise.all(
    [
      "references/characters",
      "references/environments",
      "references/props",
      "references/styles",
      "keyframes",
      "scenes",
      "clips",
      "assets",
      "prompts",
      "operations",
      "findings",
      "runs",
      "media",
    ].map((dir) => mkdir(path.join(root, dir), { recursive: true })),
  );
  const meta = { id, name: name.trim() || "Untitled video", createdAt: nowIso(), updatedAt: nowIso() };
  await writeAtomicText(path.join(root, "project.json"), JSON.stringify(meta, null, 2));
  await writeFile(path.join(root, "chat.json"), "[]\n", "utf8");
  await writeFile(path.join(root, "timeline.json"), "[]\n", "utf8");
  await writeFile(
    path.join(root, "brief.md"),
    withJsonFrontmatter(
      { id: "brief", type: "brief", version: 1 },
      `# Brief\n\nDescribe the video goal, audience, constraints, and success criteria here.\n`,
    ),
    "utf8",
  );
  await writeFile(
    path.join(root, "references", "_README.md"),
    withJsonFrontmatter(
      { id: "references_readme", type: "note" },
      [
        "# References — identity anchors",
        "",
        "Anything that recurs or must stay visually consistent (a person, item, location, style) gets a reference and a portfolio BEFORE keyframes rely on it.",
        "",
        "- `references/<category>/<id>/reference.md` — frontmatter: `id`, `type:\"reference\"`, `category`, `status`, and for speaking characters `voice_id` (the canonical voice; clips where they speak record a `<id>@voice` dependency, so changing it marks exactly those clips stale). Body: the identity description.",
        "- Narrators/voiceover speakers are ordinary `characters` references with a `voice_id` and no portfolio.",
        "- `references/<category>/<id>/portfolio.md` — frontmatter: `id`, `type:\"portfolio\"`, `reference_id`, `status` (planned|generated|approved), `urls`. The portfolio image is ground truth: future keyframes copy it.",
      ].join("\n"),
    ),
    "utf8",
  );
  await writeFile(
    path.join(root, "keyframes", "_README.md"),
    withJsonFrontmatter(
      { id: "keyframes_readme", type: "note" },
      [
        "# Keyframes — shared state anchors",
        "",
        "A keyframe is the visual state of the film at one instant. Keyframes are top-level nodes shared between clips: a continuous shot means two clips literally share a keyframe node (clip A's `to_keyframe` IS clip B's `from_keyframe`). A jump cut means no shared node.",
        "",
        "`keyframes/<id>.md` frontmatter:",
        "- `id`, `type:\"keyframe\"`, `status` (planned|generated|captured|approved|superseded)",
        "- `url` — the frame's pixels (set by generation/capture tools)",
        "- `local_path` — active local media copy under `media/keyframes/<id>.vN.<ext>`",
        "- `versions` — browse-only media history: [{ version, url, local_path }]",
        "- `depicts` — reference ids visible in the frame",
        "- `identity_anchors` — portfolio ids whose images conditioned generation",
        "- `state_anchor` — prior keyframe id this frame continues from (continuous shots only; omit across cuts)",
        "- `captured_from` — clip id, when the frame was extracted from a rendered clip",
        "- `built_against` — dependency hashes, written by tools, verified by checkProject",
      ].join("\n"),
    ),
    "utf8",
  );
  await writeFile(
    path.join(root, "scenes", "_README.md"),
    withJsonFrontmatter(
      { id: "scenes_readme", type: "note" },
      [
        "# Scenes — narrative grouping",
        "",
        "`scenes/<idx>-<slug>/scene.md` frontmatter: `id`, `type:\"scene\"`, `index`, `references`. Body: what happens, in prose.",
        "",
        "Scenes group clips for ordering and meaning; continuity itself lives in the keyframe graph (see keyframes/_README.md).",
      ].join("\n"),
    ),
    "utf8",
  );
  await writeFile(
    path.join(root, "clips", "_README.md"),
    withJsonFrontmatter(
      { id: "clips_readme", type: "note" },
      [
        "# Clips — edges between keyframes",
        "",
        "`clips/<id>.md` frontmatter:",
        "- `id`, `type:\"clip\"`, `scene`, `index`, `status`, `url`",
        "- `local_path` — active local media copy under `media/clips/<id>.vN.<ext>`",
        "- `versions` — browse-only media history: [{ version, url, local_path }]",
        "- `from_keyframe` / `to_keyframe` — the keyframe nodes this clip connects",
        "- `end_trust` — pinned (first+last frame enforced) | captured (real final frame extracted) | unknown",
        "- `transition_from_previous` — continuous | cut | hard_cut_same_assets | time_jump | camera_reset | stylized_transition",
        "- `shot_size` — ELS | LS | MLS | MS | MCU | CU | ECU (dominant framing)",
        "- `cut_motivation` — why the cut into this clip exists; name it or don't cut",
        "- `camera_move` — one of fixed|push_in|pull_out|pan|tracking|orbit|aerial|handheld (exactly one)",
        "- `motion_rate` — slow_motion | real_time | accelerated | frenetic",
        "- `frame_delta` — [{ element, change (appeared|vanished|moved|changed_state), classification (intended|continuity_error), narration? }] accounting for every difference between the two endpoint frames",
        "- `duration_seconds` — generated/playback length in seconds; keep it equal to generated_seconds unless the user explicitly asks to trim existing media",
        "- `generated_seconds` — what was generated (provider-supported range is 4-15s)",
        "- `in_timeline` — whether the clip is in the final cut (default true; set false for an outtake)",
        "- `dialogue` — { mode: no_audible_speech | nonverbal_only | exact_dialogue | voiceover_exact, lines: [{ speaker, line, start_s, end_s, delivery? }] }",
        "- `built_against` — dependency hashes, written by tools",
        "",
        "Declared `continuous` must match structure: the previous clip's `to_keyframe` must be this clip's `from_keyframe`. Never chain a continuous clip off an `end_trust: unknown` clip — capture the real final frame first.",
        "",
        "timeline.json is DERIVED from clip order (scene index, then clip index) — it is not authored by hand. To reorder the film, change scene/clip `index`; to drop a clip from the cut, set `in_timeline: false`.",
      ].join("\n"),
    ),
    "utf8",
  );
  await writeFile(
    path.join(root, "prompts", "_README.md"),
    withJsonFrontmatter(
      { id: "prompts_readme", type: "note" },
      [
        "# Prompts — inspectable generation inputs",
        "",
        "`prepareClipPrompts` writes `prompts/asset_<clip_id>.prompt.md` before video generation so users can review or edit the exact prompt that `generateClip` will send.",
        "",
        "Planned clip prompt frontmatter:",
        "- `id`, `type:\"prompt\"`, `status` (planned|active|approved|superseded)",
        "- `clip_id` / `asset_id` — the clip and media asset this prompt belongs to",
        "- `compiler` / `compiler_hash` — deterministic compiler identity and hash of the compiler-authored body",
        "- `built_against` — dependency hashes for endpoint keyframes and the clip's `prompt_plan`",
        "",
        "If the prompt body differs from `compiler_hash`, treat it as user-edited. Do not overwrite it unless the user explicitly asks to replan or replace it.",
      ].join("\n"),
    ),
    "utf8",
  );
  await writeFile(
    path.join(root, "findings", "_README.md"),
    withJsonFrontmatter(
      { id: "findings_readme", type: "note" },
      [
        "# Findings — review issues",
        "",
        "Issues found during keyframe self-review (recordFinding). `findings/<id>.md` frontmatter:",
        "- `id`, `type:\"finding\"`, `status` (open|accepted|dismissed|resolved)",
        "- `severity` — blocker | issue | note",
        "- `implicates` — node ids this finding is about (usually keyframes)",
        "- `summary` — one-line description",
        "",
        "Open findings surface in checkProject (blockers as errors) and stay open until the user accepts or dismisses them (resolveFinding).",
      ].join("\n"),
    ),
    "utf8",
  );
  return meta;
}

export async function listProjects(ownerUserId?: string | null): Promise<ProjectMeta[]> {
  if (shouldUseSupabaseWorkspace()) {
    if (!ownerUserId) return [];
    await importLocalProjectsForOwner(ownerUserId);
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("projects")
      .select("id,name,created_at,updated_at")
      .eq("owner_user_id", ownerUserId)
      .eq("status", "active")
      .order("updated_at", { ascending: false });
    if (error) throw new Error(`Failed to list projects: ${error.message}`);
    return (data ?? []).map(dbProjectToMeta);
  }

  await ensureProjectsRoot();
  const entries = await readdir(DATA_ROOT, { withFileTypes: true });
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readProjectMeta(entry.name).catch(() => null)),
  );
  return projects
    .filter((project): project is ProjectMeta => Boolean(project))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteProject(projectId: string, ownerUserId?: string | null) {
  if (shouldUseSupabaseWorkspace()) {
    const resolvedProjectId = await resolveSupabaseProjectId(projectId, ownerUserId);
    const meta = await readProjectMeta(resolvedProjectId, ownerUserId);
    const supabase = createServerClient();
    let query = supabase
      .from("projects")
      .update({
        status: "deleted",
        updated_at: nowIso(),
      })
      .eq("id", resolvedProjectId);
    if (ownerUserId) query = query.eq("owner_user_id", ownerUserId);
    const { error } = await query;
    if (error) throw new Error(`Failed to delete project: ${error.message}`);
    return { id: projectId, trashed_path: `supabase://projects/${meta.id}` };
  }

  const source = projectRoot(projectId);
  const meta = await readProjectMeta(projectId);
  await mkdir(TRASH_ROOT, { recursive: true });
  const trashedId = `${projectId}-${nowIso().replace(/[:.]/g, "-")}`;
  const target = path.join(TRASH_ROOT, trashedId);
  if (!target.startsWith(TRASH_ROOT)) throw new Error("Unsafe trash path.");
  await writeFile(
    path.join(source, "deleted.json"),
    JSON.stringify({ ...meta, deletedAt: nowIso(), originalId: projectId }, null, 2),
    "utf8",
  );
  await rename(source, target);
  return { id: projectId, trashed_path: path.relative(process.cwd(), target).replaceAll(path.sep, "/") };
}

export async function readProjectMeta(
  projectId: string,
  ownerUserId?: string | null,
): Promise<ProjectMeta> {
  if (shouldUseSupabaseWorkspace()) {
    const resolvedProjectId = await resolveSupabaseProjectId(projectId, ownerUserId);
    const supabase = createServerClient();
    let query = supabase
      .from("projects")
      .select("id,name,created_at,updated_at")
      .eq("id", resolvedProjectId)
      .neq("status", "deleted");
    if (ownerUserId) query = query.eq("owner_user_id", ownerUserId);
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error(`Failed to read project: ${error.message}`);
    if (!data) throw new Error("Project not found.");
    return dbProjectToMeta(data);
  }

  return JSON.parse(await readFile(path.join(projectRoot(projectId), "project.json"), "utf8"));
}

async function walkFiles(root: string, current = ""): Promise<WorkspaceFile[]> {
  const dir = path.join(root, current);
  const entries = await readdir(dir, { withFileTypes: true });
  const files: WorkspaceFile[] = [];
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    // Agent tooling (synced skills, CLI configs) is not project content, and
    // the skills sync rewrites it concurrently with snapshot reads.
    if (
      current === "" &&
      (entry.name === ".claude" ||
        entry.name === ".codex" ||
        entry.name === ".git" ||
        entry.name === ".video-fs")
    ) {
      continue;
    }
    const relative = path.posix.join(current.replaceAll(path.sep, "/"), entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, relative)));
      continue;
    }
    if (isProjectSupportMetadataPath(relative)) continue;
    const fileStat = await stat(path.join(root, relative)).catch(() => null);
    if (!fileStat) continue; // Deleted mid-walk.
    const ext = path.extname(entry.name).toLowerCase();
    files.push({
      path: relative,
      size: fileStat.size,
      kind: MEDIA_FILE_EXTENSIONS.has(ext) ? "media" : "file",
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function listProjectFiles(projectId: string, includeContent = false) {
  if (shouldUseSupabaseWorkspace()) {
    const resolvedProjectId = await resolveSupabaseProjectId(projectId);
    const supabase = createServerClient();
    const [{ data: textRows, error: textError }, { data: mediaRows, error: mediaError }] =
      await Promise.all([
        supabase
          .from("project_files")
          .select("path,content")
          .eq("project_id", resolvedProjectId)
          .order("path", { ascending: true }),
        supabase
          .from("project_media")
          .select("storage_path,bytes")
          .eq("project_id", resolvedProjectId)
          .order("storage_path", { ascending: true }),
      ]);
    if (textError) throw new Error(`Failed to list project files: ${textError.message}`);
    if (mediaError) throw new Error(`Failed to list project media: ${mediaError.message}`);
    const files: WorkspaceFile[] = [
      ...(textRows ?? [])
        .filter((row) => !isProjectSupportMetadataPath(row.path as string))
        .map((row) => ({
          content:
            includeContent && Buffer.byteLength(row.content ?? "", "utf8") <= 60_000
              ? (row.content as string)
              : undefined,
          kind: "file" as const,
          path: row.path as string,
          size: Buffer.byteLength(row.content ?? "", "utf8"),
        })),
      ...(mediaRows ?? [])
        .filter((row) => typeof row.storage_path === "string" && row.storage_path)
        .map((row) => {
          const filePath = mediaPathFromStoragePath(resolvedProjectId, row.storage_path as string);
          return {
            kind: mediaKindForPath(filePath),
            path: filePath,
            size: typeof row.bytes === "number" ? row.bytes : 0,
          };
        })
        .filter((file) => !isProjectSupportMetadataPath(file.path)),
    ];
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  const root = projectRoot(projectId);
  const files = await walkFiles(root);
  if (!includeContent) return files;
  return Promise.all(
    files.map(async (file) => {
      const ext = path.extname(file.path).toLowerCase();
      if (!TEXT_FILE_EXTENSIONS.has(ext) || file.size > 60_000) return file;
      // Files can vanish between the walk and this read (concurrent
      // regeneration, deletion, agent writes) — a missing file is not an
      // error, it is simply no longer part of the snapshot.
      const content = await readFile(path.join(root, file.path), "utf8").catch(
        () => null,
      );
      return content === null ? file : { ...file, content };
    }),
  );
}

export async function readWorkspaceFile(projectId: string, relativePath: string) {
  if (shouldUseSupabaseWorkspace()) {
    return readSupabaseText(projectId, relativePath);
  }

  const { target } = resolveProjectPath(projectId, relativePath);
  return readFile(target, "utf8");
}

export async function writeWorkspaceFile(projectId: string, relativePath: string, content: string) {
  if (shouldUseSupabaseWorkspace()) {
    const safe = safeRelativePath(relativePath);
    await writeSupabaseText(projectId, safe, content);
    return { path: safe, size: Buffer.byteLength(content) };
  }

  await writeText(projectId, relativePath, content);
  return { path: safeRelativePath(relativePath), size: Buffer.byteLength(content) };
}

export async function writeWorkspaceBinaryFile(projectId: string, relativePath: string, content: Buffer) {
  if (shouldUseSupabaseWorkspace()) {
    const resolvedProjectId = await resolveSupabaseProjectId(projectId);
    const safe = safeRelativePath(relativePath);
    const storagePath = `${resolvedProjectId}/${safe}`;
    const supabase = createServerClient();
    const { error: uploadError } = await supabase.storage
      .from(PROJECT_MEDIA_BUCKET)
      .upload(storagePath, content, {
        contentType: contentTypeForPath(safe),
        upsert: true,
      });
    if (uploadError) throw new Error(`Failed to upload workspace media: ${uploadError.message}`);
    const { error: deleteMediaError } = await supabase
      .from("project_media")
      .delete()
      .eq("project_id", resolvedProjectId)
      .eq("storage_path", storagePath);
    if (deleteMediaError) {
      throw new Error(`Failed to replace workspace media metadata: ${deleteMediaError.message}`);
    }
    const { error: mediaError } = await supabase.from("project_media").insert({
      bytes: content.byteLength,
      kind: mediaKindForPath(safe) === "media" ? mediaCategoryForPath(safe) : "other",
      mime_type: contentTypeForPath(safe),
      project_id: resolvedProjectId,
      storage_path: storagePath,
    });
    if (mediaError) throw new Error(`Failed to record workspace media: ${mediaError.message}`);
    await touchSupabaseProject(resolvedProjectId);
    return { path: safe, size: content.byteLength };
  }

  const { safe, target } = resolveProjectPath(projectId, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  await touchProject(projectId);
  return { path: safe, size: content.byteLength };
}

/** Time-limited Supabase signed URL for a workspace media object — the way
 * the rest of the app exposes private-bucket media to external fetchers.
 * Returns null outside Supabase mode (local dev has no URL to sign). */
export async function signedWorkspaceMediaUrl(
  projectId: string,
  relativePath: string,
  ttlSeconds = 60 * 60 * 6,
  transformWidth?: number,
): Promise<string | null> {
  if (!shouldUseSupabaseWorkspace()) return null;
  const resolvedProjectId = await resolveSupabaseProjectId(projectId);
  const safe = safeRelativePath(relativePath);
  const supabase = createServerClient();
  // A transform width serves a resized, CDN-cached thumbnail instead of the
  // full-resolution object — full-res made project/canvas grids crawl.
  const options = transformWidth
    ? { transform: { width: transformWidth, resize: "contain" as const, quality: 72 } }
    : undefined;
  const { data, error } = await supabase.storage
    .from(PROJECT_MEDIA_BUCKET)
    .createSignedUrl(`${resolvedProjectId}/${safe}`, ttlSeconds, options);
  if (error) {
    throw new Error(`Failed to sign workspace media ${safe}: ${error.message}`);
  }
  return data?.signedUrl ?? null;
}

/** Host transient generated bytes (masks, extracted frames) in the project's
 * OWN media storage and return a time-limited signed URL for model calls.
 * Generation inputs are always hosted by us — never on third-party storage. */
export async function hostProjectBytes(
  projectId: string,
  fileName: string,
  bytes: Buffer,
): Promise<{ ok: true; url: string } | { error: string; ok: false }> {
  const safeName = fileName.replaceAll("/", "_").replace(/[^a-zA-Z0-9._-]/g, "_");
  const stored = await writeWorkspaceBinaryFile(
    projectId,
    `media/hosted/${Date.now().toString(36)}-${safeName}`,
    bytes,
  );
  const url = await signedWorkspaceMediaUrl(projectId, stored.path);
  if (!url) {
    return {
      error: "Media hosting requires Supabase workspace storage; no signed URL available.",
      ok: false,
    };
  }
  return { ok: true, url };
}

export async function readWorkspaceBinaryFile(projectId: string, relativePath: string) {
  if (shouldUseSupabaseWorkspace()) {
    const resolvedProjectId = await resolveSupabaseProjectId(projectId);
    const safe = safeRelativePath(relativePath);
    const storagePath = `${resolvedProjectId}/${safe}`;
    const supabase = createServerClient();
    const { data, error } = await supabase.storage
      .from(PROJECT_MEDIA_BUCKET)
      .download(storagePath);
    if (error) throw new Error(`Failed to read workspace media: ${error.message}`);
    const buffer = Buffer.from(await data.arrayBuffer());
    return {
      content: buffer,
      contentType: contentTypeForPath(safe),
      size: buffer.byteLength,
    };
  }

  const { target } = resolveProjectPath(projectId, relativePath);
  const info = await stat(target);
  return {
    content: await readFile(target),
    contentType: contentTypeForPath(target),
    size: info.size,
  };
}

/** Absolute on-disk path for a project-relative file (local mode only —
 * Supabase-backed workspaces have no local paths). */
export function workspaceAbsolutePath(projectId: string, relativePath: string) {
  if (shouldUseSupabaseWorkspace()) {
    throw new Error("Local file paths are unavailable on Supabase workspaces.");
  }
  return resolveProjectPath(projectId, relativePath).target;
}

/** Local-mode stat for media streaming: the media route serves videos with
 * HTTP Range support straight from disk, which buffered reads cannot do.
 * Returns null on Supabase-backed workspaces (those fall back to a full read). */
export async function statWorkspaceMediaFile(
  projectId: string,
  relativePath: string,
): Promise<{ absolutePath: string; contentType: string; size: number } | null> {
  if (shouldUseSupabaseWorkspace()) return null;
  const { target } = resolveProjectPath(projectId, relativePath);
  const info = await stat(target).catch(() => null);
  if (!info || !info.isFile()) return null;
  return {
    absolutePath: target,
    contentType: contentTypeForPath(target),
    size: info.size,
  };
}

export async function patchWorkspaceFile(
  projectId: string,
  relativePath: string,
  search: string,
  replace: string,
) {
  const current = await readWorkspaceFile(projectId, relativePath);
  if (!current.includes(search)) throw new Error("Search text not found.");
  const next = current.replace(search, replace);
  await writeWorkspaceFile(projectId, relativePath, next);
  return { path: safeRelativePath(relativePath), changed: next !== current };
}

export async function readChat(projectId: string): Promise<ChatMessage[]> {
  if (shouldUseSupabaseWorkspace()) {
    const resolvedProjectId = await resolveSupabaseProjectId(projectId);
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("chat_messages")
      .select("role,text,tools,created_at")
      .eq("project_id", resolvedProjectId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`Failed to read chat: ${error.message}`);
    return (data ?? []).map((row) => ({
      at: row.created_at as string,
      role: row.role as "user" | "assistant",
      text: row.text as string,
      tools: Array.isArray(row.tools) ? (row.tools as ChatToolCall[]) : undefined,
    }));
  }

  const file = path.join(projectRoot(projectId), "chat.json");
  return JSON.parse(await readFile(file, "utf8").catch(() => "[]"));
}

export async function appendChat(projectId: string, message: Omit<ChatMessage, "at">) {
  if (shouldUseSupabaseWorkspace()) {
    const resolvedProjectId = await resolveSupabaseProjectId(projectId);
    const at = nowIso();
    const supabase = createServerClient();
    const { error } = await supabase.from("chat_messages").insert({
      created_at: at,
      project_id: resolvedProjectId,
      role: message.role,
      text: message.text,
      tools: message.tools ?? null,
    });
    if (error) throw new Error(`Failed to append chat: ${error.message}`);
    await touchSupabaseProject(resolvedProjectId);
    return readChat(resolvedProjectId);
  }

  const chat = await readChat(projectId);
  chat.push({ ...message, at: nowIso() });
  await writeAtomicText(path.join(projectRoot(projectId), "chat.json"), JSON.stringify(chat, null, 2));
  await touchProject(projectId);
  return chat;
}

function buildProjectGraphFromFiles(files: WorkspaceFile[]) {
  return buildSourceGraph(
    files
      .filter((file): file is WorkspaceFile & { content: string } =>
        typeof file.content === "string",
      )
      .map((file) => ({ path: file.path, content: file.content })),
  );
}

async function buildProjectGraph(projectId: string) {
  const files = await listProjectFiles(projectId, true);
  return buildProjectGraphFromFiles(files);
}

/** Human label for a clip id, used only as the player chip caption. */
function clipLabel(id: string): string {
  return (
    id
      .replace(/^clip[_-]/i, "")
      .replace(/^\d+[_-]/, "")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || id
  );
}

/**
 * The playable timeline is DERIVED from the graph's canonical order
 * (scene index, then clip index) — never from a separately stored order. So
 * parallel generation finishing out of order can't scramble the film, and the
 * order survives regenerations. timeline.json on disk is just a cache of this.
 */
export async function readTimeline(projectId: string): Promise<TimelineItem[]> {
  const graph = await buildProjectGraph(projectId);
  return timelineFromGraph(graph);
}

function timelineFromGraph(graph: ReturnType<typeof buildSourceGraph>): TimelineItem[] {
  return orderedClips(graph)
    .filter(
      (clip) =>
        clip.inTimeline &&
        clip.status !== "superseded" &&
        clip.status !== "rejected",
    )
    .map((clip) => ({
      id: `tl_${clip.id}`,
      title: clipLabel(clip.id),
      scene_id: clip.sceneId,
      clip_id: clip.id,
      kind: "video" as const,
      from_keyframe: clip.fromKeyframe,
      to_keyframe: clip.toKeyframe,
      url: clip.url,
      duration: clip.durationSeconds,
    }));
}

/** Recompute timeline.json from the graph. Call after any clip change. */
export async function refreshTimeline(projectId: string): Promise<TimelineItem[]> {
  const timeline = await readTimeline(projectId);
  await writeText(projectId, "timeline.json", `${JSON.stringify(timeline, null, 2)}\n`);
  return timeline;
}

/**
 * Deterministic project check: parse the workspace into the typed source
 * graph and run the linter (lib/lint.ts). This is the compiler for the
 * production method — continuity, identity anchoring, and staleness are
 * verified structurally here, not recited in prompts.
 */
export async function checkProject(projectId: string): Promise<ProjectCheck> {
  const files = await listProjectFiles(projectId, true);
  return checkProjectFiles(files);
}

/** Media bytes without a tile record never appear on the canvas — the
 * classic cause is an agent writing records under the wrong shell cwd. */
function uploadOrphanIssues(files: WorkspaceFile[]) {
  const issues: ProjectCheck["issues"] = [];
  const referencedMedia = new Set<string>();
  for (const file of files) {
    if (!/^uploads\/[^/]+\.md$/.test(file.path)) continue;
    if (typeof file.content !== "string") continue;
    const meta = parseJsonFrontmatter(file.content).meta;
    if (typeof meta.local_path === "string") {
      referencedMedia.add(safeRelativePath(meta.local_path));
    }
  }
  for (const file of files) {
    if (!file.path.startsWith("media/uploads/")) continue;
    if (/^media\/uploads\/[^/]+$/.test(file.path)) {
      if (file.kind === "media" && !referencedMedia.has(file.path)) {
        issues.push({
          level: "warning",
          message: `"${file.path}" has media bytes but no uploads/<id>.md record referencing it — its tile will never appear on the canvas. Write the record from the project root (check your shell's working directory).`,
          path: file.path,
          rule: "orphan-upload-media",
        });
      }
    } else {
      issues.push({
        level: "error",
        message: `"${file.path}" is nested under media/uploads/ — records were likely written from the wrong working directory. Tile records belong in uploads/, media bytes directly in media/uploads/.`,
        path: file.path,
        rule: "misplaced-upload-record",
      });
    }
  }
  return issues;
}

function checkProjectFiles(files: WorkspaceFile[]): ProjectCheck {
  const sources = files
    .filter((file): file is WorkspaceFile & { content: string } =>
      typeof file.content === "string",
    )
    .map((file) => ({ path: file.path, content: file.content }));
  const result = lintSourceFiles(sources);
  const uploadIssues = uploadOrphanIssues(files);
  return {
    ok: result.ok && !uploadIssues.some((issue) => issue.level === "error"),
    issues: [
      ...result.issues.map((issue) => ({
        level: issue.level,
        message: issue.message,
        path: issue.path ?? undefined,
        rule: issue.rule,
      })),
      ...uploadIssues,
    ],
  };
}

export async function getProjectSnapshot(
  projectId: string,
  ownerUserId?: string | null,
): Promise<ProjectSnapshot> {
  const project = await readProjectMeta(projectId, ownerUserId);
  const [files, chat] = await Promise.all([
    listProjectFiles(projectId, true),
    readChat(projectId),
  ]);
  const check = checkProjectFiles(files);
  const timeline = timelineFromGraph(buildProjectGraphFromFiles(files));
  return { project, files, chat, check, timeline };
}
