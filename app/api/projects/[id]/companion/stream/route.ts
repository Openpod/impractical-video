import { isLocalAppMode } from "@/lib/app-mode";
import {
  companionState,
  subscribeCompanion,
  type CompanionEvent,
} from "@/lib/companion-session";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** SSE stream of the companion session: replays the transcript, then relays
 * live events. The floating window renders directly from this. */
export async function GET(request: Request, { params }: Params) {
  if (!isLocalAppMode(process.env)) {
    return new Response("The companion chat is desktop-only.", { status: 404 });
  }
  const { id } = await params;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: CompanionEvent) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // Listener detaches on abort below.
        }
      };
      for (const event of (await companionState(id)).transcript) send(event);
      const unsubscribe = subscribeCompanion(id, send);
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);
      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });
  return new Response(stream, {
    headers: {
      "cache-control": "no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    },
  });
}
