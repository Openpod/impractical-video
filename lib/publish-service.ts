import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isLocalAppMode } from "@/lib/app-mode";
import { localLibraryFile, LOCAL_LIBRARY_PREFIX } from "@/lib/local-library";
import { cleanExplorePromptNullable } from "@/lib/explore-prompt-cleanup";
import { extractDocumentText } from "@/lib/extract-document-text";
import { createServerClient } from "@/lib/supabase";
import {
  readProjectMeta,
  listProjectFiles,
  readWorkspaceFile,
  readWorkspaceBinaryFile,
  writeWorkspaceFile,
  writeWorkspaceBinaryFile,
  withJsonFrontmatter,
} from "@/lib/workspace";
import { imageSize } from "@/lib/image-size";

/**
 * Publish + import service for the Explore library. A published item is an
 * immutable snapshot of a source-graph slice (a character or environment, for
 * v1). The slice is purely path-prefix based — `references/<category>/<id>/` —
 * which maps exactly to the filesystem/source-graph model, so no graph
 * traversal is needed. Read/write reuse the workspace adapter, so files land in
 * project_files and bytes in the project-media bucket automatically.
 */

const PUBLISHED_MEDIA_BUCKET = "published-media";

const CATEGORY_FOR_KIND: Record<string, string> = {
  character: "characters",
  environment: "environments",
  object: "props",
  prop: "props",
  style: "styles",
};

const MEDIA_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif",
  ".mp4", ".mov", ".webm", ".mp3", ".wav", ".m4a",
]);

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot).toLowerCase() : "";
}

function mediaKindForPath(path: string): "image" | "video" | "audio" | "other" {
  const ext = extOf(path);
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".webm"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".m4a"].includes(ext)) return "audio";
  return "other";
}

function mimeForPath(path: string): string {
  const ext = extOf(path);
  const map: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4",
    ".mov": "video/quicktime", ".webm": "video/webm", ".mp3": "audio/mpeg",
    ".wav": "audio/wav", ".m4a": "audio/mp4",
  };
  return map[ext] ?? "application/octet-stream";
}

function isMediaPath(path: string): boolean {
  return MEDIA_EXTENSIONS.has(extOf(path));
}

