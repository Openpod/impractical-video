import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Integration: deleteProject moves the project folder to the trash, and
 * Windows refuses that move while a file in the folder is open.
 * VIDEO_FS_DATA_ROOT must be set before the workspace module loads, hence the
 * dynamic imports.
 */

let dataRoot: string;
let workspace: typeof import("@/lib/workspace");

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(tmpdir(), "vfs-delete-"));
  process.env.VIDEO_FS_DATA_ROOT = path.join(dataRoot, "projects");
  workspace = await import("@/lib/workspace");
});

afterAll(async () => {
  delete process.env.VIDEO_FS_DATA_ROOT;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("workspace deleteProject", () => {
  it("deletes a project while a read of one of its files is still in flight", async () => {
    const project = await workspace.createProject("Busy delete");
    const reader = await open(path.join(workspace.projectRoot(project.id), "project.json"), "r");
    const released = new Promise<void>((resolve) => {
      setTimeout(() => void reader.close().then(resolve), 150);
    });
    try {
      expect((await workspace.deleteProject(project.id)).id).toBe(project.id);
      await expect(workspace.readProjectMeta(project.id)).rejects.toThrow();
    } finally {
      await released;
    }
  });
});
