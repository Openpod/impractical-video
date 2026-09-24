import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CanvasContextIdentityError,
  resolveCanvasContextIdentity,
  resolvedCanvasContextArtifactSchema,
  verifyCanvasContextIdentity,
  type ResolvedCanvasContextArtifact,
} from "@/lib/canvas-context-identity";
import { appendArtifactVersion } from "@/lib/canvas-revision";
import {
  publishEditorCommandEvent,
  type EditorCommandName,
} from "@/lib/editor-events";
import {
  listProjectFiles,
  parseJsonFrontmatter,
  readWorkspaceFile,
  safeRelativePath,
  writeWorkspaceFile,
} from "@/lib/workspace";
import {
  applyDeleteElementsMutation,
  applyInsertElementMutation,
  applyMoveElementsMutation,
  applySplitElementsMutation,
  applyUpdateElementsMutation,
} from "@opencut/commands/timeline/element/mutations";
import { findTrackInSceneTracks } from "@opencut/timeline";
import type {
  CreateTimelineElement,
  SceneTracks,
  TimelineElement,
} from "@opencut/timeline";
import type { MediaTime } from "@opencut/wasm";

export type EditorCommandInverse =
  | { sceneId: string; tracks: SceneTracks }
  | { project: EditorDocument["project"] };

export const EDITOR_DOC_PATH = "editor/opencut-project.json";

export const stableIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
export const tickSchema = z.number().int().nonnegative();
export const actorSchema = z
  .object({
    id: stableIdSchema,
    type: z.enum(["agent", "system", "user"]),
  })
  .strict();
export const originSchema = z.enum(["api", "claude", "codex", "mcp"]);
const targetSchema = z
  .object({
    artifact: resolvedCanvasContextArtifactSchema,
    elementId: stableIdSchema,
    trackId: stableIdSchema,
  })
  .strict();
export const mutationBase = {
  actor: actorSchema,
  baseEditorRevision: z.number().int().nonnegative(),
  commandId: stableIdSchema,
  idempotencyKey: stableIdSchema,
  origin: originSchema,
  projectId: stableIdSchema,
  sceneId: stableIdSchema.optional(),
};

export const editorTimelineCommandSchema = z.discriminatedUnion("tool", [
  z
    .object({
      ...mutationBase,
      artifact: resolvedCanvasContextArtifactSchema,
      durationTicks: z.number().int().positive(),
      elementId: stableIdSchema.optional(),
      name: z.string().trim().min(1).max(500).optional(),
      startTimeTicks: tickSchema,
      tool: z.literal("editor_timeline_insert"),
      trackId: stableIdSchema,
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      newStartTimeTicks: tickSchema,
      target: targetSchema,
      targetTrackId: stableIdSchema,
      tool: z.literal("editor_timeline_move"),
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      durationTicks: z.number().int().positive(),
      target: targetSchema,
      tool: z.literal("editor_timeline_trim"),
      trimEndTicks: tickSchema,
      trimStartTicks: tickSchema,
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      rightElementId: stableIdSchema.optional(),
      splitTimeTicks: z.number().int().positive(),
      target: targetSchema,
      tool: z.literal("editor_timeline_split"),
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      targets: z.array(targetSchema).min(1).max(100),
      tool: z.literal("editor_timeline_remove"),
    })
    .strict(),
]);

export type EditorTimelineCommand = z.infer<
  typeof editorTimelineCommandSchema
>;

type EditorMediaMapEntry = {
  durationSeconds?: number | null;
  kind?: string;
  mediaId: string;
  name: string;
  sourceKey?: string;
};

export type EditorCommandReceipt = {
  actor: z.infer<typeof actorSchema>;
  affectedElementIds: string[];
  command: EditorCommandName;
  commandId: string;
  completedAt: string;
  idempotencyKey: string;
  inputHash: string;
  inverse: EditorCommandInverse;
  newRevision: number;
  origin: z.infer<typeof originSchema>;
  priorRevision: number;
  recoverable: true;
  status: "completed";
  summary?: Record<string, unknown>;
};

