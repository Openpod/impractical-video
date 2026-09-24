import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { task } from "@trigger.dev/sdk";
import {
  readTrackingRecord,
  updateTrackingRecord,
  VIDEO_OBJECT_TRACKING_TASK_ID,
  writeTrackingRecord,
  type VideoTrackingBox,
  type VideoTrackingProvider,
} from "@/lib/video-object-tracking";

export type VideoObjectTrackingTaskPayload = {
  projectId: string;
  trackId: string;
};

function runPythonTracker(args: {
  box: { h: number; w: number; x: number; y: number };
  inputPath: string;
  outputPath: string;
  startTime: number;
}) {
  return new Promise<{ boxes: VideoTrackingBox[]; tracker: VideoTrackingProvider }>((resolve, reject) => {
    const scriptPath = path.join(process.cwd(), "scripts", "video_tracking", "opencv_track.py");
    const child = spawn("python3", [
      scriptPath,
      "--input",
      args.inputPath,
      "--output",
      args.outputPath,
      "--start-time",
      String(args.startTime),
      "--x",
      String(args.box.x),
      "--y",
      String(args.box.y),
      "--w",
      String(args.box.w),
      "--h",
      String(args.box.h),
    ]);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `OpenCV tracker exited with code ${code}.`));
        return;
      }
      try {
        const result = JSON.parse(await readFile(args.outputPath, "utf8")) as {
          boxes?: VideoTrackingBox[];
          tracker?: VideoTrackingProvider;
        };
        resolve({
          boxes: Array.isArray(result.boxes) ? result.boxes : [],
          tracker: result.tracker ?? "opencv",
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function runModalSam2Tracker(args: {
  box: { h: number; w: number; x: number; y: number };
  startTime: number;
  videoUrl: string;
}) {
  const endpoint = process.env.MODAL_SAM2_TRACK_URL;
  if (!endpoint) {
    throw new Error("MODAL_SAM2_TRACK_URL is required when VIDEO_TRACKING_PROVIDER=sam2-modal.");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.MODAL_SAM2_TRACK_TOKEN
        ? { authorization: `Bearer ${process.env.MODAL_SAM2_TRACK_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      box: args.box,
      start_time: args.startTime,
      video_url: args.videoUrl,
    }),
  });
  const payload = await response.json().catch(() => ({})) as {
    boxes?: VideoTrackingBox[];
    detail?: unknown;
    error?: unknown;
    tracker?: VideoTrackingProvider;
  };
  if (!response.ok) {
    const detail =
      typeof payload.detail === "string"
        ? payload.detail
        : typeof payload.error === "string"
          ? payload.error
          : `Modal SAM2 tracker failed (${response.status}).`;
    throw new Error(detail);
  }
  return {
    boxes: Array.isArray(payload.boxes) ? payload.boxes : [],
    tracker: payload.tracker ?? "sam2" as VideoTrackingProvider,
  };
}

export const videoObjectTrackingTask = task({
  id: VIDEO_OBJECT_TRACKING_TASK_ID,
  machine: {
    preset: "small-1x",
  },
  maxDuration: 300,
  run: async (payload: VideoObjectTrackingTaskPayload) => {
    let record = await readTrackingRecord(payload.projectId, payload.trackId);
    record = updateTrackingRecord(record, { status: "running" });
    await writeTrackingRecord(payload.projectId, record);

    const useModalSam2 =
      process.env.VIDEO_TRACKING_PROVIDER === "sam2-modal" || record.tracker === "sam2";
    console.log(
      `Using video tracker: ${useModalSam2 ? "sam2-modal" : "opencv"} for track ${record.id}`,
    );

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "video-object-track-"));
    try {
      const result = useModalSam2
        ? await runModalSam2Tracker({
            box: record.userBox,
            startTime: record.frame.startTime,
            videoUrl: record.source.url,
          })
        : await (async () => {
            const videoResponse = await fetch(record.source.url);
            if (!videoResponse.ok) {
              throw new Error(`Failed to download video (${videoResponse.status}).`);
            }
            const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
            const inputPath = path.join(tempDir, "input.mp4");
            const outputPath = path.join(tempDir, "boxes.json");
            await writeFile(inputPath, videoBuffer);
            return runPythonTracker({
              box: record.userBox,
              inputPath,
              outputPath,
              startTime: record.frame.startTime,
            });
          })();

      record = updateTrackingRecord(record, {
        boxes: result.boxes,
        status: "completed",
        tracker: result.tracker,
      });
      await writeTrackingRecord(payload.projectId, record);
      return { ok: true as const, boxes: result.boxes.length };
    } catch (error) {
      record = updateTrackingRecord(record, {
        error: error instanceof Error ? error.message : "Object tracking failed.",
        status: "failed",
      });
      await writeTrackingRecord(payload.projectId, record);
      return { ok: false as const, error: record.error };
    } finally {
      await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
    }
  },
});
