import { queueProjectTask } from "@/lib/project-tasks";
import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import {
  CANVAS_YOUTUBE_GENERATE_TASK_ID,
  readCanvasYoutubeImportRecord,
  writeCanvasYoutubeImportRecord,
} from "@/lib/canvas-youtube-import";
import {
  getProjectSnapshot,
  readWorkspaceFile,
} from "@/lib/workspace";

type Params = {
  params: Promise<{ id: string; importId: string }>;
};

type PlanRecord = {
  blockingQuestions?: unknown[];
  readyToGenerate?: boolean;
  requiredAssets?: Array<{ label?: string; status?: string }>;
};

export async function POST(_request: Request, { params }: Params) {
  const { id, importId } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) return NextResponse.json({ error: "Sign in to generate import." }, { status: 401 });
  await getProjectSnapshot(id, user.userId);

  const record = await readCanvasYoutubeImportRecord(id, importId);
  if (!record.planPath) {
    return NextResponse.json({ error: "Import plan is missing." }, { status: 409 });
  }
  const plan = JSON.parse(await readWorkspaceFile(id, record.planPath)) as PlanRecord;
  const missing = (plan.requiredAssets ?? []).filter((asset) => asset.status !== "resolved");
  if (!plan.readyToGenerate || missing.length || (plan.blockingQuestions ?? []).length) {
    return NextResponse.json(
      {
        error: "Resolve the planner's required fields before generating.",
        missing: missing.map((asset) => asset.label ?? "Required asset"),
      },
      { status: 409 },
    );
  }

  const run = await queueProjectTask(
    CANVAS_YOUTUBE_GENERATE_TASK_ID,
    { importId, projectId: id, userId: user.userId },
    {
      idempotencyKey: [CANVAS_YOUTUBE_GENERATE_TASK_ID, user.userId, importId, Date.now().toString(36)],
      maxDuration: 36000,
      metadata: { importId, projectId: id, userId: user.userId },
      tags: [
        CANVAS_YOUTUBE_GENERATE_TASK_ID,
        `user:${user.userId}`,
        `project:${id}`,
        `import:${importId}`,
      ],
    },
  );
  await writeCanvasYoutubeImportRecord(id, {
    ...record,
    runId: run.id,
    status: "generating",
  });
  return NextResponse.json({
    importId,
    runId: run.id,
    snapshot: await getProjectSnapshot(id, user.userId),
  });
}