export type EditorDocument = {
  commandHistory?: EditorCommandReceipt[];
  mediaMap: Record<string, EditorMediaMapEntry>;
  pendingPlacements?: unknown[];
  project: Record<string, unknown> & {
    currentSceneId?: string;
    metadata?: Record<string, unknown>;
    scenes: Array<
      Record<string, unknown> & {
        id: string;
        isMain?: boolean;
        tracks: SceneTracks;
      }
    >;
  };
  revision: number;
  source?: string;
  updatedAt?: string;
};

export type EditorTimelineCommandResult = {
  affectedElementIds: string[];
  command: EditorCommandName;
  commandId: string;
  idempotentReplay: boolean;
  inverse: EditorCommandInverse;
  newRevision: number;
  priorRevision: number;
  recoverable: true;
};

export class EditorTimelineError extends Error {
  constructor(
    readonly code:
      | "EDITOR_ARTIFACT_MISMATCH"
      | "EDITOR_COMMAND_CONFLICT"
      | "EDITOR_DOCUMENT_INVALID"
      | "EDITOR_NOT_READY"
      | "EDITOR_REVISION_CONFLICT"
      | "EDITOR_TARGET_NOT_FOUND"
      | "EDITOR_VALIDATION_FAILED",
    message: string,
    readonly status: number,
    readonly remediation: string | null = null,
  ) {
    super(message);
  }
}

const globalForEditorLocks = globalThis as typeof globalThis & {
  __videoFsEditorLocks?: Map<string, Promise<void>>;
};
const projectLocks =
  globalForEditorLocks.__videoFsEditorLocks ?? new Map<string, Promise<void>>();
