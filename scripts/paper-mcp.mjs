#!/usr/bin/env node

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveBoundProjectId } from "../desktop/project-binding.mjs";

const appUrl = (process.env.VIDEO_FS_APP_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const defaultProjectId = process.env.VIDEO_FS_PROJECT_ID || null;
const token = process.env.PAPER_MCP_TOKEN?.trim() || null;

class VideoFsToolError extends Error {
  constructor(message, { code, remediation, status } = {}) {
    super(message);
    this.name = "VideoFsToolError";
    this.code =
      typeof code === "string" && code ? code : "VIDEO_FS_TOOL_FAILED";
    this.remediation =
      typeof remediation === "string" && remediation ? remediation : null;
    this.status = typeof status === "number" ? status : null;
  }
}

/** POST to the app over node:http with all timeouts disabled. Generation
 * calls (Seedance clips especially) legitimately run past fetch/undici's
 * default 300s headers timeout, which surfaced as phantom "bridge
 * disconnected" failures mid-render — and every blind retry re-billed the
 * provider. */
function callApp(tool, args) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${appUrl}/api/paper/tools`);
    const body = JSON.stringify({ arguments: args, tool });
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(
      {
        headers: {
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        hostname: url.hostname,
        method: "POST",
        path: url.pathname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          let payload = {};
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            // Non-JSON body falls through to the status check below.
          }
          if (response.statusCode && response.statusCode < 400) {
            resolve(payload);
            return;
          }
          reject(
            new VideoFsToolError(
              typeof payload.error === "string"
                ? payload.error
                : `Video FS app returned HTTP ${response.statusCode}.`,
              {
                code: payload.code,
                remediation: payload.remediation,
                status: response.statusCode,
              },
            ),
          );
        });
        response.on("error", reject);
      },
    );
    request.setTimeout(0);
    request.on("error", reject);
    request.end(body);
  });
}

function projectId(input) {
  return resolveBoundProjectId(input, defaultProjectId);
}

function toolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent:
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : { result: payload },
  };
}

function resourceResult(uri, payload) {
  return {
    contents: [
      {
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
        uri: uri.href,
      },
    ],
  };
}

function resourceVariable(variables, name) {
  const value = variables[name];
  if (typeof value !== "string" || !value) {
    throw new Error(`MCP resource variable "${name}" is invalid.`);
  }
  return value;
}

const exactArtifactVersionSchema = z
  .object({
    index: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    version_id: z.string().min(1),
  })
  .strict();
const exactArtifactSchema = z
  .object({
    artifact_id: z.string().min(1),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    entity_revision: z.number().int().nonnegative(),
    kind: z.string().min(1),
    path: z.string().min(1),
    title: z.string().nullable().optional(),
    version: exactArtifactVersionSchema.nullable().optional(),
  })
  .strict();
const editorTargetSchema = z
  .object({
    artifact: exactArtifactSchema,
    element_id: z.string().min(1),
    track_id: z.string().min(1),
  })
  .strict();
const editorMutationInput = {
  actor_id: z.string().min(1),
  agent: z.enum(["claude", "codex", "other"]).default("other"),
  base_editor_revision: z.number().int().nonnegative(),
  command_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  project_id: z.string().optional(),
  scene_id: z.string().min(1).optional(),
};

function exactArtifact(input) {
  return {
    artifactId: input.artifact_id,
    contentHash: input.content_hash,
    entityRevision: input.entity_revision,
    kind: input.kind,
    path: input.path,
    title: input.title ?? null,
    version: input.version
      ? {
          index: input.version.index,
          sha256: input.version.sha256,
          versionId: input.version.version_id,
        }
      : null,
  };
}

function editorTarget(input) {
  return {
    artifact: exactArtifact(input.artifact),
    elementId: input.element_id,
    trackId: input.track_id,
  };
}

function editorMutationBase(input) {
  return {
    actor: { id: input.actor_id, type: "agent" },
    baseEditorRevision: input.base_editor_revision,
    commandId: input.command_id,
    idempotencyKey: input.idempotency_key,
    origin: input.agent === "claude" || input.agent === "codex" ? input.agent : "mcp",
    projectId: projectId(input.project_id),
    sceneId: input.scene_id,
  };
}

function register(name, definition, handler) {
  server.registerTool(name, definition, async (args) => {
    try {
      return toolResult(await handler(args));
    } catch (error) {
      const failure =
        error instanceof VideoFsToolError
          ? {
              code: error.code,
              message: error.message,
              remediation: error.remediation,
            }
          : {
              code: "VIDEO_FS_CONNECTION_FAILED",
              message: error instanceof Error ? error.message : `${name} failed.`,
              remediation:
                "Keep Video FS open and reconnect the project agent, then retry.",
            };
      return {
        content: [
          {
            type: "text",
            text: [
              failure.message,
              failure.remediation
                ? `Remediation: ${failure.remediation}`
                : null,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        isError: true,
        structuredContent: {
          error: failure,
          ok: false,
        },
      };
    }
  });
}

const server = new McpServer({
  name: "video-fs-paper-mode",
  version: "0.1.0",
});

register(
  "load_workflow",
  {
    description:
      "Load a built-in production recipe when the user's request is genuinely multi-stage and strongly matches the workflow inventory supplied in the composer prompt. Workflows are internal aids: adapt the recipe and continue executing instead of asking the user to choose one.",
    inputSchema: {
      project_id: z.string().optional(),
      workflow_id: z.string().min(1),
    },
  },
  ({ project_id, workflow_id }) =>
    callApp("load_workflow", {
      projectId: projectId(project_id),
      workflowId: workflow_id,
    }),
);

register(
  "create_scene",
  {
    description:
      "Create a narrative scene record in the Video FS project. Use before keyframes/clips.",
    inputSchema: {
      body: z.string().min(1),
      index: z.number().int().positive(),
      project_id: z.string().optional(),
      reference_ids: z.array(z.string()).optional(),
      scene_id: z.string().min(1),
      title: z.string().min(1),
    },
  },
  ({ body, index, project_id, reference_ids, scene_id, title }) =>
    callApp("create_scene", {
      body,
      index,
      projectId: projectId(project_id),
      referenceIds: reference_ids,
      sceneId: scene_id,
      title,
    }),
);

register(
  "scaffold_keyframe",
  {
    description:
      "Write a planned keyframe record before generating its pixels. External agents may also edit the markdown file directly.",
    inputSchema: {
      aspect_ratio: z.string().optional(),
      body: z.string().min(1),
      depicts: z.array(z.string()).optional(),
      keyframe_id: z.string().min(1),
      project_id: z.string().optional(),
      state_anchor: z.string().nullable().optional(),
      title: z.string().min(1),
    },
  },
  ({ aspect_ratio, body, depicts, keyframe_id, project_id, state_anchor, title }) =>
    callApp("scaffold_keyframe", {
      aspectRatio: aspect_ratio,
      body,
      depicts,
      keyframeId: keyframe_id,
      projectId: projectId(project_id),
      stateAnchor: state_anchor,
      title,
    }),
);

register(
  "generate_image",
  {
    description:
      "Generate or regenerate a canvas image/keyframe through the app's existing Fal image path. The CLI agent supplies all reasoning and the final prompt. REFERENCE PORTFOLIOS: pass portfolio_reference_id (+ portfolio_category: characters|environments|props|styles) instead of hand-writing portfolio.md — the app generates the 3x3 sheet AND the derived single display/profile shot, and writes references/<category>/<id>/portfolio.md itself (urls + display_url). source_ids CONDITION the sheet on existing project media — for converting a real photo into a character, pass the upload's id (+ the style portfolio's id) so the generation actually sees the images. Do not edit portfolio frontmatter manually.",
    inputSchema: {
      aspect_ratio: z.string().optional(),
      portfolio_category: z.string().optional(),
      portfolio_reference_id: z.string().optional(),
      project_id: z.string().optional(),
      prompt: z.string().min(1),
      reference_or_keyframe_id: z.string().min(1),
      source_ids: z.array(z.string()).optional(),
      title: z.string().min(1),
    },
  },
  ({
    aspect_ratio,
    portfolio_category,
    portfolio_reference_id,
    project_id,
    prompt,
    reference_or_keyframe_id,
    source_ids,
    title,
  }) =>
    callApp("generate_image", {
      aspectRatio: aspect_ratio,
      portfolioCategory: portfolio_category,
      portfolioReferenceId: portfolio_reference_id,
      projectId: projectId(project_id),
      prompt,
      referenceOrKeyframeId: reference_or_keyframe_id,
      sourceIds: source_ids,
      title,
    }),
);

register(
  "generate_clip",
  {
    description:
      "Generate a Seedance clip for an existing scene through the app's existing Fal video path. No app-side LLM is used. " +
      "For the house chaining method, pass extends_clip_id with the previous clip's id: its actual footage becomes @Video1 " +
      "on Seedance's reference-to-video endpoint, and the prompt should describe only what happens NEXT (\"Continue from " +
      "@Video1: ...\"). Pass reference_ids (reference/portfolio/keyframe ids, up to 9) to attach identity/style images as " +
      "@Image1..@ImageN in order — keep the same character references in every link of a chain. extends_clip_id and " +
      "keyframe pins are mutually exclusive; from/to keyframes belong to the keyframe-interpolation method.",
    inputSchema: {
      aspect_ratio: z.string().optional(),
      clip_id: z.string().min(1),
      duration_seconds: z.number().min(4).max(15).optional(),
      extends_clip_id: z.string().nullable().optional(),
      from_keyframe_id: z.string().nullable().optional(),
      project_id: z.string().optional(),
      prompt: z.string().min(1),
      reference_ids: z.array(z.string().min(1)).max(9).optional(),
      scene_id: z.string().min(1),
      title: z.string().min(1),
      to_keyframe_id: z.string().nullable().optional(),
    },
  },
  ({
    aspect_ratio,
    clip_id,
    duration_seconds,
    extends_clip_id,
    from_keyframe_id,
    project_id,
    prompt,
    reference_ids,
    scene_id,
    title,
    to_keyframe_id,
  }) =>
    callApp("generate_clip", {
      aspectRatio: aspect_ratio,
      clipId: clip_id,
      durationSeconds: duration_seconds,
      extendsClipId: extends_clip_id,
      fromKeyframeId: from_keyframe_id,
      projectId: projectId(project_id),
      prompt,
      referenceIds: reference_ids,
      sceneId: scene_id,
      title,
      toKeyframeId: to_keyframe_id,
    }),
);

register(
  "check_project",
  {
    description:
      "Run the deterministic Video FS continuity checker. Always call this after changing a reference or production graph record.",
    inputSchema: { project_id: z.string().optional() },
  },
  ({ project_id }) =>
    callApp("check_project", { projectId: projectId(project_id) }),
);

register(
  "get_project_status",
  {
    description:
      "Return project metadata, artifact counts, running operations, timeline size, and current checker result.",
    inputSchema: { project_id: z.string().optional() },
  },
  ({ project_id }) =>
    callApp("get_project_status", { projectId: projectId(project_id) }),
);

register(
  "get_agent_context",
  {
    annotations: { readOnlyHint: true },
    description:
      "Read the current immutable AgentContextSnapshot@1 for this project, including ordered Canvas/Editor selections and normalized attachments.",
    inputSchema: { project_id: z.string().optional() },
  },
  ({ project_id }) =>
    callApp("get_agent_context", { projectId: projectId(project_id) }),
);

register(
  "get_agent_context_status",
  {
    annotations: { readOnlyHint: true },
    description:
      "Read the bound project context revision, clear epoch, visible-item count, binding, and stale-entity status.",
    inputSchema: { project_id: z.string().optional() },
  },
  ({ project_id }) =>
    callApp("get_agent_context_status", {
      projectId: projectId(project_id),
    }),
);

register(
  "get_agent_context_revision",
  {
    annotations: { readOnlyHint: true },
    description:
      "Read one immutable AgentContextSnapshot@1 revision from the bound project.",
    inputSchema: {
      project_id: z.string().optional(),
      revision: z.number().int().nonnegative(),
    },
  },
  ({ project_id, revision }) =>
    callApp("get_agent_context_revision", {
      projectId: projectId(project_id),
      revision,
    }),
);

register(
  "get_agent_context_attachment",
  {
    annotations: { readOnlyHint: true },
    description:
      "Read a normalized, privacy-safe attachment descriptor from the bound project context. Returns only project-relative paths and hashes, never source paths.",
    inputSchema: {
      attachment_id: z.string().regex(/^att_[a-f0-9]{32}$/),
      project_id: z.string().optional(),
    },
  },
  ({ attachment_id, project_id }) =>
    callApp("get_agent_context_attachment", {
      attachmentId: attachment_id,
      projectId: projectId(project_id),
    }),
);

register(
  "create_agent_turn_snapshot",
  {
    description:
      "Freeze the current bound-project context for one Claude or Codex prompt turn. Use expected_context_revision to reject stale handoffs.",
    inputSchema: {
      agent: z.enum(["claude", "codex"]),
      agent_session_id: z.string().min(1),
      expected_context_revision: z.number().int().nonnegative().optional(),
      project_id: z.string().optional(),
      turn_id: z.string().min(1).nullable().optional(),
      window_id: z.string().min(1),
    },
  },
  ({
    agent,
    agent_session_id,
    expected_context_revision,
    project_id,
    turn_id,
    window_id,
  }) =>
    callApp("create_agent_turn_snapshot", {
      agent,
      agentSessionId: agent_session_id,
      expectedContextRevision: expected_context_revision,
      projectId: projectId(project_id),
      turnId: turn_id ?? null,
      windowId: window_id,
    }),
);

register(
  "get_agent_turn_snapshot",
  {
    annotations: { readOnlyHint: true },
    description:
      "Read one immutable prompt-turn context snapshot from the bound project.",
    inputSchema: {
      project_id: z.string().optional(),
      snapshot_id: z.string().regex(/^turn_[A-Za-z0-9-]+$/),
    },
  },
  ({ project_id, snapshot_id }) =>
    callApp("get_agent_turn_snapshot", {
      projectId: projectId(project_id),
      snapshotId: snapshot_id,
    }),
);

register(
  "refresh_agent_context",
  {
    annotations: { readOnlyHint: true },
    description:
      "Fetch the live selection and verify selected hashes. This never falls back to a cached selection.",
    inputSchema: { project_id: z.string().optional() },
  },
  ({ project_id }) =>
    callApp("refresh_agent_context", {
      projectId: projectId(project_id),
    }),
);

register(
  "rebase_agent_context",
  {
    description:
      "Freeze a new immutable turn snapshot from the latest live selection after a revision conflict.",
    inputSchema: {
      agent: z.enum(["claude", "codex"]),
      agent_session_id: z.string().min(1),
      project_id: z.string().optional(),
      turn_id: z.string().min(1).nullable().optional(),
      window_id: z.string().min(1),
    },
  },
  ({ agent, agent_session_id, project_id, turn_id, window_id }) =>
    callApp("rebase_agent_context", {
      agent,
      agentSessionId: agent_session_id,
      projectId: projectId(project_id),
      turnId: turn_id ?? null,
      windowId: window_id,
    }),
);

register(
  "get_connection_status",
  {
    annotations: { readOnlyHint: true },
    description:
      "Confirm the private loopback bridge is connected to this exact project. Never returns credentials or connection-record paths.",
    inputSchema: { project_id: z.string().optional() },
  },
  ({ project_id }) =>
    callApp("get_connection_status", {
      projectId: projectId(project_id),
  }),
);

register(
  "agent_request_input",
  {
    description:
      "Pause the bound agent turn for one concise, durable user input request. The request survives restart, expires, and may be answered exactly once.",
    inputSchema: {
      actor_id: z.string().min(1).max(160),
      choices: z
        .array(
          z
            .object({
              id: z.string().min(1).max(80),
              label: z.string().min(1).max(500),
              value: z.union([
                z.string().max(500),
                z.number().finite(),
                z.boolean(),
              ]),
            })
            .strict(),
        )
        .max(12)
        .default([]),
      expires_in_seconds: z.number().int().min(30).max(600).default(300),
      originating_command: z.string().min(1).max(180),
      project_id: z.string().optional(),
      question: z.string().min(1).max(500),
      request_id: z.string().min(1).max(120),
    },
  },
  ({
    actor_id,
    choices,
    expires_in_seconds,
    originating_command,
    project_id,
    question,
    request_id,
  }) =>
    callApp("agent_request_input", {
      actor: { id: actor_id, type: "agent" },
      choices,
      expiresInSeconds: expires_in_seconds,
      id: request_id,
      kind: "input",
      originatingCommand: originating_command,
      projectId: projectId(project_id),
      question,
    }),
);

register(
  "agent_request_approval",
  {
    description:
      "Pause the bound agent turn for durable approval of one exact proposed command and payload hash. Expiry denies by default; approval may resolve exactly once.",
    inputSchema: {
      actor_id: z.string().min(1).max(160),
      destructive: z.boolean().default(false),
      estimated_cost_usd: z.number().finite().nonnegative().nullable().default(null),
      expires_in_seconds: z.number().int().min(30).max(600).default(300),
      originating_command: z.string().min(1).max(180),
      payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
      permissions: z.array(z.string().min(1).max(120)).max(24).default([]),
      project_id: z.string().optional(),
      proposed_command: z.string().min(1).max(180),
      question: z.string().min(1).max(500),
      request_id: z.string().min(1).max(120),
    },
  },
  ({
    actor_id,
    destructive,
    estimated_cost_usd,
    expires_in_seconds,
    originating_command,
    payload_hash,
    permissions,
    project_id,
    proposed_command,
    question,
    request_id,
  }) =>
    callApp("agent_request_approval", {
      actor: { id: actor_id, type: "agent" },
      destructive,
      estimatedCostUsd: estimated_cost_usd,
      expiresInSeconds: expires_in_seconds,
      id: request_id,
      kind: "approval",
      originatingCommand: originating_command,
      payloadHash: payload_hash,
      permissions,
      projectId: projectId(project_id),
      proposedCommand: proposed_command,
      question,
    }),
);

register(
  "editor_timeline_get",
  {
    annotations: { readOnlyHint: true },
    description:
      "Read the bound project's current OpenCut timeline and editor revision. Times are integer ticks at 120000 ticks per second. Call before every timeline mutation.",
    inputSchema: { project_id: z.string().optional() },
  },
  ({ project_id }) =>
    callApp("editor_timeline_get", {
      projectId: projectId(project_id),
    }),
);

/* Superseded by editor_edit (2026-07-29): the five single-purpose timeline
   mutations below are retired from the tool surface but kept verbatim so
   reverting is a matter of uncommenting this block. The server-side
   command implementations remain live.
register(
  "editor_timeline_insert",
  {
    description:
      "Insert one exact, hash-verified Canvas artifact version into an existing OpenCut track. The inserted video is muted by default. Requires the current editor revision and an idempotency key.",
    inputSchema: {
      ...editorMutationInput,
      artifact: exactArtifactSchema,
      duration_ticks: z.number().int().positive(),
      element_id: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      start_time_ticks: z.number().int().nonnegative(),
      track_id: z.string().min(1),
    },
  },
  (input) =>
    callApp("editor_timeline_insert", {
      ...editorMutationBase(input),
      artifact: exactArtifact(input.artifact),
      durationTicks: input.duration_ticks,
      elementId: input.element_id,
      name: input.name,
      startTimeTicks: input.start_time_ticks,
      trackId: input.track_id,
    }),
);

register(
  "editor_timeline_move",
  {
    description:
      "Move one hash-verified Canvas-backed Editor element to a track/time using OpenCut's validated move command behavior.",
    inputSchema: {
      ...editorMutationInput,
      new_start_time_ticks: z.number().int().nonnegative(),
      target: editorTargetSchema,
      target_track_id: z.string().min(1),
    },
  },
  (input) =>
    callApp("editor_timeline_move", {
      ...editorMutationBase(input),
      newStartTimeTicks: input.new_start_time_ticks,
      target: editorTarget(input.target),
      targetTrackId: input.target_track_id,
    }),
);

register(
  "editor_timeline_trim",
  {
    description:
      "Trim one hash-verified Canvas-backed Editor element using OpenCut's validated element update behavior.",
    inputSchema: {
      ...editorMutationInput,
      duration_ticks: z.number().int().positive(),
      target: editorTargetSchema,
      trim_end_ticks: z.number().int().nonnegative(),
      trim_start_ticks: z.number().int().nonnegative(),
    },
  },
  (input) =>
    callApp("editor_timeline_trim", {
      ...editorMutationBase(input),
      durationTicks: input.duration_ticks,
      target: editorTarget(input.target),
      trimEndTicks: input.trim_end_ticks,
      trimStartTicks: input.trim_start_ticks,
    }),
);

register(
  "editor_timeline_split",
  {
    description:
      "Split one hash-verified Canvas-backed Editor element at an absolute timeline tick using OpenCut's split behavior.",
    inputSchema: {
      ...editorMutationInput,
      right_element_id: z.string().min(1).optional(),
      split_time_ticks: z.number().int().positive(),
      target: editorTargetSchema,
    },
  },
  (input) =>
    callApp("editor_timeline_split", {
      ...editorMutationBase(input),
      rightElementId: input.right_element_id,
      splitTimeTicks: input.split_time_ticks,
      target: editorTarget(input.target),
    }),
);

register(
  "editor_timeline_remove",
  {
    annotations: { destructiveHint: true },
    description:
      "Recoverably remove one or more hash-verified Canvas-backed Editor elements. The command receipt stores a serializable track preimage for undo/history.",
    inputSchema: {
      ...editorMutationInput,
      targets: z.array(editorTargetSchema).min(1).max(100),
    },
  },
  (input) =>
    callApp("editor_timeline_remove", {
      ...editorMutationBase(input),
      targets: input.targets.map(editorTarget),
    }),
);
*/

const editorElementRefSchema = z
  .object({
    artifact: exactArtifactSchema.optional(),
    element_id: z.string().min(1),
    track_id: z.string().min(1),
  })
  .strict();

register(
  "editor_edit",
  {
    description:
      "One OpenCut timeline ELEMENT mutation per call, chosen by `action`. Payload fields are camelCase. Times are integer ticks at 120000 ticks/second. Element refs are {trackId, elementId, artifact?} — include the exact Canvas artifact identity for media elements when you have it. Actions: insert {artifact{artifactId,contentHash,entityRevision,kind,path,version?}, startTimeTicks, durationTicks, placement:{mode:'explicit',trackId}|{mode:'auto',trackType?,insertIndex?}, name?, elementId?} · insert_text {content, startTimeTicks, durationTicks, params?, placement?, name?} · update {target, params? (e.g. volume, opacity, blendMode, 'transform.positionX', fontSize, color), retime?:{rate:0.01-5, maintainPitch?}|null, hidden?, name?, isSourceAudioEnabled?, effects?, masks?} · move {target, targetTrackId, newStartTimeTicks} · trim {target, trimStartTicks, trimEndTicks, durationTicks} · split {target, splitTimeTicks, retainSide?:'both'|'left'|'right', rightElementId?} · remove {targets:[ref], ripple?} · duplicate {target, startTimeTicks?, newElementId?} · separate_audio {target}. Returns an EditorCommandReceipt@2 with the new revision and undo info.",
    inputSchema: {
      ...editorMutationInput,
      action: z.enum([
        "duplicate",
        "insert",
        "insert_text",
        "move",
        "remove",
        "separate_audio",
        "split",
        "trim",
        "update",
      ]),
      payload: z.record(z.unknown()).default({}),
    },
  },
  (input) =>
    callApp("editor_edit", {
      ...input.payload,
      ...editorMutationBase(input),
      action: input.action,
    }),
);

register(
  "editor_structure",
  {
    description:
      "One OpenCut timeline STRUCTURE mutation per call, chosen by `action` — tracks, scenes, bookmarks, project settings, view switching, and undo. Payload fields are camelCase. Actions: track_add {trackType:'video'|'text'|'audio'|'graphic'|'effect', name?, insertIndex?, trackId?} · track_update {trackId, muted?, hidden?, name?} · track_remove {trackId, force?} · scene_add {name, newSceneId?} · scene_rename {targetSceneId, name} · scene_switch {targetSceneId} · scene_remove {targetSceneId} · bookmark_set {timeTicks, note?, color?, durationTicks?} · bookmark_remove {timeTicks} · settings_update {fps?, canvasSize?:{width,height}, background?} · undo {undoCommandId?} (replays the stored inverse of a prior receipt; omit to undo the latest command) · view_switch {view:'canvas'|'editor'} (switches the open workbench view — use before editor work when the user is on the canvas). Returns an EditorCommandReceipt@2.",
    inputSchema: {
      ...editorMutationInput,
      action: z.enum([
        "bookmark_remove",
        "bookmark_set",
        "scene_add",
        "scene_remove",
        "scene_rename",
        "scene_switch",
        "settings_update",
        "track_add",
        "view_switch",
        "track_remove",
        "track_update",
        "undo",
      ]),
      payload: z.record(z.unknown()).default({}),
    },
  },
  (input) =>
    callApp("editor_structure", {
      ...input.payload,
      ...editorMutationBase(input),
      action: input.action,
    }),
);

register(
  "edit_media",
  {
    description:
      "One canvas MEDIA edit per call, chosen by `op` — runs the app's own ffmpeg paths and versioning, exactly like the tile drawer. Ops: trim {path:'clips/<id>.md', start_seconds, end_seconds, mode:'version' (new version in place, default) | 'new' (new provenance-linked tile)} · crop_filters {path:'keyframes|uploads/<id>.md', crop?:{x,y,width,height 0..1}, filters?: record of brightness/contrast/saturation/warmth/hue/sharpen/vignette/blur 0-100 (neutral 50; blur/sharpen/vignette neutral 0)} · extract_frame {path:'clips/<id>.md', at:'first'|'last', version?}. Metadata-only changes (rename, delete via status:'rejected', groups) are direct file edits — no tool needed.",
    inputSchema: {
      at: z.enum(["first", "last"]).optional(),
      clip_id: z.string().min(1).optional(),
      crop: z
        .object({
          height: z.number().min(0).max(1),
          width: z.number().min(0).max(1),
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
        })
        .strict()
        .optional(),
      end_seconds: z.number().positive().optional(),
      filters: z.record(z.number().min(0).max(100)).optional(),
      mode: z.enum(["new", "version"]).optional(),
      op: z.enum(["crop_filters", "extract_frame", "trim"]),
      path: z.string().min(1),
      project_id: z.string().optional(),
      start_seconds: z.number().nonnegative().optional(),
      version: z.number().int().nonnegative().optional(),
    },
  },
  (input) =>
    callApp("edit_media", {
      at: input.at,
      clipId: input.clip_id,
      crop: input.crop,
      endSeconds: input.end_seconds,
      filters: input.filters,
      mode: input.mode,
      op: input.op,
      path: input.path,
      projectId: projectId(input.project_id),
      startSeconds: input.start_seconds,
      version: input.version,
    }),
);

register(
  "generate_audio",
  {
    description:
      "Generate audio through the app's providers; results land on the canvas as audio tiles. Kinds: music {prompt (genre/mood/instrumentation/tempo), title, duration_seconds? 5-120} · speech {text, title, voice? (name or a designed voiceId)} · sfx {prompt, title} · voice_design {prompt describing the voice, preview_text?} — returns ~3 voice previews with voiceIds usable as `voice` for speech; writes no tile.",
    inputSchema: {
      duration_seconds: z.number().min(5).max(120).optional(),
      kind: z.enum(["music", "sfx", "speech", "voice_design"]),
      preview_text: z.string().max(500).optional(),
      project_id: z.string().optional(),
      prompt: z.string().min(1).max(4000).optional(),
      text: z.string().min(1).max(8000).optional(),
      title: z.string().min(1).max(200).optional(),
      voice: z.string().min(1).max(120).optional(),
    },
  },
  (input) =>
    callApp("generate_audio", {
      durationSeconds: input.duration_seconds,
      kind: input.kind,
      previewText: input.preview_text,
      projectId: projectId(input.project_id),
      prompt: input.prompt,
      text: input.text,
      title: input.title,
      voice: input.voice,
    }),
);

if (defaultProjectId) {
  const boundProjectId = projectId(undefined);
  server.registerResource(
    "current-agent-context",
    "videofs://agent-context/current",
    {
      description:
        "Current AgentContextSnapshot@1 for the project bound to this MCP connection.",
      mimeType: "application/json",
      title: "Current agent context",
    },
    async (uri) =>
      resourceResult(
        uri,
        await callApp("get_agent_context", { projectId: boundProjectId }),
      ),
  );
  server.registerResource(
    "video-fs-connection-status",
    "videofs://connection/status",
    {
      description:
        "Credential-free connection status for the project bound to this MCP process.",
      mimeType: "application/json",
      title: "Video FS connection status",
    },
    async (uri) =>
      resourceResult(
        uri,
        await callApp("get_connection_status", {
          projectId: boundProjectId,
        }),
      ),
  );
  server.registerResource(
    "agent-context-status",
    "videofs://agent-context/status",
    {
      description:
        "Current revision, clear epoch, binding, and stale-entity status for the bound project.",
      mimeType: "application/json",
      title: "Agent context status",
    },
    async (uri) =>
      resourceResult(
        uri,
        await callApp("get_agent_context_status", {
          projectId: boundProjectId,
        }),
      ),
  );
  server.registerResource(
    "agent-context-revision",
    new ResourceTemplate("videofs://agent-context/revisions/{revision}", {
      list: undefined,
    }),
    {
      description:
        "One immutable AgentContextSnapshot@1 revision for the bound project.",
      mimeType: "application/json",
      title: "Agent context revision",
    },
    async (uri, variables) => {
      const revision = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(resourceVariable(variables, "revision"));
      return resourceResult(
        uri,
        await callApp("get_agent_context_revision", {
          projectId: boundProjectId,
          revision,
        }),
      );
    },
  );
  server.registerResource(
    "agent-context-attachment",
    new ResourceTemplate(
      "videofs://agent-context/attachments/{attachment_id}",
      { list: undefined },
    ),
    {
      description:
        "A normalized attachment descriptor for the bound project. Contains no original absolute path.",
      mimeType: "application/json",
      title: "Agent context attachment",
    },
    async (uri, variables) => {
      const attachmentId = z
        .string()
        .regex(/^att_[a-f0-9]{32}$/)
        .parse(resourceVariable(variables, "attachment_id"));
      return resourceResult(
        uri,
        await callApp("get_agent_context_attachment", {
          attachmentId,
          projectId: boundProjectId,
        }),
      );
    },
  );
  server.registerResource(
    "agent-context-turn-snapshot",
    new ResourceTemplate("videofs://agent-context/turns/{snapshot_id}", {
      list: undefined,
    }),
    {
      description:
        "One immutable turn-start context snapshot for the bound project.",
      mimeType: "application/json",
      title: "Agent turn context",
    },
    async (uri, variables) => {
      const snapshotId = z
        .string()
        .regex(/^turn_[A-Za-z0-9-]+$/)
        .parse(resourceVariable(variables, "snapshot_id"));
      return resourceResult(
        uri,
        await callApp("get_agent_turn_snapshot", {
          projectId: boundProjectId,
          snapshotId,
        }),
      );
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);

// Presence heartbeat: this process only lives while an agent session keeps the
// MCP server open, so a periodic ping tells the app "Claude/Codex is here".
// The agent identity comes from the MCP handshake's clientInfo (Claude Code
// and Codex both announce themselves), with an env override as fallback.
const PRESENCE_INTERVAL_MS = 20_000;
function presenceAgent() {
  const override = process.env.VIDEO_FS_AGENT;
  if (override === "claude" || override === "codex") return override;
  const clientName = (
    server.server?.getClientVersion?.()?.name ?? ""
  ).toLowerCase();
  if (clientName.includes("codex")) return "codex";
  if (clientName.includes("claude")) return "claude";
  return undefined;
}
let presenceProjectId = null;
try {
  presenceProjectId = projectId(undefined);
} catch {
  presenceProjectId = null;
}
const sendPresencePing = () => {
  const agent = presenceAgent();
  callApp("agent_presence_ping", {
    ...(agent ? { agent } : {}),
    projectId: presenceProjectId,
  }).catch(() => {
    // The app may be restarting; the next beat retries.
  });
};
if (presenceProjectId) {
  // Delay the first beat until the client's initialize handshake has landed,
  // so the ping carries the agent identity.
  setTimeout(sendPresencePing, 1_500).unref?.();
  const presenceTimer = setInterval(sendPresencePing, PRESENCE_INTERVAL_MS);
  presenceTimer.unref?.();
}
