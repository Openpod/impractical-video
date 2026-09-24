import path from "node:path";
import { rm } from "node:fs/promises";
import { NextResponse } from "next/server";
import { stepCountIs, streamText, tool, type ModelMessage } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { ensureAgentContextRoot } from "@/lib/agent-context/paths";
import { isLocalAppMode } from "@/lib/app-mode";
import { runCliComposer } from "@/lib/canvas-composer-cli";
import { billingEnabled, chargeForOp, getCreditBalance, quoteOp } from "@/lib/credits-service";
import type { BillableOp } from "@/lib/usage-pricing";
import { formatCanvasChatRequest } from "@/lib/canvas-chat";
import { OPEN_INTENT_ORCHESTRATION } from "@/lib/open-intent-orchestration";
import {
  listWorkflowSummaries,
  readWorkflow,
  type WorkflowSummary,
} from "@/lib/workflows";
import {
  cropImageToAspect,
  extractVideoFrame,
  generateFalImage,
  generateFalMusic,
  generateFalReferenceVideo,
  generateFalSpeech,
  generateFalVideo,
} from "@/lib/media";
import { extractShotTiles, materializeVideo } from "@/lib/video-shots";
import { appendArtifactVersion } from "@/lib/canvas-revision";
import {
  buildLineageIndex,
  dominantAspectRatio,
  traceLineage,
  unlinkedGenerationNote,
} from "@/lib/canvas-lineage";
import {
  appendChat,
  hostProjectBytes,
  signedWorkspaceMediaUrl,
  getProjectSnapshot,
  parseJsonFrontmatter,
  readWorkspaceBinaryFile,
  refreshTimeline,
  safeRelativePath,
  withJsonFrontmatter,
  writeWorkspaceBinaryFile,
  writeWorkspaceFile,
  type ChatToolCall,
  type ProjectSnapshot,
} from "@/lib/workspace";

// The canvas composer agent: a fast, stateless, per-request LLM call — separate
// from the main chat agent. Its "memory" is derived, not stored: a code-built
// manifest of everything in the project (references, clips, keyframes, uploads)
// plus the tail of the shared chat log. It acts in a couple of tool steps and
// writes both the request and the result into the shared chat log so the main
// chat agent stays fully aware of canvas activity.

type Params = {
  params: Promise<{ id: string }>;
};

const MODEL_ID =
  process.env.VIDEO_FS_COMPOSER_MODEL ||
  process.env.VIDEO_FS_AGENT_MODEL ||
  process.env.OPENROUTER_MODEL ||
  "openai/gpt-5.3-codex";
const MAX_TOOL_STEPS = 20;
const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;

function workflowInventoryText(workflows: WorkflowSummary[]) {
  if (!workflows.length) return "Workflow recipes: none configured.";
  return [
    "WORKFLOW INVENTORY (internal — load one only for a strong complex match):",
    ...workflows.map(
      (workflow) => `- ${workflow.id}: ${workflow.use_when}`,
    ),
  ].join("\n");
}

type ManifestEntry = {
  description: string;
  id: string;
  kind: "clip" | "keyframe" | "reference" | "upload";
  mediaPath: string | null;
  mediaUrl: string | null;
  path: string;
  title: string;
};

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 42) || "canvas"
  );
}

function firstHeading(body: string, fallback: string) {
  return (
    body
      .split("\n")
      .find((line) => line.startsWith("# "))
      ?.slice(2)
      .trim() || fallback
  );
}

function firstProseLine(body: string) {
  return (
    body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#")) ?? ""
  );
}

function firstUrl(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = firstUrl(item);
      if (nested) return nested;
    }
  }
  return null;
}

function mentionIds(text: string) {
  return [...new Set([...text.matchAll(/@([A-Za-z0-9_-]+)/g)].map((match) => match[1]!))];
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function contentTypeForPath(filePath: string) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  return "image/png";
}

function isVideoPath(filePath: string) {
  return /\.(mp4|webm|mov|m4v)$/i.test(filePath);
}

/** Build the project manifest the model resolves entities against. Pure code —
 * no LLM tokens are spent discovering what exists. */
function buildManifest(snapshot: ProjectSnapshot): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const portfolioByReference = new Map<string, string>();

  for (const file of snapshot.files) {
    if (!file.content) continue;
    if (file.path.endsWith("/portfolio.md")) {
      const parsed = parseJsonFrontmatter(file.content);
      const referenceId =
        typeof parsed.meta.reference_id === "string" ? parsed.meta.reference_id : null;
      const url = firstUrl(parsed.meta.urls);
      if (referenceId && url) portfolioByReference.set(referenceId, url);
    }
  }

  for (const file of snapshot.files) {
    if (!file.content) continue;
    const parsed = parseJsonFrontmatter(file.content);
    const id = typeof parsed.meta.id === "string" ? parsed.meta.id : null;
    if (!id) continue;
    const status = typeof parsed.meta.status === "string" ? parsed.meta.status : "active";
    if (status === "superseded" || status === "rejected") continue;
    const localPath =
      typeof parsed.meta.local_path === "string" ? parsed.meta.local_path : null;
    const url = typeof parsed.meta.url === "string" ? parsed.meta.url : null;

    if (/^references\/[^/]+\/[^/]+\/reference\.md$/.test(file.path)) {
      const category =
        typeof parsed.meta.category === "string" ? parsed.meta.category : "reference";
      entries.push({
        description: `${category} reference. ${truncate(firstProseLine(parsed.body), 160)}`,
        id,
        kind: "reference",
        mediaPath: null,
        mediaUrl: portfolioByReference.get(id) ?? null,
        path: file.path,
        title: firstHeading(parsed.body, id),
      });
    } else if (/^clips\/[^/]+\.md$/.test(file.path) && parsed.meta.type === "clip") {
      const duration =
        typeof parsed.meta.duration_seconds === "number"
          ? `${parsed.meta.duration_seconds}s`
          : "";
      entries.push({
        description: `video clip ${duration} (status: ${status})`.trim(),
        id,
        kind: "clip",
        mediaPath: localPath,
        mediaUrl: url,
        path: file.path,
        title: firstHeading(parsed.body, id),
      });
    } else if (/^keyframes\/[^/]+\.md$/.test(file.path)) {
      entries.push({
        description: `still image / keyframe (status: ${status})`,
        id,
        kind: "keyframe",
        mediaPath: localPath,
        mediaUrl: url,
        path: file.path,
        title: firstHeading(parsed.body, id),
      });
    } else if (/^uploads\/[^/]+\.md$/.test(file.path) && parsed.meta.type === "upload") {
      const kind =
        parsed.meta.kind === "video" ? "video" : parsed.meta.kind === "audio" ? "audio" : "image";
      entries.push({
        description: `user-uploaded ${kind}`,
        id,
        kind: "upload",
        mediaPath: localPath,
        mediaUrl: url,
        path: file.path,
        title: firstHeading(parsed.body, id),
      });
    }
  }
  return entries;
}

function manifestText(entries: ManifestEntry[]) {
  if (!entries.length) return "(the project is empty so far)";
  const lines = entries.map(
    (entry) =>
      `- ${entry.id} — "${entry.title}" — ${entry.description} — ${entry.path}${entry.mediaPath || entry.mediaUrl ? " — has media" : " — no media yet"}`,
  );
  return lines.join("\n");
}

