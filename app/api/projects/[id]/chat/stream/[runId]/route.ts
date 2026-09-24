import { isLocalAppMode } from "@/lib/app-mode";
import { runs, streams } from "@trigger.dev/sdk";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { setAgentRunStatus } from "@/lib/agent-runs";

export const dynamic = "force-dynamic";
// The GET stays open replaying the run's stream; raise the prod function ceiling.
export const maxDuration = 800;

type Params = { params: Promise<{ id: string; runId: string }> };
const STREAM_HEARTBEAT_MS = 15_000;

/** Verify the run belongs to the caller via the Trigger run metadata. */
async function ownedRun(runId: string, userId: string) {
  const run = await runs.retrieve(runId).catch(() => null);
  const ownerUserId =
    run?.metadata && typeof run.metadata === "object"
      ? ((run.metadata as Record<string, unknown>).userId as string | undefined)
      : undefined;
  if (!run || ownerUserId !== userId) return null;
  return run;
}

/**
 * Read (or resume) a run's stream. The live path and the reconnect path are the
 * same: `streams.read(runId, { startIndex })` replays from Trigger's buffer, so
 * a returning client just opens this at startIndex=0 to reconstruct, or at its
 * last index to continue.
 */
export async function GET(request: Request, { params }: Params) {
  if (isLocalAppMode()) return Response.json({ error: "Use the local agent connection for chat." }, { status: 404 });
  const { runId } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const run = await ownedRun(runId, user.userId);
  if (!run) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }

  const startIndexParam = new URL(request.url).searchParams.get("startIndex");
  const startIndex =
    startIndexParam && startIndexParam.trim() ? Number.parseInt(startIndexParam, 10) : undefined;

  const triggerStream = await streams.read<string>(runId, {
    ...(typeof startIndex === "number" && Number.isFinite(startIndex) ? { startIndex } : {}),
    signal: request.signal,
  });
  const encoder = new TextEncoder();

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const iterator = triggerStream[Symbol.asyncIterator]();
      let atLineBoundary = true;
      try {
        // Relay chunks VERBATIM. The loop route already emits ndjson with "\n"
        // delimiters; re-adding "\n" per Trigger chunk inserts a spurious newline
        // wherever a large event (e.g. the final snapshot) is split across stream
        // chunks, corrupting that line's JSON. The client buffers + splits on "\n".
        let nextChunk = iterator.next();
        while (true) {
          const next = await Promise.race([
            nextChunk.then((result) => ({ kind: "chunk" as const, result })),
            new Promise<{ kind: "heartbeat" }>((resolve) => {
              setTimeout(() => resolve({ kind: "heartbeat" }), STREAM_HEARTBEAT_MS);
            }),
          ]);
          if (next.kind === "heartbeat") {
            if (atLineBoundary) {
              controller.enqueue(
                encoder.encode(JSON.stringify({ type: "status", message: "Still working." }) + "\n"),
              );
            }
            continue;
          }
          if (next.result.done) break;
          controller.enqueue(encoder.encode(next.result.value));
          atLineBoundary = next.result.value.endsWith("\n");
          nextChunk = iterator.next();
        }
        controller.close();
      } catch (error) {
        if (request.signal.aborted) {
          controller.close();
          return;
        }
        controller.error(error);
      } finally {
        await iterator.return?.().catch(() => undefined);
      }
    },
  });

  return new Response(readable, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-workflow-run-id": runId,
      "x-workflow-run-cancelled": run.isCancelled ? "1" : "0",
      "x-workflow-run-completed": run.isCompleted ? "1" : "0",
    },
  });
}

/** Abort a run: cancel the Trigger run (propagates to the loop's abort signal). */
export async function DELETE(request: Request, { params }: Params) {
  if (isLocalAppMode()) return Response.json({ error: "Use the local agent connection for chat." }, { status: 404 });
  const { runId } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const run = await ownedRun(runId, user.userId);
  if (!run) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }

  if (!run.isCompleted && !run.isCancelled) {
    await Promise.allSettled([
      runs.cancel(runId),
      setAgentRunStatus(runId, "cancelled"),
    ]);
  }
  return Response.json({ success: true });
}
