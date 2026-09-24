export type AgentContextErrorCode =
  | "AGENT_CONTEXT_BINDING_MISMATCH"
  | "AGENT_CONTEXT_BUSY"
  | "AGENT_CONTEXT_NOT_FOUND"
  | "AGENT_CONTEXT_REVISION_CONFLICT"
  | "AGENT_CONTEXT_STALE"
  | "AGENT_CONTEXT_UNAVAILABLE"
  | "ATTACHMENT_INVALID"
  | "ATTACHMENT_NOT_FOUND"
  | "PROJECT_ACCESS_DENIED"
  | "PROJECT_NOT_FOUND";

export class AgentContextError extends Error {
  readonly code: AgentContextErrorCode;
  readonly details: Record<string, unknown>;
  readonly status: number;

  constructor(
    code: AgentContextErrorCode,
    message: string,
    status: number,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AgentContextError";
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export function toAgentContextError(error: unknown) {
  if (error instanceof AgentContextError) return error;
  return new AgentContextError(
    "AGENT_CONTEXT_UNAVAILABLE",
    "Agent context is temporarily unavailable.",
    500,
  );
}