globalForEditorLocks.__videoFsEditorLocks = projectLocks;

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function hashInput(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

export async function withProjectLock<T>(
  projectId: string,
  operation: () => Promise<T>,
) {
  const previous = projectLocks.get(projectId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  projectLocks.set(projectId, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (projectLocks.get(projectId) === queued) projectLocks.delete(projectId);
  }
}

function parseEditorDocument(raw: string): EditorDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new EditorTimelineError(
      "EDITOR_DOCUMENT_INVALID",
      "The Editor document is not valid JSON.",
      409,
      "Open the Editor and let Video FS repair or recreate its local document.",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EditorTimelineError(
      "EDITOR_DOCUMENT_INVALID",
      "The Editor document is invalid.",
      409,
    );
  }
  const doc = value as Partial<EditorDocument>;
  if (
    !Number.isSafeInteger(doc.revision) ||
    (doc.revision ?? -1) < 0 ||
    !doc.project ||
    !Array.isArray(doc.project.scenes) ||
    !doc.mediaMap ||
    typeof doc.mediaMap !== "object"
  ) {
    throw new EditorTimelineError(
      "EDITOR_DOCUMENT_INVALID",
      "The Editor document is missing its revision, scenes, or media map.",
      409,
      "Open the Editor and wait for the project to finish syncing.",
    );
  }
  for (const scene of doc.project.scenes) {
    if (
      !scene ||
      typeof scene.id !== "string" ||
      !validSceneTracks(scene.tracks)
    ) {
      throw new EditorTimelineError(
        "EDITOR_DOCUMENT_INVALID",
        "The Editor document contains an invalid scene or track.",
        409,
      );
    }
  }
  return doc as EditorDocument;
}

function validSceneTracks(value: unknown): value is SceneTracks {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tracks = value as Partial<SceneTracks>;
  return Boolean(
    tracks.main &&
      typeof tracks.main.id === "string" &&
      Array.isArray(tracks.main.elements) &&
      Array.isArray(tracks.overlay) &&
      tracks.overlay.every(
        (track) => track && typeof track.id === "string" && Array.isArray(track.elements),
      ) &&
      Array.isArray(tracks.audio) &&
      tracks.audio.every(
        (track) => track && typeof track.id === "string" && Array.isArray(track.elements),
      ),
  );
}

export async function readEditorDocument(projectId: string) {
  const raw = await readWorkspaceFile(projectId, EDITOR_DOC_PATH).catch(
    () => null,
  );
  if (raw === null) {
    throw new EditorTimelineError(
      "EDITOR_NOT_READY",
      "The project does not have an Editor timeline yet.",
      409,
      "Open the Editor tab once and wait for it to finish syncing.",
    );
  }
  return parseEditorDocument(raw);
}

export function activeScene(doc: EditorDocument, requestedId?: string) {
  const scenes = doc.project.scenes;
  const scene = requestedId
    ? scenes.find((entry) => entry.id === requestedId)
    : scenes.find((entry) => entry.id === doc.project.currentSceneId) ??
      scenes.find((entry) => entry.isMain) ??
      scenes[0];
  if (!scene) {
    throw new EditorTimelineError(
      "EDITOR_TARGET_NOT_FOUND",
      requestedId
        ? `Editor scene "${requestedId}" was not found.`
        : "The Editor has no active scene.",
      404,
    );
  }
  return scene;
}

function expectedMediaSourceKey(projectId: string, artifactPath: string) {
  const clean = artifactPath.startsWith("media/")
    ? artifactPath.slice("media/".length)
    : artifactPath;
  return `/api/projects/${projectId}/media/${clean}`;
}

function sourcePath(value: string | undefined) {
  if (!value) return null;
  try {
    return decodeURIComponent(new URL(value, "http://video-fs.local").pathname);
  } catch {
    return null;
  }
}

async function exactArtifactMediaPath(
  projectId: string,
  artifact: ResolvedCanvasContextArtifact,
) {
  if (artifact.version) return artifact.path;
  const source = await readWorkspaceFile(projectId, artifact.path).catch(
    () => null,
  );
  if (source === null) {
    throw new EditorTimelineError(
      "EDITOR_ARTIFACT_MISMATCH",
      `Canvas artifact "${artifact.artifactId}" is unavailable.`,
      409,
    );
  }
  const meta = parseJsonFrontmatter(source).meta;
  if (
    meta.id !== artifact.artifactId ||
    typeof meta.local_path !== "string"
  ) {
    throw new EditorTimelineError(
      "EDITOR_ARTIFACT_MISMATCH",
      `Canvas artifact "${artifact.artifactId}" has no exact local media identity.`,
      409,
      "Select a concrete generated or uploaded media artifact and retry.",
    );
  }
  return safeRelativePath(meta.local_path);
}

/** Self-heal for records that only carry a remote provider URL: downloads the
 * media into a real local version (updating the record like any regeneration
 * would), re-resolves the exact byte-level identity, and pre-seeds the Editor
 * media map so `insert` can complete without the browser having cached the
 * tile first. The seeded `videofs-…` mediaId is adopted (remapped to a real
 * media-bin id) the next time the Editor hydrates. No-op when the record
 * already has local media. */
export async function ensureArtifactEditorMedia(
  doc: EditorDocument,
  projectId: string,
  artifact: ResolvedCanvasContextArtifact,
): Promise<ResolvedCanvasContextArtifact> {
  let healed = artifact;
  let localPath: string | null = null;

  if (artifact.version) {
    localPath = artifact.path;
  } else {
    const source = await readWorkspaceFile(projectId, artifact.path).catch(
      () => null,
    );
    if (source === null) return artifact; // verifyArtifact reports precisely.
    const meta = parseJsonFrontmatter(source).meta;
    if (typeof meta.local_path === "string") {
      localPath = safeRelativePath(meta.local_path);
    } else {
      const kind =
        artifact.kind === "clip" || artifact.path.startsWith("clips/")
          ? ("clip" as const)
          : artifact.kind === "keyframe" ||
              artifact.path.startsWith("keyframes/")
            ? ("keyframe" as const)
            : null;
      const url = typeof meta.url === "string" ? meta.url : null;
      if (!kind || !url) return artifact;
      const cached = await appendArtifactVersion(projectId, {
        id: artifact.artifactId,
        kind,
        url,
      });
      if (!cached.ok) {
        throw new EditorTimelineError(
          "EDITOR_ARTIFACT_MISMATCH",
          `"${artifact.artifactId}" has no local media and its remote source could not be cached: ${cached.error}`,
          409,
          "Regenerate the artifact (its provider URL may have expired) and retry.",
        );
      }
      localPath = cached.localPath;
      healed = await resolveCanvasContextIdentity(projectId, {
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        sourcePath: artifact.path,
        title: artifact.title,
        version: {
          index: cached.version - 1,
          path: cached.localPath,
          revision: cached.version,
          versionId: `v${cached.version}`,
        },
      });
    }
  }

  if (!localPath) return healed;
  const expected = expectedMediaSourceKey(projectId, localPath);
  const alreadyMapped = Object.values(doc.mediaMap).some(
    (entry) => sourcePath(entry.sourceKey) === expected,
  );
  if (!alreadyMapped) {
    const alias = doc.mediaMap[artifact.artifactId]
      ? `videofs:${artifact.artifactId}`
      : artifact.artifactId;
    doc.mediaMap[alias] = {
      durationSeconds: null,
      kind: artifact.kind,
      mediaId: `videofs-${randomUUID()}`,
      name: artifact.title ?? artifact.artifactId,
      sourceKey: expected,
    };
  }
  return healed;
}

export async function mappedMedia(
  doc: EditorDocument,
  projectId: string,
  artifact: ResolvedCanvasContextArtifact,
) {
  const expected = expectedMediaSourceKey(
    projectId,
    await exactArtifactMediaPath(projectId, artifact),
  );
  const mapped = Object.values(doc.mediaMap).find(
    (entry) => sourcePath(entry.sourceKey) === expected,
  );
  if (!mapped) {
    throw new EditorTimelineError(
      "EDITOR_ARTIFACT_MISMATCH",
      `The exact selected version of "${artifact.artifactId}" is not in the Editor media bin.`,
      409,
      "Open the Editor and wait for that exact Canvas version to finish syncing.",
    );
  }
  if (!["audio", "image", "video", "clip", "keyframe"].includes(mapped.kind ?? "")) {
    throw new EditorTimelineError(
      "EDITOR_VALIDATION_FAILED",
      "Only Canvas image, video, keyframe, clip, or audio artifacts can be placed on the timeline.",
      422,
    );
  }
  return mapped;
}

export async function verifyArtifact(
  projectId: string,
  artifact: ResolvedCanvasContextArtifact,
) {
  try {
    const stale = await verifyCanvasContextIdentity(projectId, [artifact]);
    if (stale.length) {
      throw new EditorTimelineError(
        "EDITOR_ARTIFACT_MISMATCH",
        `Canvas artifact "${artifact.artifactId}" changed before the Editor command was applied.`,
        409,
        "Refresh agent context and retry against the current exact version.",
      );
    }
    const records = await listProjectFiles(projectId, true);
    const matchingRecord = records.find((file) => {
      if (!file.path.endsWith(".md") || typeof file.content !== "string") {
        return false;
      }
      try {
        const meta = parseJsonFrontmatter(file.content).meta;
        if (meta.id !== artifact.artifactId) return false;
        if (!artifact.version) {
          const revision =
            typeof meta.entity_revision === "number"
              ? meta.entity_revision
              : typeof meta.revision === "number"
                ? meta.revision
                : 0;
          return file.path === artifact.path && revision === artifact.entityRevision;
        }
        const versions = Array.isArray(meta.versions) ? meta.versions : [];
        return versions.some((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return false;
          }
          const row = entry as Record<string, unknown>;
          const path =
            typeof row.local_path === "string"
              ? safeRelativePath(row.local_path)
              : null;
          const revision =
            typeof row.version === "number"
              ? row.version
              : typeof row.v === "number"
                ? row.v
                : null;
          return (
            path === artifact.path &&
            revision === artifact.entityRevision &&
            artifact.version?.versionId === `v${revision}`
          );
        });
      } catch {
        return false;
      }
    });
    if (!matchingRecord) {
      throw new EditorTimelineError(
        "EDITOR_ARTIFACT_MISMATCH",
        `Canvas artifact "${artifact.artifactId}" no longer records that exact version identity.`,
        409,
        "Refresh agent context and retry against the current exact version.",
      );
    }
  } catch (error) {
    if (error instanceof EditorTimelineError) throw error;
    if (error instanceof CanvasContextIdentityError) {
      throw new EditorTimelineError(
        "EDITOR_ARTIFACT_MISMATCH",
        error.message,
        error.status,
        "Refresh agent context and retry against the current exact version.",
      );
    }
    throw error;
  }
}

