import { readWorkspaceFile, writeWorkspaceFile } from "@/lib/workspace";

export const CANVAS_YOUTUBE_IMPORT_TASK_ID = "canvas-youtube-import-v1";
export const CANVAS_YOUTUBE_GENERATE_TASK_ID = "canvas-youtube-generate-v1";

export type CanvasYoutubeImportStatus =
  | "queued"
  | "running"
  | "planning"
  | "needs_assets"
  | "source_ready"
  | "generating"
  | "completed"
  | "failed";

export type CanvasYoutubeImportSlotStatus =
  | "planned"
  | "source_ready"
  | "submitted"
  | "generating"
  | "completed"
  | "failed";

export type CanvasYoutubeImportSlot = {
  clipId: string;
  duration: number;
  end: number;
  error?: string | null;
  generatedPath?: string | null;
  index: number;
  requestId?: string | null;
  sourceClipId: string;
  sourcePath?: string | null;
  start: number;
  status: CanvasYoutubeImportSlotStatus;
  title: string;
};

export type CanvasYoutubeImportRecord = {
  completedAt?: string | null;
  createdAt: string;
  error?: string | null;
  id: string;
  planPath?: string | null;
  projectId: string;
  requirementsPath?: string | null;
  runId?: string | null;
  slots: CanvasYoutubeImportSlot[];
  sourceUrl: string;
  status: CanvasYoutubeImportStatus;
  targetBrief?: string | null;
  updatedAt: string;
  userId: string;
};

export function canvasYoutubeImportPath(importId: string) {
  const safe = importId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "import";
  return `imports/youtube/${safe}.json`;
}

export async function readCanvasYoutubeImportRecord(projectId: string, importId: string) {
  const content = await readWorkspaceFile(projectId, canvasYoutubeImportPath(importId));
  return JSON.parse(content) as CanvasYoutubeImportRecord;
}

export async function writeCanvasYoutubeImportRecord(
  projectId: string,
  record: CanvasYoutubeImportRecord,
) {
  const updated = { ...record, updatedAt: new Date().toISOString() };
  await writeWorkspaceFile(
    projectId,
    canvasYoutubeImportPath(record.id),
    `${JSON.stringify(updated, null, 2)}\n`,
  );
  return updated;
}

export async function updateCanvasYoutubeImportRecord(
  projectId: string,
  importId: string,
  updater: (record: CanvasYoutubeImportRecord) => CanvasYoutubeImportRecord,
) {
  const record = await readCanvasYoutubeImportRecord(projectId, importId);
  return writeCanvasYoutubeImportRecord(projectId, updater(record));
}
