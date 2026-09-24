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

type Params = {
  params: Promise<{ id: string }>;
};

function upsertPromptSection(content: string, prompt: string) {
  const section = `## Prompt\n\n${prompt.trim()}\n`;
  const trimmed = content.trimEnd();
  const match = trimmed.match(/(^|\n)## Prompt\n\n[\s\S]*?(?=\n## |\s*$)/);
  if (!match?.index && match?.index !== 0) return `${trimmed}\n\n${section}`;
  const prefix = trimmed.slice(0, match.index + match[1].length);
  const suffix = trimmed.slice(match.index + match[0].length);
  return `${prefix}${section}${suffix ? `${suffix}\n` : ""}`;
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to edit prompts." }, { status: 401 });
  }
  await getProjectSnapshot(id, user.userId);
  const body = await request.json().catch(() => ({}));
  const sourcePath =
    typeof body.sourcePath === "string" ? safeRelativePath(body.sourcePath) : "";
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Prompt";
  const text = typeof body.text === "string" ? body.text.trim() : "";

  if (!text) {
    return NextResponse.json({ error: "Prompt text is required." }, { status: 400 });
  }
  if (
    !(
      /^prompts\/[^/]+\.prompt\.md$/.test(sourcePath) ||
      /^clips\/[^/]+\.md$/.test(sourcePath) ||
      /^keyframes\/[^/]+\.md$/.test(sourcePath)
    )
  ) {
    return NextResponse.json({ error: "Unsupported prompt source path." }, { status: 400 });
  }

  if (sourcePath.startsWith("prompts/")) {
    const current = await readWorkspaceFile(id, sourcePath).catch(() => null);
    if (current) {
      const parsed = parseJsonFrontmatter(current);
      if (parsed.meta.type === "prompt") {
        await writeWorkspaceFile(id, sourcePath, withJsonFrontmatter(parsed.meta, text));
      } else {
        await writeWorkspaceFile(id, sourcePath, `# ${title}\n\n${text}\n`);
      }
    } else {
      await writeWorkspaceFile(id, sourcePath, `# ${title}\n\n${text}\n`);
    }
  } else {
    const current = await readWorkspaceFile(id, sourcePath);
    await writeWorkspaceFile(id, sourcePath, upsertPromptSection(current, text));
  }

  return NextResponse.json(await getProjectSnapshot(id, user.userId));
}
