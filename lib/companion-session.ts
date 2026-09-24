import "server-only";

import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_CHARTER } from "@/lib/agent-charter";
import { localAgentCliEnv, resolveAgentBinary } from "@/lib/agent-binaries";
import { ensureAgentContextRoot } from "@/lib/agent-context/paths";
import {
  COMPANION_MODELS,
  companionProjectReferences,
  normalizeCompanionModel,
  normalizeRequestedCompanionReferences,
  resolvedCompanionModel,
  type CompanionAttachmentPayload,
  type CompanionModel,
  type CompanionReference,
} from "@/lib/companion-contract";
import { publishPaperEvent } from "@/lib/paper-events";
import {
  getProjectSnapshot,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "@/lib/workspace";
import {
  formatCompanionWorkflow,
  listWorkflowSummaries,
  readWorkflow,
} from "@/lib/workflows";
import { OPEN_INTENT_ORCHESTRATION } from "@/lib/open-intent-orchestration";


/** The companion chat's engine: one persistent headless Claude Code session
 * per project, driven over stream-json stdio. The session runs from the
 * project directory, so the desktop hooks inject canvas context and the
 * video-fs MCP toolchain binds automatically (which also turns the presence
 * bolt green). The floating companion window is just a renderer of this. */

type CompanionEventPayload =
  | { kind: "assistant_delta"; text: string }
  | { kind: "assistant_text"; text: string }
  | { kind: "attention"; toolName: string }
  | {
      kind: "status";
      detail?: string;
      state: "error" | "exited" | "ready" | "starting" | "working";
    }
  | { kind: "tool_end"; toolName: string }
  | { detail?: string; kind: "tool_start"; toolName: string }
  | { kind: "user_message"; text: string };

export type CompanionEvent = CompanionEventPayload & {
  at: string;
  seq: number;
};

type CompanionSession = {
  agent: "claude";
  busy: boolean;
  child: ChildProcessWithoutNullStreams;
  emitter: EventEmitter;
  model: string | null;
  projectId: string;
  /** Set when the process was started with --resume; cleared once the CLI
   * confirms init, so a failed resume can fall back to a fresh session. */
  resuming: boolean;
  storePath: string;
  /** Set while an intentional respawn (e.g. a model switch) replaces this
   * session, so its exit does not surface as an error in the transcript. */
  retiring: boolean;
  seq: number;
  sessionId: string | null;
  stderrTail: string;
  toolNamesById: Map<string, string>;
  transcript: CompanionEvent[];
};

const TRANSCRIPT_LIMIT = 500;
// v5 refreshes the model runtime after the production charter was narrowed;
// Claude receives the appended charter only when a session starts.
const COMPANION_LAUNCH_CONTRACT_VERSION = 5;

/** Durable per-project chat state, stored privately with the project's agent
 * context. Holds the visible transcript plus the CLI session id so a new app
 * launch can both re-render the conversation and `--resume` the underlying
 * Claude session (full model-side memory). */
type StoredCompanionState = {
  /** Resuming across an incompatible launch contract can preserve Claude's
   * stale tool registry. Missing means the pre-explicit-MCP-approval launch. */
  launchContractVersion?: number;
  model: CompanionModel | null;
  seq: number;
  sessionId: string | null;
  transcript: CompanionEvent[];
  version: 1;
};

async function companionStorePath(projectId: string) {
  const { contextDirectory } = await ensureAgentContextRoot(projectId);
  const directory = path.join(contextDirectory, "companion");
  await mkdir(directory, { mode: 0o700, recursive: true });
  return path.join(directory, "chat.json");
}

async function readStoredCompanionState(
  storePath: string,
): Promise<StoredCompanionState | null> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as StoredCompanionState;
    if (parsed?.version !== 1 || !Array.isArray(parsed.transcript)) return null;
    return parsed;
  } catch {
    return null;
  }
}

const persistTimers = new Map<string, NodeJS.Timeout>();
let persistChain: Promise<unknown> = Promise.resolve();

