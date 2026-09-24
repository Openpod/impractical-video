import { rm } from "node:fs/promises";
import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { isFFmpegLambdaConfigured } from "@/lib/ffmpeg-lambda";
import { extractVideoFrame } from "@/lib/media";
import { materializeVideo, probeVideoDuration } from "@/lib/video-shots";
import {
  getProjectSnapshot,
  parseJsonFrontmatter,
  readWorkspaceFile,
  safeRelativePath,
  signedWorkspaceMediaUrl,
  withJsonFrontmatter,
  writeWorkspaceBinaryFile,
  writeWorkspaceFile,
} from "@/lib/workspace";

// Canvas tile keyboard operations: F/L frame extraction and D duplication.

type Params = {
  params: Promise<{ id: string }>;
};

function isTilePath(value: string) {
  return /^(clips|keyframes|uploads)\/[^/]+\.md$/.test(value);
}

function mediaFromMeta(meta: Record<string, unknown>) {
  if (typeof meta.local_path === "string" && meta.local_path) return meta.local_path;
  if (typeof meta.url === "string" && meta.url) return meta.url;
  return null;
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) return NextResponse.json({ error: "Sign in." }, { status: 401 });
  await getProjectSnapshot(id, user.userId);

  const body = await request.json().catch(() => ({}));
  const op = typeof body.op === "string" ? body.op : "";
  const rawPath = typeof body.path === "string" ? body.path : "";
  const tilePath = safeRelativePath(rawPath);
  if (!isTilePath(tilePath)) {
    return NextResponse.json({ error: "Unsupported tile path." }, { status: 400 });
  }
  const raw = await readWorkspaceFile(id, tilePath);
  const parsed = parseJsonFrontmatter(raw);
  const sourceId = typeof parsed.meta.id === "string" ? parsed.meta.id : "tile";
  // Ops act on the version the user is LOOKING at, not blindly the latest.
  const metaVersions = Array.isArray(parsed.meta.versions)
    ? (parsed.meta.versions as Array<Record<string, unknown>>)
    : null;
  const versionIndex =
    typeof body.version === "number" && Number.isInteger(body.version) ? body.version : null;
  const selectedVersion =
    metaVersions && versionIndex !== null && versionIndex >= 0 && versionIndex < metaVersions.length
      ? metaVersions[versionIndex]!
      : null;
  const selectedVersionMedia = selectedVersion
    ? typeof selectedVersion.local_path === "string" && selectedVersion.local_path
      ? selectedVersion.local_path
      : typeof selectedVersion.url === "string" && selectedVersion.url
        ? selectedVersion.url
        : null
    : null;
  const title =
    parsed.body
      .split("\n")
      .find((line) => line.startsWith("# "))
      ?.slice(2)
      .trim() ?? sourceId;
  const stamp = Date.now().toString(36);

  if (op === "extract_frame") {
    const at = body.at === "last" ? "last" : "first";
    const media = selectedVersionMedia ?? mediaFromMeta(parsed.meta);
    if (!media) return NextResponse.json({ error: "Tile has no media." }, { status: 400 });
    // Lambda path fetches by URL (no local materialize/cleanup); local path
    // downloads to a temp workDir that must be removed afterwards.
    let workDir: string | null = null;
    try {
      let frame: Awaited<ReturnType<typeof extractVideoFrame>>;
      // Workspace media may be unsignable (local desktop mode); fall back to
      // local ffmpeg rather than failing when the Lambda path can't get a URL.
      const signedUrl = isFFmpegLambdaConfigured()
        ? /^https?:\/\//i.test(media)
          ? media
          : await signedWorkspaceMediaUrl(id, safeRelativePath(media)).catch(
              () => null,
            )
        : null;
      if (signedUrl) {
        // Negative seconds = seek from end (last frame); the Lambda handles it.
        const seconds = at === "last" ? -0.05 : 0.04;
        frame = await extractVideoFrame({ seconds, videoUrl: signedUrl });
      } else {
        const materialized = await materializeVideo(id, media);
        workDir = materialized.workDir;
        // Negative seconds = seek from the end (-sseof): container duration
        // can exceed the video stream's end (audio tail), so duration-based
        // seeks can land past the last frame and silently produce nothing.
        const seconds = at === "last" ? -0.05 : 0.04;
        frame = await extractVideoFrame({ seconds, videoUrl: materialized.sourcePath });
      }
      if (!frame.ok) return NextResponse.json({ error: frame.error }, { status: 502 });
      const frameId = `${sourceId.slice(0, 40)}_${at}_frame_${stamp}`;
      const localPath = `media/keyframes/${frameId}.v1.png`;
      await writeWorkspaceBinaryFile(id, localPath, frame.buffer);
      await writeWorkspaceFile(
        id,
        `keyframes/${frameId}.md`,
        withJsonFrontmatter(
          {
            aspect_ratio:
              typeof parsed.meta.aspect_ratio === "string" ? parsed.meta.aspect_ratio : null,
            canvas_composed: true,
            canvas_derived_from: sourceId,
            id: frameId,
            local_path: localPath,
            status: "generated",
            type: "keyframe",
            versions: [{ local_path: localPath, url: null, version: 1 }],
          },
          `# ${title} — ${at} frame\n\nExtracted ${at} frame of @${sourceId}.\n`,
        ),
      );
      return NextResponse.json({
        created_id: frameId,
        ok: true,
        snapshot: await getProjectSnapshot(id, user.userId),
      });
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  }

  if (op === "duplicate") {
    const dir = tilePath.split("/")[0]!;
    const copyId = `${sourceId.slice(0, 48)}_copy_${stamp}`;
    await writeWorkspaceFile(
      id,
      `${dir}/${copyId}.md`,
      withJsonFrontmatter(
        {
          ...parsed.meta,
          // A duplicate is a fresh tile: the version being VIEWED becomes its
          // one and only v1 — history never carries over.
          ...(() => {
            const dupVersion =
              selectedVersion ??
              (metaVersions && metaVersions.length
                ? metaVersions[metaVersions.length - 1]!
                : null);
            return dupVersion
              ? {
                  local_path:
                    typeof dupVersion.local_path === "string" ? dupVersion.local_path : null,
                  url: typeof dupVersion.url === "string" ? dupVersion.url : null,
                  versions: [{ ...dupVersion, version: 1 }],
                }
              : {};
          })(),
          canvas_group: null,
          canvas_group_index: 0,
          canvas_group_title: null,
          id: copyId,
          in_timeline: false,
          index: Date.now(),
        },
        parsed.body.replace(/^# .*$/m, `# ${title} (copy)`),
      ),
    );
    return NextResponse.json({
      created_id: copyId,
      ok: true,
      snapshot: await getProjectSnapshot(id, user.userId),
    });
  }

  return NextResponse.json({ error: "Unknown op." }, { status: 400 });
}
