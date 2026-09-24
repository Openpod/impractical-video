import { auth } from "@clerk/nextjs/server";
import { runs, streams } from "@trigger.dev/sdk";
import { isLocalAppMode } from "@/lib/app-mode";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ id: string; runId: string }>;
};

async function assertRunAccess({
  projectId,
  runId,
  userId,
}: {
  projectId: string;
  runId: string;
  userId: string;
}) {
  const run = await runs.retrieve(runId).catch(() => null);
  const metadata =
    run?.metadata && typeof run.metadata === "object"
      ? (run.metadata as Record<string, unknown>)
      : {};
  if (
    !run ||
    metadata.userId !== userId ||
    metadata.projectId !== projectId
  ) {
    return null;
  }
  return run;
}

function parseStartIndex(request: Request) {
  const raw = new URL(request.url).searchParams.get("startIndex");
  if (!raw?.trim()) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function GET(request: Request, { params }: Params) {
  if (isLocalAppMode()) {
    return Response.json(
      { error: "Hosted resumable runs are unavailable in local mode. Use the desktop MCP connection." },
      { status: 404 },
    );
  }
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id: projectId, runId } = await params;
  const run = await assertRunAccess({ projectId, runId, userId });
  if (!run) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }

  const triggerStream = await streams.read<string>(runId, {
    startIndex: parseStartIndex(request),
    signal: request.signal,
  });
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of triggerStream) {
          controller.enqueue(encoder.encode(`${chunk}\n`));
        }
        controller.close();
      } catch (error) {
        if (request.signal.aborted) {
          controller.close();
          return;
        }
        controller.error(error);
      }
    },
  });

  return new Response(readable, {
    headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-workflow-run-cancelled": run.isCancelled ? "1" : "0",
      "x-workflow-run-completed": run.isCompleted ? "1" : "0",
      "x-workflow-run-id": runId,
      ...(typeof run.status === "string" && run.status.trim()
        ? { "x-workflow-run-status": run.status.trim() }
        : {}),
    },
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  if (isLocalAppMode()) {
    return Response.json(
      { error: "Hosted resumable runs are unavailable in local mode." },
      { status: 404 },
    );
  }
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id: projectId, runId } = await params;
  const run = await assertRunAccess({ projectId, runId, userId });
  if (!run) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }

  if (!run.isCompleted && !run.isCancelled) {
    await runs.cancel(runId);
  }
  return Response.json({ success: true });
}
