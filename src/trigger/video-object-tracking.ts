import { task } from "@trigger.dev/sdk";
import { VIDEO_OBJECT_TRACKING_TASK_ID } from "@/lib/video-object-tracking";
import { runVideoObjectTracking } from "@/lib/video-object-tracking-worker";

export const videoObjectTrackingTask = task({
  id: VIDEO_OBJECT_TRACKING_TASK_ID,
  machine: { preset: "small-1x" },
  maxDuration: 300,
  run: runVideoObjectTracking,
});
