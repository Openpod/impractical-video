import path from "node:path";
import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { billingEnabled, chargeForOp, getCreditBalance, quoteOp } from "@/lib/credits-service";
import type { BillableOp } from "@/lib/usage-pricing";
import { formatCanvasChatRequest } from "@/lib/canvas-chat";
import {
  extractVideoFrame,
  generateFalImage,
  generateFalVideo,
} from "@/lib/media";
import {
  appendChat,
  hostProjectBytes,
  signedWorkspaceMediaUrl,
  getProjectSnapshot,
  parseJsonFrontmatter,
  projectRoot,
  readWorkspaceBinaryFile,
  readWorkspaceFile,
  refreshTimeline,
  safeRelativePath,
  withJsonFrontmatter,
  writeWorkspaceBinaryFile,
  writeWorkspaceFile,
} from "@/lib/workspace";

type Params = {
  params: Promise<{ id: string }>;
};

type Annotation =
  | {
      height: number;
      timestampSeconds?: number;
      type: "rect";
      width: number;
      x: number;
      y: number;
    }
  | {
      points: Array<{ x: number; y: number }>;
      timestampSeconds?: number;
      type: "freehand";
    };

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 42) || "canvas_edit";
}

function firstUrl(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = firstUrl(item);
      if (nested) return nested;
    }
  }
  return null;
}

function mentionIds(text: string) {
  return [...new Set([...text.matchAll(/@([A-Za-z0-9_-]+)/g)].map((match) => match[1]!))];
}

function contentTypeForPath(filePath: string) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