function parseFrontmatter(content: string | undefined): Record<string, unknown> | null {
  if (!content || !content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  try {
    return JSON.parse(content.slice(content.indexOf("\n") + 1, end)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function workspaceMediaPathFromUrl(projectId: string, value: string): string | null {
  if (value.startsWith("media/")) return value;
  if (!value.startsWith("/")) return null;
  try {
    const url = new URL(value, "http://workspace.local");
    const prefix = `/api/projects/${encodeURIComponent(projectId)}/media/`;
    if (!url.pathname.startsWith(prefix)) return null;
    const relative = url.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
    return relative ? `media/${relative}` : null;
  } catch {
    return null;
  }
}

function portfolioUrlsFromSlice(files: { content?: string; path: string }[]) {
  return files.flatMap((file) => {
    if (!file.path.endsWith("/portfolio.md")) return [];
    return stringArray(parseFrontmatter(file.content)?.urls);
  });
}

/**
 * Snapshot a character/environment from a source project into an immutable
 * published item. Returns the new published item id.
 */
export async function publishItem(input: {
  sourceProjectId: string;
  kind: "character" | "environment" | "prop" | "style";
  sourceNodeId: string; // the reference id, == directory under references/<category>/
  publisherId: string;
  title: string;
  description?: string | null;
  tags?: string[];
  visibility?: "draft" | "unlisted" | "public" | "featured";
}): Promise<{ itemId: string; fileCount: number; mediaCount: number }> {
  const category = CATEGORY_FOR_KIND[input.kind];
  if (!category) throw new Error(`Unsupported publish kind "${input.kind}".`);
  const prefix = `references/${category}/${input.sourceNodeId}/`;

  const allFiles = await listProjectFiles(input.sourceProjectId, true);
  const slice = allFiles.filter((file) => file.path.startsWith(prefix));
  if (slice.length === 0) {
    throw new Error(
      `Nothing to publish: no files under "${prefix}" in the source project.`,
    );
  }

  const supabase = createServerClient();
  const itemId = randomUUID();
  const description = cleanExplorePromptNullable(input.description);
  const { error: itemError } = await supabase.from("published_items").insert({
    id: itemId,
    kind: input.kind,
    publisher_id: input.publisherId,
    source_project_id: null, // snapshot is independent; keep linkage out of v1 to avoid FK on legacy ids
    source_node_id: input.sourceNodeId,
    title: input.title,
    description,
    visibility: input.visibility ?? "draft",
    tags: input.tags ?? [],
  });
  if (itemError) throw new Error(`Failed to create published item: ${itemError.message}`);

  let fileCount = 0;
  let mediaCount = 0;
  let posterAssigned = false;
  const publishedMediaSources = new Set<string>();

  for (const file of slice) {
    if (isMediaPath(file.path)) {
      const { content } = await readWorkspaceBinaryFile(input.sourceProjectId, file.path);
      const storagePath = `${itemId}/${file.path}`;
      const { error: upErr } = await supabase.storage
        .from(PUBLISHED_MEDIA_BUCKET)
        .upload(storagePath, content, { contentType: mimeForPath(file.path), upsert: true });
      if (upErr) throw new Error(`Failed to upload published media: ${upErr.message}`);
      const kind = mediaKindForPath(file.path);
      const role = !posterAssigned && kind === "image" ? "poster" : "asset";
      if (role === "poster") posterAssigned = true;
      // Probe intrinsic dimensions for images so the Explore masonry can
      // classify orientation before paint. Video dims await clip publishing.
      const dims = kind === "image" ? imageSize(content) : null;
      const { error: medErr } = await supabase.from("published_item_media").insert({
        item_id: itemId,
        role,
        kind,
        storage_path: storagePath,
        node_id: input.sourceNodeId,
        mime_type: mimeForPath(file.path),
        bytes: content.byteLength,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
      });
      if (medErr) throw new Error(`Failed to record published media: ${medErr.message}`);
      publishedMediaSources.add(`workspace:${file.path}`);
      mediaCount += 1;
    } else {
      const content = await readWorkspaceFile(input.sourceProjectId, file.path);
      const { error: fErr } = await supabase
        .from("published_item_files")
        .insert({ item_id: itemId, path: file.path, content });
      if (fErr) throw new Error(`Failed to record published file: ${fErr.message}`);
      fileCount += 1;
    }
  }

  for (const url of portfolioUrlsFromSlice(slice)) {
    const workspaceMediaPath = workspaceMediaPathFromUrl(input.sourceProjectId, url);
    if (workspaceMediaPath && !publishedMediaSources.has(`workspace:${workspaceMediaPath}`)) {
      const { content, contentType } = await readWorkspaceBinaryFile(input.sourceProjectId, workspaceMediaPath);
      const storagePath = `${itemId}/${workspaceMediaPath}`;
      const { error: upErr } = await supabase.storage
        .from(PUBLISHED_MEDIA_BUCKET)
        .upload(storagePath, content, { contentType, upsert: true });
      if (upErr) throw new Error(`Failed to upload published portfolio media: ${upErr.message}`);
      const kind = mediaKindForPath(workspaceMediaPath);
      const role = !posterAssigned && kind === "image" ? "poster" : "asset";
      if (role === "poster") posterAssigned = true;
      const dims = kind === "image" ? imageSize(content) : null;
      const { error: medErr } = await supabase.from("published_item_media").insert({
        item_id: itemId,
        role,
        kind,
        storage_path: storagePath,
        node_id: input.sourceNodeId,
        mime_type: contentType,
        bytes: content.byteLength,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
      });
      if (medErr) throw new Error(`Failed to record published portfolio media: ${medErr.message}`);
      publishedMediaSources.add(`workspace:${workspaceMediaPath}`);
      mediaCount += 1;
    } else if (!workspaceMediaPath && !publishedMediaSources.has(`url:${url}`)) {
      const role = !posterAssigned ? "poster" : "asset";
      posterAssigned = true;
      const { error: medErr } = await supabase.from("published_item_media").insert({
        item_id: itemId,
        role,
        kind: "image",
        url,
        node_id: input.sourceNodeId,
        mime_type: null,
      });
      if (medErr) throw new Error(`Failed to record published portfolio URL: ${medErr.message}`);
      publishedMediaSources.add(`url:${url}`);
      mediaCount += 1;
    }
  }

  return { itemId, fileCount, mediaCount };
}

/**
 * Import ("Use in project") a published item into a target project. Copies the
 * bundle's files + media into the target's project_files / project-media,
 * remapping the reference id if it would collide with an existing one, then
 * records a `use` interaction (which bumps use_count via DB trigger).
 */
export async function importItemIntoProject(input: {
  itemId: string;
  targetProjectId: string;
  userId: string;
}): Promise<{ importedRefId: string; fileCount: number; mediaCount: number }> {
  if (isLocalAppMode() && input.itemId.startsWith(LOCAL_LIBRARY_PREFIX)) {
    await readProjectMeta(input.targetProjectId, input.userId);
    const asset = await localLibraryFile(input.itemId);
    const uploadId = `upload_${randomUUID().replaceAll("-", "")}`;
    const filename = safeDocumentFileName(asset.filename);
    const buffer = await readFile(asset.absolutePath);
    if (asset.kind === "document") {
      const directory = `documents/${uploadId}`;
      await writeWorkspaceBinaryFile(input.targetProjectId, `${directory}/original-${filename}`, buffer);
      const text = await extractDocumentText(buffer, filename, asset.mime).catch(() => null);
      await writeWorkspaceFile(input.targetProjectId, `${directory}/content.md`, withJsonFrontmatter({ type: "document", original_name: asset.filename, local_path: `${directory}/original-${filename}`, source: "library" }, `# ${asset.title}\n\n${text?.slice(0, 500_000) || "Original file is stored alongside this record."}\n`));
    } else {
      const mediaPath = `media/uploads/${uploadId}-${filename}`;
      await writeWorkspaceBinaryFile(input.targetProjectId, mediaPath, buffer);
      await writeWorkspaceFile(input.targetProjectId, `uploads/${uploadId}.md`, withJsonFrontmatter({ id: uploadId, type: "upload", kind: asset.kind, content_type: asset.mime, local_path: mediaPath, original_name: asset.filename, status: "active", source: "library" }, `# ${asset.title}\n\nImported from your library.\n`));
    }
    return { importedRefId: uploadId, fileCount: 1, mediaCount: 1 };
  }
  const supabase = createServerClient();

  // Ownership: never let a caller write into a project they don't own.
  await readProjectMeta(input.targetProjectId, input.userId);

  const { data: item, error: itemErr } = await supabase
    .from("published_items")
    .select("id,kind,title,publisher_id,metadata,source_node_id,visibility")
    .eq("id", input.itemId)
    .in("visibility", ["public", "featured", "unlisted", "draft"])
    .maybeSingle();
  if (itemErr) throw new Error(`Failed to read published item: ${itemErr.message}`);
  if (!item) throw new Error("Published item not found or not importable.");
  // Private drafts (e.g. your own uploads) are only importable by their owner.
  if (item.visibility === "draft" && (item.publisher_id as string) !== input.userId) {
    throw new Error("Published item not found or not importable.");
  }

  const metadata = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
    ? item.metadata as Record<string, unknown>
    : {};
  const metadataCategory = typeof metadata.reference_category === "string" ? metadata.reference_category : null;
  const category = metadataCategory ?? CATEGORY_FOR_KIND[item.kind as string];
  if (!category) {
    // Uploaded files (PDFs, scripts, images, …) aren't structured references —
    // import them as readable documents so the project agent can use them.
    return importFileItemIntoProject({
      supabase,
      item: { id: item.id as string, kind: item.kind as string, title: (item.title as string) ?? null },
      metadata,
      targetProjectId: input.targetProjectId,
      userId: input.userId,
    });
  }
  const origRefId = item.source_node_id as string;
  const origPrefix = `references/${category}/${origRefId}/`;

  // Collision check against the target project's existing tree.
  const existing = await listProjectFiles(input.targetProjectId, false);
  const collides = existing.some((f) => f.path.startsWith(origPrefix));
  const importedRefId = collides ? `${origRefId}-${randomUUID().slice(0, 6)}` : origRefId;
  const newPrefix = `references/${category}/${importedRefId}/`;
  const remap = (p: string) => (p.startsWith(origPrefix) ? newPrefix + p.slice(origPrefix.length) : p);

  const [{ data: files, error: fErr }, { data: media, error: mErr }] = await Promise.all([
    supabase.from("published_item_files").select("path,content").eq("item_id", input.itemId),
    supabase.from("published_item_media").select("storage_path").eq("item_id", input.itemId),
  ]);
  if (fErr) throw new Error(`Failed to read published files: ${fErr.message}`);
  if (mErr) throw new Error(`Failed to read published media: ${mErr.message}`);

  let fileCount = 0;
  for (const f of (files ?? []) as Array<{ path: string; content: string }>) {
    // Rewrite the reference id inside frontmatter when we remapped the dir.
    const content =
      importedRefId === origRefId
        ? f.content
        : f.content.replaceAll(`"${origRefId}"`, `"${importedRefId}"`);
    await writeWorkspaceFile(input.targetProjectId, remap(f.path), content);
    fileCount += 1;
  }

  let mediaCount = 0;
  for (const m of (media ?? []) as Array<{ storage_path: string | null }>) {
    if (!m.storage_path) continue;
    const { data, error } = await supabase.storage
      .from(PUBLISHED_MEDIA_BUCKET)
      .download(m.storage_path);
    if (error) throw new Error(`Failed to download published media: ${error.message}`);
    const buffer = Buffer.from(await data.arrayBuffer());
    // storage_path is `${itemId}/${projectRelativePath}` — strip the item id.
    const rel = m.storage_path.slice(m.storage_path.indexOf("/") + 1);
    await writeWorkspaceBinaryFile(input.targetProjectId, remap(rel), buffer);
    mediaCount += 1;
  }

  const { error: useErr } = await supabase.from("published_item_interactions").insert({
    item_id: input.itemId,
    user_id: input.userId,
    kind: "use",
    target_project_id: null, // target uses legacy/uuid id; keep FK-safe by not constraining here
  });
  if (useErr) throw new Error(`Failed to record use: ${useErr.message}`);

  return { importedRefId, fileCount, mediaCount };
}

function slugForDocument(value: string) {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function safeDocumentFileName(name: string) {
  return (
    name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "file"
  );
}

/**
 * Import an uploaded file (PDF, script, image, …) into a project. Keeps the raw
 * bytes AND, when the file is text-extractable, writes a readable `content.md`
 * node so the project agent can read its contents via the workspace index.
 */
async function importFileItemIntoProject(input: {
  item: { id: string; kind: string; title: string | null };
  metadata: Record<string, unknown>;
  supabase: ReturnType<typeof createServerClient>;
  targetProjectId: string;
  userId: string;
}): Promise<{ importedRefId: string; fileCount: number; mediaCount: number }> {
  const { item, metadata, supabase, targetProjectId, userId } = input;
  const { data: media, error } = await supabase
    .from("published_item_media")
    .select("storage_path,mime_type,kind")
    .eq("item_id", item.id);
  if (error) throw new Error(`Failed to read published media: ${error.message}`);
  if (!media?.length) throw new Error("This item has no file to import.");

  const originalName =
    (typeof metadata.original_filename === "string" && metadata.original_filename) ||
    item.title ||
    `${item.kind}-${item.id.slice(0, 6)}`;
  const slug = slugForDocument(originalName) || item.id.slice(0, 8);
  const dir = `documents/${slug}/`;

  let fileCount = 0;
  let mediaCount = 0;
  for (const m of media as Array<{ kind: string | null; mime_type: string | null; storage_path: string | null }>) {
    if (!m.storage_path) continue;
    const { data, error: dErr } = await supabase.storage.from(PUBLISHED_MEDIA_BUCKET).download(m.storage_path);
    if (dErr) throw new Error(`Failed to download published media: ${dErr.message}`);
    const buffer = Buffer.from(await data.arrayBuffer());
    const fileName = safeDocumentFileName(originalName);

    // Keep the raw bytes available in the project.
    await writeWorkspaceBinaryFile(targetProjectId, `${dir}${fileName}`, buffer);
    mediaCount += 1;

    // Extract text so the agent can READ it (PDF/script/etc.), not just see a binary.
    const text = await extractDocumentText(buffer, fileName, m.mime_type ?? "");
    if (text && text.trim()) {
      const body = [
        "---",
        "type: document",
        "source: upload",
        `filename: ${originalName.replace(/\n/g, " ")}`,
        "role: reference",
        "---",
        "",
        `# ${originalName}`,
        "",
        text.trim().slice(0, 500_000),
        "",
      ].join("\n");
      await writeWorkspaceFile(targetProjectId, `${dir}content.md`, body);
      fileCount += 1;
    }
  }

  await supabase.from("published_item_interactions").insert({
    item_id: item.id,
    user_id: userId,
    kind: "use",
    target_project_id: null,
  });

  return { importedRefId: slug, fileCount, mediaCount };
}
