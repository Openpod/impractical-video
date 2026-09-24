import { queueProjectTask } from "@/lib/project-tasks";
import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import {
  CANVAS_YOUTUBE_IMPORT_TASK_ID,
  updateCanvasYoutubeImportRecord,
  writeCanvasYoutubeImportRecord,
  type CanvasYoutubeImportRecord,
} from "@/lib/canvas-youtube-import";
import {
  appendChat,
  getProjectSnapshot,
} from "@/lib/workspace";

type Params = {
  params: Promise<{ id: string }>;
};

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "youtube";
}

function youtubeId(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("v") || parsed.pathname.split("/").filter(Boolean).pop() || "source";
  } catch {
    return "source";
  }
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to import video." }, { status: 401 });
  }
  await getProjectSnapshot(id, user.userId);

  const body = await request.json().catch(() => ({}));
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const brief = typeof body.brief === "string" ? body.brief.trim() : "";
  if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url)) {
    return NextResponse.json({ error: "Paste a valid YouTube URL." }, { status: 400 });
  }

  const idStem = slug(youtubeId(url));
  const importId = `${idStem}-${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  const record: CanvasYoutubeImportRecord = {
    createdAt: now,
    id: importId,
    projectId: id,
    slots: [],
    sourceUrl: url,
    status: "queued",
    targetBrief: brief || null,
    updatedAt: now,
    userId: user.userId,
  };
  await writeCanvasYoutubeImportRecord(id, record);
  await appendChat(id, {
    role: "user",
    text: brief
      ? `Import and mimic YouTube video: ${url}\n\nTarget brief:\n${brief}`
      : `Import and mimic YouTube video: ${url}`,
  });
  await appendChat(id, {
    role: "assistant",
    text:
      "Started smart YouTube import. I will detect shots, place ordered source references and generation placeholders on the canvas, then fill each generated clip as it finishes.",
  });

  try {
    const run = await queueProjectTask(
      CANVAS_YOUTUBE_IMPORT_TASK_ID,
      { brief: brief || null, importId, projectId: id, userId: user.userId, url },
      {
        idempotencyKey: [CANVAS_YOUTUBE_IMPORT_TASK_ID, user.userId, importId],
        maxDuration: 36000,
        metadata: { importId, projectId: id, userId: user.userId },
        tags: [
          CANVAS_YOUTUBE_IMPORT_TASK_ID,
          `user:${user.userId}`,
          `project:${id}`,
          `import:${importId}`,
        ],
      },
    );
    await updateCanvasYoutubeImportRecord(id, importId, (current) => ({ ...current, runId: run.id }));
    return NextResponse.json({
      importId,
      runId: run.id,
      snapshot: await getProjectSnapshot(id, user.userId),
    });
  } catch (error) {
    await writeCanvasYoutubeImportRecord(id, {
      ...record,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Failed to queue YouTube import.",
      status: "failed",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to queue YouTube import.",
      },
      { status: 500 },
    );
  }
}
