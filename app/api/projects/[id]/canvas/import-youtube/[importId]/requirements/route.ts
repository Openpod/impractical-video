import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { readCanvasYoutubeImportRecord } from "@/lib/canvas-youtube-import";
import {
  getProjectSnapshot,
  listProjectFiles,
  readWorkspaceFile,
  writeWorkspaceBinaryFile,
  writeWorkspaceFile,
} from "@/lib/workspace";

type Params = {
  params: Promise<{ id: string; importId: string }>;
};

type RequirementRecord = {
  assetId: string;
  description?: string;
  kind?: string;
  label?: string;
  neededForShots?: string[];
  reason?: string;
  required?: boolean;
  resolvedPath?: string | null;
  status?: "missing" | "resolved";
};

type PlanRecord = {
  blockingQuestions?: Array<{ question: string; reason?: string }>;
  questionAnswers?: Array<{ answer: string; question: string }>;
  readyToGenerate?: boolean;
  requiredAssets?: RequirementRecord[];
  optionalAssets?: RequirementRecord[];
};

function safeStem(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "asset";
}

function fileExtension(file: File) {
  const fromName = /\.[a-z0-9]+$/i.exec(file.name)?.[0];
  if (fromName) return fromName.toLowerCase();
  if (file.type.startsWith("image/")) return ".png";
  if (file.type.startsWith("video/")) return ".mp4";
  return ".bin";
}

async function readRequirements(projectId: string, importId: string, baseDir: string) {
  const files = await listProjectFiles(projectId, true);
  return files
    .filter((file) => file.path.startsWith(`${baseDir}/`) && file.path.endsWith(".json") && !file.path.endsWith("/_index.json"))
    .map((file) => {
      try {
        return JSON.parse(file.content || "{}") as RequirementRecord;
      } catch {
        return null;
      }
    })
    .filter((item): item is RequirementRecord => Boolean(item?.assetId))
    .map((item) => ({ ...item, importId }));
}

function resolveAssetInPlan(plan: PlanRecord, assetId: string, resolvedPath: string) {
  const update = (asset: RequirementRecord) =>
    asset.assetId === assetId ? { ...asset, resolvedPath, status: "resolved" as const } : asset;
  return {
    ...plan,
    optionalAssets: (plan.optionalAssets ?? []).map(update),
    requiredAssets: (plan.requiredAssets ?? []).map(update),
  };
}

function recomputeReady(plan: PlanRecord) {
  const missing = (plan.requiredAssets ?? []).some((asset) => asset.status !== "resolved");
  const unanswered = (plan.blockingQuestions ?? []).length > 0;
  return { ...plan, readyToGenerate: !missing && !unanswered };
}

export async function GET(_request: Request, { params }: Params) {
  const { id, importId } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) return NextResponse.json({ error: "Sign in to continue import." }, { status: 401 });
  await getProjectSnapshot(id, user.userId);

  const record = await readCanvasYoutubeImportRecord(id, importId);
  const plan = record.planPath
    ? JSON.parse(await readWorkspaceFile(id, record.planPath).catch(() => "{}")) as PlanRecord
    : null;
  const requirements = record.requirementsPath
    ? await readRequirements(id, importId, record.requirementsPath.replace(/\/_index\.json$/, ""))
    : [];
  return NextResponse.json({ plan, record, requirements });
}

export async function POST(request: Request, { params }: Params) {
  const { id, importId } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) return NextResponse.json({ error: "Sign in to resolve import requirements." }, { status: 401 });
  await getProjectSnapshot(id, user.userId);

  const record = await readCanvasYoutubeImportRecord(id, importId);
  if (!record.planPath || !record.requirementsPath) {
    return NextResponse.json({ error: "Import requirements are not ready yet." }, { status: 409 });
  }
  const baseDir = record.requirementsPath.replace(/\/_index\.json$/, "");
  let plan = JSON.parse(await readWorkspaceFile(id, record.planPath)) as PlanRecord;
  const requirements = await readRequirements(id, importId, baseDir);
  const form = await request.formData();

  for (const requirement of requirements) {
    const assetId = requirement.assetId;
    const file = form.get(`asset:${assetId}:file`);
    const value = String(form.get(`asset:${assetId}:value`) ?? "").trim();
    let resolvedPath: string | null = null;
    if (file instanceof File && file.size > 0) {
      const ext = fileExtension(file);
      resolvedPath = `media/references/youtube/${safeStem(importId)}/${safeStem(assetId)}${ext}`;
      await writeWorkspaceBinaryFile(id, resolvedPath, Buffer.from(await file.arrayBuffer()));
    } else if (value) {
      resolvedPath = `references/youtube/${safeStem(importId)}/${safeStem(assetId)}.txt`;
      await writeWorkspaceFile(id, resolvedPath, value);
    }
    if (!resolvedPath) continue;
    const updated = {
      ...requirement,
      resolvedPath,
      status: "resolved" as const,
    };
    await writeWorkspaceFile(
      id,
      `${baseDir}/${safeStem(assetId)}.json`,
      `${JSON.stringify(updated, null, 2)}\n`,
    );
    plan = resolveAssetInPlan(plan, assetId, resolvedPath);
  }

  const questionAnswers = (plan.blockingQuestions ?? [])
    .map((question, index) => ({
      answer: String(form.get(`question:${index}`) ?? "").trim(),
      question: question.question,
    }))
    .filter((answer) => answer.answer);
  if (questionAnswers.length === (plan.blockingQuestions ?? []).length) {
    plan = { ...plan, blockingQuestions: [], questionAnswers };
  } else if (questionAnswers.length) {
    plan = { ...plan, questionAnswers };
  }
  plan = recomputeReady(plan);
  await writeWorkspaceFile(id, record.planPath, `${JSON.stringify(plan, null, 2)}\n`);
  await writeWorkspaceFile(
    id,
    record.requirementsPath,
    `${JSON.stringify({
      blockingQuestions: plan.blockingQuestions ?? [],
      importId,
      optional: (plan.optionalAssets ?? []).map((asset) => asset.assetId),
      readyToGenerate: plan.readyToGenerate === true,
      required: (plan.requiredAssets ?? []).map((asset) => asset.assetId),
      type: "youtube_import_requirements_index",
    }, null, 2)}\n`,
  );

  return NextResponse.json({
    plan,
    record: await readCanvasYoutubeImportRecord(id, importId),
    requirements: await readRequirements(id, importId, baseDir),
    snapshot: await getProjectSnapshot(id, user.userId),
  });
}
