import { tasks } from "@trigger.dev/sdk";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { VIDEO_FS_AGENT_CHAT_TASK_ID } from "@/lib/video-fs-agent-chat-task";
import { getProjectSnapshot } from "@/lib/workspace";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ id: string }>;
};

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function POST(request: Request, { params }: Params) {
  const user = await ensureCurrentAppUser();
  if (!user) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id: projectId } = await params;
  await getProjectSnapshot(projectId, user.userId);
  const body = await request.json().catch(() => ({}));
  const bodyRecord =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const assistantMessageId = optionalString(bodyRecord.assistantMessageId);
  const run = await tasks.trigger(
    VIDEO_FS_AGENT_CHAT_TASK_ID,
    {
      body,
      projectId,
      requestCookieHeader: request.headers.get("cookie"),
      requestUrl: request.url,
      userId: user.userId,
    },
    {
      ...(assistantMessageId
        ? {
            idempotencyKey: [
              VIDEO_FS_AGENT_CHAT_TASK_ID,
              user.userId,
              projectId,
              assistantMessageId,
            ],
          }
        : {}),
      maxDuration: 36000,
      metadata: {
        userId: user.userId,
        projectId,
        ...(assistantMessageId ? { assistantMessageId } : {}),
      },
      tags: [
        VIDEO_FS_AGENT_CHAT_TASK_ID,
        `user:${user.userId}`,
        `project:${projectId}`,
      ],
    },
  );

  return Response.json(
    { runId: run.id, success: true },
    {
      headers: {
        "x-workflow-run-id": run.id,
      },
    },
  );
}
