import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let dataRoot: string | null = null;

async function loadWorkspaceWithTempRoot() {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "video-fs-prompts-"));
  process.env.APP_MODE = "local";
  process.env.VIDEO_FS_DATA_ROOT = dataRoot;
  vi.resetModules();
  const workspace = await import("@/lib/workspace");
  const route = await import("@/app/api/projects/[id]/prompts/route");
  return { ...workspace, POST: route.POST };
}

afterEach(async () => {
  if (dataRoot) {
    await rm(dataRoot, { force: true, recursive: true });
    dataRoot = null;
  }
  delete process.env.VIDEO_FS_DATA_ROOT;
  delete process.env.APP_MODE;
  vi.resetModules();
});

describe("prompts route", () => {
  it("preserves planned prompt frontmatter while saving an edited prompt body", async () => {
    const {
      createProject,
      parseJsonFrontmatter,
      readWorkspaceFile,
      withJsonFrontmatter,
      writeWorkspaceFile,
      POST,
    } = await loadWorkspaceWithTempRoot();
    const project = await createProject("Prompt route test");
    await writeWorkspaceFile(
      project.id,
      "prompts/asset_clip_1.prompt.md",
      withJsonFrontmatter(
        {
          id: "prompt_asset_clip_1",
          type: "prompt",
          status: "planned",
          clip_id: "clip_1",
          compiler: "composeClipPrompt:v3",
          compiler_hash: "originalhash",
          built_against: { kf_1: "abc123" },
        },
        "Original planned prompt.",
      ),
    );

    const response = await POST(
      new Request("http://test.local/api/projects/test/prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourcePath: "prompts/asset_clip_1.prompt.md",
          title: "Clip 1",
          text: "Edited prompt body.",
        }),
      }),
      { params: Promise.resolve({ id: project.id }) },
    );

    expect(response.status).toBe(200);
    const saved = await readWorkspaceFile(project.id, "prompts/asset_clip_1.prompt.md");
    const parsed = parseJsonFrontmatter(saved);
    expect(parsed.meta).toMatchObject({
      id: "prompt_asset_clip_1",
      type: "prompt",
      clip_id: "clip_1",
      compiler_hash: "originalhash",
    });
    expect(parsed.body.trim()).toBe("Edited prompt body.");
  });
});
