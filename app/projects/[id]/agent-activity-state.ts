export type AgentActivityFailure = {
  canReconnect: boolean;
  code?: string;
  message: string;
  remediation?: string | null;
};

export type AgentActivityItem = {
  canReconnect?: boolean;
  code?: string;
  detail?: string;
  id: string;
  label: string;
  remediation?: string | null;
  status: "completed" | "error" | "running";
};

export type AgentActivityLifecycleEvent =
  | { id: string; kind: "accepted" | "progress"; label: string }
  | { id: string; kind: "approval" | "question"; label: string }
  | { id: string; kind: "completed" | "cancelled"; label: string }
  | { id: string; kind: "failed"; label: string }
  | { id: string; kind: "disconnected"; label: string }
  | { id: string; kind: "reconnected"; label: string }
  | { id: "idle"; kind: "idle"; label: "Agent idle" };

export type AgentActivityVisualState =
  | "active"
  | "awaiting"
  | "disconnected"
  | "failed"
  | "idle"
  | "resolved";

export type AgentActivityStatusPresentation = {
  label: string;
  state: AgentActivityVisualState;
  title: string;
};

type ActivityFile = {
  content?: string;
  path: string;
};

export type PaperActivityEvent = {
  artifactId?: string;
  error?: string | null;
  kind?: "changed" | "working" | "settled";
  ok?: boolean;
  paths?: string[];
  status?: string;
  title?: string;
  tool?: "generate_image" | "generate_clip" | "write";
};

export type EditorActivityEvent = {
  command?: string;
  commandId?: string;
  error?: {
    code?: string;
    message?: string;
    remediation?: string | null;
  } | string;
  kind?:
    | "editor.command.accepted"
    | "editor.command.completed"
    | "editor.command.failed";
};

const CONNECTION_FAILURE_PATTERN =
  /\b(?:desktop (?:app )?is unavailable|connection (?:failed|lost|interrupted|refused)|econnrefused|failed to fetch|networkerror|stream failed|socket hang up)\b/i;

