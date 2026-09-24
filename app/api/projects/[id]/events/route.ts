import { watch, type FSWatcher } from "node:fs";
import {
  agentContextEventBus,
  type AgentContextProjectEvent,
} from "@/lib/agent-context/events";
import {
  editorEventBus,
  type EditorCommandEvent,
} from "@/lib/editor-events";
import {
  agentInteractionEventBus,
  type AgentInteractionEvent,
} from "@/lib/agent-interaction-events";
import { paperEventBus, type PaperProjectEvent } from "@/lib/paper-events";
import { uiEventBus, type UiProjectEvent } from "@/lib/ui-events";
import { isProjectSupportMetadataPath } from "@/lib/project-file-classification";
import { projectRoot, safeRelativePath } from "@/lib/workspace";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ id: string }>;
};

function sse(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const encoder = new TextEncoder();
  let watcher: FSWatcher | null = null;
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
      const onPaperEvent = (event: PaperProjectEvent) => {
        if (event.projectId === id) send("paper", event);
      };
      const onAgentContextEvent = (event: AgentContextProjectEvent) => {
        if (event.projectId === id) send("agent-context", event);
      };
      const onEditorEvent = (event: EditorCommandEvent) => {
        if (event.projectId === id) send("editor-command", event);
      };
      const onAgentInteractionEvent = (event: AgentInteractionEvent) => {
        if (event.projectId === id) send("agent-interaction", event);
      };
      const onUiEvent = (event: UiProjectEvent) => {
        if (event.projectId === id) send("ui", event);
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        watcher?.close();
        agentInteractionEventBus.off("project", onAgentInteractionEvent);
        uiEventBus.off("project", onUiEvent);
        agentContextEventBus.off("project", onAgentContextEvent);
        editorEventBus.off("project", onEditorEvent);
        paperEventBus.off("project", onPaperEvent);
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };
      cleanup = close;

      agentInteractionEventBus.on("project", onAgentInteractionEvent);
      uiEventBus.on("project", onUiEvent);
      agentContextEventBus.on("project", onAgentContextEvent);
      editorEventBus.on("project", onEditorEvent);
      paperEventBus.on("project", onPaperEvent);
      try {
        watcher = watch(projectRoot(id), { recursive: true }, (_eventType, fileName) => {
          if (!fileName) return;
          try {
            const relativePath = safeRelativePath(String(fileName));
            if (isProjectSupportMetadataPath(relativePath)) return;
            send("workspace", {
              at: new Date().toISOString(),
              kind: "changed",
              paths: [relativePath],
              projectId: id,
            });
          } catch {
            // Ignore unsafe/noisy watcher paths.
          }
        });
        watcher.on("error", (error) => {
          send("warning", { message: error.message });
        });
      } catch (error) {
        send("warning", {
          message: error instanceof Error ? error.message : "Workspace watch unavailable.",
        });
      }
      heartbeat = setInterval(() => send("heartbeat", { at: Date.now() }), 15_000);
      send("ready", { projectId: id });
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
