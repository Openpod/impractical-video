import { task } from "@trigger.dev/sdk";
import { CANVAS_YOUTUBE_GENERATE_TASK_ID, CANVAS_YOUTUBE_IMPORT_TASK_ID } from "@/lib/canvas-youtube-import";
import { runCanvasYoutubeGenerate, runCanvasYoutubeImport } from "@/lib/canvas-youtube-worker";

export const canvasYoutubeGenerateTask = task({
  id: CANVAS_YOUTUBE_GENERATE_TASK_ID,
  machine: { preset: "medium-1x" },
  maxDuration: 36000,
  run: runCanvasYoutubeGenerate,
});

export const canvasYoutubeImportTask = task({
  id: CANVAS_YOUTUBE_IMPORT_TASK_ID,
  machine: { preset: "medium-1x" },
  maxDuration: 36000,
  run: runCanvasYoutubeImport,
});
