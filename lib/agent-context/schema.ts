import path from "node:path";
import { z } from "zod";

export const AGENT_CONTEXT_SCHEMA = "AgentContextSnapshot@1" as const;
export const AGENT_CONTEXT_SCHEMA_VERSION = 1 as const;

const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/, "Expected a stable identifier.");

const sha256Schema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-f0-9]{64}$/, "Expected a SHA-256 digest.");

const projectRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .transform((value, context) => {
    const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
    if (
      normalized === "." ||
      normalized.startsWith("/") ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.includes("/../") ||
      normalized.includes("\0")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected a safe project-relative path.",
      });
      return z.NEVER;
    }
    return normalized;
  });

export const agentContextVersionSchema = z
  .object({
    index: z.number().int().nonnegative(),
    sha256: sha256Schema.nullable().default(null),
    versionId: idSchema.nullable().default(null),
  })
  .strict();

export const agentContextArtifactSchema = z
  .object({
    artifactId: idSchema,
    contentHash: sha256Schema.nullable().default(null),
    entityRevision: z.number().int().nonnegative().nullable().default(null),
    kind: z.string().trim().min(1).max(80),
    path: projectRelativePathSchema.nullable().default(null),
    title: z.string().trim().max(500).nullable().default(null),
    version: agentContextVersionSchema.nullable().default(null),
  })
  .strict();

export const emptyCanvasContext = () => ({
  focused: null,
  pinned: [],
  selected: [],
});

export const canvasAgentContextSchema = z
  .object({
    focused: agentContextArtifactSchema.nullable(),
    pinned: z.array(agentContextArtifactSchema).max(200),
    selected: z.array(agentContextArtifactSchema).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.focused) return;
    const visible = [...value.selected, ...value.pinned];
    if (!visible.some((entry) => entry.artifactId === value.focused?.artifactId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The focused Canvas artifact must also be selected or pinned.",
        path: ["focused"],
      });
    }
  });

export const editorElementSchema = z
  .object({
    elementId: idSchema,
    kind: z.string().trim().min(1).max(80),
    mediaId: idSchema.nullable().default(null),
    trackId: idSchema,
  })
  .strict();

export const editorKeyframeSchema = z
  .object({
    elementId: idSchema,
    keyframeId: idSchema,
    property: z.string().trim().min(1).max(160),
    trackId: idSchema,
  })
  .strict();

export const editorMaskPointsSchema = z
  .object({
    elementId: idSchema,
    pointIds: z.array(idSchema).max(1_000),
    trackId: idSchema,
  })
  .strict();

