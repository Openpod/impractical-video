import path from "node:path";
import type { GeneratedMedia } from "@/lib/media";
import {
  mediaVersionState,
  mediaVersionWriteState,
} from "@/lib/media-versions";
import {
  generateFalImage,
  generateFalReferenceVideo,
  generateFalVideo,
  prepareClipForExtension,
  uploadToFalStorage,
} from "@/lib/media";
import { publishPaperEvent } from "@/lib/paper-events";
import {
  checkProject,
  getProjectSnapshot,
  parseJsonFrontmatter,
  readWorkspaceBinaryFile,
  readWorkspaceFile,
  refreshTimeline,
  signedWorkspaceMediaUrl,
  withJsonFrontmatter,
  workspaceAbsolutePath,
  writeWorkspaceBinaryFile,
  writeWorkspaceFile,
  type ProjectSnapshot,
} from "@/lib/workspace";

const ASPECT_RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "artifact"
  );
}

function cleanId(value: string, fallback: string) {
  const clean = value.replace(/^@/, "").replace(/[^a-zA-Z0-9_-]/g, "");
  return clean || fallback;
}

function firstString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstUrl(value: unknown): string | null {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstUrl(item);
      if (url) return url;
    }
  }
  return null;
}

function mediaExtension(contentType: string | null, url: string, fallback: ".png" | ".mp4") {
  const lower = (contentType ?? "").toLowerCase();
  if (lower.includes("image/webp")) return ".webp";
  if (lower.includes("image/jpeg")) return ".jpg";
  if (lower.includes("image/png")) return ".png";
  if (lower.includes("video/webm")) return ".webm";
  if (lower.includes("video/quicktime")) return ".mov";
  if (lower.includes("video/mp4")) return ".mp4";
  const matched = /\.(png|webp|jpe?g|mp4|webm|mov)(?:[?#]|$)/i.exec(url)?.[1];
  return matched ? `.${matched.toLowerCase().replace("jpeg", "jpg")}` : fallback;
}

async function saveRemoteMedia(
  projectId: string,
  relativeBase: string,
  url: string | null | undefined,
  fallback: ".png" | ".mp4",
) {
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) return null;
  const extension = mediaExtension(response.headers.get("content-type"), url, fallback);
  const stored = await writeWorkspaceBinaryFile(
    projectId,
    `${relativeBase}${extension}`,
    Buffer.from(await response.arrayBuffer()),
  );
  return stored.path;
}

async function writeOperation(
  projectId: string,
  input: {
    id: string;
    kind: "generate_image" | "generate_clip";
    prompt: string;
    result: unknown;
    status: "running" | "succeeded" | "failed";
    title: string;
  },
) {
  await writeWorkspaceFile(
    projectId,
    `operations/${input.id}.operation.md`,
    withJsonFrontmatter(
      {
        created_at: new Date().toISOString(),
        id: input.id,
        kind: input.kind,
        status: input.status,
        type: "operation",
      },
      `# ${input.title}\n\n## Prompt\n\n${input.prompt}\n\n## Result\n\n\`\`\`json\n${JSON.stringify(input.result, null, 2).slice(0, 20_000)}\n\`\`\`\n`,
    ),
  );
}

async function writeAsset(
  projectId: string,
  input: {
    assetId: string;
    derivedFrom: string[];
    generation: GeneratedMedia;
    kind: "image" | "video";
    localPath: string | null;
    prompt: string;
    title: string;
    usedIn: string[];
  },
) {
  await writeWorkspaceFile(
    projectId,
    `assets/${input.assetId}.asset.md`,
    withJsonFrontmatter(
      {
        derived_from: input.derivedFrom,
        generated_by: {
          endpoint: input.generation.endpoint,
          provider: input.generation.provider,
        },
        id: input.assetId,
        kind: input.kind,
        local_path: input.localPath,
        status: input.generation.ok && input.generation.url ? "active" : "pending",
        type: "asset",
        url: input.generation.url ?? null,
        used_in: input.usedIn,
      },
      `# ${input.title}\n\n## Prompt\n\n${input.prompt}\n\n## Media\n\n${input.generation.url ?? "Pending or failed generation; inspect operation file."}\n`,
    ),
  );
}

async function fetchableMediaUrl(
  projectId: string,
  snapshot: ProjectSnapshot,
  rawId: string,
): Promise<string | null> {
  const id = cleanId(rawId, rawId);
  let localPath: string | null = null;
  let remoteUrl: string | null = null;

  for (const file of snapshot.files) {
    if (!file.content) continue;
    const parsed = parseJsonFrontmatter(file.content);
    if (parsed.meta.id !== id && parsed.meta.reference_id !== id) continue;
    remoteUrl =
      firstUrl(parsed.meta.url) ??
      firstUrl(parsed.meta.urls) ??
      firstUrl(parsed.meta.source_url) ??
      remoteUrl;
    localPath = firstString(parsed.meta.local_path) ?? localPath;
    if (file.path.endsWith("/reference.md")) continue;
    if (remoteUrl || localPath) break;
  }

  if (remoteUrl) return remoteUrl;
  if (!localPath) return null;
  const signed = await signedWorkspaceMediaUrl(projectId, localPath);
  if (signed) return signed;
  const binary = await readWorkspaceBinaryFile(projectId, localPath);
  const uploaded = await uploadToFalStorage(
    binary.content,
    path.basename(localPath),
    binary.contentType,
  );
  return uploaded.ok ? uploaded.url : null;
}

function referenceDependencies(snapshot: ProjectSnapshot, sourceIds: string[]) {
  const references = new Set<string>();
  const portfolios = new Map<string, string>();
  for (const file of snapshot.files) {
    if (!file.content) continue;
    const meta = parseJsonFrontmatter(file.content).meta;
    if (meta.type === "reference" && typeof meta.id === "string") {
      references.add(meta.id);
    }
    if (
      meta.type === "portfolio" &&
      typeof meta.id === "string" &&
      typeof meta.reference_id === "string"
    ) {
      portfolios.set(meta.reference_id, meta.id);
    }
  }
  const depicts = sourceIds.filter((id) => references.has(id));
  return {
    depicts,
    identityAnchors: depicts
      .map((id) => portfolios.get(id))
      .filter((id): id is string => Boolean(id)),
  };
}

export async function paperCreateScene(input: {
  body: string;
  index: number;
  projectId: string;
  referenceIds?: string[];
  sceneId: string;
  title: string;
}) {
  const sceneId = cleanId(input.sceneId, `scene_${input.index}`);
  const directory = `${String(input.index).padStart(2, "0")}-${slug(input.title).replaceAll("_", "-")}`;
  const scenePath = `scenes/${directory}/scene.md`;
  await writeWorkspaceFile(
    input.projectId,
    scenePath,
    withJsonFrontmatter(
      {
        id: sceneId,
        index: input.index,
        references: input.referenceIds ?? [],
        status: "active",
        type: "scene",
      },
      `# ${input.title}\n\n${input.body}`,
    ),
  );
  publishPaperEvent({
    kind: "changed",
    paths: [scenePath],
    projectId: input.projectId,
    tool: "write",
  });
  return { ok: true, path: scenePath, sceneId };
}

export async function paperScaffoldKeyframe(input: {
  aspectRatio?: string;
  body: string;
  depicts?: string[];
  keyframeId: string;
  projectId: string;
  stateAnchor?: string | null;
  title: string;
}) {
  const keyframeId = cleanId(input.keyframeId, `kf_${Date.now().toString(36)}`);
  const keyframePath = `keyframes/${keyframeId}.md`;
  await writeWorkspaceFile(
    input.projectId,
    keyframePath,
    withJsonFrontmatter(
      {
        aspect_ratio: ASPECT_RATIOS.has(input.aspectRatio ?? "")
          ? input.aspectRatio
          : "16:9",
        depicts: input.depicts ?? [],
        id: keyframeId,
        identity_anchors: [],
        state_anchor: input.stateAnchor ?? null,
        status: "planned",
        type: "keyframe",
      },
      `# ${input.title}\n\n${input.body}`,
    ),
  );
  publishPaperEvent({
    artifactId: keyframeId,
    aspectRatio: input.aspectRatio ?? "16:9",
    kind: "changed",
    paths: [keyframePath],
    projectId: input.projectId,
    title: input.title,
    tool: "write",
  });
  return { keyframeId, ok: true, path: keyframePath };
}

const PORTFOLIO_DISPLAY_SUBJECT: Record<string, string> = {
  characters:
    "a single FULL-BODY shot of the character: standing head-to-toe, filling roughly 85% of the frame height, facing the camera in a relaxed neutral stance on simple clean ground. The face and outfit must be clearly readable. NOT an action pose, NOT running, NOT a distant/wide shot, NOT a close-up crop",
  environments: "a single establishing shot of the location",
  props: "a single clean product-style shot of the object, large in frame",
  styles: "a single cinematic frame that embodies the style",
};

/** Generates a reference portfolio end to end, matching the hosted chat's
 * behavior: the 3x3 contact sheet, then a polished single display/profile
 * shot derived from it (the tile's face), and writes portfolio.md itself —
 * agents never hand-edit portfolio frontmatter. */
export async function paperGenerateReferencePortfolio(input: {
  category: string;
  /** Keep the existing sheet and only (re)derive the display shot. */
  displayOnly?: boolean;
  projectId: string;
  prompt: string;
  referenceId: string;
  /** Project media ids (uploads, other references) to condition the sheet
   * on — e.g. a real photo for likeness plus a style portfolio. */
  sourceIds?: string[];
  title: string;
}) {
  const referenceId = cleanId(input.referenceId, input.referenceId);
  const category = ["characters", "environments", "props", "styles"].includes(
    input.category,
  )
    ? input.category
    : "characters";
  const portfolioPath = `references/${category}/${referenceId}/portfolio.md`;
  const paths = [portfolioPath];
  publishPaperEvent({
    artifactId: `${referenceId}_portfolio`,
    kind: "working",
    paths,
    projectId: input.projectId,
    title: input.title,
    tool: "generate_image",
  });
  let generation: GeneratedMedia;
  if (input.displayOnly) {
    const snapshot = await getProjectSnapshot(input.projectId);
    const existing = snapshot.files.find((file) => file.path === portfolioPath);
    const meta = existing?.content
      ? parseJsonFrontmatter(existing.content).meta
      : {};
    const sheetUrl =
      firstUrl(meta.urls) ??
      firstUrl(meta.url) ??
      // Sheets recorded as local media paths (or living on the sheet's
      // keyframe record) resolve through the standard media resolver.
      (await fetchableMediaUrl(
        input.projectId,
        snapshot,
        `${referenceId}_portfolio`,
      ));
    if (!sheetUrl) {
      publishPaperEvent({
        artifactId: `${referenceId}_portfolio`,
        error: "No existing portfolio sheet to derive a display shot from.",
        kind: "settled",
        ok: false,
        paths,
        projectId: input.projectId,
        status: "failed",
        title: input.title,
        tool: "generate_image",
      });
      return {
        display_url: null,
        error: "No existing portfolio sheet to derive a display shot from.",
        ok: false,
        portfolio_id: `${referenceId}_portfolio`,
        reference_id: referenceId,
        url: null,
      };
    }
    generation = {
      endpoint: "existing-portfolio-sheet",
      ok: true,
      provider: "none",
      url: sheetUrl,
    } as GeneratedMedia;
  } else {
    const sourceIds = [
      ...new Set((input.sourceIds ?? []).map((sourceId) => cleanId(sourceId, sourceId))),
    ];
    let conditioningUrls: string[] = [];
    if (sourceIds.length) {
      const snapshot = await getProjectSnapshot(input.projectId);
      conditioningUrls = (
        await Promise.all(
          sourceIds.map((sourceId) =>
            fetchableMediaUrl(input.projectId, snapshot, sourceId),
          ),
        )
      ).filter((url): url is string => Boolean(url));
    }
    generation = await generateFalImage({
      aspectRatio: "1:1",
      ...(conditioningUrls.length ? { imageUrls: conditioningUrls } : {}),
      prompt: input.prompt,
    });
  }
  let displayUrl: string | null = null;
  if (generation.ok && generation.url) {
    const display = await generateFalImage({
      // References are ALWAYS 1:1 — the anti-grid work is done by the
      // prompt, never by bending the tile's aspect.
      aspectRatio: "1:1",
      imageUrls: [generation.url],
      prompt: `ONE single image. Absolutely not a grid, not a contact sheet, not panels — exactly one frame containing ${
        PORTFOLIO_DISPLAY_SUBJECT[category]
      }. The attached image is a reference sheet of the subject: reproduce that identity, palette, and design language exactly in this one new frame. No text, labels, borders, or panel lines.

Subject: ${input.title}.`,
    });
    if (display.ok && display.url) displayUrl = display.url;
  }
  await writeWorkspaceFile(
    input.projectId,
    portfolioPath,
    withJsonFrontmatter(
      {
        display_url: displayUrl,
        id: `${referenceId}_portfolio`,
        portfolio_format: "3x3_contact_sheet",
        reference_id: referenceId,
        status: generation.url ? "generated" : "planned",
        type: "portfolio",
        urls: generation.url ? [generation.url] : [],
      },
      `# ${input.title}

## Prompt

${input.prompt}

## Media

${
        generation.url ?? "Pending or failed generation; inspect operation file."
      }
`,
    ),
  );
  if ((input.sourceIds ?? []).length && generation.ok) {
    const referencePath = `references/${category}/${referenceId}/reference.md`;
    try {
      const raw = await readWorkspaceFile(input.projectId, referencePath);
      const parsedReference = parseJsonFrontmatter(raw);
      await writeWorkspaceFile(
        input.projectId,
        referencePath,
        withJsonFrontmatter(
          {
            ...parsedReference.meta,
            canvas_derived_from: [
              ...new Set(
                (input.sourceIds ?? []).map((sourceId) =>
                  cleanId(sourceId, sourceId),
                ),
              ),
            ].filter((sourceId) => sourceId !== referenceId),
          },
          parsedReference.body,
        ),
      );
    } catch {
      // Lineage is best-effort; the portfolio itself already succeeded.
    }
  }
  await writeOperation(input.projectId, {
    id: `op_portfolio_${referenceId}`,
    kind: "generate_image",
    prompt: input.prompt,
    result: {
      ...generation,
      conditioning_source_ids: input.sourceIds ?? [],
      display_url: displayUrl,
    },
    status: generation.ok ? "succeeded" : "failed",
    title: input.title,
  });
  publishPaperEvent({
    artifactId: `${referenceId}_portfolio`,
    error: generation.error ?? undefined,
    kind: "settled",
    ok: generation.ok,
    paths,
    projectId: input.projectId,
    status: generation.ok ? "succeeded" : "failed",
    title: input.title,
    tool: "generate_image",
  });
  return {
    display_url: displayUrl,
    error: generation.error ?? null,
    ok: generation.ok,
    portfolio_id: `${referenceId}_portfolio`,
    reference_id: referenceId,
    url: generation.url ?? null,
  };
}

export async function paperGenerateImage(input: {
  aspectRatio?: string;
  projectId: string;
  prompt: string;
  referenceOrKeyframeId: string;
  sourceIds?: string[];
  title: string;
}) {
  const id = cleanId(
    input.referenceOrKeyframeId,
    `paper_image_${Date.now().toString(36)}`,
  );
  const aspectRatio = ASPECT_RATIOS.has(input.aspectRatio ?? "")
    ? input.aspectRatio!
    : "16:9";
  const snapshot = await getProjectSnapshot(input.projectId);
  const sourceIds = [...new Set((input.sourceIds ?? []).map((sourceId) => cleanId(sourceId, sourceId)))];
  const targetMediaUrl = sourceIds.includes(id)
    ? null
    : await fetchableMediaUrl(input.projectId, snapshot, id);
  const conditioningIds = targetMediaUrl ? [id, ...sourceIds] : sourceIds;
  const imageUrls = (
    await Promise.all(sourceIds.map((sourceId) => fetchableMediaUrl(input.projectId, snapshot, sourceId)))
  ).filter((url): url is string => Boolean(url));
  if (targetMediaUrl) imageUrls.unshift(targetMediaUrl);
  const { depicts, identityAnchors } = referenceDependencies(snapshot, sourceIds);
  const assetId = `asset_${id}`;
  const operationId = `op_${assetId}`;
  const keyframePath = `keyframes/${id}.md`;
  const existingKeyframe = snapshot.files.find(
    (file) => file.path === keyframePath,
  )?.content;
  const existingMeta = existingKeyframe
    ? parseJsonFrontmatter(existingKeyframe).meta
    : {};
  const versionState = mediaVersionState(existingMeta);
  const paths = [
    keyframePath,
    `prompts/${assetId}.prompt.md`,
    `assets/${assetId}.asset.md`,
    `operations/${operationId}.operation.md`,
  ];

  await writeWorkspaceFile(
    input.projectId,
    `prompts/${assetId}.prompt.md`,
    withJsonFrontmatter(
      { asset_id: assetId, id: `prompt_${id}`, status: "active", type: "prompt" },
      input.prompt,
    ),
  );
  await writeWorkspaceFile(
    input.projectId,
    keyframePath,
    withJsonFrontmatter(
      {
        ...existingMeta,
        aspect_ratio: aspectRatio,
        asset_id: assetId,
        canvas_composed: true,
        depicts,
        id,
        identity_anchors: identityAnchors,
        status: "generating",
        type: "keyframe",
      },
      `# ${input.title}\n\n## Prompt\n\n${input.prompt}\n\n## Media\n\nGeneration in progress.\n`,
    ),
  );
  await writeOperation(input.projectId, {
    id: operationId,
    kind: "generate_image",
    prompt: input.prompt,
    result: { state: "running" },
    status: "running",
    title: input.title,
  });
  publishPaperEvent({
    artifactId: id,
    aspectRatio,
    kind: "working",
    paths,
    projectId: input.projectId,
    title: input.title,
    tool: "generate_image",
  });

  const generation = await generateFalImage({
    aspectRatio,
    imageUrls: imageUrls.length ? imageUrls : undefined,
    prompt: input.prompt,
  });
  const localPath = await saveRemoteMedia(
    input.projectId,
    `media/keyframes/${id}.v${versionState.nextVersion}`,
    generation.url,
    ".png",
  );
  const versionWriteState = mediaVersionWriteState(existingMeta, {
    emptyStatus: "planned",
    localPath,
    successStatus: "generated",
    url: generation.url,
  });
  await writeAsset(input.projectId, {
    assetId,
    derivedFrom: conditioningIds,
    generation,
    kind: "image",
    localPath,
    prompt: input.prompt,
    title: input.title,
    usedIn: [id],
  });
  await writeWorkspaceFile(
    input.projectId,
    keyframePath,
    withJsonFrontmatter(
      {
        ...existingMeta,
        aspect_ratio: aspectRatio,
        asset_id: assetId,
        canvas_composed: true,
        depicts,
        id,
        identity_anchors: identityAnchors,
        local_path: versionWriteState.active?.local_path ?? null,
        status: versionWriteState.status,
        type: "keyframe",
        url: versionWriteState.active?.url ?? null,
        versions: versionWriteState.versions,
      },
      `# ${input.title}\n\n## Prompt\n\n${input.prompt}\n\n## Media\n\n${generation.url ?? "Pending or failed generation; inspect operation file."}\n`,
    ),
  );
  await writeOperation(input.projectId, {
    id: operationId,
    kind: "generate_image",
    prompt: input.prompt,
    result: generation,
    status: generation.ok ? "succeeded" : "failed",
    title: input.title,
  });
  publishPaperEvent({
    artifactId: id,
    aspectRatio,
    error: generation.error ?? undefined,
    kind: "settled",
    ok: generation.ok,
    paths,
    projectId: input.projectId,
    status: generation.ok ? "succeeded" : "failed",
    title: input.title,
    tool: "generate_image",
  });
  return {
    assetId,
    error: generation.error ?? null,
    id,
    localPath,
    ok: generation.ok,
    operationId,
    url: generation.url ?? null,
    version: versionState.nextVersion,
  };
}

/** In-flight clip generations by project:clip key. A generation that outlives
 * a client timeout must not be silently duplicated by a retry — the retry gets
 * a fast, explicit "still running" error instead of a second provider bill. */
const inFlightClipGenerations = (globalThis as typeof globalThis & {
  __videoFsInFlightClips?: Set<string>;
}).__videoFsInFlightClips ??= new Set<string>();

export async function paperGenerateClip(input: {
  aspectRatio?: string;
  clipId: string;
  durationSeconds?: number;
  /** Previous clip to continue from: it becomes @Video1 on Seedance's
   * reference-to-video endpoint, which extends the actual footage instead of
   * imitating a still frame. */
  extendsClipId?: string | null;
  fromKeyframeId?: string | null;
  projectId: string;
  prompt: string;
  /** Reference/portfolio/keyframe ids attached as @Image1..@ImageN, in order.
   * Carry the character identity into every chained generation. */
  referenceIds?: string[];
  sceneId: string;
  title: string;
  toKeyframeId?: string | null;
}) {
  const clipId = cleanId(input.clipId, `paper_clip_${Date.now().toString(36)}`);
  const inFlightKey = `${input.projectId}:${clipId}`;
  if (inFlightClipGenerations.has(inFlightKey)) {
    throw new Error(
      `Clip "${clipId}" is already generating. Do not retry — wait, then read its record or check_project; the running generation will land on its own.`,
    );
  }
  inFlightClipGenerations.add(inFlightKey);
  try {
    return await generateClipInner(input, clipId);
  } finally {
    inFlightClipGenerations.delete(inFlightKey);
  }
}

async function generateClipInner(
  input: Parameters<typeof paperGenerateClip>[0],
  clipId: string,
) {
  const sceneId = cleanId(input.sceneId, input.sceneId);
  const aspectRatio = ASPECT_RATIOS.has(input.aspectRatio ?? "")
    ? input.aspectRatio!
    : "16:9";
  const durationSeconds = Math.min(15, Math.max(4, Math.round(input.durationSeconds ?? 5)));
  const snapshot = await getProjectSnapshot(input.projectId);
  const sceneExists = snapshot.files.some((file) => {
    if (!file.content || !file.path.endsWith("/scene.md")) return false;
    return parseJsonFrontmatter(file.content).meta.id === sceneId;
  });
  if (!sceneExists) throw new Error(`Scene "${sceneId}" does not exist.`);
  const fromKeyframeId = input.fromKeyframeId
    ? cleanId(input.fromKeyframeId, input.fromKeyframeId)
    : null;
  const toKeyframeId = input.toKeyframeId
    ? cleanId(input.toKeyframeId, input.toKeyframeId)
    : null;
  const imageUrl = fromKeyframeId
    ? await fetchableMediaUrl(input.projectId, snapshot, fromKeyframeId)
    : null;
  const endImageUrl = toKeyframeId
    ? await fetchableMediaUrl(input.projectId, snapshot, toKeyframeId)
    : null;
  if (fromKeyframeId && !imageUrl) {
    throw new Error(`Keyframe "${fromKeyframeId}" has no usable media.`);
  }
  if (toKeyframeId && !endImageUrl) {
    throw new Error(`Keyframe "${toKeyframeId}" has no usable media.`);
  }
  const extendsClipId = input.extendsClipId
    ? cleanId(input.extendsClipId, input.extendsClipId)
    : null;
  if (extendsClipId && (fromKeyframeId || toKeyframeId)) {
    throw new Error(
      "extendsClipId continues the previous clip's actual footage; keyframe pins do not apply. Pass either extendsClipId (chaining) or keyframe ids (interpolation), not both.",
    );
  }
  const referenceIds = (input.referenceIds ?? [])
    .map((id) => cleanId(id, id))
    .filter(Boolean);
  const referenceImageUrls: string[] = [];
  for (const referenceId of referenceIds) {
    const url = await fetchableMediaUrl(input.projectId, snapshot, referenceId);
    if (!url) throw new Error(`Reference "${referenceId}" has no usable media.`);
    referenceImageUrls.push(url);
  }
  let referenceVideoUrl: string | null = null;
  if (extendsClipId) {
    let clipLocalPath: string | null = null;
    for (const file of snapshot.files) {
      if (!file.content || !file.path.endsWith(`clips/${extendsClipId}.md`)) continue;
      const meta = parseJsonFrontmatter(file.content).meta;
      clipLocalPath = firstString(meta.local_path) ?? null;
    }
    if (!clipLocalPath) {
      throw new Error(`Clip "${extendsClipId}" has no local media to extend from.`);
    }
    const absolute = workspaceAbsolutePath(input.projectId, clipLocalPath);
    const prepared = await prepareClipForExtension({ localPath: absolute });
    if (!prepared.ok) throw new Error(prepared.error);
    const uploaded = await uploadToFalStorage(
      prepared.buffer,
      `${extendsClipId}-extend-input.mp4`,
      "video/mp4",
    );
    if (!uploaded.ok) throw new Error(uploaded.error);
    referenceVideoUrl = uploaded.url;
  }
  const assetId = `asset_${clipId}`;
  const operationId = `op_${assetId}`;
  const clipPath = `clips/${clipId}.md`;
  const paths = [
    clipPath,
    `prompts/${assetId}.prompt.md`,
    `assets/${assetId}.asset.md`,
    `operations/${operationId}.operation.md`,
    "timeline.json",
  ];

  await writeWorkspaceFile(
    input.projectId,
    `prompts/${assetId}.prompt.md`,
    withJsonFrontmatter(
      {
        asset_id: assetId,
        clip_id: clipId,
        id: `prompt_${clipId}`,
        status: "active",
        type: "prompt",
      },
      input.prompt,
    ),
  );
  await writeWorkspaceFile(
    input.projectId,
    clipPath,
    withJsonFrontmatter(
      {
        aspect_ratio: aspectRatio,
        asset_id: assetId,
        duration_seconds: durationSeconds,
        end_trust: toKeyframeId ? "pinned" : "unknown",
        extends_clip: extendsClipId,
        from_keyframe: fromKeyframeId,
        generated_seconds: durationSeconds,
        id: clipId,
        in_timeline: true,
        index: Date.now(),
        scene: sceneId,
        status: "generating",
        to_keyframe: toKeyframeId,
        type: "clip",
      },
      `# ${input.title}\n\n## Prompt\n\n${input.prompt}\n\n## Media\n\nGeneration in progress.\n`,
    ),
  );
  await writeOperation(input.projectId, {
    id: operationId,
    kind: "generate_clip",
    prompt: input.prompt,
    result: { state: "running" },
    status: "running",
    title: input.title,
  });
  publishPaperEvent({
    artifactId: clipId,
    aspectRatio,
    kind: "working",
    paths,
    projectId: input.projectId,
    title: input.title,
    tool: "generate_clip",
  });

  const generation = referenceVideoUrl || referenceImageUrls.length
    ? await generateFalReferenceVideo({
        aspectRatio,
        duration: String(durationSeconds),
        prompt: input.prompt,
        referenceImageUrls,
        referenceVideoUrls: referenceVideoUrl ? [referenceVideoUrl] : undefined,
      })
    : await generateFalVideo({
        aspectRatio,
        duration: String(durationSeconds),
        endImageUrl,
        imageUrl,
        prompt: input.prompt,
      });
  const localPath = await saveRemoteMedia(
    input.projectId,
    `media/clips/${clipId}.v1`,
    generation.url,
    ".mp4",
  );
  await writeAsset(input.projectId, {
    assetId,
    derivedFrom: [fromKeyframeId, toKeyframeId, extendsClipId, ...referenceIds].filter(
      (id): id is string => Boolean(id),
    ),
    generation,
    kind: "video",
    localPath,
    prompt: input.prompt,
    title: input.title,
    usedIn: [clipId],
  });
  await writeWorkspaceFile(
    input.projectId,
    clipPath,
    withJsonFrontmatter(
      {
        aspect_ratio: aspectRatio,
        asset_id: assetId,
        duration_seconds: durationSeconds,
        end_trust: toKeyframeId ? "pinned" : "unknown",
        extends_clip: extendsClipId,
        from_keyframe: fromKeyframeId,
        generated_seconds: durationSeconds,
        id: clipId,
        in_timeline: true,
        index: Date.now(),
        local_path: localPath,
        scene: sceneId,
        transition_from_previous: extendsClipId ? "continuous" : undefined,
        status: generation.ok && generation.url ? "active" : "pending",
        to_keyframe: toKeyframeId,
        type: "clip",
        url: generation.url ?? null,
        versions: localPath || generation.url
          ? [{ local_path: localPath, url: generation.url ?? null, version: 1 }]
          : [],
      },
      `# ${input.title}\n\n## Prompt\n\n${input.prompt}\n\n## Media\n\n${generation.url ?? "Pending or failed generation; inspect operation file."}\n`,
    ),
  );
  await refreshTimeline(input.projectId);
  await writeOperation(input.projectId, {
    id: operationId,
    kind: "generate_clip",
    prompt: input.prompt,
    result: generation,
    status: generation.ok ? "succeeded" : "failed",
    title: input.title,
  });
  publishPaperEvent({
    artifactId: clipId,
    aspectRatio,
    error: generation.error ?? undefined,
    kind: "settled",
    ok: generation.ok,
    paths,
    projectId: input.projectId,
    status: generation.ok ? "succeeded" : "failed",
    title: input.title,
    tool: "generate_clip",
  });
  return {
    assetId,
    clipId,
    error: generation.error ?? null,
    localPath,
    ok: generation.ok,
    operationId,
    url: generation.url ?? null,
  };
}

export async function paperCheckProject(projectId: string) {
  return checkProject(projectId);
}

export async function paperGetProjectStatus(projectId: string) {
  const snapshot = await getProjectSnapshot(projectId);
  const counts = {
    assets: 0,
    clips: 0,
    keyframes: 0,
    operations: 0,
    references: 0,
    scenes: 0,
  };
  const running: Array<{ id: string; kind: string; path: string; title: string }> = [];
  for (const file of snapshot.files) {
    if (!file.content) continue;
    const parsed = parseJsonFrontmatter(file.content);
    const type = firstString(parsed.meta.type);
    if (type === "asset") counts.assets += 1;
    if (type === "clip") counts.clips += 1;
    if (type === "keyframe") counts.keyframes += 1;
    if (type === "operation") counts.operations += 1;
    if (type === "reference") counts.references += 1;
    if (type === "scene") counts.scenes += 1;
    if (parsed.meta.status === "running" || parsed.meta.status === "generating") {
      running.push({
        id: firstString(parsed.meta.id) ?? file.path,
        kind: type ?? "file",
        path: file.path,
        title: parsed.body.split("\n").find((line) => line.startsWith("# "))?.slice(2) ?? file.path,
      });
    }
  }
  return {
    check: snapshot.check,
    counts,
    project: snapshot.project,
    running,
    timelineItems: snapshot.timeline.length,
  };
}
