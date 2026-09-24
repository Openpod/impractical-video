import path from "node:path";
import { createServerClient } from "@/lib/supabase";

/**
 * Focused media resolver for `ai_video_entries` rows (the Explore / rendered
 * video library). Kept separate from `lib/published-items.ts` so the isolated
 * video-portfolio pipeline can pull a playable URL for a DB video without
 * dragging in publish/Explore presentation logic.
 *
 * Resolution mirrors the private `signedAiVideoUrl` helper in
 * `lib/published-items.ts`: prefer a short-lived signed URL for stored bucket
 * objects, otherwise fall back to the original (external) URL.
 */

const SIGNED_URL_TTL_SECONDS = 60 * 60;

type AiVideoEntryMediaRow = {
  id: string;
  title: string | null;
  bucket_name: string | null;
  storage_path: string | null;
  storage_status: string | null;
  original_video_url: string | null;
  content_type: string | null;
};

export type ResolvedAiVideoEntry = {
  id: string;
  title: string | null;
  url: string;
  /** File extension (with leading dot) inferred from storage path / mime. */
  ext: string;
};

function extFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  switch (type) {
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "video/webm":
      return ".webm";
    case "video/x-m4v":
      return ".m4v";
    default:
      return null;
  }
}

function extFromUrlOrPath(value: string | null): string | null {
  if (!value) return null;
  try {
    const pathname = value.startsWith("http") ? new URL(value).pathname : value;
    const ext = path.extname(pathname).toLowerCase();
    return ext && ext.length <= 5 ? ext : null;
  } catch {
    const ext = path.extname(value).toLowerCase();
    return ext && ext.length <= 5 ? ext : null;
  }
}

/**
 * Resolve an `ai_video_entries` id into a playable URL plus a sensible file
 * extension for temp-file naming. Throws with a clear message if the row is
 * missing or has no reachable media.
 */
export async function resolveAiVideoEntryMedia(entryId: string): Promise<ResolvedAiVideoEntry> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("ai_video_entries")
    .select("id,title,bucket_name,storage_path,storage_status,original_video_url,content_type")
    .eq("id", entryId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read ai_video_entries row ${entryId}: ${error.message}`);
  if (!data) throw new Error(`No ai_video_entries row found for id ${entryId}.`);

  const row = data as AiVideoEntryMediaRow;

  let url: string | null = null;
  if (row.bucket_name && row.storage_path && row.storage_status === "stored") {
    const { data: signed, error: signError } = await supabase.storage
      .from(row.bucket_name)
      .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
    if (signError) {
      throw new Error(`Failed to sign ai_video_entries media ${entryId}: ${signError.message}`);
    }
    url = signed?.signedUrl ?? null;
  }
  if (!url) url = row.original_video_url;
  if (!url) {
    throw new Error(`ai_video_entries row ${entryId} has no stored object or original_video_url.`);
  }

  const ext =
    extFromUrlOrPath(row.storage_path) ??
    extFromContentType(row.content_type) ??
    extFromUrlOrPath(row.original_video_url) ??
    ".mp4";

  return { id: row.id, title: row.title, url, ext };
}
