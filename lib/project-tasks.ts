import { randomUUID } from "node:crypto";
import { after } from "next/server";
import type { tasks } from "@trigger.dev/sdk";
import { isLocalAppMode } from "@/lib/app-mode";
import type { CanvasYoutubeGeneratePayload, CanvasYoutubeImportPayload } from "@/lib/canvas-youtube-worker";
import { updateCanvasYoutubeImportRecord } from "@/lib/canvas-youtube-import";
import type { VideoObjectTrackingTaskPayload } from "@/lib/video-object-tracking-worker";
import { readTrackingRecord, updateTrackingRecord, writeTrackingRecord } from "@/lib/video-object-tracking";

type ProjectTasks = {
  "canvas-youtube-import-v1": CanvasYoutubeImportPayload;
  "canvas-youtube-generate-v1": CanvasYoutubeGeneratePayload;
  "video-object-tracking-v1": VideoObjectTrackingTaskPayload;
};

type ProjectTask = { [K in keyof ProjectTasks]: { id: K; payload: ProjectTasks[K] } }[keyof ProjectTasks];

async function runLocalTask(job: ProjectTask) {
  try {
    switch (job.id) {
      case "canvas-youtube-import-v1":
        return await (await import("@/lib/canvas-youtube-worker")).runCanvasYoutubeImport(job.payload);
      case "canvas-youtube-generate-v1":
        return await (await import("@/lib/canvas-youtube-worker")).runCanvasYoutubeGenerate(job.payload);
      case "video-object-tracking-v1":
        return await (await import("@/lib/video-object-tracking-worker")).runVideoObjectTracking(job.payload);
    }
  } catch (error) {
    // Also persist failures that occur before the worker's own try/catch.
    const message = error instanceof Error ? error.message : "Local task failed.";
    if (job.id === "video-object-tracking-v1") {
      const record = await readTrackingRecord(job.payload.projectId, job.payload.trackId);
      await writeTrackingRecord(job.payload.projectId, updateTrackingRecord(record, { status: "failed", error: message }));
    } else {
      await updateCanvasYoutubeImportRecord(job.payload.projectId, job.payload.importId, record => ({
        ...record, status: "failed", error: message, completedAt: new Date().toISOString(),
      }));
    }
  }
}

/** Local work stays in the app process; only hosted deployments use Trigger. */
export async function queueProjectTask<K extends keyof ProjectTasks>(
  id: K,
  payload: ProjectTasks[K],
  options?: Parameters<typeof tasks.trigger>[2],
) {
  if (!isLocalAppMode()) {
    const { tasks } = await import("@trigger.dev/sdk");
    return tasks.trigger(id, payload, options);
  }
  const runId = `local_${randomUUID()}`;
  // Run after the response so callers can persist queued state before work starts.
  // This survives navigation, but not stopping/restarting the local app process.
  after(async () => {
    try {
      await runLocalTask({ id, payload } as ProjectTask);
    } catch (error) {
      console.error("Could not persist local task failure:", error);
    }
  });
  return { id: runId };
}
