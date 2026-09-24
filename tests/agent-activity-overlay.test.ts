import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AgentActivityOverlay,
  AgentActivityStatusButton,
} from "@/app/projects/[id]/agent-activity-overlay";
import type {
  AgentActivityFailure,
  AgentActivityItem,
  AgentActivityLifecycleEvent,
} from "@/app/projects/[id]/agent-activity-state";
import type { AgentInteractionRecord } from "@/lib/agent-interaction-types";

const noop = () => undefined;

function render(overrides: {
  acknowledgedFailureIds?: ReadonlySet<string>;
  error?: string | null;
  isRunning?: boolean;
  isStopping?: boolean;
  items?: AgentActivityItem[];
  interaction?: AgentInteractionRecord | null;
  question?: string | null;
  stopped?: boolean;
  canStop?: boolean;
  open?: boolean;
} = {}) {
  return renderToStaticMarkup(
    createElement(AgentActivityOverlay, {
      acknowledgedFailureIds:
        overrides.acknowledgedFailureIds ?? new Set<string>(),
      canStop: overrides.canStop ?? true,
      error: overrides.error
        ? ({ canReconnect: true, message: overrides.error } satisfies AgentActivityFailure)
        : null,
      interaction: overrides.interaction ?? null,
      isRunning: overrides.isRunning ?? false,
      isStopping: overrides.isStopping ?? false,
      items: overrides.items ?? [],
      onAcknowledge: noop,
      onOpenQuestion: noop,
      onOpenChange: noop,
      onReconnect: noop,
      onResolveInteraction: async () => undefined,
      onStop: noop,
      open: overrides.open ?? false,
      question: overrides.question ?? null,
      stopped: overrides.stopped ?? false,
    }),
  );
}

function renderStatus(event: AgentActivityLifecycleEvent) {
  return renderToStaticMarkup(
    createElement(AgentActivityStatusButton, {
      event,
      expanded: false,
      onOpenActivity: noop,
    }),
  );
}

