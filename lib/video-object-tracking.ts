import { readWorkspaceFile, writeWorkspaceFile } from "@/lib/workspace";

export const VIDEO_OBJECT_TRACKING_TASK_ID = "video-object-tracking-v1";

export type VideoTrackingBox = {
  confidence?: number;
  frame?: number;
  h: number;
  t: number;
  w: number;
  x: number;
  y: number;
};

export type VideoTrackingStatus = "completed" | "failed" | "queued" | "running";

export type VideoTrackingProvider = "csrt" | "kcf" | "opencv" | "sam2";

export type VideoTrackingRecord = {
  boxes: VideoTrackingBox[];
  createdAt: string;
  error?: string | null;
  frame: {
    fps: number | null;
    height: number;
    startTime: number;
    width: number;
  };
  id: string;
  source: {
    id: string;
    kind: string;
    path?: string | null;
    title?: string | null;
    url: string;
  };
  status: VideoTrackingStatus;
  tracker: VideoTrackingProvider;
  updatedAt: string;
  userBox: {
    h: number;
    w: number;
    x: number;
    y: number;
  };
};

export function trackingFilePath(trackId: string) {
  const safe = trackId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) throw new Error("Invalid track id.");
  return `tracking/${safe}.json`;
}

export async function readTrackingRecord(projectId: string, trackId: string) {
  const raw = await readWorkspaceFile(projectId, trackingFilePath(trackId));
  return JSON.parse(raw) as VideoTrackingRecord;
}

export async function writeTrackingRecord(projectId: string, record: VideoTrackingRecord) {
  await writeWorkspaceFile(projectId, trackingFilePath(record.id), `${JSON.stringify(record, null, 2)}\n`);
}

export function updateTrackingRecord(
  record: VideoTrackingRecord,
  patch: Partial<Omit<VideoTrackingRecord, "createdAt" | "id">>,
): VideoTrackingRecord {
  return {
    ...record,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}
