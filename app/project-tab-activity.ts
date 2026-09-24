import type {
  AgentActivityItem,
  AgentActivityLifecycleEvent,
} from "@/app/projects/[id]/agent-activity-state";
import type { AgentInteractionEvent } from "@/lib/agent-interaction-types";

export const PROJECT_TAB_ACTIVITY_STORAGE_KEY =
  "video-fs-desktop-project-tab-activity-v1";
export const OPEN_PROJECT_ACTIVITY_STORAGE_KEY =
  "video-fs-desktop-open-project-activity-v1";

export type ProjectTabActivityMap = Record<
  string,
  AgentActivityLifecycleEvent
>;

export type ProjectTabActivityEnvelope = {
  event: AgentActivityLifecycleEvent;
  projectId: string;
};

/** Maps a paper/editor activity item to the lifecycle shape the tab and
 * companion indicators render. */
export function lifecycleFromActivityItem(
  item: AgentActivityItem,
): AgentActivityLifecycleEvent {
  if (item.status === "running") {
    return { id: item.id, kind: "progress", label: "Agent working" };
  }
  if (item.status === "error") {
    return {
      id: item.id,
      kind: item.canReconnect ? "disconnected" : "failed",
      label: item.canReconnect
        ? "Agent disconnected"
        : "Agent needs attention",
    };
  }
  return { id: item.id, kind: "completed", label: "Work completed" };
}

export function projectTabLifecycleForDisplay(
  event: AgentActivityLifecycleEvent | undefined,
  projectId: string,
  preview: boolean,
): AgentActivityLifecycleEvent | undefined {
  if (!preview) return event;
  return {
    id: `ui-preview:${projectId}`,
    kind: "progress",
    label: "Agent working",
  };
}

export function isVisibleProjectTabActivity(
  event: AgentActivityLifecycleEvent | undefined,
) {
  return Boolean(event && event.kind !== "idle" && event.kind !== "cancelled");
}

export function readProjectTabActivityMap(
  value: string | null | undefined,
): ProjectTabActivityMap {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, AgentActivityLifecycleEvent] => {
          const event = entry[1] as Partial<AgentActivityLifecycleEvent> | null;
          return Boolean(
            entry[0] &&
              event &&
              typeof event.id === "string" &&
              typeof event.kind === "string" &&
              typeof event.label === "string",
          );
        },
      ),
    );
  } catch {
    return {};
  }
}

export function reconcileProjectTabActivityMap(
  activity: ProjectTabActivityMap,
  openProjectIds: readonly string[],
) {
  const open = new Set(openProjectIds);
  return Object.fromEntries(
    Object.entries(activity).filter(([projectId]) => open.has(projectId)),
  );
}

export function lifecycleFromAgentInteraction(
  event: AgentInteractionEvent,
): AgentActivityLifecycleEvent {
  if (event.request.status === "awaiting") {
    return {
      id: `interaction:${event.request.id}`,
      kind: event.request.kind === "approval" ? "approval" : "question",
      label:
        event.request.kind === "approval"
          ? "Approval required"
          : "Question waiting",
    };
  }
  if (event.request.status === "expired") {
    return {
      id: `interaction:${event.request.id}`,
      kind: "failed",
      label: "Agent needs attention",
    };
  }
  return {
    id: `interaction:${event.request.id}`,
    kind: "completed",
    label:
      event.request.kind === "approval"
        ? "Approval resolved"
        : "Input received",
  };
}
