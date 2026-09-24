import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROJECT_SUPPORT_METADATA_PATHS } from "@/lib/project-file-classification";
import { md } from "./helpers";

/**
 * Integration: createProject scaffolding lints clean, and checkProject
 * surfaces graph errors from real files on disk. VIDEO_FS_DATA_ROOT must be
 * set before the workspace module loads, hence the dynamic import.
 */

let dataRoot: string;
let workspace: typeof import("@/lib/workspace");

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(tmpdir(), "vfs-data-"));
  process.env.VIDEO_FS_DATA_ROOT = dataRoot;
  workspace = await import("@/lib/workspace");
});

afterAll(async () => {
  delete process.env.VIDEO_FS_DATA_ROOT;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("workspace checkProject", () => {
  it("keeps project metadata and task records readable during background writes", async () => {
    const project = await workspace.createProject("Concurrent writes");
    const recordPath = "tracking/task.json";
    await workspace.writeWorkspaceFile(project.id, recordPath, JSON.stringify({ status: "queued" }));
    const writes = Promise.all(Array.from({ length: 3 }, async (_, worker) => {
      for (let revision = 0; revision < 25; revision += 1) {
        await workspace.writeWorkspaceFile(project.id, recordPath, JSON.stringify({ worker, revision, status: "running" }));
      }
    }));
    const reads = (async () => {
      for (let index = 0; index < 100; index += 1) {
        expect((await workspace.readProjectMeta(project.id)).name).toBe("Concurrent writes");
        expect(JSON.parse(await workspace.readWorkspaceFile(project.id, recordPath)).status).toMatch(/queued|running/);
      }
    })();
    const results = await Promise.allSettled([writes, reads]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    expect((await workspace.listProjectFiles(project.id)).some(file => file.path.includes(".video-fs-write-"))).toBe(false);
  });

  it("scaffolds a new project that lints clean", async () => {
    const project = await workspace.createProject("Lint Smoke");
    const check = await workspace.checkProject(project.id);
    expect(check.issues.filter((issue) => issue.level === "error")).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it("surfaces graph errors from files on disk", async () => {
    const project = await workspace.createProject("Broken Graph");
    await workspace.writeWorkspaceFile(
      project.id,
      "keyframes/kf_bad.md",
      md(
        {
          id: "kf_bad",
          type: "keyframe",
          status: "generated",
          url: "https://m.example/kf_bad.png",
          depicts: ["char_missing"],
          identity_anchors: [],
        },
        "A frame depicting a reference that does not exist.",
      ),
    );
    const check = await workspace.checkProject(project.id);
    const rules = check.issues
      .filter((issue) => issue.level === "error")
      .map((issue) => issue.rule);
    expect(rules).toContain("missing-ref");
    expect(rules).toContain("anchorless-keyframe");
    expect(check.ok).toBe(false);
  });

  it("excludes every auto-onboarding support file without hiding malformed artifacts", async () => {
    const project = await workspace.createProject("Agent Metadata Boundary");
    // The desktop helper is JavaScript because it is also shipped directly in
    // the Electron bundle.
    // @ts-expect-error The packaged ESM helper intentionally has no TS declaration.
    const { setupAgentProject } = await import("../desktop/agent-setup.mjs");
    await setupAgentProject({
      projectId: project.id,
      state: {
        appUrl: "http://127.0.0.1:3210",
        dataRoot,
        mcp: {
          args: ["--mcp"],
          command: "/Applications/Video FS.app/Contents/MacOS/Video FS",
        },
        pid: process.pid,
        startedAt: new Date().toISOString(),
        token: "test-token-never-persisted",
      },
    });

    const cleanSnapshot = await workspace.getProjectSnapshot(project.id);
    expect(cleanSnapshot.check.ok).toBe(true);
    expect(cleanSnapshot.check.issues.filter((issue) => issue.rule === "parse")).toEqual([]);
    for (const supportPath of PROJECT_SUPPORT_METADATA_PATHS) {
      expect(cleanSnapshot.files.some((file) => file.path === supportPath)).toBe(false);
    }

    await workspace.writeWorkspaceFile(
      project.id,
      "scenes/999-malformed/scene.md",
      "---\n{\"id\":\"scene_broken\",\n---\n# Broken scene\n",
    );
    await workspace.writeWorkspaceFile(
      project.id,
      "keyframes/kf_malformed.md",
      "# A genuine keyframe missing JSON frontmatter\n",
    );
    await workspace.writeWorkspaceFile(
      project.id,
      "scenes/AGENTS.md",
      "# A similarly named file in a record directory is not support metadata\n",
    );

    const broken = await workspace.getProjectSnapshot(project.id);
    const parsePaths = broken.check.issues
      .filter((issue) => issue.rule === "parse")
      .map((issue) => issue.path);
    expect(parsePaths).toContain("scenes/999-malformed/scene.md");
    expect(parsePaths).toContain("keyframes/kf_malformed.md");
    expect(parsePaths).toContain("scenes/AGENTS.md");
    expect(broken.check.ok).toBe(false);
  });
});
