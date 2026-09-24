import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import {
  getProjectSnapshot,
  parseJsonFrontmatter,
  readWorkspaceFile,
  safeRelativePath,
  withJsonFrontmatter,
  writeWorkspaceFile,
} from "@/lib/workspace";

// Renames a canvas tile: rewrites the source doc's `# Title` heading (titles
// live in the markdown body, not frontmatter) — uploads also update their
// original_name since the tile title derives from it.

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to rename tiles." }, { status: 401 });
  }
  await getProjectSnapshot(id, user.userId);

  const body = await request.json().catch(() => ({}));
  const tilePath = typeof body.path === "string" ? safeRelativePath(body.path) : "";
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
  if (!title) {
    return NextResponse.json({ error: "Title is required." }, { status: 400 });
  }
  if (
    !/^(clips|keyframes|uploads)\/[^/]+\.md$/.test(tilePath) &&
    !/^references\/[^/]+\/[^/]+\/reference\.md$/.test(tilePath)
  ) {
    return NextResponse.json({ error: "Unsupported tile path." }, { status: 400 });
  }

  const raw = await readWorkspaceFile(id, tilePath);
  const parsed = parseJsonFrontmatter(raw);
  const nextBody = /^# .*$/m.test(parsed.body)
    ? parsed.body.replace(/^# .*$/m, `# ${title}`)
    : `# ${title}\n\n${parsed.body}`;
  const nextMeta = tilePath.startsWith("uploads/")
    ? { ...parsed.meta, original_name: title }
    : parsed.meta;
  await writeWorkspaceFile(id, tilePath, withJsonFrontmatter(nextMeta, nextBody));

  return NextResponse.json(await getProjectSnapshot(id, user.userId));
}
