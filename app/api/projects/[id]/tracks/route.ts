import { tasks } from "@trigger.dev/sdk";
import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import {
  VIDEO_OBJECT_TRACKING_TASK_ID,
  writeTrackingRecord,
  type VideoTrackingRecord,
} from "@/lib/video-object-tracking";
import { formatCanvasChatRequest } from "@/lib/canvas-chat";
import { appendChat, getProjectSnapshot, readWorkspaceFile } from "@/lib/workspace";

type Params = {
  params: Promise<{ id: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boxFromAnnotations(annotations: unknown) {
  if (!Array.isArray(annotations)) return null;
  const first = annotations.find(isRecord);
  if (!first) return null;
  if (first.type === "rect") {
    const x = numberValue(first.x);
    const y = numberValue(first.y);
    const w = numberValue(first.width);
    const h = numberValue(first.height);
    if (w <= 0.01 || h <= 0.01) return null;
    return { x, y, w, h };
  }
  if (first.type === "freehand" && Array.isArray(first.points)) {
    const points = first.points.filter(isRecord).map((point) => ({
      x: numberValue(point.x),
      y: numberValue(point.y),
    }));
    if (points.length < 2) return null;
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    if (maxX - minX <= 0.01 || maxY - minY <= 0.01) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return null;
}

function absoluteUrl(value: string, requestUrl: string) {
  return new URL(value, requestUrl).toString();
}

function frontmatterMeta(content: string) {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end < 0) return null;
  try {
    return JSON.parse(content.slice(4, end)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function trackingSourceUrl({
  fallbackUrl,
  projectId,
  requestUrl,
  sourcePath,
}: {
  fallbackUrl: string;
  projectId: string;
  requestUrl: string;
  sourcePath: string | null;
}) {
  if (sourcePath) {
    const content = await readWorkspaceFile(projectId, sourcePath).catch(() => null);
    const meta = content ? frontmatterMeta(content) : null;
    if (typeof meta?.url === "string" && /^https?:\/\//i.test(meta.url)) {
      return meta.url;
    }
  }
  return absoluteUrl(fallbackUrl, requestUrl);
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to track video objects." }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const source = isRecord(body.source) ? body.source : {};
  const media = isRecord(body.media) ? body.media : {};
  const frame = isRecord(body.frame) ? body.frame : {};
  const box = boxFromAnnotations(body.annotations);
  const mediaUrl = typeof media.src === "string" && media.src ? media.src : null;
  const sourceId = typeof source.id === "string" && source.id ? source.id : null;
  const sourcePath = typeof source.path === "string" && source.path ? source.path : null;

  if (!box || !mediaUrl || !sourceId) {
    return NextResponse.json({ error: "Draw a box around the object to track." }, { status: 400 });
  }

  const now = new Date().toISOString();
  const trackId = `track_${crypto.randomUUID()}`;
  const requestedTracker = process.env.VIDEO_TRACKING_PROVIDER === "sam2-modal" ? "sam2" : "opencv";
  const record: VideoTrackingRecord = {
    boxes: [],
    createdAt: now,
    error: null,
    frame: {
      fps: typeof frame.fps === "number" && Number.isFinite(frame.fps) ? frame.fps : null,
      height: Math.max(1, Math.round(numberValue(frame.naturalHeight, 1))),
      startTime: Math.max(0, numberValue(frame.timestampSeconds, 0)),
      width: Math.max(1, Math.round(numberValue(frame.naturalWidth, 1))),
    },
    id: trackId,
    source: {
      id: sourceId,
      kind: typeof source.kind === "string" ? source.kind : "video",
      path: sourcePath,
      title: typeof source.title === "string" ? source.title : null,
      url: await trackingSourceUrl({
        fallbackUrl: mediaUrl,
        projectId: id,
        requestUrl: request.url,
        sourcePath,
      }),
    },
    status: "queued",
    tracker: requestedTracker,
    updatedAt: now,
    userBox: box,
  };

  await writeTrackingRecord(id, record);
  const sourceTitle = typeof source.title === "string" && source.title ? source.title : sourceId;
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
  await appendChat(id, {
    role: "user",
    text: formatCanvasChatRequest(
      { kind: "track", title: sourceTitle },
      instruction || "Track the marked object.",
    ),
  });
  await appendChat(id, {
    role: "assistant",
    text: `Started object tracking on "${sourceTitle}". Results will appear on the tile when ready.`,
  });
  const run = await tasks.trigger(
    VIDEO_OBJECT_TRACKING_TASK_ID,
    { projectId: id, trackId },
    {
      idempotencyKey: [VIDEO_OBJECT_TRACKING_TASK_ID, user.userId, trackId],
      maxDuration: 300,
      metadata: { userId: user.userId, projectId: id, trackId, sourceId },
      tags: [VIDEO_OBJECT_TRACKING_TASK_ID, `user:${user.userId}`, `project:${id}`, `track:${trackId}`],
    },
  );
  const snapshot = await getProjectSnapshot(id, user.userId);
  return NextResponse.json({ runId: run.id, snapshot, track: record });
}