describe("AgentActivityOverlay", () => {
  it("keeps a passive empty-state entry point in the rendered shell", () => {
    const html = renderStatus({
      id: "idle",
      kind: "idle",
      label: "Agent idle",
    });

    expect(html).toContain("Agent idle. Open Agent Activity.");
    expect(html).toContain('data-state="idle"');
    expect(html.match(/agent-activity-dot"/g)).toHaveLength(9);
  });

  it("exposes running work and a stop action", () => {
    const html = render({
      isRunning: true,
      items: [{ id: "run-1", label: "Generating opening frame", status: "running" }],
    });

    expect(html).toContain("Agent working");
    expect(html).toContain("Generating opening frame");
    expect(html).toContain(">Stop<");
    expect(html).toContain('aria-live="polite"');
  });

  it.each([
    ["progress", "active", "Agent working"],
    ["question", "awaiting", "Question waiting"],
    ["approval", "awaiting", "Approval required"],
    ["failed", "failed", "Agent needs attention"],
    ["disconnected", "disconnected", "Agent disconnected"],
  ] as const)("renders %s as a truthful %s dot state", (kind, state, label) => {
    const html = renderStatus({
      id: `state:${kind}`,
      kind,
      label,
    });

    expect(html).toContain(`data-state="${state}"`);
    expect(html).toContain(label);
    expect(html).not.toContain("Agent sees");
  });

  it("keeps completed work available in a collapsed summary", () => {
    const html = render({
      items: [{ id: "done-1", label: "Created scene", status: "completed" }],
    });

    expect(html).toContain("Work completed");
    expect(html).toContain("Created scene");
    expect(html).toContain('aria-expanded="false"');
  });

  it("makes errors recoverable without hiding the message", () => {
    const html = render({ error: "Desktop connection was interrupted." });

    expect(html).toContain("Needs attention");
    expect(html).toContain("Desktop connection was interrupted.");
    expect(html).toContain(">Reconnect<");
    expect(html).toContain(">Attention<");
    expect(html).toContain('role="alert"');
  });

  it("does not offer reconnect for provider configuration failures", () => {
    const html = render({
      items: [
        {
          canReconnect: false,
          code: "FAL_KEY_NOT_CONFIGURED",
          detail: "FAL_KEY is not configured.",
          id: "provider-failure",
          label: "Generate opening frame",
          remediation:
            "Configure FAL_KEY, relaunch Video FS, and try again.",
          status: "error",
        },
      ],
    });

    expect(html).toContain("FAL_KEY is not configured");
    expect(html).toContain(">Attention<");
    expect(html).not.toContain(">Reconnect<");
    expect(html).not.toContain("Work completed");
  });

  it("renders stopped work without inventing a reconnect action", () => {
    const html = render({ stopped: true });

    expect(html).toContain("Agent stopped");
    expect(html).not.toContain(">Reconnect<");
  });

  it("announces questions and offers a direct answer action", () => {
    const html = render({ question: "Which keyframe should lead the sequence?" });

    expect(html).toContain("Question waiting");
    expect(html).toContain("Which keyframe should lead the sequence?");
    expect(html).toContain(">Answer<");
  });

  it("renders a durable typed input request without chat state", () => {
    const html = render({
      interaction: {
        actor: { id: "codex-turn", type: "agent" },
        answer: null,
        choices: [
          { id: "opening", label: "Opening frame", value: "kf_opening" },
        ],
        createdAt: "2026-07-25T12:00:00.000Z",
        expiresAt: "2026-07-25T12:05:00.000Z",
        id: "input-1",
        kind: "input",
        originatingCommand: "editor_timeline_insert",
        projectId: "project",
        question: "Which frame should lead?",
        resolvedAt: null,
        schema: "video-fs.agent-interaction",
        schemaVersion: 1,
        status: "awaiting",
      },
    });

    expect(html).toContain("Question waiting");
    expect(html).toContain("Which frame should lead?");
    expect(html).toContain(">Opening frame<");
    expect(html).not.toContain("Open chat");
  });

  it("shows approval scope and defaults without exposing a payload", () => {
    const html = render({
      interaction: {
        actor: { id: "claude-turn", type: "agent" },
        createdAt: "2026-07-25T12:00:00.000Z",
        decision: null,
        destructive: true,
        estimatedCostUsd: 0.75,
        expiresAt: "2026-07-25T12:05:00.000Z",
        id: "approval-1",
        kind: "approval",
        originatingCommand: "media.image.generate",
        payloadHash: "d".repeat(64),
        permissions: ["provider.generate"],
        projectId: "project",
        proposedCommand: "media.image.generate",
        question: "Generate the selected frame?",
        resolvedAt: null,
        schema: "video-fs.agent-interaction",
        schemaVersion: 1,
        status: "awaiting",
      },
    });

    expect(html).toContain("Approval required");
    expect(html).toContain("media.image.generate");
    expect(html).toContain("provider.generate");
    expect(html).toContain("Destructive action");
    expect(html).toContain(">Deny<");
    expect(html).toContain(">Approve<");
    expect(html).not.toContain("dddddddddddddddd");
  });

  it("keeps durable error history visible while exposing Acknowledge", () => {
    const html = render({
      items: [
        {
          code: "EDITOR_REVISION_CONFLICT",
          detail: "The Editor changed before this command was applied.",
          id: "editor:cmd-1",
          label: "Move",
          remediation: "Read the timeline again and retry.",
          status: "error",
        },
      ],
    });

    expect(html).toContain("EDITOR REVISION CONFLICT");
    expect(html).toContain("Read the timeline again and retry.");
    expect(html).toContain(">Acknowledge<");
    expect(html).toContain("Move");
  });

  it("clears global attention after acknowledgement without deleting history", () => {
    const html = render({
      acknowledgedFailureIds: new Set(["item:editor:cmd-1"]),
      items: [
        {
          detail: "The Editor changed.",
          id: "editor:cmd-1",
          label: "Move",
          status: "error",
        },
      ],
    });

    expect(html).not.toContain(">Attention<");
    expect(html).not.toContain(">Acknowledge<");
    expect(html).toContain("Move");
  });
});
