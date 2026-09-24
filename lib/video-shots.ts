import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  readWorkspaceBinaryFile,
  safeRelativePath,
  signedWorkspaceMediaUrl,
  withJsonFrontmatter,
  writeWorkspaceBinaryFile,
  writeWorkspaceFile,
} from "@/lib/workspace";
import {
  detectShotsRemote,
  isFFmpegLambdaConfigured,
  trimVideoRemote,
} from "@/lib/ffmpeg-lambda";

// Shot extraction for agent tools: the same ffmpeg scene analysis the YouTube
// import workflow runs (lib/canvas-youtube-worker.ts), packaged so the
// chat + composer agents can split ANY workspace video into shot tiles.

const execFileAsync = promisify(execFile);

function cleanNumber(value: number, digits = 3) {
  return Number(value.toFixed(digits));
}

export type DetectedShot = {
  duration: number;
  end: number;
  index: number;
  start: number;
};

/** Resolve a workspace media reference to a URL the FFmpeg Lambda can fetch:
 * pass http(s) through untouched, otherwise sign the workspace object. */
async function sourceUrlFor(projectId: string, media: string): Promise<string> {
  if (/^https?:\/\//i.test(media)) return media;
  const url = await signedWorkspaceMediaUrl(projectId, safeRelativePath(media));
  if (!url) {
    throw new Error("Could not sign workspace media URL for FFmpeg Lambda.");
  }
  return url;
}

/** Pure shot-boundary math shared by the local ffmpeg path and the Lambda
 * path: apply the same min-gap filtering + max-length subdivision to a list of
 * raw scene-cut timestamps. */
export function buildShotBoundaries(
  cutTimes: number[],
  duration: number,
  options?: {
    /** 0 disables the forced max-length subdivision (pure scene cuts only). */
    maxSceneSeconds?: number;
    minSceneSeconds?: number;
  },
): DetectedShot[] {
  const minSceneSeconds =
    options?.minSceneSeconds ?? Number(process.env.CANVAS_YOUTUBE_MIN_SCENE_SECONDS ?? 0.75);
  const maxSceneSeconds =
    options?.maxSceneSeconds ?? Number(process.env.CANVAS_YOUTUBE_MAX_SCENE_SECONDS ?? 8);
  const cuts: number[] = [];
  for (const raw of cutTimes) {
    const time = Number(raw);
    if (Number.isFinite(time) && time > 0.05 && time < duration - 0.05) {
      const previous = cuts.at(-1);
      if (previous === undefined || time - previous >= minSceneSeconds) {
        cuts.push(cleanNumber(time));
      }
    }
  }
  const rawBoundaries = [0, ...cuts, duration];
  const boundaries: number[] = [0];
  for (const rawEnd of rawBoundaries.slice(1)) {
    let previous = boundaries.at(-1) ?? 0;
    while (maxSceneSeconds > 0 && rawEnd - previous > maxSceneSeconds) {
      previous = cleanNumber(previous + maxSceneSeconds);
      boundaries.push(previous);
    }
    if (rawEnd > (boundaries.at(-1) ?? 0)) boundaries.push(rawEnd);
  }
  return boundaries
    .slice(0, -1)
    .map((start, index) => ({
      duration: cleanNumber(boundaries[index + 1]! - start),
      end: cleanNumber(boundaries[index + 1]!),
      index,
      start: cleanNumber(start),
    }))
    .filter((shot) => shot.duration > 0.05);
}

export async function probeVideoDuration(sourcePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    sourcePath,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Could not determine video duration.");
  }
  return duration;
}

/** ffmpeg scene-change detection → shot boundaries (same tuning as the
 * YouTube import: threshold/min/max via the same env knobs). */
export async function detectShots(
  sourcePath: string,
  duration: number,
  options?: {
    /** 0 disables the forced max-length subdivision (pure scene cuts only). */
    maxSceneSeconds?: number;
    minSceneSeconds?: number;
    threshold?: number;
  },
): Promise<DetectedShot[]> {
  const threshold =
    options?.threshold ?? Number(process.env.CANVAS_YOUTUBE_SCENE_THRESHOLD ?? 0.22);
  const { stderr, stdout } = await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      sourcePath,
      "-vf",
      `select='gt(scene,${threshold})',showinfo`,
      "-an",
      "-f",
      "null",
      "-",
    ],
    { maxBuffer: 24 * 1024 * 1024 },
  );
  const cutTimes: number[] = [];
  const log = `${stdout}\n${stderr}`;
  const pattern = /pts_time:([0-9.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(log)) !== null) {
    const time = Number(match[1]);
    if (Number.isFinite(time)) cutTimes.push(time);
  }
  return buildShotBoundaries(cutTimes, duration, options);
}

async function extractShotClip(
  sourcePath: string,
  outputPath: string,
  start: number,
  duration: number,
) {
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      start.toFixed(3),
      "-i",
      sourcePath,
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
    { timeout: 180_000 },
  );
}

/** Pull a workspace media reference (local path or remote URL) into a temp
 * file ffmpeg can read directly. Caller must rm the returned workDir. */
