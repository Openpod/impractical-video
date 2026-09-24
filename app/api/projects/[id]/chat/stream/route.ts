import { runs, tasks } from "@trigger.dev/sdk";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { createAgentRun, getActiveRunForProject, setAgentRunStatus } from "@/lib/agent-runs";
import { VIDEO_FS_AGENT_CHAT_TASK_ID } from "@/lib/video-fs-agent-chat-task";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Start a durable chat run. Triggers the Trigger task (which bridges to the
 * agent loop and pipes its ndjson into Trigger's resumable stream), records an
 * agent_runs row, and returns the runId the client reads from. The run survives
 * the client closing the browser; reconnect via GET (active-run discovery).
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const assistantMessageId = crypto.randomUUID();

  const run = await tasks.trigger(
    VIDEO_FS_AGENT_CHAT_TASK_ID,
    {
      // requestedAt rides inside body so the run can log queue latency.
      body: { ...(body && typeof body === "object" ? body : {}), requestedAt: Date.now() },
      projectId: id,
      requestCookieHeader: request.headers.get("cookie"),
      requestUrl: request.url,
      userId: user.userId,
    },
    {
      idempotencyKey: [VIDEO_FS_AGENT_CHAT_TASK_ID, user.userId, assistantMessageId],
      maxDuration: 36000,
      metadata: { userId: user.userId, projectId: id, assistantMessageId },
      tags: [VIDEO_FS_AGENT_CHAT_TASK_ID, `user:${user.userId}`, `project:${id}`],
    },
  );

  await createAgentRun({
    legacyProjectId: id,
    userId: user.userId,
    triggerRunId: run.id,
    assistantMessageId,
  });

  return Response.json(
    { runId: run.id, assistantMessageId },
    { headers: { "x-workflow-run-id": run.id } },
  );
}

/** Reconnect discovery: the in-flight run for this project, if any. */
const TRIGGER_DEAD_STATUSES = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "INTERRUPTED",
  "EXPIRED",
  "TIMED_OUT",
]);

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  // A row can say queued/running while the underlying Trigger run is long
  // dead (crashes and dev restarts skip the status update). Verify against
  // Trigger and repair stale rows instead of reporting zombies — otherwise
  // the client reattaches to corpses and shows eternal "in progress".
  for (let hop = 0; hop < 3; hop += 1) {
    const activeRun = await getActiveRunForProject(id, user.userId);
    if (!activeRun?.triggerRunId) return Response.json({ activeRun: null });
    try {
      const run = await runs.retrieve(activeRun.triggerRunId);
      const status = String(run.status ?? "").toUpperCase();
      if (!TRIGGER_DEAD_STATUSES.has(status)) {
        return Response.json({ activeRun });
      }
      await setAgentRunStatus(
        activeRun.triggerRunId,
        status === "COMPLETED" ? "completed" : "failed",
        { error: status === "COMPLETED" ? null : `repaired stale row (trigger: ${status})` },
      );
      // Row repaired — loop to check whether an older live run exists.
    } catch {
      // Trigger unreachable: report what we know rather than blocking.
      return Response.json({ activeRun });
    }
  }
  return Response.json({ activeRun: null });
}
