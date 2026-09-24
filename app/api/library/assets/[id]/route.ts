import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { isLocalAppMode } from "@/lib/app-mode";
import { localLibraryFile, LocalLibraryError } from "@/lib/local-library";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isLocalAppMode()) return Response.json({ error: "Not found." }, { status: 404 });
  try {
    const file = await localLibraryFile((await params).id);
    const inline = /^(?:image\/(?:png|jpeg|gif|webp|avif)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf)$/.test(file.mime);
    const filename = encodeURIComponent(file.filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`);
    const headers: Record<string, string> = {
      "Content-Type": file.mime, "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
      "Cache-Control": "private, no-store", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'",
    };
    let start = 0; let end = file.bytes - 1;
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, file.bytes - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), file.bytes - 1) : file.bytes - 1;
      }
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.bytes) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${file.bytes}` } });
      headers["Content-Range"] = `bytes ${start}-${end}/${file.bytes}`;
    }
    headers["Content-Length"] = String(Math.max(0, end - start + 1));
    const body = file.bytes ? Readable.toWeb(createReadStream(file.absolutePath, { start, end })) as ReadableStream : null;
    return new Response(body, { status: range ? 206 : 200, headers });
  } catch (error) {
    return Response.json({ error: "Library file not found." }, { status: error instanceof LocalLibraryError ? error.status : 404 });
  }
}
