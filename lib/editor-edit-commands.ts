import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolvedCanvasContextArtifactSchema } from "@/lib/canvas-context-identity";
import { publishEditorCommandEvent } from "@/lib/editor-events";
import { publishUiEvent } from "@/lib/ui-events";
import { writeWorkspaceFile } from "@/lib/workspace";
import {
  EDITOR_DOC_PATH,
  EditorTimelineError,
  activeScene,
  ensureArtifactEditorMedia,
  actorSchema,
  allElements,
  clone,
  hashInput,
  mappedMedia,
  mutationBase,
  nowIso,
  originSchema,
  readEditorDocument,
  stableIdSchema,
  tickSchema,
  updateProjectMetadata,
  verifyArtifact,
  withProjectLock,
  type EditorCommandInverse,
  type EditorCommandReceipt,
  type EditorDocument,
} from "@/lib/editor-timeline-commands";
import {
  applyDeleteElementsMutation,
  applyInsertElementMutation,
  applyMoveElementsMutation,
  applySplitElementsMutation,
  applyUpdateElementsMutation,
} from "@opencut/commands/timeline/element/mutations";
import { findTrackInSceneTracks } from "@opencut/timeline";
import { buildEmptyTrack } from "@opencut/timeline/placement";
import type {
  AudioTrack,
  CreateTimelineElement,
  OverlayTrack,
  SceneTracks,
  TimelineElement,
  TimelineTrack,
} from "@opencut/timeline";
import type { MediaTime } from "@opencut/wasm";

/** Versioned receipt tag returned by editor_edit / editor_structure. */
export const EDITOR_COMMAND_RECEIPT_SCHEMA = "EditorCommandReceipt@2";

const paramValueSchema = z.union([
  z.string().max(5000),
  z.number().finite(),
  z.boolean(),
]);
const paramsPatchSchema = z.record(
  z.string().min(1).max(160),
  paramValueSchema,
);
const effectSchema = z
  .object({
    enabled: z.boolean().default(true),
    id: stableIdSchema,
    params: paramsPatchSchema.default({}),
    type: z.string().trim().min(1).max(80),
  })
  .strict();
const looseRecordSchema = z.record(z.string(), z.unknown());
const retimeSchema = z
  .object({
    maintainPitch: z.boolean().optional(),
    rate: z.number().min(0.01).max(5),
  })
  .strict();
/** Element reference: artifact identity is verified when supplied (media
 * elements); text/graphic elements have no artifact and pass ref-only. */
const elementRefSchema = z
  .object({
    artifact: resolvedCanvasContextArtifactSchema.optional(),
    elementId: stableIdSchema,
    trackId: stableIdSchema,
  })
  .strict();
const placementSchema = z.union([
  z.object({ mode: z.literal("explicit"), trackId: stableIdSchema }).strict(),
  z
    .object({
      insertIndex: z.number().int().nonnegative().optional(),
      mode: z.literal("auto"),
      trackType: z
        .enum(["video", "text", "audio", "graphic", "effect"])
        .optional(),
    })
    .strict(),
]);

export const editorEditCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...mutationBase,
      action: z.literal("insert"),
      artifact: resolvedCanvasContextArtifactSchema,
      durationTicks: z.number().int().positive(),
      elementId: stableIdSchema.optional(),
      name: z.string().trim().min(1).max(500).optional(),
      placement: placementSchema,
      startTimeTicks: tickSchema,
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("insert_text"),
      content: z.string().min(1).max(2000),
      durationTicks: z.number().int().positive(),
      elementId: stableIdSchema.optional(),
      name: z.string().trim().min(1).max(500).optional(),
      params: paramsPatchSchema.optional(),
      placement: placementSchema.optional(),
      startTimeTicks: tickSchema,
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("update"),
      effects: z.array(effectSchema).max(20).optional(),
      hidden: z.boolean().optional(),
      isSourceAudioEnabled: z.boolean().optional(),
      masks: z.array(looseRecordSchema).max(20).optional(),
      name: z.string().trim().min(1).max(500).optional(),
      params: paramsPatchSchema.optional(),
      retime: retimeSchema.nullable().optional(),
      target: elementRefSchema,
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("move"),
      newStartTimeTicks: tickSchema,
      target: elementRefSchema,
      targetTrackId: stableIdSchema,
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("trim"),
      durationTicks: z.number().int().positive(),
      target: elementRefSchema,
      trimEndTicks: tickSchema,
      trimStartTicks: tickSchema,
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("split"),
      retainSide: z.enum(["both", "left", "right"]).default("both"),
      rightElementId: stableIdSchema.optional(),
      splitTimeTicks: z.number().int().positive(),
      target: elementRefSchema,
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("remove"),
      ripple: z.boolean().default(false),
      targets: z.array(elementRefSchema).min(1).max(100),
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("duplicate"),
      newElementId: stableIdSchema.optional(),
      startTimeTicks: tickSchema.optional(),
      target: elementRefSchema,
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("separate_audio"),
      target: elementRefSchema,
    })
    .strict(),
]);

