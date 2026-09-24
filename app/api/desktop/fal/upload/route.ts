import { NextResponse } from "next/server";
import { isLocalAppMode } from "@/lib/app-mode";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { getCreditBalance } from "@/lib/credits-service";

export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 90 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  "audio/m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

export async function POST(request: Request) {
  if (isLocalAppMode()) {
    return NextResponse.json({ error: "The hosted upload bridge is unavailable locally." }, { status: 404 });
  }

  try {
    const user = await ensureCurrentAppUser();
    if (!user) return NextResponse.json({ error: "Sign in to upload generation references." }, { status: 401 });
    const balance = await getCreditBalance(user.userId);
    if (balance.total <= 0) {
      return NextResponse.json({ error: "Add credits before uploading generation references." }, { status: 402 });
    }

    const body = (await request.json().catch(() => null)) as {
      contentType?: unknown;
      fileName?: unknown;
      size?: unknown;
    } | null;
    const contentType = typeof body?.contentType === "string" ? body.contentType.trim().toLowerCase() : "";
    const fileName = typeof body?.fileName === "string" ? body.fileName.trim() : "";
    const size = Number(body?.size);
    if (
      !ALLOWED_CONTENT_TYPES.has(contentType) ||
      !/^[a-zA-Z0-9._-]{1,160}$/.test(fileName) ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > MAX_UPLOAD_BYTES
    ) {
      return NextResponse.json({ error: "Invalid desktop reference upload." }, { status: 400 });
    }

    const falKey = process.env.FAL_KEY?.trim();
    if (!falKey) throw new Error("FAL_KEY is not configured.");
    const response = await fetch(
      "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3",
      {
        body: JSON.stringify({ content_type: contentType, file_name: fileName }),
        headers: {
          authorization: `Key ${falKey}`,
          "content-type": "application/json",
          "x-fal-object-lifecycle": JSON.stringify({ expiration_duration_seconds: 86_400 }),
        },
        method: "POST",
      },
    );
    const result = (await response.json().catch(() => ({}))) as {
      file_url?: unknown;
      upload_url?: unknown;
    };
    if (!response.ok || typeof result.upload_url !== "string" || typeof result.file_url !== "string") {
      throw new Error(`Could not initiate fal storage upload (${response.status}).`);
    }
    return NextResponse.json({ uploadUrl: result.upload_url, url: result.file_url });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not initiate the upload.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