async function verifyTarget(
  doc: EditorDocument,
  projectId: string,
  scene: ReturnType<typeof activeScene>,
  target: z.infer<typeof targetSchema>,
) {
  await verifyArtifact(projectId, target.artifact);
  const mapping = await mappedMedia(doc, projectId, target.artifact);
  const track = findTrackInSceneTracks({
    tracks: scene.tracks,
    trackId: target.trackId,
  });
  const element = track?.elements.find(
    (entry) => entry.id === target.elementId,
  );
  if (!track || !element) {
    throw new EditorTimelineError(
      "EDITOR_TARGET_NOT_FOUND",
      `Editor element "${target.elementId}" was not found on track "${target.trackId}".`,
      404,
    );
  }
  if (!("mediaId" in element) || element.mediaId !== mapping.mediaId) {
    throw new EditorTimelineError(
      "EDITOR_ARTIFACT_MISMATCH",
      `Editor element "${target.elementId}" does not reference the supplied exact Canvas artifact version.`,
      409,
      "Read the current timeline and retry with the element's exact Canvas identity.",
    );
  }
  return { element, mapping, track };
}

export function updateProjectMetadata(doc: EditorDocument, sceneId: string) {
  const scene = doc.project.scenes.find((entry) => entry.id === sceneId);
  const end = scene
    ? allElements(scene.tracks).reduce(
        (maximum, element) =>
          Math.max(maximum, element.startTime + element.duration),
        0,
      )
    : 0;
  if (doc.project.metadata) {
    doc.project.metadata.duration = Math.max(
      ...doc.project.scenes.map((entry) =>
        allElements(entry.tracks).reduce(
          (maximum, element) =>
            Math.max(maximum, element.startTime + element.duration),
          0,
        ),
      ),
      end,
    );
    doc.project.metadata.updatedAt = nowIso();
  }
  if (scene) scene.updatedAt = nowIso();
}

