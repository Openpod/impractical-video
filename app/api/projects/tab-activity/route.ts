import {
  agentInteractionEventBus,
  type AgentInteractionEvent,
} from "@/lib/agent-interaction-events";
import {
  editorEventBus,
  type EditorCommandEvent,
} from "@/lib/editor-events";
import { listAgentInteractions } from "@/lib/agent-interactions";
import { paperEventBus, type PaperProjectEvent } from "@/lib/paper-events";
import { projectRoot } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const MAX_OPEN_PROJECTS = 24;

function sse(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function requestedProjectIds(request: Request) {
  const ids = new URL(request.url).searchParams.getAll("id");
  return [
    ...new Set(
      ids
        .map((id) => id.trim())
        .filter(Boolean)
        .slice(0, MAX_OPEN_PROJECTS),
    ),
  ].filter((id) => {
    try {
      projectRoot(id);
      return true;
    } catch {
      return false;
    }
  });
}

export async function GET(request: Request) {
  const projectIds = requestedProjectIds(request);
  const projectSet = new Set(projectIds);
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sse(event, payload)));
        } catch {
          close();
        }
      };
      const onPaper = (event: PaperProjectEvent) => {
        if (projectSet.has(event.projectId)) send("paper", event);
      };
      const onEditor = (event: EditorCommandEvent) => {
        if (projectSet.has(event.projectId)) send("editor-command", event);
      };
      const onInteraction = (event: AgentInteractionEvent) => {
        if (projectSet.has(event.projectId)) send("agent-interaction", event);
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        agentInteractionEventBus.off("project", onInteraction);
        editorEventBus.off("project", onEditor);
        paperEventBus.off("project", onPaper);
        try {
          controller.close();
        } catch {
          // The browser already closed the stream.
        }
      };
      cleanup = close;

      agentInteractionEventBus.on("project", onInteraction);
      editorEventBus.on("project", onEditor);
      paperEventBus.on("project", onPaper);

      void Promise.all(
        projectIds.map(async (projectId) => {
          const requests = await listAgentInteractions(projectId).catch(
            () => [],
          );
          const awaiting = requests.find(
            (request) => request.status === "awaiting",
          );
          if (awaiting) {
            send("agent-interaction", {
              at: new Date().toISOString(),
              kind: "agent.interaction.awaiting",
              projectId,
              request: awaiting,
            } satisfies AgentInteractionEvent);
          }
        }),
      ).finally(() => send("ready", { projectIds }));

      heartbeat = setInterval(
        () => send("heartbeat", { at: Date.now() }),
        15_000,
      );
      request.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  });
}
