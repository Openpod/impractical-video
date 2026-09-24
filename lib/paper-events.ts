import { EventEmitter } from "node:events";

export type PaperProjectEvent = {
  artifactId?: string;
  aspectRatio?: string;
  at: string;
  /** Terminal outcome for `settled` events, so subscribers without access to
   * the operation receipt files (e.g. the titlebar tabs) resolve correctly. */
  error?: string;
  kind: "changed" | "working" | "settled";
  ok?: boolean;
  paths: string[];
  projectId: string;
  status?: "failed" | "succeeded";
  title?: string;
  tool?: "generate_image" | "generate_clip" | "write" | "session";
};

type PaperEventBus = EventEmitter & {
  emit(event: "project", payload: PaperProjectEvent): boolean;
  off(event: "project", listener: (payload: PaperProjectEvent) => void): PaperEventBus;
  on(event: "project", listener: (payload: PaperProjectEvent) => void): PaperEventBus;
};

const globalForPaperEvents = globalThis as typeof globalThis & {
  __videoFsPaperEventBus?: PaperEventBus;
};

export const paperEventBus =
  globalForPaperEvents.__videoFsPaperEventBus ??
  (new EventEmitter() as PaperEventBus);

paperEventBus.setMaxListeners(100);
globalForPaperEvents.__videoFsPaperEventBus = paperEventBus;

export function publishPaperEvent(
  event: Omit<PaperProjectEvent, "at"> & { at?: string },
) {
  paperEventBus.emit("project", {
    ...event,
    at: event.at ?? new Date().toISOString(),
  });
}
