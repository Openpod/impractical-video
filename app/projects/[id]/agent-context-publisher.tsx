"use client";

import { Check, Copy, Terminal, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "@/components/ui/menu";
import type { AgentOnboardingStatus } from "@/lib/agent-onboarding-status";
import {
  AgentLaunchFooter,
  AgentSessionRows,
  launchAgentSession,
  useAgentPresence,
} from "@/app/app-shell";

export type AgentContextVersion = {
  index: number;
  sha256: string | null;
  versionId: string | null;
};

export type AgentContextArtifact = {
  artifactId: string;
  contentHash: string | null;
  entityRevision: number | null;
  kind: string;
  path: string | null;
  title: string | null;
  version: AgentContextVersion | null;
};

export type CanvasAgentContextCandidateVersion = {
  index: number;
  path: string | null;
  revision: number | null;
  versionId: string;
};

export type CanvasAgentContextCandidateArtifact = {
  artifactId: string;
  kind: string;
  sourcePath: string;
  title: string | null;
  version: CanvasAgentContextCandidateVersion | null;
};

export type CanvasAgentContextCandidate = {
  focused: CanvasAgentContextCandidateArtifact | null;
  pinned: CanvasAgentContextCandidateArtifact[];
  selected: CanvasAgentContextCandidateArtifact[];
};

export type CanvasAgentContext = {
  focused: AgentContextArtifact | null;
  pinned: AgentContextArtifact[];
  selected: AgentContextArtifact[];
};

export type EditorAgentContext = {
  documentRevision: number | null;
  fps: number | null;
  focusedArtifact: AgentContextArtifact | null;
  focusedPlacement: {
    elementId: string;
    status: "focused" | "removed";
  } | null;
  playheadTicks: number | null;
  sceneId: string | null;
  selectedElements: Array<{
    elementId: string;
    kind: string;
    mediaId: string | null;
    trackId: string;
  }>;
  selectedKeyframes: Array<{
    elementId: string;
    keyframeId: string;
    property: string;
    trackId: string;
  }>;
  selectedMaskPoints: {
    elementId: string;
    pointIds: string[];
    trackId: string;
  } | null;
  selectedTrackIds: string[];
  timeRange: {
    endTicks: number;
    startTicks: number;
  } | null;
};

export type AgentContextViewState = {
  activeView: "canvas" | "editor";
  canvas: CanvasAgentContext;
  editor: EditorAgentContext;
  projectRevision: string | null;
};

type AgentContextResponse = {
  context?: {
    activeView?: "canvas" | "editor" | "plan";
    attachments?: Array<{ attachmentId: string }>;
    binding?: { appSessionId: string; windowId: string } | null;
    canvas?: CanvasAgentContext;
    contextRevision?: number;
    editor?: EditorAgentContext;
    projectRevision?: string | null;
  };
  details?: {
    currentContextRevision?: number;
  };
  error?: string;
  code?: string;
  staleEntities?: Array<{ entityId: string; reason: string }>;
};

export type AgentContextPublisherState = {
  connected: boolean;
  contextRevision: number | null;
  staleCount: number;
  syncing: boolean;
  visibleCount: number;
};

export const EMPTY_CANVAS_AGENT_CONTEXT: CanvasAgentContext = {
  focused: null,
  pinned: [],
  selected: [],
};

export const EMPTY_CANVAS_AGENT_CONTEXT_CANDIDATE: CanvasAgentContextCandidate = {
  focused: null,
  pinned: [],
  selected: [],
};

export const EMPTY_EDITOR_AGENT_CONTEXT: EditorAgentContext = {
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
};

function artifactHasByteIdentity(item: AgentContextArtifact) {
  return Boolean(
    item.path &&
      item.contentHash &&
      item.entityRevision !== null &&
      (!item.version || item.version.sha256),
  );
}

function candidateKey(item: CanvasAgentContextCandidateArtifact) {
  return `${item.artifactId}:${item.version?.index ?? "record"}:${item.version?.versionId ?? "record"}`;
}

function activeCanvasCandidateContext(
  activeView: "canvas" | "editor",
  canvas: CanvasAgentContextCandidate,
) {
  if (activeView === "canvas") return canvas;
  return {
    focused: null,
    pinned: canvas.pinned,
    selected: [],
  };
}

function candidateArtifacts(value: CanvasAgentContextCandidate) {
  const unique = new Map<string, CanvasAgentContextCandidateArtifact>();
  for (const item of [
    ...value.selected,
    ...value.pinned,
    ...(value.focused ? [value.focused] : []),
  ]) {
    unique.set(candidateKey(item), item);
  }
  return [...unique.values()];
}

function resolvedArtifactKey(item: AgentContextArtifact) {
  return `${item.artifactId}:${item.version?.index ?? "record"}:${item.version?.versionId ?? "record"}`;
}

function resolvedContext(
  candidate: CanvasAgentContextCandidate,
  artifacts: AgentContextArtifact[],
): CanvasAgentContext {
  const byKey = new Map(
    artifacts.map((item) => [resolvedArtifactKey(item), item]),
  );
  const resolve = (item: CanvasAgentContextCandidateArtifact) => {
    const match = byKey.get(candidateKey(item));
    if (!match || !artifactHasByteIdentity(match)) {
      throw new Error("Canvas context byte identity is incomplete.");
    }
    return match;
  };
  return {
    focused: candidate.focused ? resolve(candidate.focused) : null,
    pinned: candidate.pinned.map(resolve),
    selected: candidate.selected.map(resolve),
  };
}

export function useResolvedCanvasAgentContext({
  activeView,
  projectId,
  projectRevision,
  value,
}: {
  activeView: "canvas" | "editor";
  projectId: string;
  projectRevision: string | null;
  value: CanvasAgentContextCandidate;
}) {
  const activeCandidate = useMemo(
    () => activeCanvasCandidateContext(activeView, value),
    [activeView, value],
  );
  const identityKey = useMemo(
    () => JSON.stringify({ activeCandidate, projectRevision }),
    [activeCandidate, projectRevision],
  );
  const [state, setState] = useState<{
    resolvedKey: string | null;
    staleCount: number;
    value: CanvasAgentContext;
  }>({
    resolvedKey: null,
    staleCount: 0,
    value: EMPTY_CANVAS_AGENT_CONTEXT,
  });

  useEffect(() => {
    const controller = new AbortController();
    const artifacts = candidateArtifacts(activeCandidate);
    void Promise.resolve().then(async () => {
      if (!artifacts.length) {
        if (!controller.signal.aborted) {
          setState({
            resolvedKey: identityKey,
            staleCount: 0,
            value: EMPTY_CANVAS_AGENT_CONTEXT,
          });
        }
        return;
      }
      try {
        const response = await fetch(
          `/api/projects/${projectId}/canvas/context-identity`,
          {
            body: JSON.stringify({ artifacts, mode: "resolve" }),
            cache: "no-store",
            headers: { "content-type": "application/json" },
            method: "POST",
            signal: controller.signal,
          },
        );
        const payload = (await response.json().catch(() => ({}))) as {
          artifacts?: AgentContextArtifact[];
          error?: string;
        };
        if (!response.ok || !Array.isArray(payload.artifacts)) {
          throw new Error(
            payload.error || "Canvas context identity is unavailable.",
          );
        }
        const next = resolvedContext(activeCandidate, payload.artifacts);
        if (!controller.signal.aborted) {
          setState({ resolvedKey: identityKey, staleCount: 0, value: next });
        }
      } catch {
        if (controller.signal.aborted) return;
        setState((current) => ({
          ...current,
          resolvedKey: identityKey,
          staleCount: 1,
        }));
      }
    });
    return () => controller.abort();
  }, [activeCandidate, identityKey, projectId]);

  return {
    staleCount: state.staleCount,
    syncing:
      candidateArtifacts(activeCandidate).length > 0 &&
      state.resolvedKey !== identityKey,
    value: state.value,
  };
}

function stableSessionId(key: string, prefix: string) {
  if (typeof window === "undefined") return `${prefix}_server`;
  const existing = window.sessionStorage.getItem(key)?.trim();
  if (existing) return existing;
  const id = `${prefix}_${crypto.randomUUID()}`;
  window.sessionStorage.setItem(key, id);
  return id;
}

export function contextVisibleCount(value: AgentContextViewState) {
  const ids = new Set<string>();
  for (const item of value.canvas.pinned) {
    if (artifactHasByteIdentity(item)) ids.add(`canvas:${item.artifactId}`);
  }
  if (value.activeView === "canvas") {
    for (const item of value.canvas.selected) {
      if (artifactHasByteIdentity(item)) ids.add(`canvas:${item.artifactId}`);
    }
  } else {
    if (
      value.editor.focusedArtifact &&
      artifactHasByteIdentity(value.editor.focusedArtifact)
    ) {
      ids.add(`editor-artifact:${resolvedArtifactKey(value.editor.focusedArtifact)}`);
    } else {
      for (const item of value.editor.selectedElements) {
        ids.add(`editor:${item.trackId}:${item.elementId}`);
      }
      for (const trackId of value.editor.selectedTrackIds) {
        ids.add(`track:${trackId}`);
      }
    }
    for (const item of value.editor.selectedKeyframes) {
      ids.add(`keyframe:${item.trackId}:${item.elementId}:${item.keyframeId}`);
    }
    if (value.editor.selectedMaskPoints) {
      for (const pointId of value.editor.selectedMaskPoints.pointIds) {
        ids.add(`mask:${value.editor.selectedMaskPoints.elementId}:${pointId}`);
      }
    }
  }
  return ids.size;
}

export function activeAgentContextSnapshot({
  activeView,
  canvas,
  editor,
  projectRevision,
}: AgentContextViewState): AgentContextViewState {
  if (activeView === "canvas") {
    return {
      activeView,
      canvas,
      editor: EMPTY_EDITOR_AGENT_CONTEXT,
      projectRevision,
    };
  }
  return {
    activeView,
    canvas: {
      focused: null,
      pinned: canvas.pinned,
      selected: [],
    },
    editor,
    projectRevision,
  };
}

function responseViewState(
  response: AgentContextResponse,
  fallback: AgentContextViewState,
): AgentContextViewState {
  const context = response.context;
  if (!context) return fallback;
  const activeView = context.activeView === "editor" ? "editor" : "canvas";
  return {
    activeView,
    canvas: context.canvas ?? fallback.canvas,
    editor: context.editor ?? fallback.editor,
    projectRevision: context.projectRevision ?? fallback.projectRevision,
  };
}

export function agentContextViewMatches(
  left: AgentContextViewState,
  right: AgentContextViewState,
) {
  const semanticView = (value: AgentContextViewState) => ({
    activeView: value.activeView,
    canvas: value.canvas,
    editor: value.editor,
  });
  return (
    JSON.stringify(semanticView(left)) ===
    JSON.stringify(semanticView(right))
  );
}

async function readResponse(response: Response) {
  return (await response.json().catch(() => ({}))) as AgentContextResponse;
}

class CanvasContextIdentityStaleError extends Error {}

async function verifyArtifactIdentityBeforeAcknowledge(
  projectId: string,
  artifacts: AgentContextArtifact[],
) {
  const unique = new Map<string, AgentContextArtifact>();
  for (const item of artifacts) {
    if (!artifactHasByteIdentity(item)) {
      throw new CanvasContextIdentityStaleError(
        "Canvas context byte identity is incomplete.",
      );
    }
    unique.set(resolvedArtifactKey(item), item);
  }
  if (!unique.size) return;
  const response = await fetch(
    `/api/projects/${projectId}/canvas/context-identity`,
    {
      body: JSON.stringify({
        artifacts: [...unique.values()],
        mode: "verify",
      }),
      cache: "no-store",
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  if (response.status === 409) {
    throw new CanvasContextIdentityStaleError(
      "Canvas context changed before acknowledgement.",
    );
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(payload.error || "Canvas context identity is unavailable.");
  }
}

export function useAgentContextPublisher({
  clearSequence,
  identityStaleCount = 0,
  identitySyncing = false,
  paused = false,
  projectId,
  value,
}: {
  clearSequence: number;
  identityStaleCount?: number;
  identitySyncing?: boolean;
  paused?: boolean;
  projectId: string;
  value: AgentContextViewState;
}) {
  const desired = useMemo(() => activeAgentContextSnapshot(value), [value]);
  const desiredKey = useMemo(() => JSON.stringify(desired), [desired]);
  const desiredRef = useRef(desired);
  const desiredKeyRef = useRef(desiredKey);
  const generationRef = useRef(0);
  const revisionRef = useRef<number | null>(null);
  const attachmentIdsRef = useRef<string[]>([]);
  const acknowledgedKeyRef = useRef<string | null>(null);
  const clearRequestedRef = useRef(clearSequence);
  const clearCompletedRef = useRef(clearSequence);
  const drainPendingRef = useRef(false);
  const drainRunningRef = useRef(false);
  const drainRef = useRef<() => Promise<void>>(async () => {});
  const mountedRef = useRef(true);
  const initialHydrationRef = useRef(true);
  const initialReconciliationRef = useRef(true);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [appSessionId] = useState(() =>
    stableSessionId("video-fs:agent-context:app-session", "app"),
  );
  const [windowId] = useState(() =>
    stableSessionId("video-fs:agent-context:window", "window"),
  );
  const [state, setState] = useState<AgentContextPublisherState>({
    connected: false,
    contextRevision: null,
    staleCount: 0,
    syncing: true,
    visibleCount: 0,
  });

  const acknowledge = useCallback(
    (
      response: AgentContextResponse,
      fallback: AgentContextViewState,
      options: { syncing: boolean },
    ) => {
      const revision = response.context?.contextRevision;
      if (typeof revision === "number") revisionRef.current = revision;
      attachmentIdsRef.current = (response.context?.attachments ?? [])
        .map((attachment) => attachment.attachmentId)
        .filter(Boolean);
      if (!mountedRef.current) return;
      const acknowledged = responseViewState(response, fallback);
      setState(() => ({
        connected: true,
        contextRevision:
          typeof revision === "number" ? revision : revisionRef.current,
        staleCount: response.staleEntities?.length ?? 0,
        syncing: options.syncing,
        visibleCount: contextVisibleCount(acknowledged),
      }));
    },
    [],
  );

  const readCurrent = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/agent-context`, {
      cache: "no-store",
    });
    const payload = await readResponse(response);
    if (!response.ok || !payload.context) {
      throw new Error(payload.error || "Agent context is unavailable.");
    }
    acknowledge(payload, desiredRef.current, {
      syncing: true,
    });
    return payload;
  }, [acknowledge, projectId]);

  const patchCurrent = useCallback(
    async (clear: boolean) => {
      const currentDesired = desiredRef.current;
      if (revisionRef.current === null) {
        const current = await readCurrent();
        const currentView = responseViewState(current, currentDesired);
        if (
          !clear &&
          initialReconciliationRef.current &&
          contextVisibleCount(currentDesired) === 0 &&
          contextVisibleCount(currentView) > 0
        ) {
          initialReconciliationRef.current = false;
          acknowledge(current, currentView, { syncing: false });
          return true;
        }
        initialReconciliationRef.current = false;
        if (
          !clear &&
          agentContextViewMatches(
            currentView,
            currentDesired,
          )
        ) {
          acknowledge(current, currentDesired, { syncing: false });
          return true;
        }
      }
      const response = await fetch(`/api/projects/${projectId}/agent-context`, {
        body: JSON.stringify({
          activeView: currentDesired.activeView,
          appSessionId,
          attachmentIds: attachmentIdsRef.current,
          baseContextRevision: revisionRef.current,
          canvas: currentDesired.canvas,
          clear,
          editor: currentDesired.editor,
          projectId,
          projectRevision: currentDesired.projectRevision,
          windowId,
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      const payload = await readResponse(response);
      if (response.status === 409) {
        revisionRef.current =
          payload.details?.currentContextRevision ?? revisionRef.current;
        await readCurrent();
        return false;
      }
      if (!response.ok || !payload.context) {
        throw new Error(payload.error || "Agent context is unavailable.");
      }
      if (!clear) {
        await verifyArtifactIdentityBeforeAcknowledge(
          projectId,
          [
            ...currentDesired.canvas.selected,
            ...currentDesired.canvas.pinned,
            ...(currentDesired.canvas.focused
              ? [currentDesired.canvas.focused]
              : []),
            ...(currentDesired.editor.focusedArtifact
              ? [currentDesired.editor.focusedArtifact]
              : []),
          ],
        );
      }
      acknowledge(
        payload,
        clear ? {
          ...currentDesired,
          canvas: EMPTY_CANVAS_AGENT_CONTEXT,
          editor: EMPTY_EDITOR_AGENT_CONTEXT,
        } : currentDesired,
        {
          syncing: clear || JSON.stringify(currentDesired) !== desiredKeyRef.current,
        },
      );
      return true;
    },
    [acknowledge, appSessionId, projectId, readCurrent, windowId],
  );

  const drain = useCallback(async () => {
    if (drainRunningRef.current) {
      drainPendingRef.current = true;
      return;
    }
    if (paused) return;
    drainRunningRef.current = true;
    try {
      let conflicts = 0;
      while (mountedRef.current) {
        if (clearCompletedRef.current < clearRequestedRef.current) {
          if (!(await patchCurrent(true))) {
            conflicts += 1;
            if (conflicts >= 8) throw new Error("Agent context changed repeatedly.");
            continue;
          }
          clearCompletedRef.current += 1;
          acknowledgedKeyRef.current = null;
          continue;
        }
        const key = desiredKeyRef.current;
        const generation = generationRef.current;
        if (acknowledgedKeyRef.current === key) {
          if (mountedRef.current) {
            setState((current) =>
              current.syncing ? { ...current, syncing: false } : current,
            );
          }
          break;
        }
        if (!(await patchCurrent(false))) {
          conflicts += 1;
          if (conflicts >= 8) throw new Error("Agent context changed repeatedly.");
          continue;
        }
        conflicts = 0;
        acknowledgedKeyRef.current = key;
        if (generation === generationRef.current) break;
      }
    } catch (error) {
      if (mountedRef.current) {
        setState((current) =>
          error instanceof CanvasContextIdentityStaleError
            ? { ...current, connected: true, staleCount: 1, syncing: false }
            : { ...current, connected: false, syncing: false },
        );
      }
    } finally {
      drainRunningRef.current = false;
      if (
        drainPendingRef.current &&
        mountedRef.current &&
        !pausedRef.current
      ) {
        drainPendingRef.current = false;
        queueMicrotask(() => void drainRef.current());
      }
    }
  }, [patchCurrent, paused]);
  drainRef.current = drain;

  useEffect(() => {
    desiredRef.current = desired;
    desiredKeyRef.current = desiredKey;
    generationRef.current += 1;
    if (paused) return;
    const timer = window.setTimeout(() => {
      setState((current) => ({ ...current, syncing: true }));
      initialHydrationRef.current = false;
      void drain();
    }, initialHydrationRef.current ? 900 : 120);
    return () => window.clearTimeout(timer);
  }, [desired, desiredKey, drain, paused]);

  useEffect(() => {
    if (clearSequence <= clearRequestedRef.current || paused) return;
    clearRequestedRef.current = clearSequence;
    generationRef.current += 1;
    void drain();
  }, [clearSequence, drain, paused]);

  useEffect(() => {
    initialHydrationRef.current = true;
    initialReconciliationRef.current = true;
  }, [projectId]);

  useEffect(() => {
    mountedRef.current = true;
    const reconnect = () => {
      revisionRef.current = null;
      acknowledgedKeyRef.current = null;
      generationRef.current += 1;
      void drain();
    };
    window.addEventListener("online", reconnect);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("online", reconnect);
    };
  }, [drain, paused]);

  return {
    ...state,
    staleCount: Math.max(state.staleCount, identityStaleCount),
    syncing: state.syncing || identitySyncing,
  };
}

export type AgentContextIndicatorTone =
  | "approval"
  | "connected"
  | "disconnected"
  | "off"
  | "stale"
  | "syncing";

export function agentContextIndicatorPresentation({
  approvalRequired,
  connected,
  staleCount,
  syncing,
  visibleCount,
}: AgentContextPublisherState & { approvalRequired: boolean }) {
  if (approvalRequired) {
    return {
      label: "Approval required",
      title: "The agent is waiting for your answer before it can continue.",
      tone: "approval" as const,
    };
  }
  if (staleCount > 0) {
    return {
      label: "Context stale",
      title: `${staleCount} shared ${staleCount === 1 ? "item has" : "items have"} changed or disappeared.`,
      tone: "stale" as const,
    };
  }
  if (syncing) {
    return {
      label: "Syncing context",
      title:
        visibleCount > 0
          ? `Verifying a new selection. The agent still sees ${visibleCount} ${visibleCount === 1 ? "item" : "items"}.`
          : "Verifying the selected project files before sharing them.",
      tone: "syncing" as const,
    };
  }
  if (!connected) {
    return {
      label: "Desktop unavailable",
      title:
        "Open or reconnect Video FS Desktop before sharing selection context.",
      tone: "disconnected" as const,
    };
  }
  if (visibleCount === 0) {
    return {
      label: "Context off",
      title: "Select or pin something to share it with the next agent turn.",
      tone: "off" as const,
    };
  }
  return {
    label: `Agent sees ${visibleCount} ${visibleCount === 1 ? "item" : "items"}`,
    title: "The acknowledged selection is available to the next agent turn.",
    tone: "connected" as const,
  };
}

export function agentConnectionIndicatorPresentation(connected: boolean) {
  return connected
    ? {
        label: "Desktop connected",
        title: "Video FS Desktop is connected.",
        tone: "connected" as const,
      }
    : {
        label: "Desktop unavailable",
        title: "Video FS Desktop is unavailable.",
        tone: "disconnected" as const,
      };
}

export function agentSetupRowPresentation({
  approvalRequired,
  configInstalled,
  contextHookInstalled,
  desktopAvailable,
  setupLoading,
  state,
}: {
  approvalRequired: boolean;
  configInstalled: boolean;
  contextHookInstalled: boolean;
  desktopAvailable: boolean;
  setupLoading: boolean;
  state: AgentContextPublisherState;
}): {
  label: string;
  tone: "attention" | "muted" | "ready" | "stale";
} {
  if (setupLoading) return { label: "Checking setup", tone: "muted" };
  if (!desktopAvailable || !state.connected) {
    return { label: "Desktop unavailable", tone: "attention" };
  }
  if (approvalRequired) {
    return { label: "Approval required", tone: "attention" };
  }
  if (state.staleCount > 0) {
    return { label: "Context stale", tone: "stale" };
  }
  if (
    configInstalled &&
    contextHookInstalled &&
    state.contextRevision !== null &&
    state.visibleCount > 0
  ) {
    return { label: "Context acknowledged", tone: "ready" };
  }
  if (configInstalled) {
    return { label: "Config installed", tone: "ready" };
  }
  return { label: "Config not installed", tone: "attention" };
}

export function AgentContextIndicator({
  approvalRequired,
  projectId,
  state,
}: {
  approvalRequired: boolean;
  projectId: string;
  state: AgentContextPublisherState;
}) {
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [setup, setSetup] = useState<AgentOnboardingStatus | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const presence = useAgentPresence();
  const copyResetTimerRef = useRef<number | null>(null);
  const connection = agentConnectionIndicatorPresentation(state.connected);

  useEffect(() => {
    if (!menuOpen) return;
    const controller = new AbortController();
    void fetch(`/api/projects/${projectId}/agent-context/status`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as {
          setup?: AgentOnboardingStatus;
        };
        if (!response.ok || !payload.setup) {
          throw new Error("Agent setup status is unavailable.");
        }
        setSetup(payload.setup);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSetup(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSetupLoading(false);
      });
    return () => controller.abort();
  }, [menuOpen, projectId]);

  const copyCommand = useCallback(async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCommand(command);
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(
        () =>
          setCopiedCommand((current) =>
            current === command ? null : current,
          ),
        1600,
      );
    } catch {
      setCopiedCommand(null);
    }
  }, []);

  useEffect(
    () => () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    },
    [],
  );

  const rowStatus = useCallback(
    (agent: "claude" | "codex") => {
      const agentSetup = setup?.[agent];
      return agentSetupRowPresentation({
        approvalRequired,
        configInstalled: agentSetup?.configInstalled ?? false,
        contextHookInstalled: agentSetup?.contextHookInstalled ?? false,
        desktopAvailable: setup?.desktopAvailable ?? false,
        setupLoading,
        state,
      });
    },
    [approvalRequired, setup, setupLoading, state],
  );

  const claudeStatus = rowStatus("claude");
  const codexStatus = rowStatus("codex");
  const setupDetail = (
    agent: "claude" | "codex",
    status: ReturnType<typeof rowStatus>,
  ) => {
    const displayName = agent === "claude" ? "Claude" : "Codex";
    if (status.label === "Desktop unavailable") {
      return `Open Video FS Desktop and reopen this project before launching ${displayName}.`;
    }
    if (status.label === "Approval required") {
      return "Answer the pending agent question in Activity before continuing.";
    }
    if (status.label === "Context stale") {
      return "Reselect the changed item so the next prompt receives current project context.";
    }
    const agentSetup = setup?.[agent];
    if (!setupLoading && !agentSetup?.configInstalled) {
      return "Reopen this project in Video FS Desktop. If an existing config was preserved, review the generated connection guide.";
    }
    if (agentSetup?.configInstalled && !agentSetup.contextHookInstalled) {
      return "The MCP config is ready. Review the project hook before selection context can be included.";
    }
    return agent === "claude"
      ? "Start Claude in this project. Approve the project MCP and context hook if prompted."
      : "Start Codex in this project, then use /hooks to review the Video FS context hook.";
  };

  return (
    <Menu
      open={menuOpen}
      onOpenChange={(open) => {
        setMenuOpen(open);
        if (open) {
          setSetupLoading(true);
        } else {
          setCopiedCommand(null);
          if (copyResetTimerRef.current !== null) {
            window.clearTimeout(copyResetTimerRef.current);
            copyResetTimerRef.current = null;
          }
        }
      }}
    >
      <MenuTrigger asChild>
        <button
          aria-label={`${connection.label}. External Claude and Codex terminal setup.`}
          className={`agent-context-indicator is-${connection.tone}`}
          title={connection.title}
          type="button"
        >
          <Zap
            aria-hidden="true"
            className="agent-context-indicator-bolt"
            fill={state.connected ? "currentColor" : "none"}
            strokeWidth={state.connected ? 1.7 : 1.9}
          />
          <span
            aria-live="polite"
            className="sr-only"
            role="status"
          >
            {connection.label}
          </span>
        </button>
      </MenuTrigger>
      <MenuContent
        align="end"
        aria-label="Claude and Codex setup"
        className="agent-context-menu"
        sideOffset={10}
      >
        <div className="agent-context-menu-heading">
          <div>
            <p className="agent-context-menu-title">External agents</p>
            <p className="agent-context-menu-copy">
              Advanced: connect Claude or Codex through Terminal.
            </p>
          </div>
          <Terminal aria-hidden="true" size={17} strokeWidth={1.8} />
        </div>

        <AgentSessionRows presence={presence} />

        <AgentSetupRow
          agent="Claude"
          command="claude"
          copied={copiedCommand === "claude"}
          detail={setupDetail("claude", claudeStatus)}
          onCopy={copyCommand}
          status={claudeStatus}
        />
        <AgentSetupRow
          agent="Codex"
          command="codex"
          copied={copiedCommand === "codex"}
          detail={setupDetail("codex", codexStatus)}
          onCopy={copyCommand}
          secondaryCommand="/hooks"
          secondaryCopied={copiedCommand === "/hooks"}
          status={codexStatus}
        />

        <p className="agent-context-menu-footnote">
          Only the acknowledged Canvas or Editor selection is offered to the
          next agent turn. Clear the selection to stop sharing context.
        </p>

        <AgentLaunchFooter
          onLaunch={(agent) => launchAgentSession(agent, projectId)}
        />
      </MenuContent>
    </Menu>
  );
}

function AgentSetupRow({
  agent,
  command,
  copied,
  detail,
  onCopy,
  secondaryCommand,
  secondaryCopied = false,
  status,
}: {
  agent: "Claude" | "Codex";
  command: string;
  copied: boolean;
  detail: string;
  onCopy: (command: string) => Promise<void>;
  secondaryCommand?: string;
  secondaryCopied?: boolean;
  status: {
    label: string;
    tone: "attention" | "muted" | "ready" | "stale";
  };
}) {
  return (
    <section className="agent-setup-row" aria-label={`${agent} setup`}>
      <div className="agent-setup-row-heading">
        <strong>{agent}</strong>
        <span className={`agent-setup-status is-${status.tone}`}>
          <span aria-hidden="true" />
          {status.label}
        </span>
      </div>
      <p>{detail}</p>
      <div className="agent-setup-commands">
        <MenuItem
          aria-label={`Copy ${command}`}
          className="agent-setup-command"
          onSelect={(event) => {
            event.preventDefault();
            void onCopy(command);
          }}
        >
          <code>{command}</code>
          {copied ? (
            <Check aria-hidden="true" size={14} />
          ) : (
            <Copy aria-hidden="true" size={14} />
          )}
          <span className="sr-only" aria-live="polite">
            {copied ? `${command} copied` : ""}
          </span>
        </MenuItem>
        {secondaryCommand ? (
          <MenuItem
            aria-label={`Copy Codex ${secondaryCommand} command`}
            className="agent-setup-command"
            onSelect={(event) => {
              event.preventDefault();
              void onCopy(secondaryCommand);
            }}
          >
            <code>{secondaryCommand}</code>
            {secondaryCopied ? (
              <Check aria-hidden="true" size={14} />
            ) : (
              <Copy aria-hidden="true" size={14} />
            )}
            <span className="sr-only" aria-live="polite">
              {secondaryCopied ? `${secondaryCommand} copied` : ""}
            </span>
          </MenuItem>
        ) : null}
      </div>
    </section>
  );
}