export function allElements(tracks: SceneTracks): TimelineElement[] {
  const elements: TimelineElement[] = [...tracks.main.elements];
  for (const track of tracks.overlay) elements.push(...track.elements);
  for (const track of tracks.audio) elements.push(...track.elements);
  return elements;
}

function receiptResult(
  receipt: EditorCommandReceipt,
  idempotentReplay: boolean,
): EditorTimelineCommandResult {
  return {
    affectedElementIds: receipt.affectedElementIds,
    command: receipt.command,
    commandId: receipt.commandId,
    idempotentReplay,
    inverse: receipt.inverse,
    newRevision: receipt.newRevision,
    priorRevision: receipt.priorRevision,
    recoverable: true,
  };
}

export async function getEditorTimeline(projectId: string) {
  const doc = await readEditorDocument(projectId);
  return {
    currentSceneId: doc.project.currentSceneId ?? null,
    exists: true,
    mediaMap: doc.mediaMap,
    project: doc.project,
    revision: doc.revision,
  };
}

export async function executeEditorTimelineCommand(
  rawCommand: unknown,
) {
  const command = editorTimelineCommandSchema.parse(rawCommand);
  publishEditorCommandEvent({
    affectedElementIds: [],
    command: command.tool,
    commandId: command.commandId,
    kind: "editor.command.accepted",
    priorRevision: command.baseEditorRevision,
    projectId: command.projectId,
  });
  try {
    return await withProjectLock(command.projectId, async () => {
      const doc = await readEditorDocument(command.projectId);
      const inputHash = hashInput(command);
      const replay = (doc.commandHistory ?? []).find(
        (entry) => entry.idempotencyKey === command.idempotencyKey,
      );
      if (replay) {
        if (replay.inputHash !== inputHash || replay.commandId !== command.commandId) {
          throw new EditorTimelineError(
            "EDITOR_COMMAND_CONFLICT",
            "That Editor idempotency key was already used for a different command.",
            409,
          );
        }
        publishEditorCommandEvent({
          affectedElementIds: replay.affectedElementIds,
          command: replay.command,
          commandId: replay.commandId,
          kind: "editor.command.completed",
          newRevision: replay.newRevision,
          priorRevision: replay.priorRevision,
          projectId: command.projectId,
        });
        return receiptResult(replay, true);
      }
      if (doc.revision !== command.baseEditorRevision) {
        throw new EditorTimelineError(
          "EDITOR_REVISION_CONFLICT",
          `Editor revision ${command.baseEditorRevision} is stale; current revision is ${doc.revision}.`,
          409,
          "Call editor_timeline_get and retry with the current editor revision.",
        );
      }

      const scene = activeScene(doc, command.sceneId);
      const inverseTracks = clone(scene.tracks);
      let affectedElementIds: string[] = [];

      if (command.tool === "editor_timeline_insert") {
        await verifyArtifact(command.projectId, command.artifact);
        const mapping = await mappedMedia(
          doc,
          command.projectId,
          command.artifact,
        );
        const elementId = command.elementId ?? randomUUID();
        const kind =
          mapping.kind === "audio"
            ? "audio"
            : mapping.kind === "image" || mapping.kind === "keyframe"
              ? "image"
              : "video";
        const identity = {
          artifactId: command.artifact.artifactId,
          contentHash: command.artifact.contentHash,
          entityRevision: command.artifact.entityRevision,
          path: command.artifact.path,
          version: command.artifact.version,
        };
        const element = {
          duration: command.durationTicks,
          mediaId: mapping.mediaId,
          name: command.name ?? mapping.name,
          params: {},
          sourceDuration: command.durationTicks,
          startTime: command.startTimeTicks,
          trimEnd: 0,
          trimStart: 0,
          type: kind,
          videoFsArtifact: identity,
          ...(kind === "audio"
            ? { sourceType: "upload" as const }
            : kind === "video"
              ? { isSourceAudioEnabled: false }
              : {}),
        } as unknown as CreateTimelineElement;
        const inserted = applyInsertElementMutation({
          element,
          elementId,
          placement: { mode: "explicit", trackId: command.trackId },
          tracks: scene.tracks,
        });
        if (!inserted) {
          throw new EditorTimelineError(
            "EDITOR_VALIDATION_FAILED",
            "The artifact cannot be inserted on that track or time range.",
            422,
          );
        }
        scene.tracks = inserted.updatedTracks;
        affectedElementIds = [elementId];
      } else if (command.tool === "editor_timeline_move") {
        await verifyTarget(doc, command.projectId, scene, command.target);
        scene.tracks = applyMoveElementsMutation({
          moves: [
            {
              elementId: command.target.elementId,
              newStartTime: command.newStartTimeTicks as MediaTime,
              sourceTrackId: command.target.trackId,
              targetTrackId: command.targetTrackId,
            },
          ],
          tracks: scene.tracks,
        });
        affectedElementIds = [command.target.elementId];
      } else if (command.tool === "editor_timeline_trim") {
        const { element } = await verifyTarget(
          doc,
          command.projectId,
          scene,
          command.target,
        );
        const sourceDuration =
          typeof element.sourceDuration === "number"
            ? element.sourceDuration
            : null;
        if (
          sourceDuration !== null &&
          command.trimStartTicks + command.trimEndTicks > sourceDuration
        ) {
          throw new EditorTimelineError(
            "EDITOR_VALIDATION_FAILED",
            "The requested trims exceed the source media duration.",
            422,
          );
        }
        scene.tracks = applyUpdateElementsMutation({
          tracks: scene.tracks,
          updates: [
            {
              elementId: command.target.elementId,
              patch: {
                duration: command.durationTicks as MediaTime,
                trimEnd: command.trimEndTicks as MediaTime,
                trimStart: command.trimStartTicks as MediaTime,
              },
              trackId: command.target.trackId,
            },
          ],
        });
        affectedElementIds = [command.target.elementId];
      } else if (command.tool === "editor_timeline_split") {
        const { element } = await verifyTarget(
          doc,
          command.projectId,
          scene,
          command.target,
        );
        if (
          command.splitTimeTicks <= element.startTime ||
          command.splitTimeTicks >= element.startTime + element.duration
        ) {
          throw new EditorTimelineError(
            "EDITOR_VALIDATION_FAILED",
            "The split point must fall inside the visible element.",
            422,
          );
        }
        const rightElementId = command.rightElementId ?? randomUUID();
        const split = applySplitElementsMutation({
          createId: () => rightElementId,
          elements: [
            {
              elementId: command.target.elementId,
              trackId: command.target.trackId,
            },
          ],
          splitTime: command.splitTimeTicks as MediaTime,
          tracks: scene.tracks,
        });
        scene.tracks = split.updatedTracks;
        affectedElementIds = [
          command.target.elementId,
          ...split.rightSideElements.map((entry) => entry.elementId),
        ];
      } else {
        for (const target of command.targets) {
          await verifyTarget(doc, command.projectId, scene, target);
        }
        scene.tracks = applyDeleteElementsMutation({
          elements: command.targets.map((target) => ({
            elementId: target.elementId,
            trackId: target.trackId,
          })),
          tracks: scene.tracks,
        });
        affectedElementIds = command.targets.map((target) => target.elementId);
      }

      const priorRevision = doc.revision;
      const newRevision = priorRevision + 1;
      updateProjectMetadata(doc, scene.id);
      const receipt: EditorCommandReceipt = {
        actor: command.actor,
        affectedElementIds,
        command: command.tool,
        commandId: command.commandId,
        completedAt: nowIso(),
        idempotencyKey: command.idempotencyKey,
        inputHash,
        inverse: { sceneId: scene.id, tracks: inverseTracks },
        newRevision,
        origin: command.origin,
        priorRevision,
        recoverable: true,
        status: "completed",
      };
      doc.commandHistory = [...(doc.commandHistory ?? []), receipt].slice(-100);
      doc.revision = newRevision;
      doc.source = "agent";
      doc.updatedAt = nowIso();
      await writeWorkspaceFile(
        command.projectId,
        EDITOR_DOC_PATH,
        JSON.stringify(doc),
      );
      publishEditorCommandEvent({
        affectedElementIds,
        command: command.tool,
        commandId: command.commandId,
        kind: "editor.command.completed",
        newRevision,
        priorRevision,
        projectId: command.projectId,
      });
      return receiptResult(receipt, false);
    });
  } catch (error) {
    const normalized =
      error instanceof EditorTimelineError
        ? error
        : new EditorTimelineError(
            "EDITOR_VALIDATION_FAILED",
            error instanceof Error ? error.message : "Editor command failed.",
            422,
          );
    publishEditorCommandEvent({
      affectedElementIds: [],
      command: command.tool,
      commandId: command.commandId,
      error: {
        code: normalized.code,
        message: normalized.message,
        remediation: normalized.remediation,
      },
      kind: "editor.command.failed",
      priorRevision: command.baseEditorRevision,
      projectId: command.projectId,
    });
    throw normalized;
  }
}
