import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AGENT_INTERACTION_SCHEMA,
  AGENT_INTERACTION_SCHEMA_VERSION,
  type AgentApprovalDecision,
  type AgentApprovalRequest,
  type AgentInputAnswer,
  type AgentInputRequest,
  type AgentInteractionRecord,
} from "@/lib/agent-interaction-types";
import { publishAgentInteractionEvent } from "@/lib/agent-interaction-events";
import { resolveAgentContextProjectRoot } from "@/lib/agent-context/paths";

const REQUEST_DIRECTORY = ".video-fs/agent-requests";
const WRITE_LOCK_TIMEOUT_MS = 2_000;
const WRITE_LOCK_STALE_MS = 10_000;
const requestIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const conciseText = z
  .string()
  .min(1)
  .max(500)
  .transform((value) => value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim());
const actorSchema = z
  .object({
    id: z.string().min(1).max(160),
    type: z.enum(["agent", "system", "user"]),
  })
  .strict();
const choiceValueSchema = z.union([z.string().max(500), z.number().finite(), z.boolean()]);
const choiceSchema = z
  .object({
    id: z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    label: conciseText,
    value: choiceValueSchema,
  })
  .strict();

const commonCreateSchema = {
  actor: actorSchema,
  expiresInSeconds: z.number().int().min(30).max(600).default(300),
  id: requestIdSchema,
  originatingCommand: z.string().min(1).max(180),
  projectId: z.string().min(1).max(160),
  question: conciseText,
};

export const createAgentInputRequestSchema = z
  .object({
    ...commonCreateSchema,
    choices: z.array(choiceSchema).max(12).default([]),
    kind: z.literal("input"),
  })
  .strict();

export const createAgentApprovalRequestSchema = z
  .object({
    ...commonCreateSchema,
    destructive: z.boolean().default(false),
    estimatedCostUsd: z.number().finite().nonnegative().nullable().default(null),
    kind: z.literal("approval"),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    permissions: z.array(z.string().min(1).max(120)).max(24).default([]),
    proposedCommand: z.string().min(1).max(180),
  })
  .strict();

const inputAnswerSchema = z
  .object({
    choiceId: z.string().min(1).max(80).nullable().optional(),
    value: choiceValueSchema,
  })
  .strict();
const approvalDecisionSchema = z
  .object({
    approved: z.boolean(),
    note: conciseText.nullable().optional(),
  })
  .strict();

const baseRecordSchema = z.object({
  actor: actorSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  id: requestIdSchema,
  originatingCommand: z.string().min(1).max(180),
  projectId: z.string().min(1).max(160),
  question: conciseText,
  resolvedAt: z.string().datetime().nullable(),
  schema: z.literal(AGENT_INTERACTION_SCHEMA),
  schemaVersion: z.literal(AGENT_INTERACTION_SCHEMA_VERSION),
  status: z.enum(["awaiting", "expired", "resolved"]),
});
const inputRecordSchema = baseRecordSchema
  .extend({
    answer: inputAnswerSchema.nullable(),
    choices: z.array(choiceSchema).max(12),
    kind: z.literal("input"),
  })
  .strict();
const approvalRecordSchema = baseRecordSchema
  .extend({
    decision: approvalDecisionSchema.nullable(),
    destructive: z.boolean(),
    estimatedCostUsd: z.number().finite().nonnegative().nullable(),
    kind: z.literal("approval"),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    permissions: z.array(z.string().min(1).max(120)).max(24),
    proposedCommand: z.string().min(1).max(180),
  })
  .strict();
const recordSchema = z.discriminatedUnion("kind", [
  inputRecordSchema,
  approvalRecordSchema,
]);

export class AgentInteractionError extends Error {
  constructor(
    readonly code:
      | "AGENT_INTERACTION_CONFLICT"
      | "AGENT_INTERACTION_EXPIRED"
      | "AGENT_INTERACTION_INVALID"
      | "AGENT_INTERACTION_NOT_FOUND"
      | "AGENT_INTERACTION_RESOLVED"
      | "AGENT_INTERACTION_UNAVAILABLE",
    message: string,
    readonly status: number,
    readonly remediation: string | null = null,
  ) {
    super(message);
    this.name = "AgentInteractionError";
  }
}

async function requestRoot(projectId: string) {
  const projectDirectory = await resolveAgentContextProjectRoot(projectId);
  const directory = path.join(projectDirectory, REQUEST_DIRECTORY);
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700).catch(() => {});
  return directory;
}

function requestPath(directory: string, id: string) {
  return path.join(directory, `${requestIdSchema.parse(id)}.json`);
}

