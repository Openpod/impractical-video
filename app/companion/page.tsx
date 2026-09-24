"use client";

import {
  ArrowUp,
  Check,
  ChevronDown,
  FilePlus2,
  Loader2,
  Plus,
  Square,
  Terminal,
  Waves,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import TextareaAutosize from "react-textarea-autosize";
import { AttachmentTile } from "@/components/attachment-tile";
import { FlowsModal } from "@/components/flows-modal";
import { Markdown } from "@/app/markdown";
import { AgentActivityStatusButton } from "@/app/projects/[id]/agent-activity-overlay";
import {
  activityFromEditorEvent,
  activityFromPaperEvent,
  type AgentActivityLifecycleEvent,
  type EditorActivityEvent,
  type PaperActivityEvent,
} from "@/app/projects/[id]/agent-activity-state";
import {
  isVisibleProjectTabActivity,
  lifecycleFromActivityItem,
  lifecycleFromAgentInteraction,
} from "@/app/project-tab-activity";
import type { AgentInteractionEvent } from "@/lib/agent-interaction-types";
import {
  companionProjectReferences,
  type CompanionAttachmentPayload,
  type CompanionModel,
  type CompanionReference,
} from "@/lib/companion-contract";
import type { CSSProperties } from "react";
import type { CompanionEvent } from "@/lib/companion-session";
import type { ProjectSnapshot } from "@/lib/workspace";

/** The top-level companion chat follows the main window's active project by
 * default, while its header can select another isolated project session. All
 * engine state lives in the app server; this page is a thin transcript +
 * composer over its SSE stream. */

type ProjectEntry = { id: string; name: string };

type ConnectStatus = {
  agent: "claude" | "codex";
  detail?: string | null;
  stage:
    | "awaiting_browser"
    | "connected"
    | "error"
    | "idle"
    | "installing"
    | "starting";
};

type ModelOption = { label: string; value: CompanionModel };
type WorkflowEntry = {
  category: string;
  description: string;
  id: string;
  title: string;
};
// The agent can still load workflows through the Video FS tool bridge, but the
// user should not have to choose one before describing what they want.
const MANUAL_WORKFLOWS_ENABLED = false;
type LocalAttachment = {
  error?: string | null;
  hash: string;
  id: string;
  label: string;
  size: number;
  src: string | null;
  type: string;
};

type StoredCompose = {
  attachments: Array<{ hash: string; name: string; size: number; type: string }>;
  draft: string;
  model: CompanionModel | null;
  projectId: string;
  references: Array<{ id: string; path: string }>;
  version: number;
  workflowId: string | null;
};

type ComposeResult = {
  issues?: Array<{ hash: string; message: string }>;
  state?: StoredCompose | null;
};

type StoredAttachmentRead = {
  data: string;
  hash: string;
  name: string;
  size: number;
  type: string;
};

function attachmentKind(type: string) {
  return type.startsWith("image/")
    ? "image"
    : type.startsWith("video/")
      ? "video"
      : type.startsWith("audio/")
        ? "audio"
        : "document";
}

function referencePreview(projectId: string, reference: CompanionReference) {
  if (!reference.previewPath) return null;
  const clean = reference.previewPath.replace(/^media\//, "");
  return `/api/projects/${encodeURIComponent(projectId)}/media/${clean
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

type TranscriptRow =
  | { detail?: string; key: string; kind: "system"; text: string }
  | { detail?: string; done: boolean; key: string; kind: "tool"; toolName: string }
  | { key: string; kind: "assistant"; live?: boolean; text: string }
  | { key: string; kind: "user"; text: string };

function rowsFromEvents(events: CompanionEvent[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const openTools = new Map<string, number[]>();
  // Streaming deltas accumulate into one live assistant row; the complete
  // `assistant_text` event that follows replaces it with the durable text.
  let liveIndex: number | null = null;
  const liveRow = () => {
    const row = liveIndex === null ? null : rows[liveIndex];
    return row?.kind === "assistant" ? row : null;
  };
  for (const event of events) {
    if (event.kind === "user_message") {
      liveIndex = null;
      rows.push({ key: `e${event.seq}`, kind: "user", text: event.text });
    } else if (event.kind === "assistant_delta") {
      const row = liveRow();
      if (row) {
        row.text += event.text;
      } else {
        rows.push({
          key: `e${event.seq}`,
          kind: "assistant",
          live: true,
          text: event.text,
        });
        liveIndex = rows.length - 1;
      }
    } else if (event.kind === "assistant_text") {
      const row = liveRow();
      if (row) {
        row.text = event.text;
        row.live = false;
      } else {
        rows.push({ key: `e${event.seq}`, kind: "assistant", text: event.text });
      }
      liveIndex = null;
    } else if (event.kind === "tool_start") {
      rows.push({
        detail: event.detail,
        done: false,
        key: `e${event.seq}`,
        kind: "tool",
        toolName: event.toolName,
      });
      openTools.set(event.toolName, [
        ...(openTools.get(event.toolName) ?? []),
        rows.length - 1,
      ]);
    } else if (event.kind === "tool_end") {
      const indices = openTools.get(event.toolName) ?? [];
      const index = indices.shift();
      if (index !== undefined) {
        const row = rows[index];
        if (row?.kind === "tool") row.done = true;
      }
    } else if (event.kind === "status") {
      if (event.state === "error" || event.state === "exited") {
        liveIndex = null;
        rows.push({
          detail: event.detail,
          key: `e${event.seq}`,
          kind: "system",
          text:
            event.state === "error"
              ? "The session hit an error. Send a message to restart it."
              : "Session ended. Send a message to start a new one.",
        });
      }
    }
  }
  return rows;
}

/** Streams live text in smoothly: incoming deltas land in bursts, so the
 * visible text catches up to the target at an eased per-frame rate instead of
 * jumping chunk-by-chunk. Finished (non-live) rows render instantly. */
function SmoothMarkdown({ live, text }: { live: boolean; text: string }) {
  const [visibleCount, setVisibleCount] = useState(() =>
    live ? 0 : text.length,
  );
  const visibleRef = useRef(visibleCount);
  useEffect(() => {
    if (!live) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      visibleRef.current = text.length;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVisibleCount(text.length);
      return;
    }
    let frame = 0;
    let tick = 0;
    const step = () => {
      // Re-rendering markdown every frame is too hot for long replies —
      // half rate keeps the reveal smooth at a fraction of the parse cost.
      tick += 1;
      if (tick % 2 === 0) {
        const target = text.length;
        const current = visibleRef.current;
        if (current < target) {
          // Ease toward the target: fast when far behind, gentle when close.
          const advance = Math.max(2, Math.ceil((target - current) / 8));
          visibleRef.current = Math.min(target, current + advance);
          setVisibleCount(visibleRef.current);
        }
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [live, text]);
  const shown = live ? text.slice(0, Math.min(visibleCount, text.length)) : text;
  return <Markdown text={shown} />;
}

function connectStageLine(state: ConnectStatus | null) {
  if (!state) return null;
  const name = state.agent === "claude" ? "Claude" : "Codex";
  switch (state.stage) {
    case "starting":
      return `Preparing ${name}…`;
    case "installing":
      return `Installing ${name} in the background…`;
    case "awaiting_browser":
      return `Finish signing in to ${name} in your browser — this chat is waiting here.`;
    case "connected":
      return `${name} is connected.`;
    case "error":
      return state.detail || `Connecting ${name} did not complete. Try again.`;
    default:
      return null;
  }
}

function ConnectPanel({
  inline = false,
  onConnect,
  state,
}: {
  inline?: boolean;
  onConnect: (agent: "claude") => void;
  state: ConnectStatus | null;
}) {
  const working =
    state != null &&
    ["awaiting_browser", "installing", "starting"].includes(state.stage);
  const stageLine = connectStageLine(state);
  return (
    <div className={`companion-connect${inline ? " is-inline" : ""}`}>
      <h2>Power this chat with your own AI</h2>
      <p>
        Use your existing Claude or Codex plan — or create an account during
        sign-in. It all happens in your browser on the provider&apos;s own
        page; Impractical never sees your credentials.
      </p>
      <div className="companion-connect-buttons">
        <button
          className="agent-launch-button is-claude"
          disabled={working}
          onClick={() => onConnect("claude")}
          type="button"
        >
          Connect Claude
        </button>
      </div>
      {stageLine ? (
        <p
          className={`companion-connect-stage${
            state?.stage === "error" ? " is-error" : ""
          }`}
          role="status"
        >
          {working ? <Loader2 aria-hidden className="companion-spin" size={12} /> : null}
          {stageLine}
        </p>
      ) : (
        <p className="companion-connect-note">
          The chat runs on Claude inside this window. No terminal window is
          involved.
        </p>
      )}
    </div>
  );
}

function CompanionInner() {
  const searchParams = useSearchParams();
  const initialProjectId = searchParams.get("project");
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  const [events, setEvents] = useState<CompanionEvent[]>([]);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState<CompanionModel | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [codexInstalled, setCodexInstalled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [localAttachments, setLocalAttachments] = useState<LocalAttachment[]>([]);
  const [projectReferences, setProjectReferences] = useState<CompanionReference[]>([]);
  const [selectedReferences, setSelectedReferences] = useState<CompanionReference[]>([]);
  const [referenceDialogOpen, setReferenceDialogOpen] = useState(false);
  const [workflowDialogOpen, setWorkflowDialogOpen] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowEntry[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowEntry | null>(null);
  const [hydratedProjectId, setHydratedProjectId] = useState<string | null>(null);
  const [projectActivity, setProjectActivity] = useState<
    Record<string, AgentActivityLifecycleEvent>
  >({});
  const [connectState, setConnectState] = useState<ConnectStatus | null>(null);
  const [hydrateAttempt, setHydrateAttempt] = useState(0);
  const maxSeqRef = useRef(0);
  const loadEpochRef = useRef(0);
  const sourceRef = useRef<EventSource | null>(null);
  const openStreamRef = useRef<() => void>(() => {});
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composeSnapshotRef = useRef<{
    projectId: string;
    state: StoredCompose;
  } | null>(null);

  useEffect(() => {
    document.documentElement.dataset.videoFsCompanion = "true";
  }, []);

  const chooseModel = useCallback((next: CompanionModel) => {
    if (!projectId) return;
    setModel(next);
  }, [projectId]);

  const projectIdRef = useRef(initialProjectId);

  const switchProject = useCallback((next: string | null) => {
    if (next === projectIdRef.current) return;
    projectIdRef.current = next;
    const current = composeSnapshotRef.current;
    if (current) {
      void window.videoFsDesktopEnvironment?.companionComposeSet?.(
        current.projectId,
        current.state,
      );
    }
    composeSnapshotRef.current = null;
    loadEpochRef.current += 1;
    setHydratedProjectId(null);
    setEvents([]);
    setDraft("");
    setModel(null);
    setModelOptions([]);
    setBusy(false);
    setSendError(null);
    setSelectedReferences([]);
    setSelectedWorkflow(null);
    setAttachmentError(null);
    setProjectReferences([]);
    setLocalAttachments([]);
    setWorkflows([]);
    setProjectId(next);
  }, []);

  useEffect(() => {
    if (!projectId || hydratedProjectId !== projectId) return;
    composeSnapshotRef.current = {
      projectId,
      state: {
        attachments: localAttachments.map((attachment) => ({
          hash: attachment.hash,
          name: attachment.label,
          size: attachment.size,
          type: attachment.type,
        })),
        draft,
        model,
        projectId,
        references: selectedReferences.map(({ id, path }) => ({ id, path })),
        version: 1,
        workflowId: selectedWorkflow?.id ?? null,
      },
    };
  }, [
    draft,
    hydratedProjectId,
    localAttachments,
    model,
    projectId,
    selectedReferences,
    selectedWorkflow,
  ]);

  useEffect(() => {
    const flush = () => {
      const current = composeSnapshotRef.current;
      if (current) {
        void window.videoFsDesktopEnvironment?.companionComposeSet?.(
          current.projectId,
          current.state,
        );
      }
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  // Follow the main window's project navigation. Last action wins: the user
  // can still re-point the portal anywhere from the header switcher.
  useEffect(() => {
    return window.videoFsDesktopEnvironment?.companionOnProject?.((next) => {
      if (next) switchProject(next);
    });
  }, [switchProject]);

  const loadProjects = useCallback(() => {
    void fetch("/api/projects", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { projects?: ProjectEntry[] }) => {
        if (Array.isArray(data.projects)) setProjects(data.projects);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const projectName = useMemo(
    () => projects.find((entry) => entry.id === projectId)?.name ?? null,
    [projectId, projects],
  );

  // The same lifecycle feed the titlebar tabs use, across ALL projects: it
  // drives the header's in-progress grid and the switcher's attention dots.
  useEffect(() => {
    if (!projects.length) return;
    const query = projects
      .map((project) => `id=${encodeURIComponent(project.id)}`)
      .join("&");
    const events = new EventSource(`/api/projects/tab-activity?${query}`);
    const record = (
      targetId: string,
      event: AgentActivityLifecycleEvent | undefined,
    ) => {
      if (!event) return;
      setProjectActivity((current) => ({ ...current, [targetId]: event }));
    };
    const onPaper = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as PaperActivityEvent & {
          projectId: string;
        };
        record(
          event.projectId,
          lifecycleFromActivityItem(activityFromPaperEvent(event)),
        );
      } catch {
        // Ignore malformed local lifecycle events.
      }
    };
    const onEditor = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as EditorActivityEvent & {
          projectId: string;
        };
        const item = activityFromEditorEvent(event);
        if (item) record(event.projectId, lifecycleFromActivityItem(item));
      } catch {
        // Ignore malformed local lifecycle events.
      }
    };
    const onInteraction = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as AgentInteractionEvent;
        record(event.projectId, lifecycleFromAgentInteraction(event));
      } catch {
        // Ignore malformed local lifecycle events.
      }
    };
    events.addEventListener("paper", onPaper as EventListener);
    events.addEventListener("editor-command", onEditor as EventListener);
    events.addEventListener(
      "agent-interaction",
      onInteraction as EventListener,
    );
    return () => events.close();
  }, [projects]);

  // Live attention for THIS project: the chat's own busy flag is instant;
  // the shared feed covers work driven from outside the chat. `completed`
  // deliberately does NOT hold the slot open.
  const agentWorking =
    busy ||
    ["awaiting", "disconnected", "failed", "progress"].includes(
      (projectId && projectActivity[projectId]?.kind) || "",
    );

  const otherProjectAttention = useMemo(() => {
    const others = projects.filter(
      (project) =>
        project.id !== projectId &&
        isVisibleProjectTabActivity(projectActivity[project.id]),
    );
    const urgent = others.some((project) =>
      ["awaiting", "disconnected", "failed"].includes(
        projectActivity[project.id]?.kind ?? "",
      ),
    );
    return { any: others.length > 0, urgent };
  }, [projectActivity, projectId, projects]);

  // No Claude available: the chat shows a connect panel instead of a dead
  // end. Connecting quietly runs the provider's own install + sign-in flow;
  // only the provider's browser page appears and credentials never touch us.
  const claudeUnavailable = Boolean(
    projectId && hydratedProjectId === projectId && !modelOptions.length,
  );

  const connectAgent = useCallback((agent: "claude" | "codex") => {
    setSendError(null);
    setConnectState({ agent, detail: null, stage: "starting" });
    void fetch("/api/agent-connect", {
      body: JSON.stringify({ agent }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as
          | ConnectStatus
          | { error?: string };
        if (!response.ok || !("stage" in payload)) {
          throw new Error(
            ("error" in payload && payload.error) ||
              "The connection could not start.",
          );
        }
        setConnectState(payload);
      })
      .catch((error) => {
        setConnectState({
          agent,
          detail:
            error instanceof Error
              ? error.message
              : "The connection could not start.",
          stage: "error",
        });
      });
  }, []);

  // While a connect runs, follow the hidden pilot's progress.
  useEffect(() => {
    if (
      !connectState ||
      !["awaiting_browser", "installing", "starting"].includes(
        connectState.stage,
      )
    ) {
      return;
    }
    const agent = connectState.agent;
    const timer = setInterval(() => {
      void fetch(`/api/agent-connect?agent=${agent}`, { cache: "no-store" })
        .then((response) => response.json())
        .then((status: ConnectStatus) => {
          setConnectState((current) =>
            current?.agent === agent ? status : current,
          );
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [connectState]);

  // While disconnected, watch for the CLI appearing (the user finishing
  // sign-in in the provider flow) and light the chat up without a restart.
  useEffect(() => {
    if (!claudeUnavailable || !projectId) return;
    const timer = setInterval(() => {
      void fetch(`/api/projects/${encodeURIComponent(projectId)}/companion`, {
        cache: "no-store",
      })
        .then((response) => response.json())
        .then(
          (session: {
            availableModels?: ModelOption[];
            installedAgents?: { claude?: boolean; codex?: boolean };
            resolvedModel?: CompanionModel | null;
            sessionModel?: CompanionModel | null;
          }) => {
            setCodexInstalled(Boolean(session.installedAgents?.codex));
            const options = Array.isArray(session.availableModels)
              ? session.availableModels
              : [];
            if (!options.length) return;
            setModelOptions(options);
            // The live session's model is the truth; the discovery default is
            // only a hint for fresh conversations.
            setModel(
              (current) =>
                current ??
                options.find((option) => option.value === session.sessionModel)
                  ?.value ??
                options.find(
                  (option) => option.value === session.resolvedModel,
                )?.value ??
                options[0]?.value ??
                null,
            );
          },
        )
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [claudeUnavailable, projectId]);

  useEffect(() => {
    void window.videoFsDesktopEnvironment?.companionTitleSet?.(
      projectId,
      projectName,
    );
  }, [projectId, projectName]);

  const appendEvent = useCallback((event: CompanionEvent) => {
    if (event.seq <= maxSeqRef.current) return;
    maxSeqRef.current = event.seq;
    setEvents((current) => {
      // Long streams emit thousands of tiny deltas; storing each as its own
      // event grew the array unboundedly with a full copy per token — an
      // O(n^2) churn that eventually crashed the renderer. Consecutive
      // deltas coalesce into one event, and the durable assistant_text
      // replaces the accumulated delta outright.
      const last = current[current.length - 1];
      if (event.kind === "assistant_delta" && last?.kind === "assistant_delta") {
        const merged = current.slice(0, -1);
        // Keep the FIRST delta's seq: it is the React row key, and changing
        // it remounted the streaming row per token (reveal restarting from
        // zero — the pulsing scrollbar). Dedupe uses maxSeqRef, not this.
        merged.push({ ...last, at: event.at, text: last.text + event.text });
        return merged;
      }
      if (event.kind === "assistant_text" && last?.kind === "assistant_delta") {
        return [...current.slice(0, -1), event];
      }
      const next = [...current, event];
      return next.length > 900 ? next.slice(-750) : next;
    });
    if (event.kind === "status") {
      setBusy(event.state === "working" || event.state === "starting");
    }
    if (event.kind === "attention") {
      void window.videoFsDesktopEnvironment?.companionShow?.();
    }
  }, []);

  const openStream = useCallback(() => {
    if (!projectId) return;
    sourceRef.current?.close();
    const source = new EventSource(
      `/api/projects/${encodeURIComponent(projectId)}/companion/stream`,
    );
    source.onmessage = (message) => {
      try {
        appendEvent(JSON.parse(message.data) as CompanionEvent);
      } catch {
        // Ignore malformed lines.
      }
    };
    source.onerror = () => {
      // EventSource reconnects on its own unless the connection was closed
      // for good (e.g. a server restart); reopen it then so the transcript
      // replay (seq-deduped) repopulates without user interaction.
      if (source.readyState !== EventSource.CLOSED) return;
      setTimeout(() => {
        if (sourceRef.current === source) openStreamRef.current();
      }, 3000);
    };
    sourceRef.current = source;
  }, [appendEvent, projectId]);

  useEffect(() => {
    openStreamRef.current = openStream;
  }, [openStream]);

  useEffect(() => {
    if (!projectId) return;
    const epoch = (loadEpochRef.current += 1);
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    maxSeqRef.current = 0;
    // The seq high-water mark restarts, so the row list must too — otherwise
    // a hydration retry would append the replayed transcript twice.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEvents([]);
    const composeGet =
      window.videoFsDesktopEnvironment?.companionComposeGet?.(projectId) ??
      Promise.resolve({ state: null } as ComposeResult);
    void Promise.all([
      fetch(`/api/projects/${encodeURIComponent(projectId)}/companion`, {
        cache: "no-store",
      }).then((response) => response.json()) as Promise<{
        availableModels?: ModelOption[];
        installedAgents?: { claude?: boolean; codex?: boolean };
        busy?: boolean;
        resolvedModel?: CompanionModel | null;
        sessionModel?: CompanionModel | null;
        transcript?: CompanionEvent[];
      }>,
      fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        cache: "no-store",
      }).then((response) => {
        if (!response.ok) throw new Error("Project items are unavailable.");
        return response.json() as Promise<ProjectSnapshot>;
      }),
      MANUAL_WORKFLOWS_ENABLED
        ? fetch("/api/workflows", { cache: "no-store" }).then((response) => {
            if (!response.ok) throw new Error("Flows are unavailable.");
            return response.json() as Promise<{ workflows?: WorkflowEntry[] }>;
          })
        : Promise.resolve({ workflows: [] as WorkflowEntry[] }),
      composeGet as Promise<ComposeResult>,
    ])
      .then(async ([session, snapshot, workflowPayload, composePayload]) => {
        if (cancelled || epoch !== loadEpochRef.current) return;
        setCodexInstalled(Boolean(session.installedAgents?.codex));
        const options = Array.isArray(session.availableModels)
          ? session.availableModels
          : [];
        const availableReferences = companionProjectReferences(snapshot.files);
        const availableWorkflows = workflowPayload.workflows ?? [];
        const compose = composePayload.state;
        const selectedModel =
          options.find((option) => option.value === compose?.model)?.value ??
          options.find((option) => option.value === session.sessionModel)?.value ??
          options.find((option) => option.value === session.resolvedModel)?.value ??
          null;
        const references = availableReferences.filter((reference) =>
          compose?.references.some(
            (saved) =>
              saved.id === reference.id && saved.path === reference.path,
          ),
        );
        const workflow = MANUAL_WORKFLOWS_ENABLED
          ? availableWorkflows.find(
              (entry) => entry.id === compose?.workflowId,
            ) ?? null
          : null;
        const issueByHash = new Map(
          (composePayload.issues ?? []).map((issue) => [
            issue.hash,
            issue.message,
          ]),
        );
        const attachments: LocalAttachment[] = (compose?.attachments ?? []).map(
          (attachment) => ({
            error: issueByHash.get(attachment.hash) ?? null,
            hash: attachment.hash,
            id: attachment.hash,
            label: attachment.name,
            size: attachment.size,
            src: null,
            type: attachment.type,
          }),
        );
        for (const event of session.transcript ?? []) appendEvent(event);
        setBusy(Boolean(session.busy));
        setModelOptions(options);
        setModel(selectedModel);
        setDraft(compose?.draft ?? "");
        setProjectReferences(availableReferences);
        setSelectedReferences(references);
        setWorkflows(availableWorkflows);
        setSelectedWorkflow(workflow);
        setLocalAttachments(attachments);
        setAttachmentError(
          composePayload.issues?.[0]?.message ??
            (compose && compose.references.length !== references.length
              ? "A saved project item is no longer available and was removed."
              : null),
        );
        setHydratedProjectId(projectId);
        openStream();
        const readAttachment =
          window.videoFsDesktopEnvironment?.companionAttachmentRead;
        if (!readAttachment) return;
        for (const attachment of attachments) {
          if (attachment.error || !attachment.type.startsWith("image/")) continue;
          try {
            const stored = (await readAttachment(
              projectId,
              attachment.hash,
            )) as StoredAttachmentRead;
            if (cancelled || epoch !== loadEpochRef.current) return;
            setLocalAttachments((current) =>
              current.map((entry) =>
                entry.hash === attachment.hash
                  ? {
                      ...entry,
                      src: `data:${stored.type};base64,${stored.data}`,
                    }
                  : entry,
              ),
            );
          } catch (error) {
            if (cancelled || epoch !== loadEpochRef.current) return;
            const message =
              error instanceof Error
                ? error.message
                : `"${attachment.label}" is unavailable.`;
            setAttachmentError(message);
            setLocalAttachments((current) =>
              current.map((entry) =>
                entry.hash === attachment.hash
                  ? { ...entry, error: message }
                  : entry,
              ),
            );
          }
        }
      })
      .catch((error) => {
        if (cancelled || epoch !== loadEpochRef.current) return;
        // Transient failures (dev recompiles, brief 500s) must not leave a
        // dead, empty chat: keep whatever was loaded, reattach the stream,
        // and retry hydration until it lands.
        setAttachmentError(
          error instanceof Error
            ? error.message
            : "The companion composer could not be restored.",
        );
        openStream();
        retryTimer = setTimeout(() => {
          if (!cancelled && epoch === loadEpochRef.current) {
            setHydrateAttempt((attempt) => attempt + 1);
          }
        }, 2500);
      });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      sourceRef.current?.close();
    };
  }, [appendEvent, hydrateAttempt, openStream, projectId]);

  // Follow the conversation: pinned to the bottom unless the user scrolls
  // away (returning near the bottom re-engages). While a reply streams, a
  // per-frame follow keeps the text glued smoothly instead of jumping.
  const stickToBottomRef = useRef(true);
  const [scrolledAway, setScrolledAway] = useState(false);

  const handleTranscriptScroll = useCallback(() => {
    const element = transcriptRef.current;
    if (!element) return;
    // Re-attach only when the user has returned to (essentially) the bottom.
    // Detaching is handled by the wheel handler, so the follow loop can't
    // fight an upward scroll gesture.
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 16) {
      stickToBottomRef.current = true;
    }
    setScrolledAway(element.scrollTop > 8);
  }, []);

  const handleTranscriptWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      // Any upward intent detaches immediately — one flick, no fighting.
      if (event.deltaY < 0) stickToBottomRef.current = false;
    },
    [],
  );

  useEffect(() => {
    const element = transcriptRef.current;
    if (!element || !stickToBottomRef.current || busy) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollTo({
      behavior: reduce ? "auto" : "smooth",
      top: element.scrollHeight,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  useEffect(() => {
    if (!busy) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const step = () => {
      const element = transcriptRef.current;
      if (element && stickToBottomRef.current) {
        const target = element.scrollHeight - element.clientHeight;
        const distance = target - element.scrollTop;
        if (distance > 1) {
          // Eased, strictly downward follow: glides toward the bottom and
          // never overshoots or reverses (reversals read as bouncing).
          element.scrollTop = Math.min(
            target,
            element.scrollTop + (reduce ? distance : Math.max(1, distance * 0.22)),
          );
        }
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [busy]);

  useEffect(() => {
    if (!projectId || hydratedProjectId !== projectId) return;
    const state: StoredCompose = {
      attachments: localAttachments.map((attachment) => ({
        hash: attachment.hash,
        name: attachment.label,
        size: attachment.size,
        type: attachment.type,
      })),
      draft,
      model,
      projectId,
      references: selectedReferences.map(({ id, path }) => ({ id, path })),
      version: 1,
      workflowId: selectedWorkflow?.id ?? null,
    };
    const timer = window.setTimeout(() => {
      void window.videoFsDesktopEnvironment?.companionComposeSet?.(
        projectId,
        state,
      );
    }, 100);
    return () => window.clearTimeout(timer);
  }, [
    draft,
    hydratedProjectId,
    localAttachments,
    model,
    projectId,
    selectedReferences,
    selectedWorkflow,
  ]);

  const addLocalFiles = useCallback(
    async (files: File[]) => {
      if (!projectId) return;
      const storeAttachment =
        window.videoFsDesktopEnvironment?.companionAttachmentStore;
      if (!storeAttachment) {
        setAttachmentError("Private attachment storage is unavailable.");
        return;
      }
      for (const file of files) {
        try {
          if (file.size > 25 * 1024 * 1024) {
            throw new Error(`"${file.name}" is too large (maximum 25 MB).`);
          }
          const stored = (await storeAttachment(projectId, {
            bytes: await file.arrayBuffer(),
            name: file.name,
            size: file.size,
            type: file.type || "application/octet-stream",
          })) as {
            hash: string;
            name: string;
            size: number;
            type: string;
          };
          setLocalAttachments((current) => {
            if (current.some((entry) => entry.hash === stored.hash)) return current;
            return [
              ...current,
              {
                error: null,
                hash: stored.hash,
                id: stored.hash,
                label: stored.name,
                size: stored.size,
                src: stored.type.startsWith("image/")
                  ? URL.createObjectURL(file)
                  : null,
                type: stored.type,
              },
            ];
          });
          setAttachmentError(null);
        } catch (error) {
          setAttachmentError(
            error instanceof Error
              ? error.message
              : `"${file.name}" could not be attached.`,
          );
        }
      }
    },
    [projectId],
  );

  const send = async () => {
    const text =
      draft.trim() ||
      (selectedWorkflow
        ? "Run the selected workflow with the selected context."
        : localAttachments.length || selectedReferences.length
        ? "Please review the selected project items and attached files."
        : "");
    if (
      !text ||
      !projectId ||
      !model ||
      localAttachments.some((attachment) => attachment.error)
    ) {
      return;
    }
    setSendError(null);
    try {
      const readAttachment =
        window.videoFsDesktopEnvironment?.companionAttachmentRead;
      if (localAttachments.length && !readAttachment) {
        throw new Error("Private attachment storage is unavailable.");
      }
      const attachments: CompanionAttachmentPayload[] = await Promise.all(
        localAttachments.map(async (attachment) => {
          const stored = (await readAttachment?.(
            projectId,
            attachment.hash,
          )) as StoredAttachmentRead;
          return {
            data: `data:${stored.type};base64,${stored.data}`,
            name: stored.name,
            type: stored.type,
          };
        }),
      );
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/companion`,
        {
          body: JSON.stringify({
            attachments,
            model,
            references: selectedReferences.map(({ id, path }) => ({ id, path })),
            text,
            workflowId: selectedWorkflow?.id ?? null,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "The message could not be sent.");
      }
      // The session may have just spawned; reattach to its event stream.
      setDraft("");
      setSelectedReferences([]);
      setSelectedWorkflow(null);
      await Promise.all(
        localAttachments.map((attachment) =>
          window.videoFsDesktopEnvironment?.companionAttachmentRemove?.(
            projectId,
            attachment.hash,
          ),
        ),
      );
      localAttachments.forEach((attachment) => {
        if (attachment.src?.startsWith("blob:")) URL.revokeObjectURL(attachment.src);
      });
      setLocalAttachments([]);
      openStream();
    } catch (error) {
      setSendError(
        error instanceof Error ? error.message : "The message could not be sent.",
      );
    }
  };

  const rows = useMemo(() => rowsFromEvents(events), [events]);
  const hasSession = events.length > 0;

  return (
    <div className={`companion-shell${scrolledAway ? " is-scrolled" : ""}`}>
      <header className="companion-header">
        <Menu onOpenChange={(open) => open && loadProjects()}>
          <MenuTrigger asChild>
            <button
              aria-label="Switch project"
              className="companion-header-switch"
              type="button"
            >
              <span className="companion-title">
                {projectName ?? "Choose a project"}
              </span>
              {otherProjectAttention.any ? (
                <span
                  aria-label={
                    otherProjectAttention.urgent
                      ? "Another project needs attention"
                      : "Agents are working in other projects"
                  }
                  className={`companion-switch-notif${
                    otherProjectAttention.urgent ? " is-urgent" : ""
                  }`}
                  role="status"
                />
              ) : null}
              <ChevronDown aria-hidden size={12} strokeWidth={2.2} />
            </button>
          </MenuTrigger>
          <MenuContent align="start">
            <MenuLabel>Talk to a project</MenuLabel>
            {projects.map((project) => (
              <MenuItem
                key={project.id}
                onSelect={() => {
                  switchProject(project.id);
                  // Mirror the pick into the main app: open (or activate) the
                  // project's tab there so both windows stay on one project.
                  void window.videoFsDesktopEnvironment?.companionOpenProject?.(
                    project.id,
                  );
                }}
              >
                <span className="companion-project-name">{project.name}</span>
                {isVisibleProjectTabActivity(projectActivity[project.id]) ? (
                  <span
                    aria-hidden
                    className={`companion-menu-notif is-${
                      projectActivity[project.id]?.kind ?? "progress"
                    }`}
                  />
                ) : null}
                {project.id === projectId ? (
                  <Check aria-hidden size={14} strokeWidth={2.4} />
                ) : null}
              </MenuItem>
            ))}
            {!projects.length ? (
              <MenuItem disabled>No projects yet</MenuItem>
            ) : null}
          </MenuContent>
        </Menu>
        <span aria-hidden className="companion-header-spacer" />
        <Menu>
          <MenuTrigger asChild>
            <button
              aria-label="Switch model"
              className={`companion-header-switch is-model${busy ? " is-thinking" : ""}`}
              disabled={busy}
              title={busy ? "Model changes apply after this turn" : undefined}
              type="button"
            >
              {busy ? (
                <em className="companion-model-thinking">
                  {modelOptions.find((option) => option.value === model)?.label ??
                    "Claude"}{" "}
                  is thinking
                </em>
              ) : (
                <>
                  {modelOptions.find((option) => option.value === model)?.label ??
                    "Model unavailable"}
                  <ChevronDown aria-hidden size={12} strokeWidth={2.2} />
                </>
              )}
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuLabel>Model</MenuLabel>
            {modelOptions.map((option) => (
              <MenuItem
                key={option.label}
                onSelect={() => chooseModel(option.value)}
              >
                <span className="companion-project-name">{option.label}</span>
                {option.value === model ? (
                  <Check aria-hidden size={14} strokeWidth={2.4} />
                ) : null}
              </MenuItem>
            ))}
            {!modelOptions.length ? (
              <MenuItem disabled>Claude Code unavailable</MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuItem disabled={!projectId} onSelect={() => {
              if (!codexInstalled) { connectAgent("codex"); return; }
              if (!projectId) return;
              void fetch("/api/agent-launch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: "codex", projectId }) })
                .then(async response => { if (!response.ok) { const body = await response.json(); throw new Error(body.error || "Could not open Codex."); } })
                .catch(error => setConnectState({ agent: "codex", stage: "error", detail: error instanceof Error ? error.message : "Could not open Codex." }));
            }}><Terminal size={14} />{codexInstalled ? "Codex installed · Open in Terminal" : "Connect Codex"}</MenuItem>
          </MenuContent>
        </Menu>
        <span
          className={`companion-activity-slot${
            agentWorking ? " has-activity" : ""
          }`}
        >
          {projectId && agentWorking ? (
            <AgentActivityStatusButton
              compact
              event={
                busy
                  ? { id: "chat", kind: "progress", label: "Claude is working" }
                  : (projectActivity[projectId] ?? {
                      id: "idle",
                      kind: "idle",
                      label: "Agent idle",
                    })
              }
              expanded={false}
              onOpenActivity={() => {
                // The chat has no activity surface of its own: jump to the
                // project in the main app, where the overlay lives.
                void window.videoFsDesktopEnvironment?.companionOpenProject?.(
                  projectId,
                );
              }}
              projectName={projectName ?? undefined}
            />
          ) : null}
        </span>
      </header>

      <div
        className="companion-transcript"
        onScroll={handleTranscriptScroll}
        onWheel={handleTranscriptWheel}
        ref={transcriptRef}
      >
        {!projectId ? (
          <p className="companion-empty">
            Open a project in Impractical — or pick one from the menu above —
            to start a conversation.
          </p>
        ) : claudeUnavailable && !hasSession ? (
          <ConnectPanel onConnect={connectAgent} state={connectState} />
        ) : !hasSession ? (
          <p className="companion-empty">
            Ask Claude to create, edit, or arrange — it works directly on your
            canvas and timeline.
          </p>
        ) : null}
        {rows.map((row) =>
          row.kind === "user" ? (
            <div className="companion-row is-user" key={row.key}>
              <div className="companion-bubble">{row.text}</div>
            </div>
          ) : row.kind === "assistant" ? (
            <div className="companion-row" key={row.key}>
              <div className="companion-assistant">
                <SmoothMarkdown live={Boolean(row.live)} text={row.text} />
              </div>
            </div>
          ) : row.kind === "tool" ? (
            <div
              className="companion-tool"
              key={row.key}
              title={row.detail}
            >
              {row.done ? (
                <Check aria-hidden size={12} />
              ) : (
                <Loader2 aria-hidden className="companion-spin" size={12} />
              )}
              <span className="companion-tool-name">
                {row.toolName.replaceAll("_", " ")}
              </span>
              {row.detail ? (
                <span className="companion-tool-detail">{row.detail}</span>
              ) : null}
            </div>
          ) : (
            <div className="companion-system" key={row.key} title={row.detail}>
              {row.text}
            </div>
          ),
        )}
        {claudeUnavailable && hasSession ? (
          <ConnectPanel inline onConnect={connectAgent} state={connectState} />
        ) : null}
        {busy ? (
          <div aria-label="Claude is working" className="companion-working">
            <span
              aria-hidden
              className="agent-activity-status-button is-active companion-working-grid"
              data-motion="running"
            >
              <span className="agent-activity-dot-grid">
                {Array.from({ length: 9 }, (_, index) => (
                  <span
                    className="agent-activity-dot"
                    key={index}
                    style={
                      {
                        "--agent-dot-order":
                          Math.floor(index / 3) + (index % 3),
                      } as CSSProperties
                    }
                  />
                ))}
              </span>
            </span>
          </div>
        ) : null}
      </div>

      <footer className="companion-composer">
        {sendError || attachmentError ? (
          <p className="companion-error" role="alert">
            {sendError ?? attachmentError}
          </p>
        ) : null}
        <input
          ref={fileInputRef}
          className="hidden"
          type="file"
          multiple
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            if (files.length) void addLocalFiles(files);
            event.currentTarget.value = "";
          }}
        />
        <div className="companion-composer-card">
          {selectedWorkflow || selectedReferences.length || localAttachments.length ? (
            <div className="companion-composer-tray" aria-label="Selected context">
              {selectedWorkflow ? (
                <AttachmentTile
                  kind="workflow"
                  name={selectedWorkflow.title}
                  onRemove={() => setSelectedWorkflow(null)}
                />
              ) : null}
              {selectedReferences.map((reference) => (
                <AttachmentTile
                  key={`${reference.path}:${reference.id}`}
                  kind={reference.kind}
                  name={reference.title}
                  src={projectId ? referencePreview(projectId, reference) : null}
                  onRemove={() =>
                    setSelectedReferences((current) =>
                      current.filter((entry) => entry.path !== reference.path),
                    )
                  }
                />
              ))}
              {localAttachments.map((attachment) => (
                <AttachmentTile
                  key={attachment.id}
                  kind={attachmentKind(attachment.type)}
                  name={attachment.label}
                  src={attachment.src}
                  onRemove={() => {
                    if (!projectId) return;
                    if (attachment.src?.startsWith("blob:")) {
                      URL.revokeObjectURL(attachment.src);
                    }
                    setLocalAttachments((current) =>
                      current.filter((entry) => entry.id !== attachment.id),
                    );
                    void window.videoFsDesktopEnvironment?.companionAttachmentRemove?.(
                      projectId,
                      attachment.hash,
                    );
                  }}
                />
              ))}
            </div>
          ) : null}
          <TextareaAutosize
            className="companion-composer-textarea"
            disabled={!projectId}
            maxRows={8}
            minRows={2}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={
              projectId ? "Ask for anything…" : "Choose a project first"
            }
            value={draft}
          />
          <div className="companion-composer-controls">
            <Menu>
              <MenuTrigger asChild>
                <button
                  aria-label="Add attachment or project reference"
                  className="companion-composer-tool"
                  disabled={!projectId}
                  title="Add"
                  type="button"
                >
                  <Plus size={16} />
                </button>
              </MenuTrigger>
              <MenuContent align="start">
                <MenuLabel>Add context</MenuLabel>
                <MenuItem onSelect={() => fileInputRef.current?.click()}>
                  <FilePlus2 size={15} />
                  Add files
                </MenuItem>
                <MenuItem onSelect={() => setReferenceDialogOpen(true)}>
                  <Plus size={15} />
                  Add project item
                </MenuItem>
              </MenuContent>
            </Menu>
            {MANUAL_WORKFLOWS_ENABLED ? (
              <button
                aria-expanded={workflowDialogOpen}
                aria-haspopup="dialog"
                aria-label="Flows"
                className="companion-flow-button"
                disabled={!projectId}
                onClick={() => setWorkflowDialogOpen(true)}
                title="Flows"
                type="button"
              >
                <Waves aria-hidden size={15} />
                Flows
              </button>
            ) : null}
            <span className="companion-composer-spacer" />
            {busy &&
            !draft.trim() &&
            !localAttachments.length &&
            !selectedReferences.length &&
            !selectedWorkflow ? (
              <button
                aria-label="Stop the current response"
                className="companion-send is-stop"
                onClick={() => {
                  if (!projectId) return;
                  void fetch(
                    `/api/projects/${encodeURIComponent(projectId)}/companion/interrupt`,
                    { method: "POST" },
                  ).catch(() => {});
                }}
                title="Stop"
                type="button"
              >
                <Square fill="currentColor" size={11} />
              </button>
            ) : (
              <button
                aria-label={busy ? "Send (interjects into the current turn)" : "Send"}
                className="companion-send"
                disabled={
                  !projectId ||
                  !model ||
                  localAttachments.some((attachment) => attachment.error) ||
                  (!draft.trim() &&
                    !localAttachments.length &&
                    !selectedReferences.length &&
                    !selectedWorkflow)
                }
                onClick={() => void send()}
                type="button"
              >
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </div>
      </footer>

      <Dialog open={referenceDialogOpen} onOpenChange={setReferenceDialogOpen}>
        <DialogContent className="companion-picker-dialog">
          <DialogTitle>Add project item</DialogTitle>
          <div className="companion-picker-list">
            {projectReferences.map((reference) => {
              const selected = selectedReferences.some(
                (entry) => entry.path === reference.path,
              );
              return (
                <button
                  aria-pressed={selected}
                  className="companion-picker-row"
                  key={`${reference.path}:${reference.id}`}
                  onClick={() => {
                    setSelectedReferences((current) =>
                      selected
                        ? current.filter((entry) => entry.path !== reference.path)
                        : [...current, reference],
                    );
                  }}
                  type="button"
                >
                  <span>
                    <strong>{reference.title}</strong>
                    <small>@{reference.id} · {reference.kind}</small>
                  </span>
                  {selected ? <Check aria-hidden size={15} /> : null}
                </button>
              );
            })}
            {!projectReferences.length ? (
              <p className="companion-picker-empty">No project items available.</p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      {MANUAL_WORKFLOWS_ENABLED ? (
        <FlowsModal
          emptyLabel="No workflows available."
          flows={workflows.map((workflow) => ({
            category: "Workflows",
            description: workflow.description,
            icon: "workflow" as const,
            id: workflow.id,
            run: () => setSelectedWorkflow(workflow),
            selected: selectedWorkflow?.id === workflow.id,
            title: workflow.title,
          }))}
          onOpenChange={setWorkflowDialogOpen}
          open={workflowDialogOpen}
        />
      ) : null}
    </div>
  );
}

export default function CompanionPage() {
  return (
    <Suspense fallback={null}>
      <CompanionInner />
    </Suspense>
  );
}