async function falUrlForWorkspaceMedia(projectId: string, mediaPath: string) {
  if (/^https?:\/\//i.test(mediaPath)) return mediaPath;
  const safe = safeRelativePath(mediaPath);
  // Our storage or nothing: time-limited Supabase signed URL. Generation
  // inputs are never re-hosted on third-party (fal) storage.
  const signed = await signedWorkspaceMediaUrl(projectId, safe);
  if (!signed) {
    throw new Error(`Workspace media "${safe}" could not be signed — Supabase storage hosting required.`);
  }
  return signed;
}

async function seedImageFromSource(input: {
  annotations: Annotation[];
  projectId: string;
  sourceKind: "clip" | "keyframe" | "upload";
  sourcePath: string;
  timestampSeconds: number;
}) {
  const raw = await readWorkspaceFile(input.projectId, input.sourcePath);
  const parsed = parseJsonFrontmatter(raw);
  const url = typeof parsed.meta.url === "string" ? parsed.meta.url : null;
  const localPath = typeof parsed.meta.local_path === "string" ? parsed.meta.local_path : null;
  const aspectRatio =
    typeof parsed.meta.aspect_ratio === "string" ? parsed.meta.aspect_ratio : null;

  // Uploaded images seed directly; uploaded videos fall through to the
  // frame-extraction path below, same as clips.
  const uploadIsImage = input.sourceKind === "upload" && parsed.meta.kind !== "video";
  if (input.sourceKind === "keyframe" || uploadIsImage) {
    if (url) return { aspectRatio, isImageSource: true, url };
    if (!localPath) throw new Error("Selected tile has no media.");
    return {
      aspectRatio,
      isImageSource: true,
      url: await falUrlForWorkspaceMedia(input.projectId, localPath),
    };
  }
  if (!url && !localPath) throw new Error("Selected clip has no media.");

  const timestamp =
    input.annotations.find((annotation) => typeof annotation.timestampSeconds === "number")
      ?.timestampSeconds ??
    input.timestampSeconds ??
    (typeof parsed.meta.duration_seconds === "number" ? parsed.meta.duration_seconds / 2 : 0.5);
  const frame = await extractVideoFrame({
    seconds: Math.max(0, timestamp),
    videoUrl: url ?? path.join(projectRoot(input.projectId), safeRelativePath(localPath ?? "")),
  });
  if (!frame.ok) throw new Error(frame.error);
  const hosted = await hostProjectBytes(
    input.projectId,
    `${slug(String(parsed.meta.id ?? "clip"))}-seed.png`,
    frame.buffer,
  );
  if (!hosted.ok) throw new Error(hosted.error);
  return { aspectRatio, isImageSource: false, url: hosted.url };
}

async function resolveReferenceUrls(projectId: string, instruction: string) {
  const ids = mentionIds(instruction);
  if (!ids.length) return [] as Array<{ id: string; url: string }>;
  const snapshot = await getProjectSnapshot(projectId);
  const refs: Array<{ id: string; url: string }> = [];
  for (const id of ids) {
    const portfolio = snapshot.files.find((file) => {
      if (!file.path.endsWith("/portfolio.md") || !file.content) return false;
      const parsed = parseJsonFrontmatter(file.content);
      const referenceId =
        typeof parsed.meta.reference_id === "string" ? parsed.meta.reference_id : null;
      const portfolioId = typeof parsed.meta.id === "string" ? parsed.meta.id : null;
      return referenceId === id || portfolioId === id || portfolioId === `${id}_portfolio`;
    });
    if (!portfolio?.content) continue;
    const parsed = parseJsonFrontmatter(portfolio.content);
    const url = firstUrl(parsed.meta.urls);
    if (!url) continue;
    refs.push({ id, url: await falUrlForWorkspaceMedia(projectId, url) });
  }
  return refs;
}

async function saveRemoteMedia(projectId: string, relativePath: string, url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download generated media (${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeWorkspaceBinaryFile(projectId, relativePath, buffer);
  return relativePath;
}

function annotationSummary(annotations: Annotation[]) {
  if (!annotations.length) return "No drawn annotations.";
  return annotations
    .map((annotation, index) => {
      if (annotation.type === "rect") {
        return `${index + 1}. rectangle at x=${annotation.x.toFixed(3)}, y=${annotation.y.toFixed(3)}, width=${annotation.width.toFixed(3)}, height=${annotation.height.toFixed(3)}, t=${(annotation.timestampSeconds ?? 0).toFixed(2)}s`;
      }
      return `${index + 1}. freehand mark with ${annotation.points.length} points, t=${(annotation.timestampSeconds ?? 0).toFixed(2)}s`;
    })
    .join("\n");
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to generate canvas changes." }, { status: 401 });
  }
  await getProjectSnapshot(id, user.userId);

  const body = await request.json().catch(() => ({}));
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
  const source = body.source && typeof body.source === "object" ? body.source as Record<string, unknown> : {};
  const sourcePath = typeof source.path === "string" ? safeRelativePath(source.path) : "";
  const sourceKind = sourcePath.startsWith("uploads/")
    ? "upload"
    : source.kind === "keyframe"
      ? "keyframe"
      : "clip";
  const sourceId = typeof source.id === "string" ? source.id : slug(sourcePath);
  const sourceTitle = typeof source.title === "string" ? source.title : sourceId;
  const annotations = Array.isArray(body.annotations) ? body.annotations as Annotation[] : [];
  const frame =
    body.frame && typeof body.frame === "object"
      ? body.frame as Record<string, unknown>
      : {};
  const timestampSeconds =
    typeof frame.timestampSeconds === "number" ? frame.timestampSeconds : 0;

  if (!instruction) {
    return NextResponse.json({ error: "Instruction is required." }, { status: 400 });
  }
  if (!/^(clips|keyframes|uploads)\/[^/]+\.md$/.test(sourcePath)) {
    return NextResponse.json({ error: "Unsupported canvas source." }, { status: 400 });
  }

  await appendChat(id, {
    role: "user",
    text: formatCanvasChatRequest(
      { kind: annotations.length ? "draw" : "edit", title: sourceTitle },
      instruction,
    ),
  });

  try {
    const seed = await seedImageFromSource({
      annotations,
      projectId: id,
      sourceKind,
      sourcePath,
      timestampSeconds,
    });
    const seedUrl = seed.url;
    const aspectRatio = seed.aspectRatio ?? "16:9";
    const references = await resolveReferenceUrls(id, instruction);
    const referenceLegend = references.length
      ? `\n\nReferenced identity images: ${references.map((ref) => `@${ref.id}`).join(", ")}. Use them as binding references when the request names them.`
      : "";
    const markLegend = annotationSummary(annotations);
    const editPrompt = [
      `Edit this selected source frame from "${sourceTitle}".`,
      `User request: ${instruction}`,
      referenceLegend.trim(),
      `Drawn annotations:\n${markLegend}`,
      "Keep the composition, physical camera feel, and useful source motion direction unless the request says to change them.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const editOp: BillableOp = { kind: "image", tool: "regenerate.editStill", resolution: "1K" };
    if (billingEnabled()) {
      const required = quoteOp(editOp);
      const balance = await getCreditBalance(user.userId);
      if (balance.total < required) {
        throw new Error(
          `Insufficient credits: this edit needs ${required} credits but the account has ${balance.total}.`,
        );
      }
    }
    const editedStill = await generateFalImage({
      aspectRatio,
      imageUrls: [seedUrl, ...references.map((ref) => ref.url)],
      prompt: editPrompt,
    });
    if (!editedStill.ok || !editedStill.url) {
      throw new Error(editedStill.error || "Failed to create edited first frame.");
    }
    if (billingEnabled()) {
      await chargeForOp({
        userId: user.userId,
        op: editOp,
        projectId: id,
        idempotencyKey: `regenerate.editStill:${editedStill.url}`,
        description: `regenerate.editStill (${id})`,
        artifact: { title: sourceTitle, url: editedStill.url },
      }).catch(() => {});
    }

    // Editing an image yields an image — persist the edited still as a new
    // keyframe tile and stop. Only video sources continue on to Seedance.
    if (seed.isImageSource) {
      const keyframeId = `${slug(sourceId)}_edit_${Date.now().toString(36)}`;
      const stillLocalPath = await saveRemoteMedia(
        id,
        `media/keyframes/${keyframeId}.v1.png`,
        editedStill.url,
      );
      await writeWorkspaceFile(
        id,
        `keyframes/${keyframeId}.md`,
        withJsonFrontmatter(
          {
            annotations,
            aspect_ratio: aspectRatio,
            canvas_derived_from: sourceId,
            id: keyframeId,
            local_path: stillLocalPath,
            status: "generated",
            type: "keyframe",
            url: editedStill.url,
            versions: [{ local_path: stillLocalPath, url: editedStill.url, version: 1 }],
          },
          `# ${sourceTitle} edit\n\n## Request\n\n${instruction}\n\n## Prompt\n\n${editPrompt}\n\n## Annotations\n\n${markLegend}\n\n## Media\n\n${editedStill.url}\n`,
        ),
      );
      await appendChat(id, {
        role: "assistant",
        text: `Applied your edit to "${sourceTitle}" — the new image is on the canvas.`,
      });
      return NextResponse.json(await getProjectSnapshot(id, user.userId));
    }

    const videoPrompt = [
      `Animate the edited frame into a short coherent video clip.`,
      `User request: ${instruction}`,
      "Preserve the selected tile's grounded style and make the change visible without adding unrelated sci-fi or digital artifacts.",
    ].join("\n\n");
    const videoOp: BillableOp = {
      kind: "clip",
      tool: "regenerate.video",
      pinned: false,
      resolution: "720p",
      seconds: 5,
    };
    if (billingEnabled()) {
      const required = quoteOp(videoOp);
      const balance = await getCreditBalance(user.userId);
      if (balance.total < required) {
        throw new Error(
          `Insufficient credits: this regeneration needs ${required} credits but the account has ${balance.total}.`,
        );
      }
    }
    const generated = await generateFalVideo({
      aspectRatio,
      duration: "5",
      imageUrl: editedStill.url,
      prompt: videoPrompt,
    });
    if (!generated.ok || !generated.url) {
      throw new Error(generated.error || "Failed to generate video.");
    }
    if (billingEnabled()) {
      await chargeForOp({
        userId: user.userId,
        op: videoOp,
        projectId: id,
        idempotencyKey: `regenerate.video:${generated.url}`,
        description: `regenerate.video (${id})`,
        artifact: { title: sourceTitle, url: generated.url },
      }).catch(() => {});
    }

    const clipId = `${slug(sourceId)}_edit_${Date.now().toString(36)}`;
    const assetId = `asset_${clipId}`;
    const clipLocalPath = await saveRemoteMedia(
      id,
      `media/clips/${clipId}.v1.mp4`,
      generated.url,
    );
    const stillLocalPath = await saveRemoteMedia(
      id,
      `media/keyframes/${clipId}_seed.v1.png`,
      editedStill.url,
    );

    await writeWorkspaceFile(
      id,
      `prompts/${assetId}.prompt.md`,
      withJsonFrontmatter(
        {
          clip_id: clipId,
          compiler: "canvas-regenerate",
          id: `prompt_${clipId}`,
          status: "active",
          type: "prompt",
        },
        videoPrompt,
      ),
    );
    await writeWorkspaceFile(
      id,
      `assets/${assetId}.asset.md`,
      withJsonFrontmatter(
        {
          derived_from: [sourceId],
          id: assetId,
          kind: "video",
          local_path: clipLocalPath,
          status: "active",
          type: "asset",
          url: generated.url,
          used_in: [clipId],
        },
        `# ${sourceTitle} edit\n\n${instruction}\n`,
      ),
    );
    await writeWorkspaceFile(
      id,
      `clips/${clipId}.md`,
      withJsonFrontmatter(
        {
          annotations,
          asset_id: assetId,
          aspect_ratio: aspectRatio,
          canvas_derived_from: sourceId,
          duration_seconds: 5,
          generated_seconds: 5,
          id: clipId,
          in_timeline: true,
          index: Date.now(),
          local_path: clipLocalPath,
          seed_image_local_path: stillLocalPath,
          seed_image_url: editedStill.url,
          status: "active",
          type: "clip",
          url: generated.url,
          versions: [{ local_path: clipLocalPath, url: generated.url, version: 1 }],
        },
        `# ${sourceTitle} edit\n\n## Request\n\n${instruction}\n\n## Prompt\n\n${videoPrompt}\n\n## Annotations\n\n${markLegend}\n\n## Media\n\n${generated.url}\n`,
      ),
    );

    await refreshTimeline(id);
    await appendChat(id, {
      role: "assistant",
      text: `Applied your canvas edit to "${sourceTitle}" — the new clip is on the canvas.`,
    });
    return NextResponse.json(await getProjectSnapshot(id, user.userId));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to generate canvas change.";
    await appendChat(id, {
      role: "assistant",
      text: `Canvas edit on "${sourceTitle}" failed: ${message}`,
    }).catch(() => {});
    const status = /insufficient credits/i.test(message) ? 402 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