async function readRecordAt(filePath: string) {
  return recordSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
}

async function writeAtomic(filePath: string, value: AgentInteractionRecord) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600).catch(() => {});
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function withRequestLock<T>(
  directory: string,
  id: string,
  operation: () => Promise<T>,
) {
  const lockPath = path.join(directory, `.${requestIdSchema.parse(id)}.lock`);
  const deadline = Date.now() + WRITE_LOCK_TIMEOUT_MS;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > WRITE_LOCK_STALE_MS) {
        await rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new AgentInteractionError(
          "AGENT_INTERACTION_UNAVAILABLE",
          "The agent request is busy; try again.",
          503,
          "Wait a moment, then retry the same request ID.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

function sameRequest(
  current: AgentInteractionRecord,
  next: AgentInteractionRecord,
) {
  const requestIdentity = (record: AgentInteractionRecord) => {
    const common = {
      actor: record.actor,
      id: record.id,
      kind: record.kind,
      originatingCommand: record.originatingCommand,
      projectId: record.projectId,
      question: record.question,
      schema: record.schema,
      schemaVersion: record.schemaVersion,
    };
    if (record.kind === "input") {
      return { ...common, choices: record.choices };
    }
    return {
      ...common,
      destructive: record.destructive,
      estimatedCostUsd: record.estimatedCostUsd,
      payloadHash: record.payloadHash,
      permissions: record.permissions,
      proposedCommand: record.proposedCommand,
    };
  };
  return (
    JSON.stringify(requestIdentity(current)) ===
    JSON.stringify(requestIdentity(next))
  );
}

export async function createAgentInteraction(
  raw:
    | z.input<typeof createAgentApprovalRequestSchema>
    | z.input<typeof createAgentInputRequestSchema>,
  options: { now?: Date } = {},
) {
  const input =
    raw.kind === "approval"
      ? createAgentApprovalRequestSchema.parse(raw)
      : createAgentInputRequestSchema.parse(raw);
  const now = options.now ?? new Date();
  const common = {
    actor: input.actor,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1_000).toISOString(),
    id: input.id,
    originatingCommand: input.originatingCommand,
    projectId: input.projectId,
    question: input.question,
    resolvedAt: null,
    schema: AGENT_INTERACTION_SCHEMA as typeof AGENT_INTERACTION_SCHEMA,
    schemaVersion:
      AGENT_INTERACTION_SCHEMA_VERSION as typeof AGENT_INTERACTION_SCHEMA_VERSION,
    status: "awaiting" as const,
  };
  const next: AgentInteractionRecord =
    input.kind === "input"
      ? { ...common, answer: null, choices: input.choices, kind: "input" }
      : {
          ...common,
          decision: null,
          destructive: input.destructive,
          estimatedCostUsd: input.estimatedCostUsd,
          kind: "approval",
          payloadHash: input.payloadHash,
          permissions: [...new Set(input.permissions)],
          proposedCommand: input.proposedCommand,
        };
  const directory = await requestRoot(input.projectId);
  const filePath = requestPath(directory, input.id);
  const result = await withRequestLock(directory, input.id, async () => {
    const existing = await readRecordAt(filePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      if (!sameRequest(existing, next)) {
        throw new AgentInteractionError(
          "AGENT_INTERACTION_CONFLICT",
          "This request ID is already bound to different work.",
          409,
          "Create a new request ID for the new question or approval.",
        );
      }
      return { created: false, record: existing };
    }
    await writeAtomic(filePath, next);
    return { created: true, record: next };
  });
  if (result.created) {
    publishAgentInteractionEvent("agent.interaction.awaiting", result.record);
  }
  return result.record;
}

export async function readAgentInteraction(projectId: string, id: string) {
  const directory = await requestRoot(projectId);
  return readRecordAt(requestPath(directory, id)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgentInteractionError(
        "AGENT_INTERACTION_NOT_FOUND",
        "The agent request was not found.",
        404,
      );
    }
    throw error;
  });
}

async function expireRecord(
  record: AgentInteractionRecord,
  now: Date,
): Promise<AgentInteractionRecord> {
  if (record.kind === "approval") {
    return {
      ...record,
      decision: { approved: false, note: "Expired without approval." },
      resolvedAt: now.toISOString(),
      status: "expired",
    };
  }
  return {
    ...record,
    answer: null,
    resolvedAt: now.toISOString(),
    status: "expired",
  };
}

