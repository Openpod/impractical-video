import { describe, expect, it } from "vitest";
import {
  agentActivityLifecycleEvent,
  agentActivityStatusPresentation,
  activityFromEditorEvent,
  activityFromPaperEvent,
  activityFromToolReceipt,
  classifyActivityFailure,
  failedActivitiesFromOperationFiles,
} from "@/app/projects/[id]/agent-activity-state";

function operation(status: "failed" | "running" | "succeeded", result: unknown) {
  return [
    "---",
    JSON.stringify({
      id: "op_asset_opening",
      kind: "generate_image",
      status,
      type: "operation",
    }),
    "---",
    "# Opening frame",
    "",
    "## Result",
    "",
    "```json",
    JSON.stringify(result, null, 2),
    "```",
    "",
  ].join("\n");
}

describe("agent activity receipts", () => {
  it("uses a durable failed operation instead of calling settled work complete", () => {
    const item = activityFromPaperEvent(
      {
        artifactId: "kf_opening",
        kind: "settled",
        paths: [
          "keyframes/kf_opening.md",
          "operations/op_asset_opening.operation.md",
        ],
        title: "Opening frame",
        tool: "generate_image",
      },
      [
        {
          content: operation("failed", {
            error: "FAL_KEY is not configured.",
            ok: false,
          }),
          path: "operations/op_asset_opening.operation.md",
        },
      ],
    );

    expect(item.status).toBe("error");
    expect(item.canReconnect).toBe(false);
    expect(item.detail).toBe(
      "FAL_KEY is not configured.",
    );
    expect(item.remediation).toBe(
      "Open Account → API keys, save your fal.ai key, and try again.",
    );
  });

  it("marks work complete only from a successful durable receipt", () => {
    const item = activityFromPaperEvent(
      {
        artifactId: "kf_opening",
        kind: "settled",
        paths: ["operations/op_asset_opening.operation.md"],
        title: "Opening frame",
        tool: "generate_image",
      },
      [
        {
          content: operation("succeeded", { ok: true, url: "https://example.invalid/frame.png" }),
          path: "operations/op_asset_opening.operation.md",
        },
      ],
    );

    expect(item.status).toBe("completed");
  });

  it("treats an unverified settled event as an error", () => {
    const item = activityFromPaperEvent({
      artifactId: "kf_opening",
      kind: "settled",
      paths: ["operations/op_asset_opening.operation.md"],
      title: "Opening frame",
      tool: "generate_image",
    });

    expect(item.status).toBe("error");
    expect(item.detail).toContain("without a valid terminal receipt");
  });

  it("uses tool ok:false receipts as terminal errors", () => {
    const item = activityFromToolReceipt({
      id: "chat:call-1",
      label: "Generate opening frame",
      output: { error: "FAL_KEY is not configured.", ok: false },
    });

    expect(item.status).toBe("error");
    expect(item.canReconnect).toBe(false);
  });

  it("offers reconnect only for connection failures", () => {
    expect(classifyActivityFailure("Desktop app is unavailable.").canReconnect).toBe(true);
    expect(classifyActivityFailure("FAL_KEY is not configured.").canReconnect).toBe(false);
  });

  it("hydrates unresolved failures after relaunch without hydrating successes", () => {
    const items = failedActivitiesFromOperationFiles([
      {
        content: operation("succeeded", { ok: true }),
        path: "operations/op_success.operation.md",
      },
      {
        content: operation("failed", {
          error: "FAL_KEY is not configured.",
          ok: false,
        }),
        path: "operations/op_failed.operation.md",
      },
      {
        content: "# unrelated",
        path: "brief.md",
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      canReconnect: false,
      label: "Opening frame",
      status: "error",
    });
    expect(items[0]?.remediation).toContain("Account → API keys");
  });

  it("hydrates transport failures with reconnect enabled", () => {
    const items = failedActivitiesFromOperationFiles([
      {
        content: operation("failed", {
          error: "Desktop app is unavailable.",
          ok: false,
        }),
        path: "operations/op_transport.operation.md",
      },
    ]);

    expect(items[0]?.canReconnect).toBe(true);
    expect(items[0]?.remediation).toContain("Open or reconnect Video FS");
  });
});

describe("agent activity lifecycle adapter", () => {
  const base = {
    approvalRequired: false,
    connection: "connected" as const,
    error: null,
    isRunning: false,
    isStopping: false,
    items: [],
    question: null,
    reconnectedKey: null,
    stopped: false,
  };

  it("maps accepted and progress events to active work", () => {
    expect(
      agentActivityLifecycleEvent({ ...base, isRunning: true }),
    ).toMatchObject({ kind: "accepted", label: "Agent working" });
    expect(
      agentActivityLifecycleEvent({
        ...base,
        isRunning: true,
        items: [{ id: "tool-1", label: "Create scene", status: "running" }],
      }),
    ).toMatchObject({ kind: "progress", label: "Agent working" });
  });

  it("adapts Editor accepted, completed, and failed receipts", () => {
    expect(
      activityFromEditorEvent({
        command: "editor_timeline_insert",
        commandId: "cmd-1",
        kind: "editor.command.accepted",
      }),
    ).toMatchObject({
      id: "editor:cmd-1",
      label: "Insert",
      status: "running",
    });
    expect(
      activityFromEditorEvent({
        command: "editor_timeline_insert",
        commandId: "cmd-1",
        kind: "editor.command.completed",
      }),
    ).toMatchObject({ status: "completed" });
    expect(
      activityFromEditorEvent({
        command: "editor_timeline_insert",
        commandId: "cmd-1",
        error: {
          code: "EDITOR_REVISION_CONFLICT",
          message: "The Editor changed before this command was applied.",
          remediation: "Read the timeline again and retry with the new revision.",
        },
        kind: "editor.command.failed",
      }),
    ).toMatchObject({
      canReconnect: false,
      code: "EDITOR_REVISION_CONFLICT",
      detail: "The Editor changed before this command was applied.",
      remediation: "Read the timeline again and retry with the new revision.",
      status: "error",
    });
  });

  it("maps questions and approvals to the same awaiting treatment", () => {
    const question = agentActivityLifecycleEvent({
      ...base,
      question: "Which take should lead?",
    });
    const approval = agentActivityLifecycleEvent({
      ...base,
      approvalRequired: true,
      question: "Approve this change?",
    });

    expect(question.kind).toBe("question");
    expect(approval.kind).toBe("approval");
    expect(agentActivityStatusPresentation(question).state).toBe("awaiting");
    expect(agentActivityStatusPresentation(approval).state).toBe("awaiting");
  });

  it("keeps provider failures distinct from transport disconnects", () => {
    const failed = agentActivityLifecycleEvent({
      ...base,
      error: {
        canReconnect: false,
        message: "FAL_KEY is not configured.",
      },
    });
    const disconnected = agentActivityLifecycleEvent({
      ...base,
      connection: "disconnected",
    });

    expect(failed.kind).toBe("failed");
    expect(agentActivityStatusPresentation(failed).state).toBe("failed");
    expect(disconnected.kind).toBe("disconnected");
    expect(agentActivityStatusPresentation(disconnected).state).toBe(
      "disconnected",
    );
  });

  it("maps explicit completion, cancellation, and reconnection receipts", () => {
    expect(
      agentActivityLifecycleEvent({
        ...base,
        items: [{ id: "done-1", label: "Created scene", status: "completed" }],
      }).kind,
    ).toBe("completed");
    expect(
      agentActivityLifecycleEvent({ ...base, stopped: true }).kind,
    ).toBe("cancelled");
    expect(
      agentActivityLifecycleEvent({
        ...base,
        reconnectedKey: "connection-2",
      }).kind,
    ).toBe("reconnected");
  });
});