export const editorTimeRangeSchema = z
  .object({
    endTicks: z.number().int().nonnegative(),
    startTicks: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => value.endTicks >= value.startTicks, {
    message: "Editor time-range end must not precede its start.",
  });

export const emptyEditorContext = () => ({
  documentRevision: null,
  fps: null,
  focusedArtifact: null,
  focusedPlacement: null,
  playheadTicks: null,
  sceneId: null,
  selectedElements: [],
  selectedKeyframes: [],
  selectedMaskPoints: null,
  selectedTrackIds: [],
  timeRange: null,
});

export const editorAgentContextSchema = z
  .object({
    documentRevision: z.number().int().nonnegative().nullable(),
    fps: z.number().positive().max(1_000).nullable(),
    focusedArtifact: agentContextArtifactSchema.nullable().default(null),
    focusedPlacement: z
      .preprocess(
        (value) => {
          if (
            value &&
            typeof value === "object" &&
            "elementId" in value &&
            "stale" in value
          ) {
            const legacy = value as { elementId: unknown; stale: unknown };
            return {
              elementId: legacy.elementId,
              status: legacy.stale ? "removed" : "focused",
            };
          }
          return value;
        },
        z
      .object({
        elementId: idSchema,
            status: z.enum(["focused", "removed"]),
      })
      .strict()
      )
      .nullable()
      .default(null),
    playheadTicks: z.number().int().nonnegative().nullable(),
    sceneId: idSchema.nullable(),
    selectedElements: z.array(editorElementSchema).max(2_000),
    selectedKeyframes: z.array(editorKeyframeSchema).max(5_000),
    selectedMaskPoints: editorMaskPointsSchema.nullable(),
    selectedTrackIds: z.array(idSchema).max(1_000),
    timeRange: editorTimeRangeSchema.nullable(),
  })
  .strict();

export const agentContextAttachmentSchema = z
  .object({
    attachmentId: idSchema,
    displayName: z.string().trim().min(1).max(160),
    media: z
      .object({
        durationSeconds: z.number().nonnegative().nullable(),
        height: z.number().int().positive().nullable(),
        width: z.number().int().positive().nullable(),
      })
      .strict(),
    mimeType: z.string().trim().min(1).max(160),
    path: projectRelativePathSchema,
    sha256: sha256Schema,
    size: z.number().int().nonnegative(),
  })
  .strict();

export const agentContextBindingSchema = z
  .object({
    appSessionId: idSchema,
    windowId: idSchema,
  })
  .strict();

export const agentContextSnapshotSchema = z
  .object({
    activeView: z.enum(["canvas", "editor", "plan"]),
    attachments: z.array(agentContextAttachmentSchema).max(100),
    binding: agentContextBindingSchema.nullable(),
    canvas: canvasAgentContextSchema,
    clearEpoch: z.number().int().nonnegative(),
    contentHash: sha256Schema,
    contextRevision: z.number().int().nonnegative(),
    editor: editorAgentContextSchema,
    projectId: idSchema,
    projectRevision: z.string().trim().max(200).nullable(),
    schema: z.literal(AGENT_CONTEXT_SCHEMA),
    schemaVersion: z.literal(AGENT_CONTEXT_SCHEMA_VERSION),
    snapshotId: idSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();

export const patchAgentContextSchema = z
  .object({
    activeView: z.enum(["canvas", "editor", "plan"]),
    appSessionId: idSchema,
    attachmentIds: z.array(idSchema).max(100).default([]),
    baseContextRevision: z.number().int().nonnegative(),
    canvas: canvasAgentContextSchema,
    clear: z.boolean().default(false),
    editor: editorAgentContextSchema,
    projectId: idSchema,
    projectRevision: z.string().trim().max(200).nullable().default(null),
    windowId: idSchema,
  })
  .strict();

export const createTurnSnapshotSchema = z
  .object({
    agent: z.enum(["claude", "codex"]),
    agentSessionId: idSchema,
    expectedContextRevision: z.number().int().nonnegative().optional(),
    projectId: idSchema,
    turnId: idSchema.nullable().default(null),
    windowId: idSchema,
  })
  .strict();

export const agentTurnSnapshotSchema = z
  .object({
    agent: z.enum(["claude", "codex"]),
    agentSessionId: idSchema,
    context: agentContextSnapshotSchema,
    createdAt: z.string().datetime(),
    projectId: idSchema,
    schema: z.literal("AgentContextTurnSnapshot@1"),
    snapshotId: idSchema,
    turnId: idSchema.nullable(),
    windowId: idSchema,
  })
  .strict();

export const attachmentManifestSchema = agentContextAttachmentSchema.extend({
  createdAt: z.string().datetime(),
  schema: z.literal("AgentContextAttachment@1"),
});

export function normalizeAgentContextAttachment(
  value: z.input<typeof attachmentManifestSchema>,
) {
  const manifest = attachmentManifestSchema.parse(value);
  return agentContextAttachmentSchema.parse({
    attachmentId: manifest.attachmentId,
    displayName: manifest.displayName,
    media: manifest.media,
    mimeType: manifest.mimeType,
    path: manifest.path,
    sha256: manifest.sha256,
    size: manifest.size,
  });
}

export type AgentContextArtifact = z.infer<typeof agentContextArtifactSchema>;
export type AgentContextAttachment = z.infer<typeof agentContextAttachmentSchema>;
export type AgentContextBinding = z.infer<typeof agentContextBindingSchema>;
export type AgentContextSnapshot = z.infer<typeof agentContextSnapshotSchema>;
export type AgentTurnSnapshot = z.infer<typeof agentTurnSnapshotSchema>;
export type AttachmentManifest = z.infer<typeof attachmentManifestSchema>;
export type CreateTurnSnapshotInput = z.infer<typeof createTurnSnapshotSchema>;
export type PatchAgentContextInput = z.infer<typeof patchAgentContextSchema>;
