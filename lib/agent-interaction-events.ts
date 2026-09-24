import { EventEmitter } from "node:events";
import type {
  AgentInteractionEvent,
  AgentInteractionRecord,
} from "@/lib/agent-interaction-types";

export type { AgentInteractionEvent } from "@/lib/agent-interaction-types";

type AgentInteractionEventBus = EventEmitter & {
  emit(event: "project", payload: AgentInteractionEvent): boolean;
  off(
    event: "project",
    listener: (payload: AgentInteractionEvent) => void,
  ): AgentInteractionEventBus;
  on(
    event: "project",
    listener: (payload: AgentInteractionEvent) => void,
  ): AgentInteractionEventBus;
};

const globalForAgentInteractions = globalThis as typeof globalThis & {
  __videoFsAgentInteractionEventBus?: AgentInteractionEventBus;
};

export const agentInteractionEventBus =
  globalForAgentInteractions.__videoFsAgentInteractionEventBus ??
  (new EventEmitter() as AgentInteractionEventBus);

agentInteractionEventBus.setMaxListeners(100);
globalForAgentInteractions.__videoFsAgentInteractionEventBus =
  agentInteractionEventBus;

export function publishAgentInteractionEvent(
  kind: AgentInteractionEvent["kind"],
  request: AgentInteractionRecord,
) {
  agentInteractionEventBus.emit("project", {
    at: new Date().toISOString(),
    kind,
    projectId: request.projectId,
    request,
  });
}