export type EditorEditCommand = z.infer<typeof editorEditCommandSchema>;

const canvasSizeSchema = z
  .object({
    height: z.number().int().positive().max(8192),
    width: z.number().int().positive().max(8192),
  })
  .strict();

export const editorStructureCommandSchema = z.discriminatedUnion("action", [
  // Workspace UI navigation: no document mutation, so no revision handshake.
  z
    .object({
      action: z.literal("view_switch"),
      projectId: stableIdSchema,
      view: z.enum(["canvas", "editor"]),
    })
    .passthrough(),
  z
    .object({
      ...mutationBase,
      action: z.literal("track_add"),
      insertIndex: z.number().int().nonnegative().optional(),
      name: z.string().trim().min(1).max(200).optional(),
      trackId: stableIdSchema.optional(),
      trackType: z.enum(["audio", "effect", "graphic", "text", "video"]),
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("track_update"),
      hidden: z.boolean().optional(),
      muted: z.boolean().optional(),
      name: z.string().trim().min(1).max(200).optional(),
      trackId: stableIdSchema,
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("track_remove"),
      force: z.boolean().default(false),
      trackId: stableIdSchema,
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("scene_add"),
      name: z.string().trim().min(1).max(200),
      newSceneId: stableIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("scene_rename"),
      name: z.string().trim().min(1).max(200),
      targetSceneId: stableIdSchema,
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("scene_switch"),
      targetSceneId: stableIdSchema,
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("scene_remove"),
      targetSceneId: stableIdSchema,
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("bookmark_set"),
      color: z.string().trim().max(40).optional(),
      durationTicks: z.number().int().positive().optional(),
      note: z.string().trim().max(500).optional(),
      timeTicks: tickSchema,
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("bookmark_remove"),
      timeTicks: tickSchema,
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("settings_update"),
      background: looseRecordSchema.optional(),
      canvasSize: canvasSizeSchema.optional(),
      fps: z
        .union([
          z.number().positive().max(240),
          z
            .object({
              denominator: z.number().int().positive(),
              numerator: z.number().int().positive(),
            })
            .strict(),
        ])
        .optional(),
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      action: z.literal("undo"),
      undoCommandId: stableIdSchema.optional(),
    })
    .strict(),
]);

export type EditorStructureCommand = z.infer<
  typeof editorStructureCommandSchema
>;

export type EditorEditResult = {
  action: string;
  affectedElementIds: string[];
  command: "editor_edit" | "editor_structure";
  commandId: string;
  idempotentReplay: boolean;
  newRevision: number;
  priorRevision: number;
  recoverable: true;
  schema: typeof EDITOR_COMMAND_RECEIPT_SCHEMA;
  suggestedCheck: string;
  summary: Record<string, unknown>;
};

type MutateOutcome = {
  affectedElementIds: string[];
  inverse: EditorCommandInverse;
  summary?: Record<string, unknown>;
};

type Envelope = {
  action: string;
  actor: z.infer<typeof actorSchema>;
  baseEditorRevision: number;
  commandId: string;
  idempotencyKey: string;
  origin: z.infer<typeof originSchema>;
  projectId: string;
};

/** Shared envelope runner: lock, idempotent replay, revision CAS, receipt
 * with inverse, document write, and lifecycle events — identical guarantees
 * to the original editor_timeline_* commands. */
