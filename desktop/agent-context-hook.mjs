import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  readPrivateConnectionState,
} from "./connection-state.mjs";
import {
  deriveProjectBearerToken,
  validateProjectId,
} from "./project-binding.mjs";

const AGENTS = new Set(["claude", "codex"]);
const MAX_HOOK_INPUT_BYTES = 256 * 1024;

export async function runAgentContextHook({
  agent,
  input,
  projectId: rawProjectId,
  statePath,
}) {
  const normalizedAgent = AGENTS.has(agent) ? agent : null;
  if (!normalizedAgent) {
    return failOpen(agent, "Video FS context was not injected: unsupported agent.");
  }

  let projectId;
  try {
    projectId = validateProjectId(rawProjectId, "project id");
  } catch {
    return failOpen(
      normalizedAgent,
      "Video FS context was not injected: invalid project binding.",
    );
  }

  const safeInput = normalizeHookInput(input);
  if (!safeInput) {
    return failOpen(
      normalizedAgent,
      "Video FS context was not injected: invalid hook input.",
    );
  }

  try {
    const state = await readPrivateConnectionState(statePath);
    await assertHookProjectBinding({
      cwd: safeInput.cwd,
      dataRoot: state.dataRoot,
      projectId,
    });
    const currentPayload = await callDesktop(state, projectId, "get_agent_context", {
      projectId,
    });
    const context = currentPayload?.context;
    if (
      !context ||
      context.projectId !== projectId ||
      !Number.isSafeInteger(context.contextRevision) ||
      context.contextRevision <= 0 ||
      !context.binding?.windowId
    ) {
      return failOpen(
        normalizedAgent,
        "Video FS context was not injected: the app has no live selection for this project.",
      );
    }
    if (Array.isArray(currentPayload.staleEntities) && currentPayload.staleEntities.length) {
      return failOpen(
        normalizedAgent,
        "Video FS context was not injected: the current selection is stale. Refresh it in Video FS.",
      );
    }

    const turnPayload = await callDesktop(
      state,
      projectId,
      "create_agent_turn_snapshot",
      {
        agent: normalizedAgent,
        agentSessionId: safeInput.sessionId,
        expectedContextRevision: context.contextRevision,
        projectId,
        turnId: safeInput.turnId,
        windowId: context.binding.windowId,
      },
    );
    const snapshot = turnPayload?.snapshot;
    if (
      !snapshot ||
      snapshot.projectId !== projectId ||
      snapshot.agent !== normalizedAgent ||
      snapshot.agentSessionId !== safeInput.sessionId ||
      snapshot.context?.contextRevision !== context.contextRevision
    ) {
      return failOpen(
        normalizedAgent,
        "Video FS context was not injected: the turn snapshot could not be verified.",
      );
    }

    return {
      contextInjected: true,
      output: hookOutput(compactDeveloperContext(snapshot)),
      snapshotId: snapshot.snapshotId,
    };
  } catch {
    return failOpen(
      normalizedAgent,
      "Video FS context was not injected: the desktop connection is offline or changed. Reopen the project and retry.",
    );
  }
}

export function parseHookInput(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_HOOK_INPUT_BYTES) {
    return null;
  }
  try {
    return normalizeHookInput(JSON.parse(raw));
  } catch {
    return null;
  }
}

function normalizeHookInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sessionId =
    typeof (value.session_id ?? value.sessionId) === "string" &&
    (value.session_id ?? value.sessionId).trim()
      ? (value.session_id ?? value.sessionId).trim()
      : null;
  const cwd =
    typeof value.cwd === "string" && path.isAbsolute(value.cwd)
      ? value.cwd
      : null;
  const turnId =
    typeof (value.turn_id ?? value.turnId) === "string" &&
    (value.turn_id ?? value.turnId).trim()
      ? (value.turn_id ?? value.turnId).trim()
      : null;
  if (!sessionId || !cwd) return null;
  return { cwd, sessionId, turnId };
}