function persistCompanionState(session: CompanionSession) {
  const { storePath } = session;
  const existing = persistTimers.get(storePath);
  if (existing) clearTimeout(existing);
  persistTimers.set(
    storePath,
    setTimeout(() => {
      persistTimers.delete(storePath);
      const state: StoredCompanionState = {
        launchContractVersion: COMPANION_LAUNCH_CONTRACT_VERSION,
        model: session.model as CompanionModel | null,
        seq: session.seq,
        sessionId: session.sessionId,
        transcript: session.transcript,
        version: 1,
      };
      persistChain = persistChain
        .catch(() => {})
        .then(async () => {
          const scratch = `${storePath}.tmp`;
          await writeFile(scratch, JSON.stringify(state), { mode: 0o600 });
          await rename(scratch, storePath);
        })
        .catch(() => {
          // Chat keeps working in memory if the disk write fails.
        });
    }, 250),
  );
}

const store = globalThis as typeof globalThis & {
  __videoFsCompanionSessions?: Map<string, CompanionSession>;
};
const sessions =
  store.__videoFsCompanionSessions ?? new Map<string, CompanionSession>();
store.__videoFsCompanionSessions = sessions;

function prettyToolName(rawName: string) {
  return rawName.replace(/^mcp__video-fs__/, "");
}

/** Mirrors the chat session's busy state onto the shared paper event bus so
 * the titlebar project tabs show the same in-progress indicator for
 * companion-driven work as for any other agent activity. */
function publishSessionActivity(
  projectId: string,
  state: "settled" | "working",
  error?: string,
) {
  publishPaperEvent({
    artifactId: "companion-session",
    ...(state === "settled"
      ? { error, ok: !error, status: error ? "failed" : "succeeded" }
      : {}),
    kind: state,
    paths: [],
    projectId,
    title: "Claude is working in this project",
    tool: "session",
  });
}

/** A one-line human summary of what a tool call is doing, so the transcript
 * shows "Bash — run project tests" instead of a bare "Bash". */