function userGroupsText(snapshot: ProjectSnapshot) {
  const groupsFile = snapshot.files.find((file) => file.path === "canvas/groups.json");
  if (!groupsFile || typeof groupsFile.content !== "string") return "";
  try {
    const parsed = JSON.parse(groupsFile.content) as {
      groups?: Array<{ cardIds?: string[]; id?: string; title?: string }>;
    };
    const entries = (parsed.groups ?? []).filter(
      (group) => Array.isArray(group.cardIds) && group.cardIds.length,
    );
    if (!entries.length) return "";
    return `CANVAS GROUPS (the user's hand organization — treat membership as intent about what belongs together). To place a NEW tile into one of these groups, pass the group's title as group_id (e.g. "Main clips" → group_id "main_clips") — matching is by title. When your output clearly belongs with an existing group, place it there instead of loose on the canvas:\n${entries
      .map((group) => `- "${group.title ?? group.id}": ${group.cardIds!.join(", ")}`)
      .join("\n")}`;
  } catch {
    return "";
  }
}

function recentActivityText(snapshot: ProjectSnapshot) {
  const tail = snapshot.chat.slice(-8);
  if (!tail.length) return "(no chat activity yet)";
  return tail
    .map((message) => `${message.role}: ${truncate(message.text.replace(/\n+/g, " "), 220)}`)
    .join("\n");
}

/** Throws when the account can't afford the op (tool convention: throw → error result). */
async function composerPreflight(userId: string, op: BillableOp): Promise<void> {
  if (!billingEnabled()) return;
  const required = quoteOp(op);
  const balance = await getCreditBalance(userId);
  if (balance.total < required) {
    throw new Error(
      `Insufficient credits: this needs ${required} credits but the account has ${balance.total}. Buy credits to continue.`,
    );
  }
}