export async function materializeVideo(
  projectId: string,
  media: string,
): Promise<{ sourcePath: string; workDir: string }> {
  const workDir = await mkdtemp(path.join(tmpdir(), "vfs-shots-"));
  const sourcePath = path.join(workDir, "source.mp4");
  if (/^https?:\/\//i.test(media)) {
    const response = await fetch(media);
    if (!response.ok) throw new Error(`Failed to fetch source video (${response.status}).`);
    await writeFile(sourcePath, Buffer.from(await response.arrayBuffer()));
  } else {
    const binary = await readWorkspaceBinaryFile(projectId, safeRelativePath(media));
    await writeFile(sourcePath, binary.content);
  }
  return { sourcePath, workDir };
}

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32) || "shots"
  );
}

/** Split a workspace video into shot clip tiles, grouped as a canvas row. */
export async function extractShotTiles(input: {
  maxShots?: number;
  media: string;
  projectId: string;
  sourceId: string;
  sourceTitle: string;
}): Promise<{ count: number; groupId: string; paths: string[]; totalDetected: number }> {
  const maxShots = Math.max(1, Math.min(input.maxShots ?? 20, 40));

  if (isFFmpegLambdaConfigured()) {
    const videoUrl = await sourceUrlFor(input.projectId, input.media);
    const detect = await detectShotsRemote({
      videoUrl,
      threshold: Number(process.env.CANVAS_YOUTUBE_SCENE_THRESHOLD ?? 0.22),
    });
    if (!detect.success) {
      throw new Error(detect.error || "Shot detection failed.");
    }
    const duration = detect.metadata?.duration;
    if (!duration || !Number.isFinite(duration) || duration <= 0) {
      throw new Error("Could not determine video duration.");
    }
    const shots = buildShotBoundaries(detect.cutTimes ?? [], duration);
    const selected = shots.slice(0, maxShots);
    const groupId = `shots_${slug(input.sourceId)}_${Date.now().toString(36)}`;
    const paths: string[] = [];
    for (const shot of selected) {
      const shotId = `${slug(input.sourceId)}_shot_${String(shot.index + 1).padStart(3, "0")}_${Date.now().toString(36)}`;
      const trimmed = await trimVideoRemote({
        videoUrl,
        startTime: shot.start,
        duration: shot.duration,
      });
      if (!trimmed.success || !trimmed.outputUrl) {
        throw new Error(trimmed.error || "Shot trim failed.");
      }
      const response = await fetch(trimmed.outputUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch trimmed shot (${response.status}).`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const mediaPath = `media/clips/${shotId}.v1.mp4`;
      await writeWorkspaceBinaryFile(input.projectId, mediaPath, bytes);
      const tilePath = `clips/${shotId}.md`;
      await writeWorkspaceFile(
        input.projectId,
        tilePath,
        withJsonFrontmatter(
          {
            canvas_derived_from: input.sourceId,
            canvas_group: groupId,
            canvas_group_index: shot.index,
            canvas_group_title: `${input.sourceTitle} shots`,
            duration_seconds: shot.duration,
            generated_seconds: shot.duration,
            id: shotId,
            in_timeline: false,
            index: Date.now() + shot.index,
            local_path: mediaPath,
            status: "active",
            type: "clip",
            versions: [{ local_path: mediaPath, url: null, version: 1 }],
          },
          `# ${input.sourceTitle} — shot ${shot.index + 1}\n\nExtracted from @${input.sourceId} (${shot.start.toFixed(2)}s → ${shot.end.toFixed(2)}s) via ffmpeg scene detection.\n`,
        ),
      );
      paths.push(tilePath);
    }
    return { count: selected.length, groupId, paths, totalDetected: shots.length };
  }

  const { sourcePath, workDir } = await materializeVideo(input.projectId, input.media);
  try {
    const duration = await probeVideoDuration(sourcePath);
    const shots = await detectShots(sourcePath, duration);
    const selected = shots.slice(0, maxShots);
    const groupId = `shots_${slug(input.sourceId)}_${Date.now().toString(36)}`;
    const paths: string[] = [];
    for (const shot of selected) {
      const shotId = `${slug(input.sourceId)}_shot_${String(shot.index + 1).padStart(3, "0")}_${Date.now().toString(36)}`;
      const clipTempPath = path.join(workDir, `${shotId}.mp4`);
      await extractShotClip(sourcePath, clipTempPath, shot.start, shot.duration);
      const { readFile: readTemp } = await import("node:fs/promises");
      const bytes = await readTemp(clipTempPath);
      const mediaPath = `media/clips/${shotId}.v1.mp4`;
      await writeWorkspaceBinaryFile(input.projectId, mediaPath, bytes);
      const tilePath = `clips/${shotId}.md`;
      await writeWorkspaceFile(
        input.projectId,
        tilePath,
        withJsonFrontmatter(
          {
            canvas_derived_from: input.sourceId,
            canvas_group: groupId,
            canvas_group_index: shot.index,
            canvas_group_title: `${input.sourceTitle} shots`,
            duration_seconds: shot.duration,
            generated_seconds: shot.duration,
            id: shotId,
            in_timeline: false,
            index: Date.now() + shot.index,
            local_path: mediaPath,
            status: "active",
            type: "clip",
            versions: [{ local_path: mediaPath, url: null, version: 1 }],
          },
          `# ${input.sourceTitle} — shot ${shot.index + 1}\n\nExtracted from @${input.sourceId} (${shot.start.toFixed(2)}s → ${shot.end.toFixed(2)}s) via ffmpeg scene detection.\n`,
        ),
      );
      paths.push(tilePath);
    }
    return { count: selected.length, groupId, paths, totalDetected: shots.length };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
