import { EventEmitter } from "node:events";

export type EditorCommandName =
  | "editor_edit"
  | "editor_structure"
  | "editor_timeline_insert"
  | "editor_timeline_move"
  | "editor_timeline_remove"
  | "editor_timeline_split"
  | "editor_timeline_trim";

export type EditorCommandEvent = {
  affectedElementIds: string[];
  at: string;
  command: EditorCommandName;
  commandId: string;
  error?: {
    code: string;
    message: string;
    remediation: string | null;
  };
  kind:
    | "editor.command.accepted"
    | "editor.command.completed"
    | "editor.command.failed";
  newRevision?: number;
  priorRevision?: number;
  projectId: string;
};

type EditorEventBus = EventEmitter & {
  emit(event: "project", payload: EditorCommandEvent): boolean;
  off(
    event: "project",
    listener: (payload: EditorCommandEvent) => void,
  ): EditorEventBus;
  on(
    event: "project",
    listener: (payload: EditorCommandEvent) => void,
  ): EditorEventBus;
};

const globalForEditorEvents = globalThis as typeof globalThis & {
  __videoFsEditorEventBus?: EditorEventBus;
};

export const editorEventBus =
  globalForEditorEvents.__videoFsEditorEventBus ??
  (new EventEmitter() as EditorEventBus);

editorEventBus.setMaxListeners(100);
globalForEditorEvents.__videoFsEditorEventBus = editorEventBus;

export function publishEditorCommandEvent(
  event: Omit<EditorCommandEvent, "at"> & { at?: string },
) {
  editorEventBus.emit("project", {
    ...event,
    at: event.at ?? new Date().toISOString(),
  });
}
