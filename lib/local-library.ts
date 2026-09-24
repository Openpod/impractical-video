import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isLocalAppMode } from "@/lib/app-mode";
import type { PublishedItemDetail } from "@/lib/published-items";

export const LOCAL_LIBRARY_PREFIX = "local:library:";
export const LIBRARY_UPLOAD_LIMIT = 100 * 1024 * 1024;
type Asset = { id: string; title: string; filename: string; mime: string; kind: "image" | "video" | "audio" | "document"; bytes: number; createdAt: string };

export class LocalLibraryError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function root() {
  if (!isLocalAppMode()) throw new LocalLibraryError("Local library unavailable.", 404);
  const projects = process.env.VIDEO_FS_DATA_ROOT?.trim() || path.join(process.cwd(), "data", "projects");
  return path.join(path.dirname(projects), "library", "uploads");
}

function assetDirectory(id: string) {
  if (!/^local:library:[a-f0-9-]{36}$/.test(id)) throw new LocalLibraryError("Library asset not found.", 404);
  return path.join(root(), id.slice(LOCAL_LIBRARY_PREFIX.length));
}

function fileMime(file: File) {
  const known: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", aac: "audio/aac", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", pdf: "application/pdf", txt: "text/plain", md: "text/plain", zip: "application/zip" };
  const supplied = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.type) ? file.type : "";
  return supplied && supplied !== "application/octet-stream" ? supplied : known[path.extname(file.name).slice(1).toLowerCase()] || "application/octet-stream";
}

async function readAsset(id: string): Promise<Asset> {
  const directory = assetDirectory(id);
  try {
    const asset = JSON.parse(await readFile(path.join(directory, "metadata.json"), "utf8")) as Asset;
    if (asset.id !== id || typeof asset.filename !== "string" || typeof asset.title !== "string" || typeof asset.mime !== "string" || typeof asset.createdAt !== "string" || !["image", "video", "audio", "document"].includes(asset.kind)) throw new Error("Invalid asset");
    return asset;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LocalLibraryError("Library asset not found.", 404);
    throw new LocalLibraryError("Could not read this library asset.", 500);
  }
}

function detail(asset: Asset): PublishedItemDetail {
  const url = `/api/library/assets/${encodeURIComponent(asset.id)}`;
  const visual = asset.kind === "image" || asset.kind === "video";
  return {
    id: asset.id, title: asset.title, kind: asset.kind, createdAt: asset.createdAt,
    description: `Uploaded file · ${asset.filename}`, featuredRank: null,
    isLiked: false, libraryStatus: "saved", likeCount: 0, useCount: 0, viewCount: 0,
    posterHeight: null, posterWidth: null, posterMediaKind: visual ? asset.kind : null,
    posterOrientation: asset.kind === "video" ? "landscape" : "square",
    posterUrl: visual ? url : null, previewVideoUrl: asset.kind === "video" ? url : null,
    publisher: null, sourceEntryId: null, sourceNodeId: null, sourceProjectId: null,
    visibility: "private", tags: ["local", "upload"], files: [],
    metadata: { local: true, upload: true, original_filename: asset.filename, bytes: asset.bytes, media_kind: asset.kind },
    media: [{ id: `${asset.id}:file`, kind: asset.kind === "document" ? "other" : asset.kind, url, mimeType: asset.mime, role: visual ? "display" : "asset", durationS: null, height: null, width: null, nodeId: null }],
  };
}

export async function listLocalLibraryUploads() {
  let entries;
  try { entries = await readdir(root(), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const assets = await Promise.all(entries.filter(entry => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name)).map(entry => getLocalLibraryUpload(`${LOCAL_LIBRARY_PREFIX}${entry.name}`).catch(() => null)));
  return assets.filter((asset): asset is PublishedItemDetail => asset !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getLocalLibraryUpload(id: string) { return detail(await readAsset(id)); }

export async function uploadLocalLibraryFiles(files: File[]) {
  if (!files.length) throw new LocalLibraryError("Choose at least one file.");
  if (files.some(file => file.size > LIBRARY_UPLOAD_LIMIT)) throw new LocalLibraryError("Each file must be 100 MB or smaller.", 413);
  if (files.length > 50 || files.reduce((sum, file) => sum + file.size, 0) > LIBRARY_UPLOAD_LIMIT) throw new LocalLibraryError("Upload up to 100 MB at a time.", 413);
  await mkdir(root(), { recursive: true, mode: 0o700 });
  const createdIds: string[] = [];
  try {
    for (const file of files) {
      const uuid = randomUUID();
      const id = `${LOCAL_LIBRARY_PREFIX}${uuid}`;
      const temporary = path.join(root(), `.upload-${uuid}`);
      const mime = fileMime(file);
      const kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "document";
      const filename = file.name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) || "Untitled file";
      const asset: Asset = { id, filename, title: filename, mime, kind, bytes: file.size, createdAt: new Date().toISOString() };
      await mkdir(temporary, { mode: 0o700 });
      try {
        await writeFile(path.join(temporary, "file"), Buffer.from(await file.arrayBuffer()), { mode: 0o600, flag: "wx" });
        await writeFile(path.join(temporary, "metadata.json"), JSON.stringify(asset), { mode: 0o600, flag: "wx" });
        await rename(temporary, assetDirectory(id));
        createdIds.push(id);
      } finally { await rm(temporary, { force: true, recursive: true }); }
    }
    return createdIds;
  } catch (error) {
    await Promise.all(createdIds.map(id => rm(assetDirectory(id), { force: true, recursive: true })));
    throw error;
  }
}

export async function localLibraryFile(id: string) {
  const asset = await readAsset(id);
  const absolutePath = path.join(assetDirectory(id), "file");
  const info = await stat(absolutePath);
  return { ...asset, absolutePath, bytes: info.size };
}

export async function renameLocalLibraryUpload(id: string, title: string) {
  if (!title.trim() || title.length > 255) throw new LocalLibraryError("Enter a name of up to 255 characters.");
  const asset = await readAsset(id);
  const directory = assetDirectory(id);
  const temporary = path.join(directory, `metadata.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ ...asset, title: title.trim() }), { mode: 0o600, flag: "wx" });
    await rename(temporary, path.join(directory, "metadata.json"));
  } finally { await rm(temporary, { force: true }); }
  return getLocalLibraryUpload(id);
}

export async function deleteLocalLibraryUpload(id: string) {
  await readAsset(id);
  const trash = path.join(path.dirname(root()), "trash");
  await mkdir(trash, { recursive: true, mode: 0o700 });
  await rename(assetDirectory(id), path.join(trash, `${id.slice(LOCAL_LIBRARY_PREFIX.length)}-${randomUUID()}`));
}
