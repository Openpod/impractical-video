import { EventEmitter } from "node:events";

export type AgentContextProjectEvent =
  | {
      at: string;
      clearEpoch: number;
      contextRevision: number;
      kind: "agent_context.changed" | "agent_context.cleared";
      projectId: string;
      visibleCount: number;
      windowId: string;
    }
  | {
      agent: "claude" | "codex";
      agentSessionId: string;
      at: string;
      contextRevision: number;
      kind: "agent_context.turn_snapshot";
      projectId: string;
      snapshotId: string;
    }
  | {
      at: string;
      attachmentId: string;
      kind: "attachment.processing" | "attachment.ready" | "attachment.failed";
      projectId: string;
      sha256?: string;
    };

type AgentContextProjectEventInput =
  AgentContextProjectEvent extends infer Event
    ? Event extends { at: string }
      ? Omit<Event, "at"> & { at?: string }
      : never
    : never;

type AgentContextEventBus = EventEmitter & {
  emit(event: "project", payload: AgentContextProjectEvent): boolean;
  off(
    event: "project",
    listener: (payload: AgentContextProjectEvent) => void,
  ): AgentContextEventBus;
  on(
    event: "project",
    listener: (payload: AgentContextProjectEvent) => void,
  ): AgentContextEventBus;
};

const globalForAgentContext = globalThis as typeof globalThis & {
  __videoFsAgentContextEventBus?: AgentContextEventBus;
};

export const agentContextEventBus =
  globalForAgentContext.__videoFsAgentContextEventBus ??
  (new EventEmitter() as AgentContextEventBus);

agentContextEventBus.setMaxListeners(100);
globalForAgentContext.__videoFsAgentContextEventBus = agentContextEventBus;

export function publishAgentContextEvent(
  event: AgentContextProjectEventInput,
) {
  agentContextEventBus.emit("project", {
    ...event,
    at: event.at ?? new Date().toISOString(),
  } as AgentContextProjectEvent);
}
