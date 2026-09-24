"use client";

import {
  AlertCircle,
  Check,
  ChevronDown,
  CircleStop,
  Loader2,
  MessageCircleQuestion,
  RotateCw,
  Sparkles,
} from "lucide-react";
import {
  type CSSProperties,
  forwardRef,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  agentActivityFailureKey,
  type AgentActivityFailure,
  type AgentActivityItem,
  agentActivityStatusPresentation,
  type AgentActivityLifecycleEvent,
  type AgentActivityStatusPresentation,
} from "@/app/projects/[id]/agent-activity-state";
import type {
  AgentInputAnswer,
  AgentInteractionRecord,
} from "@/lib/agent-interaction-types";

export type { AgentActivityFailure, AgentActivityItem } from "@/app/projects/[id]/agent-activity-state";

const RESOLVED_TRANSITION_MS = 1200;

function initialStatusPresentation(
  event: AgentActivityLifecycleEvent,
): AgentActivityStatusPresentation {
  if (event.kind === "completed" || event.kind === "reconnected") {
    return agentActivityStatusPresentation({
      id: "idle",
      kind: "idle",
      label: "Agent idle",
    });
  }
  return agentActivityStatusPresentation(event);
}

export function useAgentActivityStatus(
  event: AgentActivityLifecycleEvent,
) {
  const eventKey = `${event.kind}:${event.id}`;
  const previousEventKeyRef = useRef(eventKey);
  const transientEventKeyRef = useRef<string | null>(null);
  const resolvedTimerRef = useRef<number | null>(null);
  const [documentVisible, setDocumentVisible] = useState(true);
  const [presentation, setPresentation] = useState(() =>
    initialStatusPresentation(event),
  );

  useEffect(() => {
    const onVisibilityChange = () =>
      setDocumentVisible(document.visibilityState === "visible");
    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (event.kind === "reconnected") {
      if (eventKey === transientEventKeyRef.current) return;
      transientEventKeyRef.current = eventKey;
      if (resolvedTimerRef.current !== null) {
        window.clearTimeout(resolvedTimerRef.current);
      }
      setPresentation(agentActivityStatusPresentation(event));
      resolvedTimerRef.current = window.setTimeout(() => {
        resolvedTimerRef.current = null;
        setPresentation(
          agentActivityStatusPresentation({
            id: "idle",
            kind: "idle",
            label: "Agent idle",
          }),
        );
      }, RESOLVED_TRANSITION_MS);
      return;
    }
    transientEventKeyRef.current = null;
    if (eventKey === previousEventKeyRef.current) return;
    previousEventKeyRef.current = eventKey;
    if (resolvedTimerRef.current !== null) {
      window.clearTimeout(resolvedTimerRef.current);
      resolvedTimerRef.current = null;
    }
    setPresentation(agentActivityStatusPresentation(event));
    if (event.kind === "completed") {
      resolvedTimerRef.current = window.setTimeout(() => {
        resolvedTimerRef.current = null;
        setPresentation(
          agentActivityStatusPresentation({
            id: "idle",
            kind: "idle",
            label: "Agent idle",
          }),
        );
      }, RESOLVED_TRANSITION_MS);
    }
  }, [event, eventKey]);

  useEffect(
    () => () => {
      if (resolvedTimerRef.current !== null) {
        window.clearTimeout(resolvedTimerRef.current);
      }
    },
    [],
  );

  return {
    documentVisible,
    presentation,
  };
}

export const AgentActivityStatusButton = forwardRef<
  HTMLButtonElement,
  {
    compact?: boolean;
    controlsId?: string;
    event: AgentActivityLifecycleEvent;
    expanded: boolean;
    onOpenActivity: () => void;
    preview?: boolean;
    projectName?: string;
  }
>(function AgentActivityStatusButton(
  {
    compact = false,
    controlsId = "agent-activity-surface",
    event,
    expanded,
    onOpenActivity,
    preview = false,
    projectName,
  },
  ref,
) {
  const { documentVisible, presentation } = useAgentActivityStatus(event);
  const urgent =
    presentation.state === "awaiting" ||
    presentation.state === "disconnected" ||
    presentation.state === "failed";
  if (compact && presentation.state === "idle") return null;

  return (
    <button
      ref={ref}
      aria-controls={controlsId || undefined}
      aria-expanded={expanded}
      aria-label={`${projectName ? `${projectName}: ` : ""}${presentation.label}${preview ? " preview" : ""}. Open Agent Activity.`}
      className={`agent-activity-status-button is-${presentation.state}${
        compact ? " is-project-tab" : ""
      }`}
      data-motion={documentVisible ? "running" : "paused"}
      data-state={presentation.state}
      onClick={onOpenActivity}
      title={
        projectName
          ? `${projectName}: ${presentation.label}${preview ? " preview" : ""}. Open Agent Activity.`
          : presentation.title
      }
      type="button"
    >
      <span className="agent-activity-dot-grid" aria-hidden="true">
        {Array.from({ length: 9 }, (_, index) => {
          const row = Math.floor(index / 3);
          const column = index % 3;
          return (
            <span
              className="agent-activity-dot"
              key={index}
              style={
                {
                  "--agent-dot-order": row + column,
                } as CSSProperties
              }
            />
          );
        })}
      </span>
      {urgent ? <span className="sr-only">Attention required.</span> : null}
      <span className="sr-only" role="status" aria-live="polite">
        {presentation.label}
      </span>
    </button>
  );
});

