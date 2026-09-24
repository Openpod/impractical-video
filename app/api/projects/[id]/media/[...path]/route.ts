import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import {
  readProjectMeta,
  readWorkspaceBinaryFile,
  safeRelativePath,
  signedWorkspaceMediaUrl,
  statWorkspaceMediaFile,
} from "@/lib/workspace";

type Params = {
  params: Promise<{ id: string; path: string[] }>;
};

/** Streams one byte range from disk. Range support is what makes `<video>`
 * seek/scrub work — without 206 responses the players re-fetch whole files
 * and playback stutters. */
function rangeResponse(
  file: { absolutePath: string; contentType: string; size: number },
  rangeHeader: string | null,
) {
  const common = {
    "accept-ranges": "bytes",
    // Workspace media can be replaced by external agents or legacy routes.
    // Revalidate cached bytes so a stable URL never pins stale canvas pixels.
    "cache-control": "private, no-cache, max-age=0, must-revalidate",
    "content-type": file.contentType,
  };
  const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  if (match && (match[1] || match[2])) {
    const start = match[1]
      ? Number(match[1])
      : Math.max(0, file.size - Number(match[2]));
    const end = match[1] && match[2]
      ? Math.min(Number(match[2]), file.size - 1)
      : file.size - 1;
    if (!Number.isFinite(start) || start >= file.size || start > end) {
      return new Response(null, {
        headers: { ...common, "content-range": `bytes */${file.size}` },
        status: 416,
      });
    }
    return new Response(
      Readable.toWeb(
        createReadStream(file.absolutePath, { end, start }),
      ) as ReadableStream,
      {
        headers: {
          ...common,
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${file.size}`,
        },
        status: 206,
      },
    );
  }
  return new Response(
    Readable.toWeb(createReadStream(file.absolutePath)) as ReadableStream,
    { headers: { ...common, "content-length": String(file.size) } },
  );
}

export async function GET(request: Request, { params }: Params) {
  const { id, path: parts } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to view media." }, { status: 401 });
  }
  const project = await readProjectMeta(id, user.userId).catch(() => null);
  if (!project) {
    return NextResponse.json({ error: "Media not found." }, { status: 404 });
  }
  const mediaPath = safeRelativePath(["media", ...parts].join("/"));
  // Thumbnail request (?w=): redirect to a resized, cached Supabase render URL
  // for images. Full-res requests (no ?w) serve the bytes below unchanged.
  const widthParam = Number(new URL(request.url).searchParams.get("w"));
  if (
    Number.isFinite(widthParam) &&
    widthParam > 0 &&
    /\.(png|jpe?g|webp)$/i.test(mediaPath)
  ) {
    const transformed = await signedWorkspaceMediaUrl(
      id,
      mediaPath,
      60 * 60 * 6,
      Math.min(1280, Math.round(widthParam)),
    ).catch(() => null);
    if (transformed) return NextResponse.redirect(transformed, 302);
  }
  const rangeHeader = request.headers.get("range");
  const streamable =
    (await statWorkspaceMediaFile(id, mediaPath).catch(() => null)) ??
    (parts[0] === "uploads"
      ? await statWorkspaceMediaFile(id, safeRelativePath(parts.join("/"))).catch(
          () => null,
        )
      : null);
  if (streamable) return rangeResponse(streamable, rangeHeader);
  // Supabase-backed workspaces: buffered read, full-body response.
  let media = await readWorkspaceBinaryFile(id, mediaPath).catch(() => null);
  if (!media && parts[0] === "uploads") {
    // Legacy chat attachments were written to uploads/** instead of media/**;
    // serve them from their original location.
    media = await readWorkspaceBinaryFile(id, safeRelativePath(parts.join("/"))).catch(() => null);
  }
  if (!media) {
    return NextResponse.json({ error: "Media not found." }, { status: 404 });
  }
  return new Response(media.content, {
    headers: {
      "cache-control": "private, no-cache, max-age=0, must-revalidate",
      "content-length": String(media.size),
      "content-type": media.contentType,
    },
  });
}
