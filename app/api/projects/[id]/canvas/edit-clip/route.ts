import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

import { ensureCurrentAppUser } from "@/lib/app-users";
import { isFFmpegLambdaConfigured, trimVideoRemote } from "@/lib/ffmpeg-lambda";
import {
  getProjectSnapshot,
  parseJsonFrontmatter,
  readWorkspaceBinaryFile,
  readWorkspaceFile,
  refreshTimeline,
  safeRelativePath,
  signedWorkspaceMediaUrl,
  withJsonFrontmatter,
  writeWorkspaceBinaryFile,
  writeWorkspaceFile,
} from "@/lib/workspace";

const execFileAsync = promisify(execFile);

type Params = {
  params: Promise<{ id: string }>;
};

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 44) || "clip"
  );
}

function versionNumberFromPath(value: string | null | undefined) {
  const match = value?.match(/\.v(\d+)\.[a-z0-9]+$/i);
  return match ? Number(match[1]) : null;
}

function clipVersions(meta: Record<string, unknown>) {
  return Array.isArray(meta.versions)
    ? meta.versions.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function currentLocalPath(meta: Record<string, unknown>) {
  if (typeof meta.local_path === "string" && meta.local_path) return safeRelativePath(meta.local_path);
  const versions = clipVersions(meta);
  const last = versions.at(-1);
  return typeof last?.local_path === "string" ? safeRelativePath(last.local_path) : null;
}

function nextVersionNumber(meta: Record<string, unknown>, localPath: string | null) {
  const explicit = clipVersions(meta)
    .map((item) => (typeof item.version === "number" ? item.version : null))
    .filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  const fromPath = versionNumberFromPath(localPath);
  return Math.max(0, fromPath ?? 0, ...explicit) + 1;
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to edit canvas clips." }, { status: 401 });
  }
  await getProjectSnapshot(id, user.userId);

  const body = await request.json().catch(() => ({}));
  const clipId = typeof body.clipId === "string" ? body.clipId : "";
  const mode = body.mode === "new" ? "new" : "version";
  const clipPath = typeof body.path === "string" ? safeRelativePath(body.path) : "";
  const ops = body.ops && typeof body.ops === "object" ? (body.ops as Record<string, unknown>) : {};
  const trim = ops.trim && typeof ops.trim === "object" ? (ops.trim as Record<string, unknown>) : null;

  if (!/^clips\/[^/]+\.md$/.test(clipPath)) {
    return NextResponse.json({ error: "Unsupported clip path." }, { status: 400 });
  }
  if (typeof ops.speed === "number") {
    return NextResponse.json({ error: "Speed edits are not enabled yet." }, { status: 400 });
  }
  const startSeconds = typeof trim?.startSeconds === "number" ? trim.startSeconds : null;
  const endSeconds = typeof trim?.endSeconds === "number" ? trim.endSeconds : null;
  if (
    startSeconds === null ||
    endSeconds === null ||
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    startSeconds < 0 ||
    endSeconds <= startSeconds
  ) {
    return NextResponse.json({ error: "Valid trim start/end are required." }, { status: 400 });
  }

  const source = await readWorkspaceFile(id, clipPath);
  const parsed = parseJsonFrontmatter(source);
  const sourceId = typeof parsed.meta.id === "string" ? parsed.meta.id : clipId;
  if (clipId && sourceId && clipId !== sourceId) {
    return NextResponse.json({ error: "Clip id did not match clip path." }, { status: 400 });
  }
  const sourceLocalPath = currentLocalPath(parsed.meta);
  if (!sourceLocalPath) {
    return NextResponse.json({ error: "Selected clip has no local media to trim." }, { status: 400 });
  }

  const duration = endSeconds - startSeconds;
  const nextVersion = mode === "version" ? nextVersionNumber(parsed.meta, sourceLocalPath) : 1;
  const outputClipId =
    mode === "version" ? sourceId : `${slug(sourceId)}_trim_${Date.now().toString(36)}`;
  const outputLocalPath = `media/clips/${outputClipId}.v${nextVersion}.mp4`;
  // Lambda path trims by signed URL and re-hosts the result; local path shells
  // out to ffmpeg in a temp workDir that must be cleaned up afterwards.
  let workDir: string | null = null;

  try {
    // Workspace media may be unsignable (local desktop mode); fall back to
    // local ffmpeg rather than failing when the Lambda path can't get a URL.
    const lambdaUrl = isFFmpegLambdaConfigured()
      ? await signedWorkspaceMediaUrl(id, sourceLocalPath).catch(() => null)
      : null;
    if (lambdaUrl) {
      const trimmed = await trimVideoRemote({
        videoUrl: lambdaUrl,
        startTime: startSeconds,
        duration,
      });
      if (!trimmed.success || !trimmed.outputUrl) {
        throw new Error(trimmed.error || "Clip trim failed.");
      }
      const response = await fetch(trimmed.outputUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch trimmed clip (${response.status}).`);
      }
      await writeWorkspaceBinaryFile(
        id,
        outputLocalPath,
        Buffer.from(await response.arrayBuffer()),
      );
    } else {
      workDir = await mkdtemp(path.join(tmpdir(), "canvas-edit-"));
      const inputPath = path.join(workDir, "input.mp4");
      const outputPath = path.join(workDir, "output.mp4");
      const media = await readWorkspaceBinaryFile(id, sourceLocalPath);
      await writeFile(inputPath, media.content);
      await execFileAsync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          startSeconds.toFixed(3),
          "-i",
          inputPath,
          "-t",
          duration.toFixed(3),
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "20",
          "-c:a",
          "aac",
          "-movflags",
          "+faststart",
          "-y",
          outputPath,
        ],
        { timeout: 90_000, maxBuffer: 1024 * 1024 * 4 },
      );
      await writeWorkspaceBinaryFile(id, outputLocalPath, await readFile(outputPath));
    }

    const versionEntry = {
      local_path: outputLocalPath,
      operation: "trim",
      trim: {
        end_seconds: Number(endSeconds.toFixed(3)),
        start_seconds: Number(startSeconds.toFixed(3)),
      },
      version: nextVersion,
    };
    const existingVersions = clipVersions(parsed.meta);
    const baseVersions = existingVersions.length
      ? existingVersions
      : [
          {
            local_path: sourceLocalPath,
            version: versionNumberFromPath(sourceLocalPath) ?? 1,
          },
        ];

    if (mode === "version") {
      await writeWorkspaceFile(
        id,
        clipPath,
        withJsonFrontmatter(
          {
            ...parsed.meta,
            duration_seconds: Number(duration.toFixed(2)),
            generated_seconds: Number(duration.toFixed(2)),
            local_path: outputLocalPath,
            status: "active",
            versions: [...baseVersions, versionEntry],
          },
          parsed.body,
        ),
      );
    } else {
      await writeWorkspaceFile(
        id,
        `clips/${outputClipId}.md`,
        withJsonFrontmatter(
          {
            ...parsed.meta,
            asset_id: `asset_${outputClipId}`,
            derived_from: sourceId,
            duration_seconds: Number(duration.toFixed(2)),
            generated_seconds: Number(duration.toFixed(2)),
            id: outputClipId,
            local_path: outputLocalPath,
            source_clip: sourceId,
            status: "active",
            type: "clip",
            versions: [versionEntry],
          },
          [
            `# ${outputClipId}`,
            "",
            `Trimmed from ${sourceId}: ${startSeconds.toFixed(2)}s - ${endSeconds.toFixed(2)}s.`,
            "",
            parsed.body,
          ].join("\n"),
        ),
      );
    }

    await refreshTimeline(id);
    return NextResponse.json({
      ...(await getProjectSnapshot(id, user.userId)),
      created_id: mode === "new" ? outputClipId : sourceId,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to edit clip.",
      },
      { status: 500 },
    );
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
}