async function runEditorCommand(
  commandName: "editor_edit" | "editor_structure",
  envelope: Envelope,
  input: unknown,
  mutate: (doc: EditorDocument) => Promise<MutateOutcome> | MutateOutcome,
): Promise<EditorEditResult> {
  publishEditorCommandEvent({
    affectedElementIds: [],
    command: commandName,
    commandId: envelope.commandId,
    kind: "editor.command.accepted",
    priorRevision: envelope.baseEditorRevision,
    projectId: envelope.projectId,
  });
  try {
    return await withProjectLock(envelope.projectId, async () => {
      const doc = await readEditorDocument(envelope.projectId);
      const inputHash = hashInput(input);
      const replay = (doc.commandHistory ?? []).find(
        (entry) => entry.idempotencyKey === envelope.idempotencyKey,
      );
      if (replay) {
        if (
          replay.inputHash !== inputHash ||
          replay.commandId !== envelope.commandId
        ) {
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
          projectId: envelope.projectId,
        });
        return resultFromReceipt(commandName, envelope.action, replay, true);
      }
      if (doc.revision !== envelope.baseEditorRevision) {
        throw new EditorTimelineError(
          "EDITOR_REVISION_CONFLICT",
          `Editor revision ${envelope.baseEditorRevision} is stale; current revision is ${doc.revision}.`,
          409,
          "Call editor_timeline_get and retry with the current editor revision.",
        );
      }

      const outcome = await mutate(doc);

      const priorRevision = doc.revision;
      const newRevision = priorRevision + 1;
      const receipt: EditorCommandReceipt = {
        actor: envelope.actor,
        affectedElementIds: outcome.affectedElementIds,
        command: commandName,
        commandId: envelope.commandId,
        completedAt: nowIso(),
        idempotencyKey: envelope.idempotencyKey,
        inputHash,
        inverse: outcome.inverse,
        newRevision,
        origin: envelope.origin,
        priorRevision,
        recoverable: true,
        status: "completed",
        summary: { action: envelope.action, ...(outcome.summary ?? {}) },
      };
      doc.commandHistory = [...(doc.commandHistory ?? []), receipt].slice(-100);
      doc.revision = newRevision;
      doc.source = "agent";
      doc.updatedAt = nowIso();
      await writeWorkspaceFile(
        envelope.projectId,
        EDITOR_DOC_PATH,
        JSON.stringify(doc),
      );
      publishEditorCommandEvent({
        affectedElementIds: outcome.affectedElementIds,
        command: commandName,
        commandId: envelope.commandId,
        kind: "editor.command.completed",
        newRevision,
        priorRevision,
        projectId: envelope.projectId,
      });
      return resultFromReceipt(commandName, envelope.action, receipt, false);
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
      command: commandName,
      commandId: envelope.commandId,
      error: {
        code: normalized.code,
        message: normalized.message,
        remediation: normalized.remediation,
      },
      kind: "editor.command.failed",
      priorRevision: envelope.baseEditorRevision,
      projectId: envelope.projectId,
    });
    throw normalized;
  }
}

function resultFromReceipt(
  commandName: "editor_edit" | "editor_structure",
  action: string,
  receipt: EditorCommandReceipt,
  idempotentReplay: boolean,
): EditorEditResult {
  return {
    action,
    affectedElementIds: receipt.affectedElementIds,
    command: commandName,
    commandId: receipt.commandId,
    idempotentReplay,
    newRevision: receipt.newRevision,
    priorRevision: receipt.priorRevision,
    recoverable: true,
    schema: EDITOR_COMMAND_RECEIPT_SCHEMA,
    suggestedCheck:
      "Call editor_timeline_get to confirm the new revision before the next mutation.",
    summary: receipt.summary ?? { action },
  };
}

type SceneRecord = EditorDocument["project"]["scenes"][number];

function requireElement(
  scene: SceneRecord,
  ref: { elementId: string; trackId: string },
) {
  const track = findTrackInSceneTracks({
    trackId: ref.trackId,
    tracks: scene.tracks,
  });
  const element = track?.elements.find((entry) => entry.id === ref.elementId);
  if (!track || !element) {
    throw new EditorTimelineError(
      "EDITOR_TARGET_NOT_FOUND",
      `Editor element "${ref.elementId}" was not found on track "${ref.trackId}".`,
      404,
    );
  }
  return { element: element as TimelineElement, track };
}

/** Verifies artifact identity when the ref carries one (media elements). */
async function verifyRef(
  doc: EditorDocument,
  projectId: string,
  scene: SceneRecord,
  ref: z.infer<typeof elementRefSchema>,
) {
  const found = requireElement(scene, ref);
  if (ref.artifact) {
    await verifyArtifact(projectId, ref.artifact);
    const mapping = await mappedMedia(doc, projectId, ref.artifact);
    if (
      !("mediaId" in found.element) ||
      found.element.mediaId !== mapping.mediaId
    ) {
      throw new EditorTimelineError(
        "EDITOR_ARTIFACT_MISMATCH",
        `Editor element "${ref.elementId}" does not reference the supplied exact Canvas artifact version.`,
        409,
        "Read the current timeline and retry with the element's exact Canvas identity.",
      );
    }
  }
  return found;
}

