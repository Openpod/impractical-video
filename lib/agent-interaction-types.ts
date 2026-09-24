export const AGENT_INTERACTION_SCHEMA = "video-fs.agent-interaction";
export const AGENT_INTERACTION_SCHEMA_VERSION = 1;

export type AgentInteractionActor = {
  id: string;
  type: "agent" | "system" | "user";
};

export type AgentInputChoice = {
  id: string;
  label: string;
  value: boolean | number | string;
};

export type AgentInputAnswer = {
  choiceId?: string | null;
  value: boolean | number | string;
};

export type AgentApprovalDecision = {
  approved: boolean;
  note?: string | null;
};

type AgentInteractionBase = {
  actor: AgentInteractionActor;
  createdAt: string;
  expiresAt: string;
  id: string;
  originatingCommand: string;
  projectId: string;
  question: string;
  resolvedAt: string | null;
  schema: typeof AGENT_INTERACTION_SCHEMA;
  schemaVersion: typeof AGENT_INTERACTION_SCHEMA_VERSION;
  status: "awaiting" | "expired" | "resolved";
};

export type AgentInputRequest = AgentInteractionBase & {
  answer: AgentInputAnswer | null;
  choices: AgentInputChoice[];
  kind: "input";
};

export type AgentApprovalRequest = AgentInteractionBase & {
  decision: AgentApprovalDecision | null;
  destructive: boolean;
  estimatedCostUsd: number | null;
  kind: "approval";
  payloadHash: string;
  permissions: string[];
  proposedCommand: string;
};

export type AgentInteractionRecord =
  | AgentApprovalRequest
  | AgentInputRequest;

export type AgentInteractionEvent = {
  at: string;
  kind:
    | "agent.interaction.awaiting"
    | "agent.interaction.expired"
    | "agent.interaction.resolved";
  projectId: string;
  request: AgentInteractionRecord;
};