/** Charge for a generation that succeeded (idempotent, fire-and-forget). */
async function composerSettle(
  userId: string,
  op: BillableOp,
  projectId: string,
  artifact?: { path?: string | null; title?: string | null; url?: string | null },
): Promise<void> {
  if (!billingEnabled()) return;
  // A generation URL/path is unique per generation, so a stable key derived
  // from it dedups retries while still letting distinct generations charge once.
  const key =
    artifact?.url || artifact?.path
      ? `${op.tool}:${artifact.url ?? artifact.path}`
      : crypto.randomUUID();
  await chargeForOp({
    userId,
    op,
    projectId,
    idempotencyKey: key,
    description: `${op.tool} (${projectId})`,
    artifact,
  }).catch(() => {});
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to use the canvas composer." }, { status: 401 });
  }
  if (!isLocalAppMode(process.env) && !process.env.OPENROUTER_API_KEY) {
    return NextResponse.json({ error: "OPENROUTER_API_KEY is not configured." }, { status: 500 });
  }
  const snapshot = await getProjectSnapshot(id, user.userId);
  const workflowSummaries = await listWorkflowSummaries();

  const body = await request.json().catch(() => ({}));
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
  // `focus` accepts a single tile or a staged list of tiles.
  type FocusTile = { id?: string; kind?: string; path?: string; title?: string };
  const focusList: FocusTile[] = Array.isArray(body.focus)
    ? (body.focus as FocusTile[]).filter((entry) => entry && typeof entry === "object")
    : body.focus && typeof body.focus === "object"
      ? [body.focus as FocusTile]
      : [];
  const focus = focusList[0] ?? null;
  const IMAGE_BACKENDS = new Set(["nano-banana", "qwen", "flux-kontext", "gpt-image"]);
  const imageBackend =
    typeof body.imageModel === "string" && IMAGE_BACKENDS.has(body.imageModel)
      ? body.imageModel
      : undefined;
  if (!instruction) {
    return NextResponse.json({ error: "Instruction is required." }, { status: 400 });
  }

  await appendChat(id, {
    role: "user",
    text: formatCanvasChatRequest(
      { kind: "compose", title: focus?.title || "Canvas" },
      instruction,
    ),
  });

  const manifest = buildManifest(snapshot);
  const manifestById = new Map(manifest.map((entry) => [entry.id, entry]));
  const toolCalls: ChatToolCall[] = [];
  const createdPaths: string[] = [];

  /** Resolve a manifest entry's media to a fal-hosted image URL usable as
   * generation conditioning. Videos contribute a mid frame. */
  async function falImageUrlForEntry(entry: ManifestEntry): Promise<string> {
    if (entry.kind === "reference") {
      if (!entry.mediaUrl) throw new Error(`Reference "${entry.id}" has no portfolio image yet.`);
      return falUrlForWorkspaceMedia(entry.mediaUrl);
    }
    const media = entry.mediaPath ?? entry.mediaUrl;
    if (!media) throw new Error(`"${entry.id}" has no media to use.`);
    const isVideo =
      entry.kind === "clip" || (entry.kind === "upload" && isVideoPath(media));
    if (!isVideo) return falUrlForWorkspaceMedia(media);
    const videoUrl = await falUrlForWorkspaceMedia(media);
    const frame = await extractVideoFrame({ seconds: 0.5, videoUrl });
    if (!frame.ok) throw new Error(frame.error);
    const hosted = await hostProjectBytes(id, `${slug(entry.id)}-frame.png`, frame.buffer);
    if (!hosted.ok) throw new Error(hosted.error);
    return hosted.url;
  }

  async function falUrlForWorkspaceMedia(mediaPath: string) {
    if (/^https?:\/\//i.test(mediaPath)) return mediaPath;
    const safe = safeRelativePath(mediaPath);
    // Our storage or nothing: time-limited Supabase signed URL. Generation
    // inputs are never re-hosted on third-party (fal) storage.
    const signed = await signedWorkspaceMediaUrl(id, safe);
    if (!signed) {
      throw new Error(`Workspace media "${safe}" could not be signed — Supabase storage hosting required.`);
    }
    return signed;
  }

  async function saveRemoteMedia(relativePath: string, url: string, exactAspect?: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download generated media (${response.status}).`);
    let bytes: Buffer = Buffer.from(await response.arrayBuffer());
    // Image models' "16:9" is often approximate; a stored off-ratio frame
    // used later as a pinned video endpoint drifts through a subtle squeeze.
    if (exactAspect && /\.(png|jpe?g|webp)$/i.test(relativePath)) {
      bytes = await cropImageToAspect(bytes, exactAspect);
    }
    await writeWorkspaceBinaryFile(id, relativePath, bytes);
    return relativePath;
  }

  /** Artifacts created MID-REQUEST must be usable as sources immediately —
   * the manifest is a snapshot from request start, and rejecting a freshly
   * extracted frame forces the model to substitute a wrong-but-available
   * image (the "used the wrong reference" failure). */
  function registerManifestEntry(entry: ManifestEntry) {
    manifestById.set(entry.id, entry);
  }


  function resolveSources(sourceIds: string[] | undefined | null) {
    const resolved: ManifestEntry[] = [];
    for (const sourceId of sourceIds ?? []) {
      const entry = manifestById.get(sourceId.replace(/^@/, ""));
      if (!entry) throw new Error(`Unknown source id "${sourceId}". Use ids from the manifest.`);
      resolved.push(entry);
    }
    return resolved;
  }

  const tools = {
    loadWorkflow: tool({
      description:
        "Load one workflow recipe as an internal execution aid when this is a complex request with a strong match. Adapt it to the user's outcome; do not make the user select a workflow.",
      inputSchema: z.object({ workflow_id: z.string().min(1) }),
      execute: async ({ workflow_id }) => {
        const workflow = await readWorkflow(workflow_id);
        toolCalls.push({
          name: "loadWorkflow",
          ok: true,
          summary: `Loaded ${workflow.title}`,
        });
        return { workflow };
      },
    }),
    listFiles: tool({
      description:
        "List all workspace file paths. Escape hatch for when the manifest is not enough.",
      inputSchema: z.object({}),
      execute: async () => {
        toolCalls.push({ name: "listFiles", ok: true, summary: "Listed workspace files" });
        return snapshot.files.map((file) => file.path).join("\n");
      },
    }),
    readFile: tool({
      description:
        "Read one workspace text file (reference docs, clip/keyframe sources, uploads metadata). Escape hatch when a manifest line is not enough detail.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path: relativePath }) => {
        const file = snapshot.files.find((entry) => entry.path === safeRelativePath(relativePath));
        toolCalls.push({
          name: "readFile",
          ok: Boolean(file?.content),
          summary: `Read ${relativePath}`,
        });
        if (!file?.content) return `No readable text file at ${relativePath}.`;
        return truncate(file.content, 20_000);
      },
    }),
    traceLineage: tool({
      description:
        "Trace an artifact's provenance DAG: what it was derived from (ancestors), what was made from it (descendants), and its canvas-group siblings. Use before building on or modifying something whose history matters.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id: nodeId }) => {
        const index = buildLineageIndex(snapshot.files);
        const trace = traceLineage(index, nodeId.replace(/^@/, ""));
        toolCalls.push({
          name: "traceLineage",
          ok: Boolean(trace),
          summary: trace ? `Traced ${nodeId}` : `Unknown id ${nodeId}`,
        });
        return trace ?? { error: `Unknown id "${nodeId}".` };
      },
    }),
    viewImage: tool({
      description:
        "Look at a manifest entry's actual image (reference portfolio, keyframe, or uploaded image). Use when you need to see what something looks like before writing a generation prompt.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id: entryId }) => {
        const entry = manifestById.get(entryId.replace(/^@/, ""));
        if (!entry) {
          toolCalls.push({ name: "viewImage", ok: false, summary: `Unknown id ${entryId}` });
          return { error: `Unknown id "${entryId}".`, ok: false as const };
        }
        try {
          const media =
            entry.kind === "reference" ? entry.mediaUrl : entry.mediaPath ?? entry.mediaUrl;
          if (!media) throw new Error("No media.");
          if (entry.kind === "clip" || (entry.kind === "upload" && isVideoPath(media))) {
            throw new Error("Video sources cannot be viewed as stills here.");
          }
          let buffer: Buffer;
          let mediaType: string;
          if (/^https?:\/\//i.test(media)) {
            const response = await fetch(media);
            if (!response.ok) throw new Error(`Fetch failed (${response.status}).`);
            buffer = Buffer.from(await response.arrayBuffer());
            mediaType = response.headers.get("content-type") || contentTypeForPath(media);
          } else {
            const binary = await readWorkspaceBinaryFile(id, safeRelativePath(media));
            buffer = binary.content;
            mediaType = binary.contentType || contentTypeForPath(media);
          }
          if (buffer.byteLength > 20 * 1024 * 1024) throw new Error("Image too large to view.");
          toolCalls.push({ name: "viewImage", ok: true, summary: `Viewed ${entry.id}` });
          return {
            base64: buffer.toString("base64"),
            id: entry.id,
            mediaType,
            ok: true as const,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to load image.";
          toolCalls.push({ name: "viewImage", ok: false, summary: message });
          return { error: message, ok: false as const };
        }
      },
      toModelOutput: ({ output }) => {
        if (!output.ok) return { type: "text", value: output.error ?? "Failed." };
        return {
          type: "content",
          value: [
            { type: "text", text: `Image: ${output.id}` },
            { type: "file-data", data: output.base64!, mediaType: output.mediaType! },
          ],
        };
      },
    }),
    generateVideoFromReferences: tool({
      description:
        "Generate a video from references (Seedance reference-to-video): pass reference_ids — CLIP ids attach as VIDEO references (the actual footage, up to 3), image/keyframe/reference/upload ids attach as image references. IN THE PROMPT, refer to attachments by @ tags in id order: images are @Image1..@ImageN, videos are @Video1..@VideoN (e.g. \"@Video1 continues: the character from @Image1 enters\"). This is how to pass a video itself as a reference or extend footage in its own style.",
      inputSchema: z.object({
        aspect_ratio: z.enum(ASPECT_RATIOS).default("16:9"),
        duration_seconds: z
          .number()
          .min(4)
          .max(15)
          .default(5)
          .describe("Whole seconds, MINIMUM 4, maximum 15 (hard model constraint — values under 4 are invalid and will be rejected). If the user asks for a shorter beat, generate 4-5s and trim in the editor."),
        group_id: z.string().nullable().default(null),
        group_index: z.number().int().min(0).default(0),
        group_title: z.string().nullable().default(null),
        prompt: z.string().describe("Full motion + visual description of the clip."),
        reference_ids: z.array(z.string()).min(1).max(4),
        revises: z
          .string()
          .nullable()
          .default(null)
          .describe("Existing tile id to REDO: appends a new version to that tile (same id, same canvas position) instead of creating a sibling tile. ONLY for re-attempting the SAME creative intent (redo/fix/try-again of this exact artifact). NEVER for new content the user wants to keep alongside — another shot, a sequel, a continuation, a variation — those get a NEW tile even when an existing tile is focused; the focused tile is context, not the revision target."),
        title: z.string().describe("Short human title for the new clip."),
      }),
      execute: async ({
        aspect_ratio,
        duration_seconds,
        group_id,
        group_index,
        group_title,
        prompt,
        reference_ids,
        revises,
        title,
      }) => {
        try {
          const sources = resolveSources(reference_ids);
          const referenceImageUrls: string[] = [];
          const referenceVideoUrls: string[] = [];
          for (const entry of sources) {
            const media = entry.mediaPath ?? entry.mediaUrl;
            const isVideoSource =
              entry.kind === "clip" || (entry.kind === "upload" && media && isVideoPath(media));
            if (isVideoSource && media) {
              // Clips attach as VIDEO references — the actual footage.
              referenceVideoUrls.push(await falUrlForWorkspaceMedia(media));
            } else {
              referenceImageUrls.push(await falImageUrlForEntry(entry));
            }
          }
          if (referenceVideoUrls.length > 3) {
            throw new Error("At most 3 clip (video) references are supported.");
          }
          const r2vOp: BillableOp = {
            kind: "clip",
            tool: "composer.generateVideoFromReferences",
            pinned: true,
            resolution: "720p",
            seconds: Math.round(duration_seconds),
          };
          await composerPreflight(user.userId, r2vOp);
          const generated = await generateFalReferenceVideo({
            aspectRatio: aspect_ratio,
            duration: String(Math.round(duration_seconds)),
            prompt,
            referenceImageUrls,
            referenceVideoUrls,
          });
          if (!generated.ok || !generated.url) {
            throw new Error(generated.error || "Reference-to-video generation failed.");
          }
          await composerSettle(user.userId, r2vOp, id, { title, url: generated.url });
          if (revises) {
            const revision = await appendArtifactVersion(id, {
              id: revises.replace(/^@/, ""),
              kind: "clip",
              metaPatch: {
                duration_seconds: Math.round(duration_seconds),
                generated_seconds: Math.round(duration_seconds),
              },
              note: `Reference-to-video revision.\n\nPrompt: ${prompt}\n\nReferences: ${sources.map((entry) => `@${entry.id}`).join(", ") || "(none)"}`,
              url: generated.url,
            });
            if (!revision.ok) throw new Error(revision.error);
            createdPaths.push(revision.path);
            toolCalls.push({
              name: "generateVideoFromReferences",
              ok: true,
              summary: `Updated clip "${revises}" to v${revision.version}`,
            });
            return `Updated clip ${revises.replace(/^@/, "")} in place to version ${revision.version} — same tile, new pixels.`;
          }
          const clipId = `canvas_${slug(title)}_${Date.now().toString(36)}`;
          const localPath = await saveRemoteMedia(`media/clips/${clipId}.v1.mp4`, generated.url);
          await writeWorkspaceFile(
            id,
            `clips/${clipId}.md`,
            withJsonFrontmatter(
              {
                aspect_ratio,
                canvas_composed: true,
                canvas_derived_from: sources[0]?.id ?? null,
                canvas_group: group_id,
                canvas_group_index: group_index,
                canvas_group_title: group_title ?? group_id,
                depicts: sources.map((entry) => entry.id),
                duration_seconds: Math.round(duration_seconds),
                generated_seconds: Math.round(duration_seconds),
                id: clipId,
                in_timeline: false,
                index: Date.now(),
                local_path: localPath,
                status: "active",
                type: "clip",
                url: generated.url,
                versions: [{ local_path: localPath, url: generated.url, version: 1 }],
              },
              `# ${title}\n\n## Request\n\n${instruction}\n\n## Prompt\n\n${prompt}\n\n## References\n\n${sources.map((entry) => `@${entry.id}`).join(", ")}\n`,
            ),
          );
          createdPaths.push(`clips/${clipId}.md`);
          registerManifestEntry({
            description: `Generated clip (reference-to-video): ${title}`,
            id: clipId,
            kind: "clip",
            mediaPath: localPath,
            mediaUrl: generated.url,
            path: `clips/${clipId}.md`,
            title,
          });
          toolCalls.push({
            name: "generateVideoFromReferences",
            ok: true,
            summary: `Created clip "${title}" from ${sources.length} reference(s)`,
          });
          return `Created clip "${title}" (id: ${clipId}) from references ${sources.map((entry) => entry.id).join(", ")}. It is on the canvas.`;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Reference-to-video failed.";
          toolCalls.push({ name: "generateVideoFromReferences", ok: false, summary: message });
          return `Failed: ${message}`;
        }
      },
    }),
    generateSpeech: tool({
      description:
        "Generate spoken audio (ElevenLabs TTS) from text; the result lands on the canvas as an audio tile.",
      inputSchema: z.object({
        text: z.string().min(1).describe("Exactly what should be spoken."),
        title: z.string().describe("Short human title for the audio tile."),
        voice: z.string().nullable().default(null).describe("Optional voice name."),
      }),
      execute: async ({ text, title, voice }) => {
        try {
          const speechOp: BillableOp = {
            kind: "speech",
            tool: "composer.generateSpeech",
            characters: text.length,
          };
          await composerPreflight(user.userId, speechOp);
          const generated = await generateFalSpeech({ text, voice: voice ?? undefined });
          if (!generated.ok || !generated.url) {
            throw new Error(generated.error || "Speech generation failed.");
          }
          await composerSettle(user.userId, speechOp, id, { title, url: generated.url });
          const audioId = `canvas_${slug(title)}_${Date.now().toString(36)}`;
          const localPath = await saveRemoteMedia(
            `media/uploads/${audioId}.mp3`,
            generated.url,
          );
          await writeWorkspaceFile(
            id,
            `uploads/${audioId}.md`,
            withJsonFrontmatter(
              {
                canvas_composed: true,
                id: audioId,
                kind: "audio",
                local_path: localPath,
                status: "active",
                type: "upload",
              },
              `# ${title}\n\nGenerated speech.\n\n> ${text.slice(0, 400)}\n`,
            ),
          );
          createdPaths.push(`uploads/${audioId}.md`);
          toolCalls.push({ name: "generateSpeech", ok: true, summary: `Voice-over "${title}"` });
          return `Created speech audio "${title}" (id: ${audioId}) — on the canvas as an audio tile.`;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Speech generation failed.";
          toolCalls.push({ name: "generateSpeech", ok: false, summary: message });
          return `Failed: ${message}`;
        }
      },
    }),
    generateMusic: tool({
      description:
        "Generate music (ElevenLabs) from a text brief; the result lands on the canvas as an audio tile.",
      inputSchema: z.object({
        duration_seconds: z.number().min(5).max(120).nullable().default(null),
        prompt: z.string().min(1).describe("Genre, mood, instrumentation, tempo."),
        title: z.string().describe("Short human title for the audio tile."),
      }),
      execute: async ({ duration_seconds, prompt, title }) => {
        try {
          const musicOp: BillableOp = {
            kind: "music",
            tool: "composer.generateMusic",
            seconds: duration_seconds ?? 30,
          };
          await composerPreflight(user.userId, musicOp);
          const generated = await generateFalMusic({
            durationSeconds: duration_seconds ?? undefined,
            prompt,
          });
          if (!generated.ok || !generated.url) {
            throw new Error(generated.error || "Music generation failed.");
          }
          await composerSettle(user.userId, musicOp, id, { title, url: generated.url });
          const audioId = `canvas_${slug(title)}_${Date.now().toString(36)}`;
          const localPath = await saveRemoteMedia(
            `media/uploads/${audioId}.mp3`,
            generated.url,
          );
          await writeWorkspaceFile(
            id,
            `uploads/${audioId}.md`,
            withJsonFrontmatter(
              {
                canvas_composed: true,
                id: audioId,
                kind: "audio",
                local_path: localPath,
                status: "active",
                type: "upload",
              },
              `# ${title}\n\nGenerated music.\n\n> ${prompt.slice(0, 400)}\n`,
            ),
          );
          createdPaths.push(`uploads/${audioId}.md`);
          toolCalls.push({ name: "generateMusic", ok: true, summary: `Music "${title}"` });
          return `Created music "${title}" (id: ${audioId}) — on the canvas as an audio tile.`;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Music generation failed.";
          toolCalls.push({ name: "generateMusic", ok: false, summary: message });
          return `Failed: ${message}`;
        }
      },
    }),
    extractFrame: tool({
      description:
        "Extract a still frame from a video source (clip or uploaded video) at a timestamp; the frame lands on the canvas as an image tile. Use for 'grab the frame at Xs', poster stills, or getting an editable image out of footage.",
      inputSchema: z.object({
        at_seconds: z.number().min(0).default(0),
        source_id: z.string().describe("Manifest id of the video (clip/upload)."),
        title: z.string().describe("Short human title for the extracted frame."),
      }),
      execute: async ({ at_seconds, source_id, title }) => {
        try {
          const entry = manifestById.get(source_id.replace(/^@/, ""));
          if (!entry) throw new Error(`Unknown source "${source_id}".`);
          const media = entry.mediaPath ?? entry.mediaUrl;
          if (!media) throw new Error(`"${entry.id}" has no media.`);
          const isVideo =
            entry.kind === "clip" || (entry.kind === "upload" && isVideoPath(media));
          if (!isVideo) throw new Error(`"${entry.id}" is not a video.`);
          const { sourcePath, workDir } = await materializeVideo(id, media);
          try {
            const frame = await extractVideoFrame({ seconds: at_seconds, videoUrl: sourcePath });
            if (!frame.ok) throw new Error(frame.error);
            const frameId = `canvas_${slug(title)}_${Date.now().toString(36)}`;
            const localPath = `media/keyframes/${frameId}.v1.png`;
            await writeWorkspaceBinaryFile(id, localPath, frame.buffer);
            await writeWorkspaceFile(
              id,
              `keyframes/${frameId}.md`,
              withJsonFrontmatter(
                {
                  canvas_composed: true,
                  canvas_derived_from: entry.id,
                  id: frameId,
                  local_path: localPath,
                  status: "generated",
                  type: "keyframe",
                  versions: [{ local_path: localPath, url: null, version: 1 }],
                },
                `# ${title}\n\nFrame extracted at ${at_seconds.toFixed(2)}s from @${entry.id}.\n`,
              ),
            );
            createdPaths.push(`keyframes/${frameId}.md`);
            registerManifestEntry({
              description: `Frame extracted at ${at_seconds.toFixed(2)}s from ${entry.id}`,
              id: frameId,
              kind: "keyframe",
              mediaPath: localPath,
              mediaUrl: null,
              path: `keyframes/${frameId}.md`,
              title,
            });
            toolCalls.push({
              name: "extractFrame",
              ok: true,
              summary: `Frame at ${at_seconds.toFixed(2)}s from ${entry.id}`,
            });
            return `Extracted the frame at ${at_seconds.toFixed(2)}s from ${entry.id} — image "${title}" (id: ${frameId}) is on the canvas.`;
          } finally {
            await rm(workDir, { recursive: true, force: true });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Frame extraction failed.";
          toolCalls.push({ name: "extractFrame", ok: false, summary: message });
          return `Failed: ${message}`;
        }
      },
    }),
    extractShots: tool({
      description:
        "Split a video source (clip or uploaded video) into its individual shots via ffmpeg scene detection — the same analyzer the YouTube import uses. Each shot becomes its own clip tile, grouped as a row on the canvas.",
      inputSchema: z.object({
        max_shots: z.number().int().min(1).max(40).default(20),
        source_id: z.string().describe("Manifest id of the video (clip/upload)."),
      }),
      execute: async ({ max_shots, source_id }) => {
        try {
          const entry = manifestById.get(source_id.replace(/^@/, ""));
          if (!entry) throw new Error(`Unknown source "${source_id}".`);
          const media = entry.mediaPath ?? entry.mediaUrl;
          if (!media) throw new Error(`"${entry.id}" has no media.`);
          const isVideo =
            entry.kind === "clip" || (entry.kind === "upload" && isVideoPath(media));
          if (!isVideo) throw new Error(`"${entry.id}" is not a video.`);
          const result = await extractShotTiles({
            maxShots: max_shots,
            media,
            projectId: id,
            sourceId: entry.id,
            sourceTitle: entry.title,
          });
          createdPaths.push(...result.paths);
          for (const tilePath of result.paths) {
            const shotId = tilePath.replace(/^clips\//, "").replace(/\.md$/, "");
            registerManifestEntry({
              description: `Shot extracted from ${entry.id}`,
              id: shotId,
              kind: "clip",
              mediaPath: `media/clips/${shotId}.v1.mp4`,
              mediaUrl: null,
              path: tilePath,
              title: shotId,
            });
          }
          toolCalls.push({
            name: "extractShots",
            ok: true,
            summary: `${result.count} shots from ${entry.id}`,
          });
          return `Split ${entry.id} into ${result.count} shot tiles (of ${result.totalDetected} detected), grouped as "${entry.title} shots" on the canvas.`;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Shot extraction failed.";
          toolCalls.push({ name: "extractShots", ok: false, summary: message });
          return `Failed: ${message}`;
        }
      },
    }),
    generateImage: tool({
      description:
        "Generate a still image. Pass source_ids (manifest ids: references, uploads, keyframes, clips) to condition on their pixels — always include a character reference's id when depicting it. The result appears on the canvas.",
      inputSchema: z.object({
        aspect_ratio: z.enum(ASPECT_RATIOS).default("16:9"),
        group_id: z
          .string()
          .nullable()
          .default(null)
          .describe(
            "Optional group slug. Tiles sharing a group_id are arranged together as a row on the canvas (e.g. a storyboard sequence). Omit for one-off generations.",
          ),
        group_index: z.number().int().min(0).default(0).describe("Order within the group."),
        group_title: z.string().nullable().default(null),
        prompt: z.string().describe("Full visual description of the image to create."),
        source_ids: z.array(z.string()).default([]),
        revises: z
          .string()
          .nullable()
          .default(null)
          .describe("Existing tile id to REDO: appends a new version to that tile (same id, same canvas position) instead of creating a sibling tile. ONLY for re-attempting the SAME creative intent (redo/fix/try-again of this exact artifact). NEVER for new content the user wants to keep alongside — another shot, a sequel, a continuation, a variation — those get a NEW tile even when an existing tile is focused; the focused tile is context, not the revision target."),
        title: z.string().describe("Short human title for the new image."),
      }),
      execute: async ({ aspect_ratio, group_id, group_index, group_title, prompt, revises, source_ids, title }) => {
        try {
          const sources = resolveSources(source_ids);
          const imageUrls = await Promise.all(sources.map(falImageUrlForEntry));
          const imageOp: BillableOp = {
            kind: "image",
            tool: "composer.generateImage",
            resolution: "1K",
          };
          await composerPreflight(user.userId, imageOp);
          const generated = await generateFalImage({
            aspectRatio: aspect_ratio,
            backend: imageBackend,
            imageUrls: imageUrls.length ? imageUrls : undefined,
            prompt,
          });
          if (!generated.ok || !generated.url) {
            throw new Error(generated.error || "Image generation failed.");
          }
          await composerSettle(user.userId, imageOp, id, { title, url: generated.url });
          if (revises) {
            const revision = await appendArtifactVersion(id, {
              exactAspect: aspect_ratio,
              id: revises.replace(/^@/, ""),
              kind: "keyframe",
              note: `Image revision.\n\nPrompt: ${prompt}\n\nSources: ${sources.map((entry) => `@${entry.id}`).join(", ") || "(none)"}`,
              url: generated.url,
            });
            if (!revision.ok) throw new Error(revision.error);
            createdPaths.push(revision.path);
            toolCalls.push({
              name: "generateImage",
              ok: true,
              summary: `Updated image "${revises}" to v${revision.version}`,
            });
            return `Updated image ${revises.replace(/^@/, "")} in place to version ${revision.version} — same tile, new pixels.`;
          }
          const imageId = `canvas_${slug(title)}_${Date.now().toString(36)}`;
          const localPath = await saveRemoteMedia(
            `media/keyframes/${imageId}.v1.png`,
            generated.url,
            aspect_ratio,
          );
          await writeWorkspaceFile(
            id,
            `keyframes/${imageId}.md`,
            withJsonFrontmatter(
              {
                aspect_ratio,
                canvas_composed: true,
                canvas_group: group_id,
                canvas_group_index: group_index,
                canvas_group_title: group_title ?? group_id,
                depicts: sources.map((entry) => entry.id),
                id: imageId,
                local_path: localPath,
                status: "generated",
                type: "keyframe",
                url: generated.url,
                versions: [{ local_path: localPath, url: generated.url, version: 1 }],
              },
              `# ${title}\n\n## Prompt\n\n${prompt}\n\n## Media\n\n${generated.url}\n`,
            ),
          );
          createdPaths.push(`keyframes/${imageId}.md`);
          registerManifestEntry({
            description: `Generated image: ${title}`,
            id: imageId,
            kind: "keyframe",
            mediaPath: localPath,
            mediaUrl: generated.url,
            path: `keyframes/${imageId}.md`,
            title,
          });
          toolCalls.push({ name: "generateImage", ok: true, summary: `Created image "${title}"` });
          return `Created image "${title}" (id: ${imageId}). It is now on the canvas.`;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Image generation failed.";
          toolCalls.push({ name: "generateImage", ok: false, summary: message });
          return `Failed: ${message}`;
        }
      },
    }),
    generateVideo: tool({
      description:
        "Generate a video clip (Seedance). Optional start_source_id (a manifest id) seeds the first frame from that artifact's pixels; optional end_source_id ALSO pins the final frame (first/last interpolation) — the tool for 'goes from image A to image B' and appear/transform beats. Without sources the clip is generated from text alone. The result appears on the canvas.",
      inputSchema: z.object({
        aspect_ratio: z.enum(ASPECT_RATIOS).default("16:9"),
        duration_seconds: z
          .number()
          .min(4)
          .max(15)
          .default(5)
          .describe("Whole seconds, MINIMUM 4, maximum 15 (hard model constraint — values under 4 are invalid and will be rejected). If the user asks for a shorter beat, generate 4-5s and trim in the editor."),
        group_id: z
          .string()
          .nullable()
          .default(null)
          .describe(
            "Optional group slug. Tiles sharing a group_id are arranged together as a row on the canvas (e.g. a shot sequence). Omit for one-off generations.",
          ),
        group_index: z.number().int().min(0).default(0).describe("Order within the group."),
        group_title: z.string().nullable().default(null),
        prompt: z
          .string()
          .describe("Full motion + visual description of the clip to create."),
        end_source_id: z
          .string()
          .nullable()
          .default(null)
          .describe(
            "Optional manifest id whose pixels pin the FINAL frame (first/last interpolation).",
          ),
        revises: z
          .string()
          .nullable()
          .default(null)
          .describe("Existing tile id to REDO: appends a new version to that tile (same id, same canvas position) instead of creating a sibling tile. ONLY for re-attempting the SAME creative intent (redo/fix/try-again of this exact artifact). NEVER for new content the user wants to keep alongside — another shot, a sequel, a continuation, a variation — those get a NEW tile even when an existing tile is focused; the focused tile is context, not the revision target."),
        start_source_id: z.string().nullable().default(null),
        title: z.string().describe("Short human title for the new clip."),
      }),
      execute: async ({ aspect_ratio, duration_seconds, end_source_id, group_id, group_index, group_title, prompt, revises, start_source_id, title }) => {
        try {
          const sources = resolveSources(start_source_id ? [start_source_id] : []);
          const imageUrl = sources.length ? await falImageUrlForEntry(sources[0]!) : null;
          const endSources = resolveSources(end_source_id ? [end_source_id] : []);
          const endImageUrl = endSources.length
            ? await falImageUrlForEntry(endSources[0]!)
            : null;
          const videoOp: BillableOp = {
            kind: "clip",
            tool: "composer.generateVideo",
            pinned: Boolean(imageUrl && endImageUrl),
            resolution: "720p",
            seconds: Math.round(duration_seconds),
          };
          await composerPreflight(user.userId, videoOp);
          const generated = await generateFalVideo({
            aspectRatio: aspect_ratio,
            duration: String(Math.round(duration_seconds)),
            endImageUrl,
            imageUrl,
            prompt,
          });
          if (!generated.ok || !generated.url) {
            throw new Error(generated.error || "Video generation failed.");
          }
          await composerSettle(user.userId, videoOp, id, { title, url: generated.url });
          if (revises) {
            const revision = await appendArtifactVersion(id, {
              id: revises.replace(/^@/, ""),
              kind: "clip",
              metaPatch: {
                duration_seconds: Math.round(duration_seconds),
                generated_seconds: Math.round(duration_seconds),
              },
              note: `Video revision.\n\nPrompt: ${prompt}\n\nStart: ${sources[0] ? `@${sources[0].id}` : "(text only)"}${endSources[0] ? ` · End: @${endSources[0].id}` : ""}`,
              url: generated.url,
            });
            if (!revision.ok) throw new Error(revision.error);
            await refreshTimeline(id);
            createdPaths.push(revision.path);
            toolCalls.push({
              name: "generateVideo",
              ok: true,
              summary: `Updated clip "${revises}" to v${revision.version}`,
            });
            return `Updated clip ${revises.replace(/^@/, "")} in place to version ${revision.version} — same tile, new pixels.`;
          }
          const clipId = `canvas_${slug(title)}_${Date.now().toString(36)}`;
          const assetId = `asset_${clipId}`;
          const localPath = await saveRemoteMedia(`media/clips/${clipId}.v1.mp4`, generated.url);
          await writeWorkspaceFile(
            id,
            `prompts/${assetId}.prompt.md`,
            withJsonFrontmatter(
              {
                clip_id: clipId,
                compiler: "canvas-composer",
                id: `prompt_${clipId}`,
                status: "active",
                type: "prompt",
              },
              prompt,
            ),
          );
          await writeWorkspaceFile(
            id,
            `assets/${assetId}.asset.md`,
            withJsonFrontmatter(
              {
                derived_from: [...sources, ...endSources].map((entry) => entry.id),
                id: assetId,
                kind: "video",
                local_path: localPath,
                status: "active",
                type: "asset",
                url: generated.url,
                used_in: [clipId],
              },
              `# ${title}\n\n${instruction}\n`,
            ),
          );
          await writeWorkspaceFile(
            id,
            `clips/${clipId}.md`,
            withJsonFrontmatter(
              {
                asset_id: assetId,
                aspect_ratio,
                canvas_composed: true,
                canvas_derived_from: sources[0]?.id ?? null,
                canvas_group: group_id,
                canvas_group_index: group_index,
                canvas_group_title: group_title ?? group_id,
                duration_seconds: Math.round(duration_seconds),
                generated_seconds: Math.round(duration_seconds),
                id: clipId,
                in_timeline: true,
                index: Date.now(),
                local_path: localPath,
                status: "active",
                type: "clip",
                url: generated.url,
                versions: [{ local_path: localPath, url: generated.url, version: 1 }],
              },
              `# ${title}\n\n## Request\n\n${instruction}\n\n## Prompt\n\n${prompt}\n\n## Media\n\n${generated.url}\n`,
            ),
          );
          await refreshTimeline(id);
          createdPaths.push(`clips/${clipId}.md`);
          registerManifestEntry({
            description: `Generated clip: ${title}`,
            id: clipId,
            kind: "clip",
            mediaPath: localPath,
            mediaUrl: generated.url,
            path: `clips/${clipId}.md`,
            title,
          });
          toolCalls.push({ name: "generateVideo", ok: true, summary: `Created clip "${title}"` });
          const lineageNote = unlinkedGenerationNote(
            buildLineageIndex(snapshot.files),
            sources.map((entry) => entry.id),
          );
          return `Created clip "${title}" (id: ${clipId}). It is now on the canvas.${lineageNote ? `\n\n${lineageNote}` : ""}`;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Video generation failed.";
          toolCalls.push({ name: "generateVideo", ok: false, summary: message });
          return `Failed: ${message}`;
        }
      },
    }),
  };

  const mentioned = mentionIds(instruction)
    .map((mentionId) => manifestById.get(mentionId))
    .filter((entry): entry is ManifestEntry => Boolean(entry));
  const mentionBlock = mentioned.length
    ? `\n\nExplicitly referenced by the user (binding — condition on these):\n${mentioned
        .map((entry) => `- ${entry.id} — "${entry.title}" — ${entry.description}`)
        .join("\n")}`
    : "";
  const focusBlock =
    focusList.length > 1
      ? `\n\nThe user STAGED these canvas tiles together (their images are attached below — treat ALL of them as binding sources unless the request says otherwise):\n${focusList
          .map((entry) => `- ${entry.id} ("${entry.title ?? entry.id}", ${entry.kind ?? "tile"})`)
          .join("\n")}`
      : focus?.id
        ? `\n\nThe user has this canvas tile focused (its image is attached below when available): ${focus.id} ("${focus.title ?? focus.id}", ${focus.kind ?? "tile"}). It is the DEFAULT EDIT TARGET: a modification-intent request ("make it...", "change...", "animate this", "recolor", "fix") edits THIS tile — revises=${focus.id} for a keyframe/image/clip, or reference.md + portfolio regen for a reference. Only mint a new tile if the request is clearly for new/additional content.`
        : "";

  /** Resolve a manifest entry to something the model can SEE: a still image
   * part (remote URL passthrough or workspace bytes as a data URL). Video
   * sources are skipped here — the tools extract frames when generating. */
  async function imageAttachmentForEntry(
    entry: ManifestEntry,
  ): Promise<{ image: string } | null> {
    const media =
      entry.kind === "reference" ? entry.mediaUrl : entry.mediaPath ?? entry.mediaUrl;
    if (!media) return null;
    if (entry.kind === "clip" || (entry.kind === "upload" && isVideoPath(media))) return null;
    if (/^https?:\/\//i.test(media)) return { image: media };
    try {
      const binary = await readWorkspaceBinaryFile(id, safeRelativePath(media));
      if (binary.content.byteLength > 20 * 1024 * 1024) return null;
      const mediaType = binary.contentType || contentTypeForPath(media);
      return { image: `data:${mediaType};base64,${binary.content.toString("base64")}` };
    } catch {
      return null;
    }
  }

  // Attach the staged tiles' pixels so titles never have to carry the meaning.
  const focusImageParts: Array<
    { type: "text"; text: string } | { type: "image"; image: string }
  > = [];
  for (const tile of focusList.slice(0, 4)) {
    const entry = tile.id ? manifestById.get(tile.id) : undefined;
    if (!entry) continue;
    const attachment = await imageAttachmentForEntry(entry);
    if (!attachment) continue;
    focusImageParts.push({ type: "text", text: `Attached image is ${entry.id} ("${entry.title}"):` });
    focusImageParts.push({ type: "image", image: attachment.image });
  }

  const system = [
    "You are the adaptive canvas agent for a video-creation workspace. The composer is an open intent surface, not a menu of predefined tasks.",
    OPEN_INTENT_ORCHESTRATION,
    workflowInventoryText(workflowSummaries),
    "For direct requests, act immediately with the fewest tool calls that satisfy the request. For a genuinely complex request with one strong workflow match, call loadWorkflow, follow only the useful parts, and continue creating in this run. Never stop at a plan or workflow recommendation.",
    "Resolve names against the PROJECT MANIFEST below. When the user names a person/place/thing that matches a reference, ALWAYS pass that reference's id in source_ids so identity is preserved. Uploads, keyframes and clips can also be sources.",
    "Requests phrased as edits of an existing artifact should seed from that artifact via source ids. Infer the OUTPUT TYPE from the request, never from the source type: appearance changes (\"make the jacket red\", \"turn this into night\") are generateImage edits even on a video source frame, while motion or action requests (\"make him wave\", \"have the car drive off\") are generateVideo even when the source is a still image.",
    "When a request implies a sequence (a storyboard, several shots or frames of one idea), make one generate call per tile and give them all the same group_id with increasing group_index — they will be laid out as a row on the canvas. One-off generations get no group.",
    "EXPANDING AN EXISTING SHOT (new characters/action in a scene the user already has): anchor on the existing clip's PIXELS, not on loose references. Recipe: (1) extractFrame a representative frame from the existing clip — that IS the scene (set, light, how subjects actually render); (2) if the request adds a subject that doesn't exist in pixels yet (a new character, outfit, object), composite it into that frame with generateImage first; (3) generate the video FROM those anchors (start frame or reference images = the extracted/composited frames); (4) as a NEW tile. Character portfolios alone preserve identity but NOT the scene — using only them makes the world drift, which users read as 'you didn't continue from my clip'.",
    "REAL PEOPLE: characters based on real-life people need a real picture as reference (a photo in the manifest, via source_ids/reference_ids). If none exists, say the main chat can fetch one first, and stop. Imaginary characters: invent freely, no pictures needed.",
    "SEEDANCE PROMPT STYLE: video prompts are declarative descriptions of what is ON SCREEN over time — never meta-instructions (no 'use X as reference'/'create a'/'keep the style'; weave tags naturally: 'In the style of @Image1, ...' / '@Video1 continues: ...'). Concrete subjects doing concrete actions with energetic physical verbs — never abstract energy words ('dynamic movement', 'sharp cuts') or unrenderable concepts ('continuity', 'broadcast geography'). ONE camera move per shot. Internal cuts each get their own described shot ('Cut to: ...'). Style constants as visual facts; negatives at the end.",
    "SEEDANCE @ TAGS: reference-to-video prompts address their attachments as @Image1..@ImageN and @Video1..@VideoN (in reference_ids order). Use them explicitly in the prompt to bind subjects and footage — e.g. '@Video1 continues seamlessly; the chicken from @Image1 walks into frame'. These are the ONLY tag forms Seedance understands; never invent bracket tags. For CHARACTERS, bind each name to its tag on first mention — 'Salah (@Image1) presses forward as Messi (@Image2) closes in' — then use the name alone.",
    "ENDPOINT RULE: when the request supplies a BEFORE and an AFTER image ('from these two images', 'goes from A to B', an appear/transform beat between two frames), that is FIRST/LAST interpolation — generateVideo with start_source_id = the before frame and end_source_id = the after frame. generateVideoFromReferences is ONLY for putting subjects into brand-new footage; it cannot pin frames and must never be used for endpoint pairs.",
    "GROUP DISCIPLINE: do NOT create a new group per artifact. Only set group_id when (a) the user names a group, (b) you are adding to an existing group listed in CANVAS GROUPS, or (c) one request explicitly asks for a multi-part sequence. A single one-off clip or image gets NO group.",
    "VERSION vs NEW TILE: decide by the user's intent toward the FOCUSED tile. If the instruction is an EDIT of the focused tile — change/adjust/fix/recolor/restyle/add-to/animate 'this' — pass revises: <the focused tile id> so it updates in place as a new version (for a character/location/object/style REFERENCE, instead patch its reference.md and regenerate the portfolio — same tile). If the instruction asks for NEW or ADDITIONAL content the user wants alongside what exists — another shot, a sequel, a continuation, a distinctly different subject, 'also make…', 'a new…' — mint a NEW tile (never revise). The focused tile is the default EDIT target for modification requests; it is only a context/reference source when the request is clearly for new content. Minting a fresh id for a redo/edit of the focused tile is an error.",
    "SCOPE DISCIPLINE: produce the complete scope the user asked for, whether that is one artifact or a coordinated set. Never add unrequested 'extended', 'alternate', or bonus variants; complexity should come from fulfilling the request, not inventing extra deliverables.",
    "extractFrame pulls a still out of any video source at a timestamp; extractShots splits a video into its shots (each becomes a grouped clip tile). Prefer these over generation when the user wants material FROM existing footage.",
    "generateVideoFromReferences makes video DIRECTLY from reference images (characters/places/things in the manifest) — the primary way to put existing subjects into new footage. generateSpeech (TTS) and generateMusic create audio tiles.",
    "If the manifest lacks detail, you may use readFile/listFiles once — but never browse broadly.",
    "When done, briefly describe what was created and any material assumption you made. Do not expose internal workflow or mode names unless the user asks.",
  ].join("\n\n");

  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text" as const,
          text: [
            (() => {
              const workingAspect = dominantAspectRatio(snapshot.files);
              return workingAspect
                ? `WORKING ASPECT RATIO: ${workingAspect} — pass aspect_ratio: "${workingAspect}" on EVERY generation unless the user explicitly asks for a different ratio. Do not choose a ratio yourself.`
                : "";
            })(),
            `PROJECT MANIFEST:\n${manifestText(manifest)}`,
            userGroupsText(snapshot),
            `RECENT ACTIVITY:\n${recentActivityText(snapshot)}`,
            `REQUEST:${focusBlock}${mentionBlock}\n\n${instruction}`,
          ].join("\n\n---\n\n"),
        },
        ...focusImageParts,
      ],
    },
  ];

  // Desktop/local mode: the prompt box always talks to the user's Claude Code
  // or Codex CLI — never OpenRouter. The CLI runs headless from the project
  // directory, so the desktop hooks inject the live canvas context and every
  // action lands through the same video-fs MCP tools the terminal agent uses.
  if (isLocalAppMode(process.env)) {
    const { projectDirectory } = await ensureAgentContextRoot(id);
    const workingAspect = dominantAspectRatio(snapshot.files);
    const cliPrompt = [
      "You are acting as this project's adaptive creation agent. Execute the user's outcome through the video-fs MCP tools — never hand-author what a tool can produce.",
      OPEN_INTENT_ORCHESTRATION,
      workflowInventoryText(workflowSummaries),
      "For a complex request with one strong workflow match, call load_workflow before planning, adapt the returned recipe, and continue executing. For direct asks, skip workflows and create immediately.",
      workingAspect
        ? `WORKING ASPECT RATIO: ${workingAspect} — pass aspect_ratio: "${workingAspect}" on every generation unless the user explicitly asks for a different ratio.`
        : "",
      `REQUEST:${focusBlock}${mentionBlock}\n\n${instruction}`,
      "When done, briefly describe what was created. Do not expose internal workflow or mode names unless the user asks.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const beforePaths = new Set(snapshot.files.map((file) => file.path));
    const localEncoder = new TextEncoder();
    const localStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: Record<string, unknown>) => {
          try {
            controller.enqueue(localEncoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            // Client went away; keep executing so the work still lands.
          }
        };
        const runLog: Array<Record<string, unknown>> = [
          {
            at: new Date().toISOString(),
            instruction,
            type: "composer_request",
            via: "local-cli",
          },
        ];
        try {
          const result = await runCliComposer({
            cwd: projectDirectory,
            onEvent: (event) => {
              runLog.push({ at: new Date().toISOString(), ...event });
              emit(event);
            },
            prompt: cliPrompt,
          });
          const reply =
            result.text || "Done — the result is on the canvas.";
          await appendChat(id, { role: "assistant", text: reply });
          const nextSnapshot = await getProjectSnapshot(id, user.userId);
          const createdPaths = nextSnapshot.files
            .map((file) => file.path)
            .filter(
              (filePath) =>
                !beforePaths.has(filePath) &&
                filePath.endsWith(".md") &&
                !filePath.startsWith("runs/") &&
                !filePath.startsWith("prompts/"),
            );
          runLog.push({
            agent: result.agent,
            at: new Date().toISOString(),
            createdPaths,
            type: "result",
          });
          emit({ type: "final", createdPaths, snapshot: nextSnapshot });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Canvas composer failed.";
          runLog.push({ at: new Date().toISOString(), message, type: "error" });
          await appendChat(id, {
            role: "assistant",
            text: `Canvas task failed: ${message}`,
          }).catch(() => {});
          emit({ type: "error", message });
        } finally {
          await writeWorkspaceFile(
            id,
            `runs/composer_${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
            runLog.map((entry) => JSON.stringify(entry)).join("\n"),
          ).catch(() => {});
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
    });
    return new Response(localStream, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8" },
    });
  }

  // Stream ndjson so the canvas can show a placeholder immediately and morph
  // it to the right aspect ratio the moment the model commits to a tool call.
  const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // Client went away; keep executing so the work still lands.
        }
      };
      // Full audit log (mirrors chat runs): every tool call WITH inputs and
      // every result, written to runs/ so post-hoc "what did it actually
      // use?" questions are answerable.
      const runLog: Array<Record<string, unknown>> = [
        { at: new Date().toISOString(), instruction, type: "composer_request" },
      ];
      try {
        const result = streamText({
          model: openrouter.chat(MODEL_ID),
          system,
          messages,
          tools,
          stopWhen: stepCountIs(MAX_TOOL_STEPS),
        });
        for await (const part of result.fullStream) {
          if (part.type === "tool-call") {
            const input =
              part.input && typeof part.input === "object"
                ? (part.input as Record<string, unknown>)
                : {};
            runLog.push({
              at: new Date().toISOString(),
              input: part.input,
              toolName: part.toolName,
              type: "tool_call",
            });
            emit({
              type: "tool_start",
              toolName: part.toolName,
              aspectRatio:
                typeof input.aspect_ratio === "string" ? input.aspect_ratio : null,
              revises: typeof input.revises === "string" ? input.revises : null,
              title: typeof input.title === "string" ? input.title : null,
            });
          } else if (part.type === "tool-result") {
            runLog.push({
              at: new Date().toISOString(),
              output:
                typeof part.output === "string"
                  ? part.output.slice(0, 2000)
                  : part.output,
              toolName: part.toolName,
              type: "tool_result",
            });
            emit({ type: "tool_end", toolName: part.toolName });
          }
        }
        const text = (await result.text).trim();
        // The chat card mines @mentions for its artifact stack — make sure
        // every created artifact is named even if the prose skipped it.
        const artifactIds = createdPaths
          .map((createdPath) => createdPath.split("/").pop()?.replace(/\.md$/, ""))
          .filter((artifactId): artifactId is string => Boolean(artifactId));
        const unmentioned = artifactIds.filter((artifactId) => !text.includes(`@${artifactId}`));
        const reply =
          (text ||
            (createdPaths.length
              ? "Done — the result is on the canvas."
              : "I could not complete that request.")) +
          (unmentioned.length ? `\n\n${unmentioned.map((id) => `@${id}`).join(" ")}` : "");
        await appendChat(id, {
          role: "assistant",
          text: reply,
          tools: toolCalls.length ? toolCalls : undefined,
        });
        const nextSnapshot = await getProjectSnapshot(id, user.userId);
        emit({ type: "final", createdPaths, snapshot: nextSnapshot });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Canvas composer failed.";
        runLog.push({ at: new Date().toISOString(), message, type: "error" });
        await appendChat(id, {
          role: "assistant",
          text: `Canvas task failed: ${message}`,
          tools: toolCalls.length ? toolCalls : undefined,
        }).catch(() => {});
        emit({ type: "error", message });
      } finally {
        await writeWorkspaceFile(
          id,
          `runs/composer_${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
          runLog.map((entry) => JSON.stringify(entry)).join("\n"),
        ).catch(() => {});
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
}