function tracksInverse(scene: SceneRecord): EditorCommandInverse {
  return { sceneId: scene.id, tracks: clone(scene.tracks) };
}

function projectInverse(doc: EditorDocument): EditorCommandInverse {
  return { project: clone(doc.project) };
}

export async function executeEditorEditCommand(rawCommand: unknown) {
  const command = editorEditCommandSchema.parse(rawCommand);
  return runEditorCommand(
    "editor_edit",
    command,
    command,
    async (doc) => {
      const scene = activeScene(doc, command.sceneId);
      const inverse = tracksInverse(scene);

      if (command.action === "insert") {
        // Validate the identity the agent supplied first; then self-heal
        // records that only carry a remote URL (download + version + media
        // map seed) and continue with the re-resolved exact identity.
        await verifyArtifact(command.projectId, command.artifact);
        const artifact = await ensureArtifactEditorMedia(
          doc,
          command.projectId,
          command.artifact,
        );
        const mapping = await mappedMedia(doc, command.projectId, artifact);
        const elementId = command.elementId ?? randomUUID();
        const kind =
          mapping.kind === "audio"
            ? "audio"
            : mapping.kind === "image" || mapping.kind === "keyframe"
              ? "image"
              : "video";
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
          videoFsArtifact: {
            artifactId: artifact.artifactId,
            contentHash: artifact.contentHash,
            entityRevision: artifact.entityRevision,
            path: artifact.path,
            version: artifact.version,
          },
          ...(kind === "audio"
            ? { sourceType: "upload" as const }
            : kind === "video"
              ? { isSourceAudioEnabled: false }
              : {}),
        } as unknown as CreateTimelineElement;
        const inserted = applyInsertElementMutation({
          element,
          elementId,
          placement: command.placement,
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
        updateProjectMetadata(doc, scene.id);
        return {
          affectedElementIds: [elementId],
          inverse,
          summary: { elementId, trackId: inserted.targetTrackId },
        };
      }

      if (command.action === "insert_text") {
        const elementId = command.elementId ?? randomUUID();
        const element = {
          duration: command.durationTicks,
          name: command.name ?? command.content.slice(0, 60),
          params: { content: command.content, ...(command.params ?? {}) },
          sourceDuration: command.durationTicks,
          startTime: command.startTimeTicks,
          trimEnd: 0,
          trimStart: 0,
          type: "text",
        } as unknown as CreateTimelineElement;
        const inserted = applyInsertElementMutation({
          element,
          elementId,
          placement: command.placement ?? { mode: "auto", trackType: "text" },
          tracks: scene.tracks,
        });
        if (!inserted) {
          throw new EditorTimelineError(
            "EDITOR_VALIDATION_FAILED",
            "The text element cannot be placed on that track or time range.",
            422,
          );
        }
        scene.tracks = inserted.updatedTracks;
        updateProjectMetadata(doc, scene.id);
        return {
          affectedElementIds: [elementId],
          inverse,
          summary: { elementId, trackId: inserted.targetTrackId },
        };
      }

      if (command.action === "update") {
        const { element } = await verifyRef(
          doc,
          command.projectId,
          scene,
          command.target,
        );
        const patch: Record<string, unknown> = {};
        if (command.name !== undefined) patch.name = command.name;
        if (command.hidden !== undefined) patch.hidden = command.hidden;
        if (command.isSourceAudioEnabled !== undefined) {
          patch.isSourceAudioEnabled = command.isSourceAudioEnabled;
        }
        if (command.retime !== undefined) {
          if (element.type !== "video" && element.type !== "audio") {
            throw new EditorTimelineError(
              "EDITOR_VALIDATION_FAILED",
              `Only video and audio elements can be retimed; "${command.target.elementId}" is ${element.type}.`,
              422,
            );
          }
          patch.retime = command.retime ?? undefined;
        }
        if (command.effects !== undefined) patch.effects = command.effects;
        if (command.masks !== undefined) patch.masks = command.masks;
        if (command.params) {
          patch.params = { ...element.params, ...command.params };
        }
        if (!Object.keys(patch).length) {
          throw new EditorTimelineError(
            "EDITOR_VALIDATION_FAILED",
            "The update patch is empty.",
            422,
          );
        }
        scene.tracks = applyUpdateElementsMutation({
          tracks: scene.tracks,
          updates: [
            {
              elementId: command.target.elementId,
              patch: patch as Partial<TimelineElement>,
              trackId: command.target.trackId,
            },
          ],
        });
        updateProjectMetadata(doc, scene.id);
        return {
          affectedElementIds: [command.target.elementId],
          inverse,
          summary: { patched: Object.keys(patch) },
        };
      }

      if (command.action === "move") {
        await verifyRef(doc, command.projectId, scene, command.target);
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
        updateProjectMetadata(doc, scene.id);
        return {
          affectedElementIds: [command.target.elementId],
          inverse,
          summary: { targetTrackId: command.targetTrackId },
        };
      }

      if (command.action === "trim") {
        const { element } = await verifyRef(
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
        updateProjectMetadata(doc, scene.id);
        return {
          affectedElementIds: [command.target.elementId],
          inverse,
        };
      }

      if (command.action === "split") {
        const { element } = await verifyRef(
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
          retainSide: command.retainSide,
          splitTime: command.splitTimeTicks as MediaTime,
          tracks: scene.tracks,
        });
        scene.tracks = split.updatedTracks;
        updateProjectMetadata(doc, scene.id);
        const affected =
          command.retainSide === "right"
            ? split.rightSideElements.map((entry) => entry.elementId)
            : command.retainSide === "left"
              ? [command.target.elementId]
              : [
                  command.target.elementId,
                  ...split.rightSideElements.map((entry) => entry.elementId),
                ];
        return {
          affectedElementIds: affected,
          inverse,
          summary: { retainSide: command.retainSide },
        };
      }

      if (command.action === "remove") {
        const removedSpans = new Map<
          string,
          Array<{ duration: number; startTime: number }>
        >();
        for (const target of command.targets) {
          const { element } = await verifyRef(
            doc,
            command.projectId,
            scene,
            target,
          );
          removedSpans.set(target.trackId, [
            ...(removedSpans.get(target.trackId) ?? []),
            { duration: element.duration, startTime: element.startTime },
          ]);
        }
        scene.tracks = applyDeleteElementsMutation({
          elements: command.targets.map((target) => ({
            elementId: target.elementId,
            trackId: target.trackId,
          })),
          tracks: scene.tracks,
        });
        if (command.ripple) {
          for (const [trackId, spans] of removedSpans) {
            const track = findTrackInSceneTracks({
              trackId,
              tracks: scene.tracks,
            });
            if (!track) continue;
            const shifted = track.elements.map((element) => {
              const shift = spans.reduce(
                (total, span) =>
                  span.startTime <= element.startTime
                    ? total + span.duration
                    : total,
                0,
              );
              return shift > 0
                ? { ...element, startTime: Math.max(0, element.startTime - shift) }
                : element;
            });
            scene.tracks = applyUpdateElementsMutation({
              tracks: scene.tracks,
              updates: shifted
                .filter(
                  (element, index) =>
                    element.startTime !== track.elements[index]!.startTime,
                )
                .map((element) => ({
                  elementId: element.id,
                  patch: { startTime: element.startTime as MediaTime },
                  trackId,
                })),
            });
          }
        }
        updateProjectMetadata(doc, scene.id);
        return {
          affectedElementIds: command.targets.map((target) => target.elementId),
          inverse,
          summary: { ripple: command.ripple },
        };
      }

      if (command.action === "duplicate") {
        const { element } = await verifyRef(
          doc,
          command.projectId,
          scene,
          command.target,
        );
        const newElementId = command.newElementId ?? randomUUID();
        const copy = {
          ...clone(element),
          name: `${element.name} (copy)`,
          startTime:
            command.startTimeTicks ?? element.startTime + element.duration,
        } as unknown as CreateTimelineElement;
        delete (copy as Record<string, unknown>).id;
        const inserted = applyInsertElementMutation({
          element: copy,
          elementId: newElementId,
          placement: { mode: "explicit", trackId: command.target.trackId },
          tracks: scene.tracks,
        });
        if (!inserted) {
          throw new EditorTimelineError(
            "EDITOR_VALIDATION_FAILED",
            "There is no room for the duplicate at that time; pass startTimeTicks.",
            422,
          );
        }
        scene.tracks = inserted.updatedTracks;
        updateProjectMetadata(doc, scene.id);
        return {
          affectedElementIds: [newElementId],
          inverse,
          summary: { elementId: newElementId },
        };
      }

      // separate_audio
      const { element } = await verifyRef(
        doc,
        command.projectId,
        scene,
        command.target,
      );
      if (element.type !== "video" || !("mediaId" in element)) {
        throw new EditorTimelineError(
          "EDITOR_VALIDATION_FAILED",
          "Only video elements carry embedded source audio to separate.",
          422,
        );
      }
      const audioElementId = randomUUID();
      const audioElement = {
        duration: element.duration,
        mediaId: element.mediaId,
        name: `${element.name} (audio)`,
        params: {},
        sourceDuration: element.sourceDuration ?? element.duration,
        sourceType: "upload" as const,
        startTime: element.startTime,
        trimEnd: element.trimEnd,
        trimStart: element.trimStart,
        type: "audio",
      } as unknown as CreateTimelineElement;
      let inserted = null as ReturnType<typeof applyInsertElementMutation>;
      const firstAudioTrack = scene.tracks.audio[0];
      if (firstAudioTrack) {
        inserted = applyInsertElementMutation({
          element: audioElement,
          elementId: audioElementId,
          placement: { mode: "explicit", trackId: firstAudioTrack.id },
          tracks: scene.tracks,
        });
      }
      if (!inserted) {
        inserted = applyInsertElementMutation({
          element: audioElement,
          elementId: audioElementId,
          placement: { mode: "auto", trackType: "audio" },
          tracks: scene.tracks,
        });
      }
      if (!inserted) {
        throw new EditorTimelineError(
          "EDITOR_VALIDATION_FAILED",
          "The separated audio could not be placed on an audio track.",
          422,
        );
      }
      scene.tracks = applyUpdateElementsMutation({
        tracks: inserted.updatedTracks,
        updates: [
          {
            elementId: command.target.elementId,
            patch: { isSourceAudioEnabled: false } as Partial<TimelineElement>,
            trackId: command.target.trackId,
          },
        ],
      });
      updateProjectMetadata(doc, scene.id);
      return {
        affectedElementIds: [command.target.elementId, audioElementId],
        inverse,
        summary: { audioElementId, audioTrackId: inserted.targetTrackId },
      };
    },
  );
}

function requireTrack(scene: SceneRecord, trackId: string) {
  const track = findTrackInSceneTracks({ trackId, tracks: scene.tracks });
  if (!track) {
    throw new EditorTimelineError(
      "EDITOR_TARGET_NOT_FOUND",
      `Editor track "${trackId}" was not found.`,
      404,
    );
  }
  return track as TimelineTrack;
}

function replaceTrack(
  tracks: SceneTracks,
  trackId: string,
  update: (track: TimelineTrack) => TimelineTrack,
): SceneTracks {
  return {
    audio: tracks.audio.map((track) =>
      track.id === trackId ? (update(track) as AudioTrack) : track,
    ),
    main:
      tracks.main.id === trackId
        ? (update(tracks.main) as SceneTracks["main"])
        : tracks.main,
    overlay: tracks.overlay.map((track) =>
      track.id === trackId ? (update(track) as OverlayTrack) : track,
    ),
  };
}

export async function executeEditorStructureCommand(rawCommand: unknown) {
  const command = editorStructureCommandSchema.parse(rawCommand);
  if (command.action === "view_switch") {
    publishUiEvent({
      kind: "view.switch",
      projectId: command.projectId,
      view: command.view,
    });
    return {
      ok: true,
      schema: EDITOR_COMMAND_RECEIPT_SCHEMA,
      summary: {
        message: `Switched the open workbench to the ${command.view} view.`,
        view: command.view,
      } as Record<string, unknown>,
      view: command.view,
    };
  }
  return runEditorCommand(
    "editor_structure",
    command,
    command,
    async (doc) => {
      if (command.action === "track_add") {
        const scene = activeScene(doc, command.sceneId);
        const inverse = tracksInverse(scene);
        const trackId = command.trackId ?? randomUUID();
        const track = buildEmptyTrack({
          id: trackId,
          type: command.trackType,
        }) as TimelineTrack;
        if (command.name) (track as { name: string }).name = command.name;
        if (track.type === "audio") {
          const index = Math.min(
            command.insertIndex ?? scene.tracks.audio.length,
            scene.tracks.audio.length,
          );
          scene.tracks = {
            ...scene.tracks,
            audio: [
              ...scene.tracks.audio.slice(0, index),
              track as AudioTrack,
              ...scene.tracks.audio.slice(index),
            ],
          };
        } else {
          const index = Math.min(
            command.insertIndex ?? scene.tracks.overlay.length,
            scene.tracks.overlay.length,
          );
          scene.tracks = {
            ...scene.tracks,
            overlay: [
              ...scene.tracks.overlay.slice(0, index),
              track as OverlayTrack,
              ...scene.tracks.overlay.slice(index),
            ],
          };
        }
        return {
          affectedElementIds: [],
          inverse,
          summary: { trackId, trackType: command.trackType },
        };
      }

      if (command.action === "track_update") {
        const scene = activeScene(doc, command.sceneId);
        const inverse = tracksInverse(scene);
        const track = requireTrack(scene, command.trackId);
        if (command.muted !== undefined && !("muted" in track)) {
          throw new EditorTimelineError(
            "EDITOR_VALIDATION_FAILED",
            `Track type "${track.type}" has no mute state.`,
            422,
          );
        }
        if (command.hidden !== undefined && !("hidden" in track)) {
          throw new EditorTimelineError(
            "EDITOR_VALIDATION_FAILED",
            `Track type "${track.type}" has no visibility state.`,
            422,
          );
        }
        scene.tracks = replaceTrack(scene.tracks, command.trackId, (entry) => ({
          ...entry,
          ...(command.muted !== undefined ? { muted: command.muted } : {}),
          ...(command.hidden !== undefined ? { hidden: command.hidden } : {}),
          ...(command.name !== undefined ? { name: command.name } : {}),
        }));
        return {
          affectedElementIds: [],
          inverse,
          summary: { trackId: command.trackId },
        };
      }

      if (command.action === "track_remove") {
        const scene = activeScene(doc, command.sceneId);
        const inverse = tracksInverse(scene);
        if (scene.tracks.main.id === command.trackId) {
          throw new EditorTimelineError(
            "EDITOR_VALIDATION_FAILED",
            "The main track cannot be removed.",
            422,
          );
        }
        const track = requireTrack(scene, command.trackId);
        if (track.elements.length && !command.force) {
          throw new EditorTimelineError(
            "EDITOR_VALIDATION_FAILED",
            `Track "${command.trackId}" still has ${track.elements.length} element(s); pass force to remove them with it.`,
            422,
          );
        }
        scene.tracks = {
          ...scene.tracks,
          audio: scene.tracks.audio.filter(
            (entry) => entry.id !== command.trackId,
          ),
          overlay: scene.tracks.overlay.filter(
            (entry) => entry.id !== command.trackId,
          ),
        };
        return {
          affectedElementIds: track.elements.map((element) => element.id),
          inverse,
          summary: { removedTrackId: command.trackId },
        };
      }

      if (command.action === "scene_add") {
        const inverse = projectInverse(doc);
        const sceneId = command.newSceneId ?? randomUUID();
        if (doc.project.scenes.some((scene) => scene.id === sceneId)) {
          throw new EditorTimelineError(
            "EDITOR_VALIDATION_FAILED",
            `Scene "${sceneId}" already exists.`,
            422,
          );
        }
        doc.project.scenes.push({
          bookmarks: [],
          createdAt: nowIso(),
          id: sceneId,
          isMain: false,
          name: command.name,
          tracks: {
            audio: [],
            main: buildEmptyTrack({
              id: randomUUID(),
              type: "video",
            }) as SceneTracks["main"],
            overlay: [],
          },
          updatedAt: nowIso(),
        } as unknown as SceneRecord);
        return {
          affectedElementIds: [],
          inverse,
          summary: { sceneId },
        };
      }

      if (command.action === "scene_rename") {
        const inverse = projectInverse(doc);
        const scene = activeScene(doc, command.targetSceneId);
        (scene as { name?: string }).name = command.name;
        scene.updatedAt = nowIso();
        return {
          affectedElementIds: [],
          inverse,
          summary: { sceneId: scene.id },
        };
      }

      if (command.action === "scene_switch") {
        const inverse = projectInverse(doc);
        activeScene(doc, command.targetSceneId);
        doc.project.currentSceneId = command.targetSceneId;
        return {
          affectedElementIds: [],
          inverse,
          summary: { currentSceneId: command.targetSceneId },
        };
      }

      if (command.action === "scene_remove") {
        const inverse = projectInverse(doc);
        const scene = activeScene(doc, command.targetSceneId);
        if (scene.isMain) {
          throw new EditorTimelineError(
            "EDITOR_VALIDATION_FAILED",
            "The main scene cannot be removed.",
            422,
          );
        }
        doc.project.scenes = doc.project.scenes.filter(
          (entry) => entry.id !== command.targetSceneId,
        );
        if (doc.project.currentSceneId === command.targetSceneId) {
          const fallback =
            doc.project.scenes.find((entry) => entry.isMain) ??
            doc.project.scenes[0];
          doc.project.currentSceneId = fallback?.id;
        }
        return {
          affectedElementIds: allElements(scene.tracks).map(
            (element) => element.id,
          ),
          inverse,
          summary: { removedSceneId: command.targetSceneId },
        };
      }

      if (command.action === "bookmark_set") {
        const scene = activeScene(doc, command.sceneId);
        const inverse = projectInverse(doc);
        const bookmarks = Array.isArray(
          (scene as unknown as { bookmarks?: unknown }).bookmarks,
        )
          ? ((scene as unknown as { bookmarks: Array<Record<string, unknown>> }).bookmarks)
          : [];
        const next = bookmarks.filter(
          (bookmark) => bookmark.time !== command.timeTicks,
        );
        next.push({
          ...(command.color ? { color: command.color } : {}),
          ...(command.durationTicks
            ? { duration: command.durationTicks }
            : {}),
          ...(command.note ? { note: command.note } : {}),
          time: command.timeTicks,
        });
        (scene as unknown as { bookmarks: unknown }).bookmarks = next.sort(
          (first, second) => Number(first.time) - Number(second.time),
        );
        return {
          affectedElementIds: [],
          inverse,
          summary: { timeTicks: command.timeTicks },
        };
      }

      if (command.action === "bookmark_remove") {
        const scene = activeScene(doc, command.sceneId);
        const inverse = projectInverse(doc);
        const bookmarks = Array.isArray(
          (scene as unknown as { bookmarks?: unknown }).bookmarks,
        )
          ? ((scene as unknown as { bookmarks: Array<Record<string, unknown>> }).bookmarks)
          : [];
        (scene as unknown as { bookmarks: unknown }).bookmarks = bookmarks.filter(
          (bookmark) => bookmark.time !== command.timeTicks,
        );
        return {
          affectedElementIds: [],
          inverse,
          summary: { timeTicks: command.timeTicks },
        };
      }

      if (command.action === "settings_update") {
        const inverse = projectInverse(doc);
        const settings =
          (doc.project as unknown as { settings?: Record<string, unknown> }).settings ??
          {};
        (doc.project as unknown as { settings: Record<string, unknown> }).settings = {
          ...settings,
          ...(command.fps !== undefined ? { fps: command.fps } : {}),
          ...(command.canvasSize
            ? { canvasSize: command.canvasSize, canvasSizeMode: "custom" }
            : {}),
          ...(command.background ? { background: command.background } : {}),
        };
        return {
          affectedElementIds: [],
          inverse,
          summary: {
            patched: [
              ...(command.fps !== undefined ? ["fps"] : []),
              ...(command.canvasSize ? ["canvasSize"] : []),
              ...(command.background ? ["background"] : []),
            ],
          },
        };
      }

      // undo
      const history = doc.commandHistory ?? [];
      const receipt = command.undoCommandId
        ? history.find((entry) => entry.commandId === command.undoCommandId)
        : [...history]
            .reverse()
            .find((entry) => (entry.summary?.action ?? "") !== "undo");
      if (!receipt) {
        throw new EditorTimelineError(
          "EDITOR_TARGET_NOT_FOUND",
          command.undoCommandId
            ? `No receipt found for command "${command.undoCommandId}".`
            : "There is nothing to undo.",
          404,
        );
      }
      const inverse = projectInverse(doc);
      if ("tracks" in receipt.inverse) {
        const scene = doc.project.scenes.find(
          (entry) => entry.id === (receipt.inverse as { sceneId: string }).sceneId,
        );
        if (!scene) {
          throw new EditorTimelineError(
            "EDITOR_TARGET_NOT_FOUND",
            "The undone command's scene no longer exists.",
            404,
          );
        }
        scene.tracks = clone(
          (receipt.inverse as { tracks: SceneTracks }).tracks,
        );
        updateProjectMetadata(doc, scene.id);
      } else {
        doc.project = clone(
          (receipt.inverse as { project: EditorDocument["project"] }).project,
        );
      }
      return {
        affectedElementIds: receipt.affectedElementIds,
        inverse,
        summary: { undidCommandId: receipt.commandId },
      };
    },
  );
}
