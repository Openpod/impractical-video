import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { setItemPlacement } from "@/lib/library";
import { createServerClient } from "@/lib/supabase";
import { isLocalAppMode } from "@/lib/app-mode";
import { LIBRARY_UPLOAD_LIMIT, LocalLibraryError, uploadLocalLibraryFiles } from "@/lib/local-library";

export const dynamic = "force-dynamic";

const PUBLISHED_MEDIA_BUCKET = "published-media";
const MAX_BYTES = 100 * 1024 * 1024; // 100 MB per file

type UploadKind = "audio" | "document" | "image" | "video";

function mediaKindFor(mime: string): UploadKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

function mediaRowKind(kind: UploadKind): "audio" | "image" | "other" | "video" {
  return kind === "document" ? "other" : kind;
}

function safeName(name: string) {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "file";
}

function titleFromFilename(name: string) {
  return name.trim() || "Untitled upload";
}

export async function POST(request: Request) {
  if (isLocalAppMode()) {
    try {
      if (Number(request.headers.get("content-length")) > LIBRARY_UPLOAD_LIMIT + 1024 * 1024) throw new LocalLibraryError("Upload up to 100 MB at a time.", 413);
      const form = await request.formData().catch(() => null);
      if (!form) throw new LocalLibraryError("Expected file uploads.");
      if (form.get("folderId")) throw new LocalLibraryError("Local uploads are saved in the Library root.");
      const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
      return NextResponse.json({ ok: true, createdIds: await uploadLocalLibraryFiles(files) });
    } catch (error) {
      return NextResponse.json({ error: error instanceof LocalLibraryError ? error.message : "Could not save the files. Check disk space and try again." }, { status: error instanceof LocalLibraryError ? error.status : 500 });
    }
  }
  try {
    const user = await ensureCurrentAppUser();
    if (!user) return NextResponse.json({ error: "Sign in to upload to your library." }, { status: 401 });

    const form = await request.formData();
    const rawFolderId = form.get("folderId");
    const folderId = typeof rawFolderId === "string" && rawFolderId ? rawFolderId : null;
    const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
    if (!files.length) {
      return NextResponse.json({ error: "No files were provided." }, { status: 400 });
    }

    const supabase = createServerClient();
    const createdIds: string[] = [];

    for (const file of files) {
      if (file.size > MAX_BYTES) {
        throw new Error(`"${file.name}" is larger than the 100 MB limit.`);
      }
      const mime = file.type || "application/octet-stream";
      const kind = mediaKindFor(mime);
      const itemId = randomUUID();
      const buffer = Buffer.from(await file.arrayBuffer());
      const storagePath = `${itemId}/${safeName(file.name)}`;

      const { error: itemError } = await supabase.from("published_items").insert({
        id: itemId,
        kind,
        metadata: { media_kind: kind, original_filename: file.name, upload: true },
        publisher_id: user.userId,
        title: titleFromFilename(file.name),
        visibility: "draft",
      });
      if (itemError) throw new Error(`Failed to create item: ${itemError.message}`);

      const { error: uploadError } = await supabase.storage
        .from(PUBLISHED_MEDIA_BUCKET)
        .upload(storagePath, buffer, { contentType: mime, upsert: true });
      if (uploadError) throw new Error(`Failed to upload "${file.name}": ${uploadError.message}`);

      const { error: mediaError } = await supabase.from("published_item_media").insert({
        bytes: buffer.byteLength,
        item_id: itemId,
        kind: mediaRowKind(kind),
        mime_type: mime,
        role: kind === "image" || kind === "video" ? "display" : "asset",
        storage_path: storagePath,
      });
      if (mediaError) throw new Error(`Failed to record "${file.name}": ${mediaError.message}`);

      if (folderId) {
        await setItemPlacement({ folderId, itemId, ownerUserId: user.userId });
      }
      createdIds.push(itemId);
    }

    return NextResponse.json({ createdIds, ok: true });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Upload failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
