import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { filterImageRemote, isFFmpegLambdaConfigured } from "@/lib/ffmpeg-lambda";
import {
  getProjectSnapshot,
  parseJsonFrontmatter,
  readWorkspaceBinaryFile,
  readWorkspaceFile,
  safeRelativePath,
  signedWorkspaceMediaUrl,
  withJsonFrontmatter,
  writeWorkspaceBinaryFile,
  writeWorkspaceFile,
} from "@/lib/workspace";

// Bakes crop + filter adjustments (brightness/contrast/saturation/blur) into
// image tiles (keyframes and uploaded images) via ffmpeg, appending a new
// media version so the original stays reachable through the version strip.

const execFileAsync = promisify(execFile);

type Params = {
  params: Promise<{ id: string }>;
};

type Filters = {
  blur: number;
  brightness: number;
  contrast: number;
  hue: number;
  saturation: number;
  sharpen: number;
  vignette: number;
  warmth: number;
};

const NEUTRAL: Filters = {
  blur: 0,
  brightness: 50,
  contrast: 50,
  hue: 50,
  saturation: 50,
  sharpen: 0,
  vignette: 0,
  warmth: 50,
};

function clamp01(value: unknown, fallback: number) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(100, Math.max(0, n));
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to edit images." }, { status: 401 });
  }
  await getProjectSnapshot(id, user.userId);

  const body = await request.json().catch(() => ({}));
  const tilePath = typeof body.path === "string" ? safeRelativePath(body.path) : "";
  if (!/^(keyframes|uploads)\/[^/]+\.md$/.test(tilePath)) {
    return NextResponse.json({ error: "Unsupported image tile path." }, { status: 400 });
  }
  const crop =
    body.crop && typeof body.crop === "object"
      ? (body.crop as Record<string, unknown>)
      : null;
  const rawFilters =
    body.filters && typeof body.filters === "object"
      ? (body.filters as Record<string, unknown>)
      : {};
  const filters: Filters = {
    blur: clamp01(rawFilters.blur, NEUTRAL.blur),
    brightness: clamp01(rawFilters.brightness, NEUTRAL.brightness),
    contrast: clamp01(rawFilters.contrast, NEUTRAL.contrast),
    hue: clamp01(rawFilters.hue, NEUTRAL.hue),
    saturation: clamp01(rawFilters.saturation, NEUTRAL.saturation),
    sharpen: clamp01(rawFilters.sharpen, NEUTRAL.sharpen),
    vignette: clamp01(rawFilters.vignette, NEUTRAL.vignette),
    warmth: clamp01(rawFilters.warmth, NEUTRAL.warmth),
  };

  const filterParts: string[] = [];
  if (crop) {
    const x = clamp01(typeof crop.x === "number" ? crop.x * 100 : NaN, 0) / 100;
    const y = clamp01(typeof crop.y === "number" ? crop.y * 100 : NaN, 0) / 100;
    const w = clamp01(typeof crop.width === "number" ? crop.width * 100 : NaN, 100) / 100;
    const h = clamp01(typeof crop.height === "number" ? crop.height * 100 : NaN, 100) / 100;
    if (w > 0.01 && h > 0.01 && (x > 0 || y > 0 || w < 1 || h < 1)) {
      filterParts.push(
        `crop=floor(iw*${w.toFixed(4)}/2)*2:floor(ih*${h.toFixed(4)}/2)*2:iw*${x.toFixed(4)}:ih*${y.toFixed(4)}`,
      );
    }
  }
  const eq: string[] = [];
  if (filters.brightness !== NEUTRAL.brightness) {
    eq.push(`brightness=${((filters.brightness - 50) / 100).toFixed(3)}`);
  }
  if (filters.contrast !== NEUTRAL.contrast) {
    eq.push(`contrast=${(0.5 + filters.contrast / 100).toFixed(3)}`);
  }
  if (filters.saturation !== NEUTRAL.saturation) {
    eq.push(`saturation=${(filters.saturation / 50).toFixed(3)}`);
  }
  if (eq.length) filterParts.push(`eq=${eq.join(":")}`);
  if (filters.warmth !== NEUTRAL.warmth) {
    // Midtone color balance toward red (warm) or blue (cool).
    const w = ((filters.warmth - 50) / 100).toFixed(3);
    filterParts.push(`colorbalance=rm=${w}:bm=${(-Number(w)).toFixed(3)}`);
  }
  if (filters.hue !== NEUTRAL.hue) {
    filterParts.push(`hue=h=${((filters.hue - 50) * 1.8).toFixed(1)}`);
  }
  if (filters.sharpen > 0) {
    filterParts.push(`unsharp=5:5:${((filters.sharpen / 100) * 1.5).toFixed(2)}`);
  }
  if (filters.vignette > 0) {
    const angle = Math.PI / 5 + (filters.vignette / 100) * (Math.PI / 2 - Math.PI / 5);
    filterParts.push(`vignette=a=${angle.toFixed(4)}`);
  }
  if (filters.blur > 0) filterParts.push(`gblur=sigma=${(filters.blur / 20).toFixed(2)}`);

  if (!filterParts.length) {
    return NextResponse.json({ error: "No adjustments to apply." }, { status: 400 });
  }

  const raw = await readWorkspaceFile(id, tilePath);
  const parsed = parseJsonFrontmatter(raw);
  const tileId = typeof parsed.meta.id === "string" ? parsed.meta.id : path.basename(tilePath, ".md");
  const localPath =
    typeof parsed.meta.local_path === "string" ? parsed.meta.local_path : null;
  const remoteUrl = typeof parsed.meta.url === "string" ? parsed.meta.url : null;

  // Lambda path filters by URL and re-hosts the result; local path shells out
  // to ffmpeg in a temp workDir that must be cleaned up afterwards.
  let workDir: string | null = null;
  try {
    let edited: Buffer;
    // Workspace media may be unsignable (local desktop mode); fall back to
    // local ffmpeg rather than failing when the Lambda path can't get a URL.
    const lambdaImageUrl = isFFmpegLambdaConfigured()
      ? localPath
        ? await signedWorkspaceMediaUrl(id, safeRelativePath(localPath)).catch(
            () => null,
          )
        : remoteUrl
      : null;
    if (lambdaImageUrl) {
      const filtered = await filterImageRemote({
        imageUrl: lambdaImageUrl,
        filter: filterParts.join(","),
      });
      if (!filtered.success || !filtered.outputUrl) {
        throw new Error(filtered.error || "Image edit failed.");
      }
      const response = await fetch(filtered.outputUrl);
      if (!response.ok) throw new Error(`Failed to fetch edited image (${response.status}).`);
      edited = Buffer.from(await response.arrayBuffer());
    } else {
      workDir = await mkdtemp(path.join(tmpdir(), "vfs-imgedit-"));
      const inputPath = path.join(workDir, "input");
      if (localPath) {
        const media = await readWorkspaceBinaryFile(id, safeRelativePath(localPath));
        await writeFile(inputPath, media.content);
      } else if (remoteUrl) {
        const response = await fetch(remoteUrl);
        if (!response.ok) throw new Error(`Failed to fetch source image (${response.status}).`);
        await writeFile(inputPath, Buffer.from(await response.arrayBuffer()));
      } else {
        return NextResponse.json({ error: "Tile has no media to edit." }, { status: 400 });
      }

      const outputPath = path.join(workDir, "output.png");
      await execFileAsync(
        "ffmpeg",
        ["-i", inputPath, "-vf", filterParts.join(","), "-frames:v", "1", "-y", outputPath],
        { timeout: 60_000 },
      );
      edited = await readFile(outputPath);
    }

    const existingVersions = Array.isArray(parsed.meta.versions) ? parsed.meta.versions : [];
    // The pre-edit media becomes v1 if the tile never tracked versions.
    const baseVersions = existingVersions.length
      ? existingVersions
      : [{ local_path: localPath, url: remoteUrl, version: 1 }];
    const newVersionNumber = baseVersions.length + 1;
    const mediaDir = tilePath.startsWith("uploads/") ? "uploads" : "keyframes";
    const newMediaPath = `media/${mediaDir}/${tileId}.v${newVersionNumber}.png`;
    await writeWorkspaceBinaryFile(id, newMediaPath, edited);

    await writeWorkspaceFile(
      id,
      tilePath,
      withJsonFrontmatter(
        {
          ...parsed.meta,
          local_path: newMediaPath,
          url: null,
          versions: [
            ...baseVersions,
            { local_path: newMediaPath, url: null, version: newVersionNumber },
          ],
        },
        parsed.body,
      ),
    );
    return NextResponse.json(await getProjectSnapshot(id, user.userId));
  } catch (error) {
    const message =
      error instanceof Error ? `Image edit failed: ${error.message}` : "Image edit failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
}