async function assertHookProjectBinding({ cwd, dataRoot, projectId }) {
  const root = await realpath(path.resolve(dataRoot));
  const projectRoot = await realpath(path.join(root, projectId));
  if (path.dirname(projectRoot) !== root) {
    throw new Error("Project resolved outside the desktop data root.");
  }
  const resolvedCwd = await realpath(cwd);
  const relative = path.relative(projectRoot, resolvedCwd);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Hook working directory is outside the bound project.");
  }
}

async function callDesktop(state, projectId, tool, args) {
  const projectBearer = deriveProjectBearerToken(
    state.token,
    state.dataRoot,
    projectId,
  );
  const response = await fetch(`${state.appUrl}/api/paper/tools`, {
    body: JSON.stringify({ arguments: args, tool }),
    headers: {
      authorization: `Bearer ${projectBearer}`,
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(4_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error("Video FS context request failed.");
  }
  return payload;
}

function compactDeveloperContext(snapshot) {
  const context = snapshot.context;
  const lines = [
    "<video-fs-context>",
    `turn_snapshot: ${snapshot.snapshotId}`,
    `context_revision: ${context.contextRevision}`,
    `active_view: ${context.activeView}`,
    `resource: videofs://agent-context/turns/${snapshot.snapshotId}`,
  ];

  if (context.activeView === "canvas") {
    appendArtifacts(lines, "selected", context.canvas.selected);
    appendArtifacts(lines, "pinned", context.canvas.pinned);
    if (context.canvas.focused) {
      appendArtifacts(lines, "focused", [context.canvas.focused]);
    }
  } else if (context.activeView === "editor") {
    appendArtifacts(
      lines,
      "editor_focused",
      context.editor.focusedArtifact ? [context.editor.focusedArtifact] : [],
    );
    lines.push(
      `editor_document_revision: ${nullable(context.editor.documentRevision)}`,
      `editor_scene: ${nullable(context.editor.sceneId)}`,
      `editor_playhead_ticks: ${nullable(context.editor.playheadTicks)}`,
      `editor_tracks: ${context.editor.selectedTrackIds.join(",") || "none"}`,
      `editor_elements: ${
        context.editor.selectedElements
          .map((item) => `${item.trackId}/${item.elementId}:${item.kind}`)
          .join(",") || "none"
      }`,
      `editor_keyframes: ${
        context.editor.selectedKeyframes
          .map(
            (item) =>
              `${item.trackId}/${item.elementId}/${item.keyframeId}:${item.property}`,
          )
          .join(",") || "none"
      }`,
      `editor_time_range: ${
        context.editor.timeRange
          ? `${context.editor.timeRange.startTicks}-${context.editor.timeRange.endTicks}`
          : "none"
      }`,
    );
  }
  lines.push(
    `ready_attachments: ${
      context.attachments.map((item) => item.attachmentId).join(",") || "none"
    }`,
    "</video-fs-context>",
  );
  return lines.join("\n");
}

function appendArtifacts(lines, label, artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    lines.push(`${label}: none`);
    return;
  }
  for (const artifact of artifacts) {
    const projectPath = safeProjectRelativePath(artifact.path);
    lines.push(
      `${label}: ${artifact.kind}:${artifact.artifactId}` +
        ` path=${nullable(projectPath)}` +
        ` version=${nullable(artifact.version?.versionId)}` +
        ` index=${nullable(artifact.version?.index)}` +
        ` version_sha256=${nullable(artifact.version?.sha256)}` +
        ` content_sha256=${nullable(artifact.contentHash)}` +
        ` entity_revision=${nullable(artifact.entityRevision)}`,
    );
  }
}

function safeProjectRelativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    return null;
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return null;
  }
  return value;
}

function nullable(value) {
  return value === null || value === undefined ? "none" : String(value);
}

function hookOutput(context) {
  return {
    continue: true,
    hookSpecificOutput: {
      additionalContext: context,
      hookEventName: "UserPromptSubmit",
    },
    suppressOutput: true,
  };
}

function failOpen(agent, message) {
  return {
    contextInjected: false,
    output:
      agent === "claude"
        ? {
            continue: true,
            suppressOutput: false,
            systemMessage: message,
          }
        : {
            continue: true,
            suppressOutput: false,
            systemMessage: message,
          },
    snapshotId: null,
  };
}