export function AgentActivityOverlay({
  acknowledgedFailureIds,
  canStop,
  error,
  interaction,
  isRunning,
  isStopping,
  items,
  onAcknowledge,
  onOpenQuestion,
  onResolveInteraction,
  onReconnect,
  onStop,
  onOpenChange,
  open,
  question,
  stopped,
}: {
  acknowledgedFailureIds: ReadonlySet<string>;
  canStop: boolean;
  error: AgentActivityFailure | null;
  interaction: AgentInteractionRecord | null;
  isRunning: boolean;
  isStopping: boolean;
  items: AgentActivityItem[];
  onAcknowledge: (failureId: string) => void;
  onOpenQuestion: () => void;
  onResolveInteraction: (
    request: AgentInteractionRecord,
    resolution:
      | { answer: AgentInputAnswer; kind: "input" }
      | {
          decision: { approved: boolean; note?: string | null };
          kind: "approval";
        },
  ) => Promise<void>;
  onReconnect: () => void;
  onStop: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  question: string | null;
  stopped: boolean;
}) {
  const [answerText, setAnswerText] = useState("");
  const [resolvingInteraction, setResolvingInteraction] = useState(false);
  const itemFailure = items.find(
    (item) =>
      item.status === "error" &&
      !acknowledgedFailureIds.has(agentActivityFailureKey(item)),
  );
  const globalError =
    error && !acknowledgedFailureIds.has(agentActivityFailureKey(error))
      ? error
      : null;
  const visibleError = globalError ?? (
    itemFailure
      ? {
          canReconnect: Boolean(itemFailure.canReconnect),
          code: itemFailure.code,
          message: itemFailure.detail || itemFailure.label,
          remediation: itemFailure.remediation,
        }
      : null
  );
  const awaitingInteraction =
    interaction?.status === "awaiting" ? interaction : null;
  const questionText = awaitingInteraction?.question ?? question;
  const hasAcknowledgedErrorHistory =
    !visibleError && items.some((item) => item.status === "error");
  const hasCompletedWork = items.some((item) => item.status === "completed");

  const state = questionText
    ? "question"
    : visibleError
      ? "error"
      : isRunning || isStopping
        ? "running"
        : stopped
          ? "stopped"
          : hasCompletedWork
            ? "completed"
            : "idle";
  const label = questionText
    ? awaitingInteraction?.kind === "approval"
      ? "Approval required"
      : "Question waiting"
    : visibleError
      ? "Needs attention"
      : isStopping
        ? "Stopping agent"
        : isRunning
          ? "Agent working"
          : stopped
            ? "Agent stopped"
            : hasAcknowledgedErrorHistory
              ? "Error acknowledged"
              : hasCompletedWork
              ? "Work completed"
              : "Ready";

  return (
    <aside
      id="agent-activity-surface"
      className={`agent-activity is-${state} ${open ? "is-expanded" : ""}`}
      aria-label="Agent activity"
      aria-hidden={!open}
      data-state={state}
      hidden={!open}
    >
      <button
        type="button"
        className="agent-activity-summary"
        aria-controls="agent-activity-details"
        aria-expanded={open}
        onClick={() => onOpenChange(false)}
      >
        <span className="agent-activity-state-icon" aria-hidden="true">
          {state === "running" ? (
            <Loader2 className="agent-activity-spinner" size={15} />
          ) : state === "error" ? (
            <AlertCircle size={15} />
          ) : state === "question" ? (
            <MessageCircleQuestion size={15} />
          ) : state === "stopped" ? (
            <CircleStop size={15} />
          ) : state === "idle" ? (
            <Sparkles size={15} />
          ) : (
            <Check size={15} />
          )}
        </span>
        <span className="agent-activity-summary-copy">
          <strong>Agent Activity</strong>
          <span role="status" aria-live="polite">
            {label}
          </span>
        </span>
        {visibleError ? (
          <span className="agent-activity-attention">Attention</span>
        ) : null}
        <ChevronDown className="agent-activity-chevron" size={15} aria-hidden="true" />
      </button>

      <div id="agent-activity-details" className="agent-activity-details">
        {questionText ? (
          <div className="agent-activity-callout is-question">
            <MessageCircleQuestion size={15} aria-hidden="true" />
            <span>{questionText}</span>
          </div>
        ) : null}
        {visibleError ? (
          <div className="agent-activity-callout is-error" role="alert">
            <AlertCircle size={15} aria-hidden="true" />
            <span>
              {visibleError.code ? (
                <strong>{visibleError.code.replaceAll("_", " ")}: </strong>
              ) : null}
              {visibleError.message}
              {visibleError.remediation ? (
                <span className="agent-activity-remediation">
                  {visibleError.remediation}
                </span>
              ) : null}
            </span>
          </div>
        ) : null}

        {awaitingInteraction?.kind === "input" &&
        awaitingInteraction.choices.length ? (
          <div
            className="agent-activity-choice-list"
            aria-label="Available answers"
          >
            {awaitingInteraction.choices.map((choice) => (
              <button
                className="agent-activity-button"
                disabled={resolvingInteraction}
                key={choice.id}
                onClick={() => {
                  setResolvingInteraction(true);
                  void onResolveInteraction(awaitingInteraction, {
                    answer: { choiceId: choice.id, value: choice.value },
                    kind: "input",
                  }).finally(() => setResolvingInteraction(false));
                }}
                type="button"
              >
                {choice.label}
              </button>
            ))}
          </div>
        ) : null}
        {awaitingInteraction?.kind === "input" &&
        !awaitingInteraction.choices.length ? (
          <form
            className="agent-activity-answer-form"
            onSubmit={(event) => {
              event.preventDefault();
              const value = answerText.trim();
              if (!value) return;
              setResolvingInteraction(true);
              void onResolveInteraction(awaitingInteraction, {
                answer: { value },
                kind: "input",
              })
                .then(() => setAnswerText(""))
                .finally(() => setResolvingInteraction(false));
            }}
          >
            <label>
              <span className="sr-only">Your answer</span>
              <input
                disabled={resolvingInteraction}
                onChange={(event) => setAnswerText(event.target.value)}
                placeholder="Type an answer"
                value={answerText}
              />
            </label>
            <button
              className="agent-activity-button is-primary"
              disabled={!answerText.trim() || resolvingInteraction}
              type="submit"
            >
              Answer
            </button>
          </form>
        ) : null}
        {awaitingInteraction?.kind === "approval" ? (
          <div className="agent-activity-approval">
            <dl>
              <div>
                <dt>Command</dt>
                <dd>{awaitingInteraction.proposedCommand}</dd>
              </div>
              {awaitingInteraction.permissions.length ? (
                <div>
                  <dt>Permissions</dt>
                  <dd>{awaitingInteraction.permissions.join(", ")}</dd>
                </div>
              ) : null}
              {awaitingInteraction.estimatedCostUsd !== null ? (
                <div>
                  <dt>Estimated cost</dt>
                  <dd>${awaitingInteraction.estimatedCostUsd.toFixed(2)}</dd>
                </div>
              ) : null}
              {awaitingInteraction.destructive ? (
                <div>
                  <dt>Risk</dt>
                  <dd>Destructive action</dd>
                </div>
              ) : null}
            </dl>
            <div className="agent-activity-actions">
              <button
                className="agent-activity-button"
                disabled={resolvingInteraction}
                onClick={() => {
                  setResolvingInteraction(true);
                  void onResolveInteraction(awaitingInteraction, {
                    decision: { approved: false },
                    kind: "approval",
                  }).finally(() => setResolvingInteraction(false));
                }}
                type="button"
              >
                Deny
              </button>
              <button
                className="agent-activity-button is-primary"
                disabled={resolvingInteraction}
                onClick={() => {
                  setResolvingInteraction(true);
                  void onResolveInteraction(awaitingInteraction, {
                    decision: { approved: true },
                    kind: "approval",
                  }).finally(() => setResolvingInteraction(false));
                }}
                type="button"
              >
                Approve
              </button>
            </div>
          </div>
        ) : null}

        {items.length ? (
          <ol className="agent-activity-list" aria-label="Recent agent work">
            {items.slice(0, 4).map((item) => (
              <li key={item.id} className={`is-${item.status}`}>
                <span className="agent-activity-item-icon" aria-hidden="true">
                  {item.status === "running" ? (
                    <Loader2 className="agent-activity-spinner" size={13} />
                  ) : item.status === "error" ? (
                    <AlertCircle size={13} />
                  ) : (
                    <Check size={13} />
                  )}
                </span>
                <span title={item.label}>{item.label}</span>
              </li>
            ))}
          </ol>
        ) : !questionText && !visibleError ? (
          <p className="agent-activity-empty">
            <Sparkles size={14} aria-hidden="true" />
            The canvas is ready.
          </p>
        ) : null}

        {questionText || isRunning || isStopping || visibleError || stopped ? (
          <div className="agent-activity-actions">
            {question && !awaitingInteraction ? (
              <button type="button" className="agent-activity-button is-primary" onClick={onOpenQuestion}>
                Answer
              </button>
            ) : null}
            {canStop && (isRunning || isStopping) ? (
              <button
                type="button"
                className="agent-activity-button"
                disabled={isStopping}
                onClick={onStop}
              >
                <CircleStop size={13} aria-hidden="true" />
                {isStopping ? "Stopping…" : "Stop"}
              </button>
            ) : null}
            {visibleError?.canReconnect ? (
              <button type="button" className="agent-activity-button" onClick={onReconnect}>
                <RotateCw size={13} aria-hidden="true" />
                Reconnect
              </button>
            ) : null}
            {visibleError ? (
              <button
                className="agent-activity-button"
                onClick={() =>
                  onAcknowledge(
                    agentActivityFailureKey(globalError ?? itemFailure!),
                  )
                }
                type="button"
              >
                Acknowledge
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