function toolDetail(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const tail = (value: string | null) =>
    value ? value.split("/").slice(-2).join("/") : null;
  const direct =
    text(record.description) ??
    (toolName === "Bash" ? text(record.command) : null) ??
    tail(text(record.file_path) ?? text(record.path) ?? text(record.notebook_path)) ??
    text(record.pattern) ??
    text(record.query) ??
    text(record.url) ??
    text(record.prompt) ??
    text(record.action) ??
    text(record.op) ??
    text(record.kind) ??
    text(record.id) ??
    text(record.title);
  if (direct) return direct.replace(/\s+/g, " ").slice(0, 120);
  const compact = Object.entries(record)
    .filter(([, value]) => ["boolean", "number", "string"].includes(typeof value))
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${String(value).slice(0, 40)}`)
    .join(", ");
  return compact ? compact.slice(0, 120) : undefined;
}

function pushEvent(
  session: CompanionSession,
  event: CompanionEventPayload,
) {
  const full: CompanionEvent = {
    ...event,
    at: new Date().toISOString(),
    seq: (session.seq += 1),
  };
  session.transcript = [...session.transcript, full].slice(-TRANSCRIPT_LIMIT);
  session.emitter.emit("event", full);
  persistCompanionState(session);
  return full;
}

/** Emit to live listeners without recording in the transcript. Used for
 * streaming text deltas — the complete `assistant_text` event that follows is
 * the durable record, so replays stay compact and non-duplicated. */
function pushEphemeralEvent(
  session: CompanionSession,
  event: CompanionEventPayload,
) {
  const full: CompanionEvent = {
    ...event,
    at: new Date().toISOString(),
    seq: (session.seq += 1),
  };
  session.emitter.emit("event", full);
  return full;
}

async function claudeBinary() {
  const binary = await resolveAgentBinary("claude", process.env.VIDEO_FS_COMPANION_CLI);
  if (binary) return binary;
  throw new Error("Claude Code was not found. Connect Claude from the agent menu or check its installation.");
}

/** Capability checks must not send prompts or consume a user's agent plan. */
export async function companionCapabilities() {
  const [claude, codex] = await Promise.all([
    resolveAgentBinary("claude", process.env.VIDEO_FS_COMPANION_CLI),
    resolveAgentBinary("codex"),
  ]);
  const availableModels = claude ? [...COMPANION_MODELS] : [];
  const preferred = process.env.VIDEO_FS_COMPANION_MODEL?.trim() || resolvedCompanionModel(undefined);
  return {
    availableModels,
    installedAgents: { claude: Boolean(claude), codex: Boolean(codex) },
    resolvedModel: availableModels.some((entry) => entry.value === preferred)
      ? preferred : availableModels[0]?.value ?? null,
  };
}

export async function isAvailableCompanionModel(value: string) {
  return COMPANION_MODELS.some((entry) => entry.value === value);
}

function safeAttachmentName(value: string) {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "attachment"
  );
}

async function materializeCompanionAttachments(
  projectId: string,
  attachments: readonly CompanionAttachmentPayload[],
) {
  if (!attachments.length) return [];
  const { contextDirectory } = await ensureAgentContextRoot(projectId);
  const directory = path.join(contextDirectory, "companion-attachments");
  await mkdir(directory, { mode: 0o700, recursive: true });
  const saved: Array<{ name: string; path: string; type: string }> = [];
  for (const attachment of attachments.slice(0, 10)) {
    const encoded = attachment.data.includes(",")
      ? attachment.data.split(",").pop() ?? ""
      : attachment.data;
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.byteLength || bytes.byteLength > 25 * 1024 * 1024) {
      throw new Error(`"${attachment.name}" could not be attached (max 25MB).`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    const name = `${digest}-${safeAttachmentName(attachment.name)}`;
    const filePath = path.join(directory, name);
    await writeFile(filePath, bytes, { mode: 0o600 });
    saved.push({
      name: attachment.name,
      path: `.video-fs/agent-context/companion-attachments/${name}`,
      type: attachment.type || "application/octet-stream",
    });
  }
  return saved;
}

export type CompanionMessageInput = {
  attachments?: readonly CompanionAttachmentPayload[];
  model: CompanionModel;
  references?: readonly Pick<CompanionReference, "id" | "path">[];
  text: string;
  workflowId?: string | null;
};

async function prepareCompanionMessage(
  projectId: string,
  input: CompanionMessageInput,
) {
  const snapshot = await getProjectSnapshot(projectId);
  const availableReferences = companionProjectReferences(snapshot.files);
  const references = normalizeRequestedCompanionReferences(
    input.references ?? [],
    availableReferences,
  );
  if (references.length !== (input.references ?? []).length) {
    throw new Error(
      "One or more selected project items are no longer available. Remove them and try again.",
    );
  }
  const workflow = input.workflowId
    ? await readWorkflow(input.workflowId)
    : null;
  const workflowSummaries = await listWorkflowSummaries();
  const attachments = await materializeCompanionAttachments(
    projectId,
    input.attachments ?? [],
  );
  return [
    input.text,
    [
      "",
      OPEN_INTENT_ORCHESTRATION,
      "Workflow inventory (internal):",
      ...workflowSummaries.map(
        (candidate) => `- ${candidate.id}: ${candidate.use_when}`,
      ),
      "For one strong complex match, call the video-fs load_workflow tool and continue executing. Skip it for direct asks. Do not ask the user to choose a workflow.",
    ].join("\n"),
    workflow ? `\n${formatCompanionWorkflow(workflow)}` : "",
    references.length
      ? [
          "",
          "Selected project references (validated against this project):",
          ...references.map(
            (reference) =>
              `- @${reference.id} [${reference.kind}] ${reference.path} — ${reference.title}`,
          ),
        ].join("\n")
      : "",
    attachments.length
      ? [
          "",
          "Attached files (private project-support paths):",
          ...attachments.map(
            (attachment) =>
              `- ${attachment.name} [${attachment.type}] ${attachment.path}`,
          ),
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function handleStreamLine(session: CompanionSession, line: string) {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (event.type === "system" && event.subtype === "init") {
    if (typeof event.session_id === "string") {
      session.sessionId = event.session_id;
    }
    session.resuming = false;
    persistCompanionState(session);
    // The CLI re-emits an init per turn; only the spawn-time one means idle.
    // Mid-turn, a `ready` here would hide the working indicator early.
    if (!session.busy) {
      pushEvent(session, { kind: "status", state: "ready" });
    }
    return;
  }
  if (event.type === "stream_event") {
    const inner = event.event as
      | { delta?: { text?: string; type?: string }; type?: string }
      | undefined;
    if (
      inner?.type === "content_block_delta" &&
      inner.delta?.type === "text_delta" &&
      typeof inner.delta.text === "string" &&
      inner.delta.text
    ) {
      pushEphemeralEvent(session, {
        kind: "assistant_delta",
        text: inner.delta.text,
      });
    }
    return;
  }
  if (event.type === "assistant") {
    const message = event.message as
      | { content?: Array<Record<string, unknown>> }
      | undefined;
    for (const block of message?.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text.trim()) {
          pushEvent(session, { kind: "assistant_text", text: block.text });
        }
      }
      if (block.type === "tool_use") {
        const rawName = typeof block.name === "string" ? block.name : "tool";
        const toolName = prettyToolName(rawName);
        if (typeof block.id === "string") {
          session.toolNamesById.set(block.id, toolName);
        }
        pushEvent(session, {
          detail: toolDetail(toolName, block.input),
          kind: "tool_start",
          toolName,
        });
        if (toolName.startsWith("agent_request_")) {
          // The agent needs the user: the companion window auto-raises on this.
          pushEvent(session, { kind: "attention", toolName });
        }
      }
    }
    return;
  }
  if (event.type === "user") {
    const message = event.message as
      | { content?: Array<Record<string, unknown>> }
      | undefined;
    for (const block of message?.content ?? []) {
      if (block.type !== "tool_result") continue;
      const toolUseId =
        typeof block.tool_use_id === "string" ? block.tool_use_id : null;
      const toolName =
        (toolUseId ? session.toolNamesById.get(toolUseId) : null) ?? "tool";
      pushEvent(session, { kind: "tool_end", toolName });
    }
    return;
  }
  if (event.type === "result") {
    session.busy = false;
    pushEvent(session, { kind: "status", state: "ready" });
    publishSessionActivity(session.projectId, "settled");
  }
}

async function spawnSession(
  projectId: string,
  model: CompanionModel,
  carryover?: Pick<CompanionSession, "seq" | "transcript"> & {
    resumeSessionId?: string | null;
  },
): Promise<CompanionSession> {
  const { projectDirectory } = await ensureAgentContextRoot(projectId);
  const binary = await claudeBinary();
  const storePath = await companionStorePath(projectId);
  const mcpConfigPath = path.join(projectDirectory, ".mcp.json");
  const resumeSessionId = carryover?.resumeSessionId ?? null;
  const child = spawn(
    binary,
    [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      // System-prompt-level product framing: the strongest lever against
      // misclassifying normal creative direction as content to moderate.
      "--append-system-prompt",
      AGENT_CHARTER,
      // Headless/print sessions skip Claude's interactive project-trust flow.
      // Pass the app-owned MCP approval explicitly so the Video FS bridge is
      // started instead of remaining in `Pending approval` forever.
      "--settings",
      JSON.stringify({
        enableAllProjectMcpServers: true,
        enabledMcpjsonServers: ["video-fs"],
      }),
      "--mcp-config",
      mcpConfigPath,
      "--model",
      model,
      ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
    ],
    {
      cwd: projectDirectory,
      env: localAgentCliEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const session: CompanionSession = {
    agent: "claude",
    busy: false,
    child,
    emitter: new EventEmitter(),
    model,
    projectId,
    resuming: Boolean(resumeSessionId),
    retiring: false,
    seq: carryover?.seq ?? 0,
    sessionId: resumeSessionId,
    stderrTail: "",
    storePath,
    toolNamesById: new Map(),
    transcript: carryover?.transcript ?? [],
  };
  session.emitter.setMaxListeners(50);
  pushEvent(session, { kind: "status", state: "starting" });

  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (line) handleStreamLine(session, line);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    session.stderrTail = `${session.stderrTail}${chunk}`.slice(-4000);
  });
  child.on("close", (code) => {
    const wasBusy = session.busy;
    session.busy = false;
    if (wasBusy && !session.retiring) {
      publishSessionActivity(
        session.projectId,
        "settled",
        code === 0 ? undefined : "The Claude session ended unexpectedly.",
      );
    }
    if (session.resuming && code !== 0) {
      // The stored CLI session could not be resumed (evicted/corrupt): drop
      // the stale id so the next message starts a fresh session instead of
      // failing the same way forever. The visible transcript is kept.
      session.sessionId = null;
      session.resuming = false;
      persistCompanionState(session);
    }
    if (!session.retiring) {
      pushEvent(session, {
        detail:
          code === 0
            ? undefined
            : session.stderrTail.trim().slice(-500) || `exit code ${code}`,
        kind: "status",
        state: code === 0 ? "exited" : "error",
      });
    }
    if (sessions.get(projectId) === session) sessions.delete(projectId);
  });
  child.on("error", (error) => {
    pushEvent(session, {
      detail: error.message,
      kind: "status",
      state: "error",
    });
    if (sessions.get(projectId) === session) sessions.delete(projectId);
  });
  return session;
}

export async function ensureCompanionSession(
  projectId: string,
  model?: CompanionModel,
) {
  const existing = sessions.get(projectId);
  if (existing && existing.child.exitCode === null) {
    // `undefined` keeps whatever model the session already runs; an explicit
    // value that differs replaces the session, carrying the transcript over.
    if (model === undefined || model === existing.model) return existing;
    existing.retiring = true;
    existing.child.kill("SIGTERM");
    const session = await spawnSession(projectId, model, {
      // Resume the SAME Claude conversation under the new model — without
      // this, a model switch silently discarded all session memory and the
      // agent re-inspected the project from scratch.
      resumeSessionId: existing.sessionId,
      seq: existing.seq,
      transcript: existing.transcript,
    });
    sessions.set(projectId, session);
    return session;
  }
  // Cold start: restore the saved conversation and resume the underlying
  // CLI session, so the chat picks up exactly where it left off.
  const stored = await readStoredCompanionState(
    await companionStorePath(projectId),
  );
  const session = await spawnSession(
    projectId,
    model ??
      normalizeCompanionModel(stored?.model) ??
      resolvedCompanionModel(process.env.VIDEO_FS_COMPANION_MODEL),
    stored
      ? {
          // Claude freezes MCP tool discovery into a session. Preserve the
          // visible transcript across launch-contract upgrades, but start a
          // fresh model runtime once so new bridge/approval arguments apply.
          resumeSessionId:
            stored.launchContractVersion ===
            COMPANION_LAUNCH_CONTRACT_VERSION
              ? stored.sessionId
              : null,
          seq: stored.seq,
          transcript: stored.transcript,
        }
      : undefined,
  );
  sessions.set(projectId, session);
  return session;
}

export function getCompanionSession(projectId: string) {
  const session = sessions.get(projectId);
  return session && session.child.exitCode === null ? session : null;
}

/** Deterministic autonaming: the first substantive message to a project
 * still carrying the placeholder name becomes its title (the agent can
 * refine it later). Engine-level so it cannot be skipped. */
function projectNameFromFirstTask(text: string): string | null {
  const cleaned = text.trim().replace(/\s+/g, " ");
  // Greetings and one-word pokes don't name projects; wait for a real task.
  if (cleaned.length < 12) return null;
  const sentence = cleaned.split(/(?<=[.!?])\s/)[0] ?? cleaned;
  const capped =
    sentence.length > 48 ? `${sentence.slice(0, 45).trimEnd()}…` : sentence;
  const name = capped.replace(/[.!?]+$/, "");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

async function maybeAutonameProject(projectId: string, text: string) {
  try {
    const raw = await readWorkspaceFile(projectId, "project.json");
    const meta = JSON.parse(raw) as Record<string, unknown>;
    const current = typeof meta.name === "string" ? meta.name.trim() : "";
    if (current && current.toLowerCase() !== "untitled video") return;
    const name = projectNameFromFirstTask(text);
    if (!name) return;
    await writeWorkspaceFile(
      projectId,
      "project.json",
      `${JSON.stringify({ ...meta, name }, null, 2)}\n`,
    );
  } catch {
    // Naming is best-effort; the chat proceeds regardless.
  }
}

export async function sendCompanionMessage(
  projectId: string,
  input: CompanionMessageInput,
) {
  const model = input.model?.trim();
  if (!model || !(await isAvailableCompanionModel(model))) {
    throw new Error("The selected Claude model is unavailable.");
  }
  void maybeAutonameProject(projectId, input.text);
  const text = await prepareCompanionMessage(projectId, input);
  const session = await ensureCompanionSession(projectId, model);
  pushEvent(session, { kind: "user_message", text: input.text });
  session.busy = true;
  pushEvent(session, { kind: "status", state: "working" });
  publishSessionActivity(projectId, "working");
  session.child.stdin.write(
    `${JSON.stringify({
      message: { content: [{ text, type: "text" }], role: "user" },
      type: "user",
    })}\n`,
  );
  return { sessionId: session.sessionId };
}

/** Aborts the in-flight turn like Esc in the interactive CLI: a control
 * interrupt over stdin first; if the CLI does not settle quickly, the process
 * is killed — cheap now that sessions resume via --resume. */
export async function interruptCompanionSession(projectId: string) {
  const session = getCompanionSession(projectId);
  if (!session || !session.busy) return { interrupted: false };
  session.child.stdin.write(
    `${JSON.stringify({
      request: { subtype: "interrupt" },
      request_id: `interrupt-${Date.now().toString(36)}`,
      type: "control_request",
    })}
`,
  );
  const settled = await new Promise<boolean>((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (!session.busy || session.child.exitCode !== null) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - startedAt > 4000) {
        clearInterval(timer);
        resolve(false);
      }
    }, 120);
  });
  if (!settled) {
    // The transcript and CLI session survive; the next message resumes.
    session.retiring = true;
    session.child.kill("SIGTERM");
    session.busy = false;
    if (sessions.get(projectId) === session) sessions.delete(projectId);
    pushEvent(session, { kind: "status", state: "ready" });
    publishSessionActivity(projectId, "settled");
  }
  return { interrupted: true };
}

export function stopCompanionSession(projectId: string) {
  const session = sessions.get(projectId);
  if (!session) return false;
  session.retiring = true;
  session.child.kill("SIGTERM");
  sessions.delete(projectId);
  return true;
}

export async function companionState(projectId: string) {
  const session = getCompanionSession(projectId);
  if (session) {
    return {
      busy: session.busy,
      running: true,
      sessionId: session.sessionId,
      sessionModel: session.model,
      transcript: session.transcript,
    };
  }
  // No live process: the saved conversation still renders immediately; the
  // session itself resumes on the next message.
  const stored = await readStoredCompanionState(
    await companionStorePath(projectId),
  );
  return {
    busy: false,
    running: false,
    sessionId: stored?.sessionId ?? null,
    sessionModel: stored?.model ?? null,
    transcript: stored?.transcript ?? [],
  };
}

export function subscribeCompanion(
  projectId: string,
  listener: (event: CompanionEvent) => void,
) {
  const session = sessions.get(projectId);
  if (!session) return () => {};
  session.emitter.on("event", listener);
  return () => session.emitter.off("event", listener);
}