function safeMessage(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

export function classifyActivityFailure(value: unknown): AgentActivityFailure {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const nested =
    record?.error && typeof record.error === "object" && !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : null;
  const source = nested ?? record;
  const code = safeMessage(source?.code);
  const providedRemediation = safeMessage(source?.remediation);
  const message =
    safeMessage(source?.message) ||
    safeMessage(typeof record?.error === "string" ? record.error : value) ||
    "The operation failed.";
  if (/FAL_KEY is not configured/i.test(message)) {
    return {
      canReconnect: false,
      code: code || "FAL_KEY_NOT_CONFIGURED",
      message: "FAL_KEY is not configured.",
      remediation:
        providedRemediation ||
        "Open Account → API keys, save your fal.ai key, and try again.",
    };
  }
  if (/OPENROUTER_API_KEY is not configured/i.test(message)) {
    return {
      canReconnect: false,
      code: code || "OPENROUTER_API_KEY_NOT_CONFIGURED",
      message: "OPENROUTER_API_KEY is not configured.",
      remediation:
        providedRemediation ||
        "Configure the key, relaunch Video FS, and try again.",
    };
  }
  const canReconnect =
    code === "VIDEO_FS_CONNECTION_FAILED" ||
    code === "DESKTOP_CONNECTION_FAILED" ||
    CONNECTION_FAILURE_PATTERN.test(message);
  return {
    canReconnect,
    code: code || undefined,
    message,
    remediation:
      providedRemediation ||
      (canReconnect
        ? "Open or reconnect Video FS, then try again."
        : null),
  };
}

function parseOperationReceipt(content: string | undefined) {
  if (!content?.startsWith("---\n")) return null;
  const frontmatterEnd = content.indexOf("\n---", 4);
  if (frontmatterEnd < 0) return null;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(content.slice(4, frontmatterEnd)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const resultMatch = /## Result\s+```json\s+([\s\S]*?)\s+```/i.exec(
    content.slice(frontmatterEnd + 4),
  );
  let result: Record<string, unknown> | null = null;
  if (resultMatch?.[1]) {
    try {
      const parsed = JSON.parse(resultMatch[1]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        result = parsed as Record<string, unknown>;
      }
    } catch {
      result = null;
    }
  }
  return {
    createdAt: typeof meta.created_at === "string" ? meta.created_at : "",
    error: result?.error,
    ok: typeof result?.ok === "boolean" ? result.ok : null,
    status: typeof meta.status === "string" ? meta.status : "",
    title:
      /^#\s+(.+)$/m.exec(content.slice(frontmatterEnd + 4))?.[1]?.trim() ||
      (typeof meta.id === "string" ? meta.id : "Operation"),
  };
}

export function failedActivitiesFromOperationFiles(
  files: ActivityFile[],
): AgentActivityItem[] {
  return files
    .filter(
      (file) =>
        file.path.startsWith("operations/") &&
        file.path.endsWith(".operation.md"),
    )
    .map((file) => {
      const receipt = parseOperationReceipt(file.content);
      if (!receipt || (receipt.status !== "failed" && receipt.ok !== false)) {
        return null;
      }
      const failure = classifyActivityFailure(receipt.error);
      return {
        createdAt: receipt.createdAt,
        item: {
          canReconnect: failure.canReconnect,
          code: failure.code,
          detail: failure.message,
          id: `operation:${file.path}`,
          label: receipt.title,
          remediation: failure.remediation,
          status: "error" as const,
        },
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort(
      (left, right) =>
        Date.parse(right.createdAt || "1970-01-01") -
        Date.parse(left.createdAt || "1970-01-01"),
    )
    .slice(0, 6)
    .map((entry) => entry.item);
}

function activityIdentity(event: PaperActivityEvent) {
  const paths = Array.isArray(event.paths) ? event.paths : [];
  return {
    id: `paper:${event.artifactId ?? (paths.join("|") || event.tool || "workspace")}`,
    label:
      event.title ??
      (event.artifactId
        ? `Updating ${event.artifactId}`
        : paths[0]
          ? `Updating ${paths[0]}`
          : "Updating the canvas"),
    paths,
  };
}

export function activityFromPaperEvent(
  event: PaperActivityEvent,
  files: ActivityFile[] = [],
): AgentActivityItem {
  const identity = activityIdentity(event);
  if (event.kind === "working") {
    return { ...identity, status: "running" };
  }
  if (event.kind === "changed") {
    return { ...identity, status: "completed" };
  }

  const eventFailed = event.ok === false || event.status === "failed";
  const operationPath = identity.paths.find(
    (path) => path.startsWith("operations/") && path.endsWith(".operation.md"),
  );
  const receipt = operationPath
    ? parseOperationReceipt(files.find((file) => file.path === operationPath)?.content)
    : null;
  const receiptFailed = receipt?.ok === false || receipt?.status === "failed";

  if (eventFailed || receiptFailed) {
    const failure = classifyActivityFailure(event.error || receipt?.error);
    return {
      ...identity,
      canReconnect: failure.canReconnect,
      code: failure.code,
      detail: failure.message,
      remediation: failure.remediation,
      status: "error",
    };
  }
  if (event.ok === true || event.status === "succeeded" || receipt?.ok === true || receipt?.status === "succeeded") {
    return { ...identity, status: "completed" };
  }

  const failure = classifyActivityFailure(
    operationPath
      ? "The operation ended without a valid terminal receipt. Reopen the project and try again."
      : "The operation finished without a durable receipt. Reopen the project and try again.",
  );
  return {
    ...identity,
    canReconnect: failure.canReconnect,
    detail: failure.message,
    status: "error",
  };
}

export function activityFromToolReceipt(input: {
  id: string;
  label: string;
  output: unknown;
}): AgentActivityItem {
  const output =
    input.output && typeof input.output === "object" && !Array.isArray(input.output)
      ? (input.output as Record<string, unknown>)
      : null;
  if (
    output?.ok === true ||
    output?.status === "succeeded" ||
    output?.status === "completed"
  ) {
    return { id: input.id, label: input.label, status: "completed" };
  }
  const failure = classifyActivityFailure(
    output?.ok === false || output?.status === "failed"
      ? output?.error
      : {
          code: "MISSING_SUCCESS_RECEIPT",
          message: "The agent stopped without a successful tool receipt.",
          remediation: "Open Agent Activity, confirm the app is connected, and retry.",
        },
  );
  return {
    canReconnect: failure.canReconnect,
    code: failure.code,
    detail: failure.message,
    id: input.id,
    label: input.label,
    remediation: failure.remediation,
    status: "error",
  };
}

export function activityFromEditorEvent(
  event: EditorActivityEvent,
): AgentActivityItem | null {
  if (
    event.kind !== "editor.command.accepted" &&
    event.kind !== "editor.command.completed" &&
    event.kind !== "editor.command.failed"
  ) {
    return null;
  }
  const id = `editor:${event.commandId ?? event.command ?? "command"}`;
  const commandLabel = (event.command ?? "Editor command")
    .replace(/^editor_timeline_/, "")
    .replaceAll("_", " ");
  const label = `${commandLabel.charAt(0).toUpperCase()}${commandLabel.slice(1)}`;
  if (event.kind === "editor.command.accepted") {
    return { id, label, status: "running" };
  }
  if (event.kind === "editor.command.completed") {
    return { id, label, status: "completed" };
  }
  const failure = classifyActivityFailure(event.error);
  return {
    canReconnect: failure.canReconnect,
    code: failure.code,
    detail: failure.message,
    id,
    label,
    remediation: failure.remediation,
    status: "error",
  };
}

export function agentActivityFailureKey(
  failure: AgentActivityFailure | AgentActivityItem,
) {
  if ("id" in failure) return `item:${failure.id}`;
  return `failure:${failure.code ?? "unknown"}:${failure.message}`;
}

export function agentActivityLifecycleEvent({
  approvalRequired,
  connection,
  error,
  isRunning,
  isStopping,
  items,
  question,
  reconnectedKey,
  stopped,
}: {
  approvalRequired: boolean;
  connection: "connected" | "disconnected";
  error: AgentActivityFailure | null;
  isRunning: boolean;
  isStopping: boolean;
  items: AgentActivityItem[];
  question: string | null;
  reconnectedKey?: string | null;
  stopped: boolean;
}): AgentActivityLifecycleEvent {
  if (connection === "disconnected" || error?.canReconnect) {
    return {
      id: `disconnected:${error?.message ?? "event-stream"}`,
      kind: "disconnected",
      label: "Agent disconnected",
    };
  }
  if (question) {
    return {
      id: `question:${question}`,
      kind: approvalRequired ? "approval" : "question",
      label: approvalRequired ? "Approval required" : "Question waiting",
    };
  }
  if (error) {
    return {
      id: `failed:${error.message}`,
      kind: "failed",
      label: "Agent needs attention",
    };
  }
  const itemFailure = items.find((item) => item.status === "error");
  if (itemFailure) {
    return {
      id: `failed:${itemFailure.id}`,
      kind: itemFailure.canReconnect ? "disconnected" : "failed",
      label: itemFailure.canReconnect
        ? "Agent disconnected"
        : "Agent needs attention",
    };
  }
  const runningItem = items.find((item) => item.status === "running");
  if (isRunning || isStopping || runningItem) {
    return {
      id: `active:${runningItem?.id ?? (isStopping ? "stopping" : "run")}`,
      kind: runningItem ? "progress" : "accepted",
      label: isStopping ? "Stopping agent" : "Agent working",
    };
  }
  if (stopped) {
    return {
      id: "cancelled:current",
      kind: "cancelled",
      label: "Agent stopped",
    };
  }
  if (reconnectedKey) {
    return {
      id: `reconnected:${reconnectedKey}`,
      kind: "reconnected",
      label: "Agent reconnected",
    };
  }
  const completedItem = items.find((item) => item.status === "completed");
  if (completedItem) {
    return {
      id: `completed:${completedItem.id}`,
      kind: "completed",
      label: "Work completed",
    };
  }
  return { id: "idle", kind: "idle", label: "Agent idle" };
}

export function agentActivityStatusPresentation(
  event: AgentActivityLifecycleEvent,
): AgentActivityStatusPresentation {
  switch (event.kind) {
    case "accepted":
    case "progress":
      return {
        label: event.label,
        state: "active",
        title: "Agent work is active. Open Agent Activity for details.",
      };
    case "approval":
    case "question":
      return {
        label: event.label,
        state: "awaiting",
        title: `${event.label}. Open Agent Activity to continue.`,
      };
    case "failed":
      return {
        label: event.label,
        state: "failed",
        title: "Agent work needs attention. Open Agent Activity for remediation.",
      };
    case "disconnected":
      return {
        label: event.label,
        state: "disconnected",
        title: "The agent connection is offline. Open Agent Activity to reconnect.",
      };
    case "completed":
    case "reconnected":
      return {
        label: event.label,
        state: "resolved",
        title: `${event.label}. Open Agent Activity for details.`,
      };
    case "cancelled":
      return {
        label: event.label,
        state: "idle",
        title: "Agent work is stopped. Open Agent Activity for details.",
      };
    case "idle":
      return {
        label: event.label,
        state: "idle",
        title: "Agent Activity is idle.",
      };
  }
}