export async function expireAgentInteraction(
  projectId: string,
  id: string,
  options: { now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const directory = await requestRoot(projectId);
  const filePath = requestPath(directory, id);
  const result = await withRequestLock(directory, id, async () => {
    const current = await readAgentInteraction(projectId, id);
    if (current.status !== "awaiting" || Date.parse(current.expiresAt) > now.getTime()) {
      return { changed: false, record: current };
    }
    const record = await expireRecord(current, now);
    await writeAtomic(filePath, record);
    return { changed: true, record };
  });
  if (result.changed) {
    publishAgentInteractionEvent("agent.interaction.expired", result.record);
  }
  return result.record;
}

export async function resolveAgentInteraction(
  projectId: string,
  id: string,
  resolution:
    | { answer: AgentInputAnswer; kind: "input" }
    | { decision: AgentApprovalDecision; kind: "approval" },
  options: { now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const directory = await requestRoot(projectId);
  const filePath = requestPath(directory, id);
  const result = await withRequestLock(directory, id, async () => {
    let current = await readAgentInteraction(projectId, id);
    if (current.status !== "awaiting") {
      throw new AgentInteractionError(
        "AGENT_INTERACTION_RESOLVED",
        "This request has already been answered.",
        409,
      );
    }
    if (Date.parse(current.expiresAt) <= now.getTime()) {
      current = await expireRecord(current, now);
      await writeAtomic(filePath, current);
      return { expired: true, record: current };
    }
    if (current.kind !== resolution.kind) {
      throw new AgentInteractionError(
        "AGENT_INTERACTION_INVALID",
        "The response type does not match this request.",
        400,
      );
    }
    let record: AgentInteractionRecord;
    if (current.kind === "input" && resolution.kind === "input") {
      const answer = inputAnswerSchema.parse(resolution.answer);
      if (
        answer.choiceId &&
        !current.choices.some(
          (choice) =>
            choice.id === answer.choiceId &&
            JSON.stringify(choice.value) === JSON.stringify(answer.value),
        )
      ) {
        throw new AgentInteractionError(
          "AGENT_INTERACTION_INVALID",
          "The selected answer is not one of the available choices.",
          400,
        );
      }
      record = {
        ...current,
        answer,
        resolvedAt: now.toISOString(),
        status: "resolved",
      };
    } else if (current.kind === "approval" && resolution.kind === "approval") {
      record = {
        ...current,
        decision: approvalDecisionSchema.parse(resolution.decision),
        resolvedAt: now.toISOString(),
        status: "resolved",
      };
    } else {
      throw new AgentInteractionError(
        "AGENT_INTERACTION_INVALID",
        "The response type does not match this request.",
        400,
      );
    }
    await writeAtomic(filePath, record);
    return { expired: false, record };
  });
  publishAgentInteractionEvent(
    result.expired
      ? "agent.interaction.expired"
      : "agent.interaction.resolved",
    result.record,
  );
  if (result.expired) {
    throw new AgentInteractionError(
      "AGENT_INTERACTION_EXPIRED",
      "This request expired before it was answered.",
      409,
      "Ask the agent to create a new request.",
    );
  }
  return result.record;
}

export async function listAgentInteractions(
  projectId: string,
  options: { now?: Date } = {},
) {
  const directory = await requestRoot(projectId);
  const names = await readdir(directory);
  const records = await Promise.all(
    names
      .filter((name) => /^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/.test(name))
      .map((name) => readRecordAt(path.join(directory, name))),
  );
  const now = options.now ?? new Date();
  const settled = await Promise.all(
    records.map((record) =>
      record.status === "awaiting" && Date.parse(record.expiresAt) <= now.getTime()
        ? expireAgentInteraction(projectId, record.id, { now })
        : record,
    ),
  );
  return settled.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function waitForAgentInteraction(
  projectId: string,
  id: string,
  options: { pollMs?: number } = {},
) {
  const pollMs = options.pollMs ?? 125;
  while (true) {
    const record = await expireAgentInteraction(projectId, id);
    if (record.status !== "awaiting") return record;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export function agentInteractionErrorPayload(error: unknown) {
  if (error instanceof z.ZodError) {
    return {
      body: {
        code: "AGENT_INTERACTION_INVALID",
        error: "Invalid agent request.",
        remediation: "Correct the invalid fields and retry with the same request intent.",
      },
      status: 400,
    };
  }
  if (error instanceof AgentInteractionError) {
    return {
      body: {
        code: error.code,
        error: error.message,
        remediation: error.remediation,
      },
      status: error.status,
    };
  }
  return {
    body: {
      code: "AGENT_INTERACTION_UNAVAILABLE",
      error: "Agent requests are temporarily unavailable.",
      remediation: "Keep Video FS open, then retry the request.",
    },
    status: 500,
  };
}
