import { EventEmitter } from "node:events";

/** Agent-driven workspace UI commands (e.g. switching the workbench between
 * canvas and editor). Delivered to open project views over the project SSE
 * channel; harmless no-ops when no view is open. */
export type UiProjectEvent = {
  at: string;
  kind: "view.switch";
  projectId: string;
  view: "canvas" | "editor";
};

type UiEventBus = EventEmitter & {
  emit(event: "project", payload: UiProjectEvent): boolean;
  off(event: "project", listener: (payload: UiProjectEvent) => void): UiEventBus;
  on(event: "project", listener: (payload: UiProjectEvent) => void): UiEventBus;
};

const globalForUiEvents = globalThis as typeof globalThis & {
  __videoFsUiEventBus?: UiEventBus;
};

export const uiEventBus =
  globalForUiEvents.__videoFsUiEventBus ?? (new EventEmitter() as UiEventBus);

uiEventBus.setMaxListeners(100);
globalForUiEvents.__videoFsUiEventBus = uiEventBus;

export function publishUiEvent(
  event: Omit<UiProjectEvent, "at"> & { at?: string },
) {
  uiEventBus.emit("project", {
    ...event,
    at: event.at ?? new Date().toISOString(),
  });
}
