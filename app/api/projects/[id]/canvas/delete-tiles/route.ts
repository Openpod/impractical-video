import { NextResponse } from "next/server";

import { ensureCurrentAppUser } from "@/lib/app-users";
import {
  getProjectSnapshot,
  parseJsonFrontmatter,
  readWorkspaceFile,
  refreshTimeline,
  safeRelativePath,
  withJsonFrontmatter,
  writeWorkspaceFile,
} from "@/lib/workspace";

type Params = {
  params: Promise<{ id: string }>;
};

type DeleteClipInput = {
  id?: unknown;
  path?: unknown;
};

function isTilePath(value: string) {
  return /^(clips|keyframes|uploads)\/[^/]+\.md$/.test(value);
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to delete canvas tiles." }, { status: 401 });
  }
  await getProjectSnapshot(id, user.userId);

  const body = await request.json().catch(() => ({}));
  const clips = Array.isArray(body.clips) ? (body.clips as DeleteClipInput[]) : [];
  if (!clips.length) {
    return NextResponse.json({ error: "No clips provided." }, { status: 400 });
  }

  for (const clip of clips) {
    const rawPath = typeof clip.path === "string" ? clip.path : "";
    const clipPath = safeRelativePath(rawPath);
    if (!isTilePath(clipPath)) {
      return NextResponse.json({ error: "Unsupported canvas tile path." }, { status: 400 });
    }
    const content = await readWorkspaceFile(id, clipPath);
    const parsed = parseJsonFrontmatter(content);
    const clipId = typeof parsed.meta.id === "string" ? parsed.meta.id : "";
    if (typeof clip.id === "string" && clipId && clip.id !== clipId) {
      return NextResponse.json({ error: "Clip id did not match tile path." }, { status: 400 });
    }
    await writeWorkspaceFile(
      id,
      clipPath,
      withJsonFrontmatter(
        {
          ...parsed.meta,
          status: "rejected",
        },
        parsed.body,
      ),
    );
  }

  await refreshTimeline(id);
  return NextResponse.json(await getProjectSnapshot(id, user.userId));
}
