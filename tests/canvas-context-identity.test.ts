import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { md } from "./helpers";

vi.mock("server-only", () => ({}));

const originalEnvironment = { ...process.env };
let dataRoot = "";
let projectId = "";
let workspace: typeof import("@/lib/workspace");

function digest(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

beforeEach(async () => {
  process.env = { ...originalEnvironment };
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "video-fs-canvas-context-"));
  process.env.APP_MODE = "local";
  process.env.VIDEO_FS_DATA_ROOT = dataRoot;
  vi.resetModules();
  workspace = await import("@/lib/workspace");
  projectId = (await workspace.createProject("Historical identity")).id;
});

afterEach(async () => {
  process.env = { ...originalEnvironment };
  vi.resetModules();
  if (dataRoot) await rm(dataRoot, { force: true, recursive: true });
  dataRoot = "";
  projectId = "";
});

describe("Canvas historical-version byte identity", () => {
  it("resolves selected v1 bytes while v2 is current, then detects a pre-acknowledgement change", async () => {
    const v1 = Buffer.from("historical-version-one");
    const v2 = Buffer.from("current-version-two");
    const sourcePath = "keyframes/kf_history.md";
    const v1Path = "media/keyframes/kf_history.v1.png";
    const v2Path = "media/keyframes/kf_history.v2.png";
    await workspace.writeWorkspaceBinaryFile(projectId, v1Path, v1);
    await workspace.writeWorkspaceBinaryFile(projectId, v2Path, v2);
    await workspace.writeWorkspaceFile(
      projectId,
      sourcePath,
      md(
        {
          id: "kf_history",
          local_path: v2Path,
          status: "generated",
          type: "keyframe",
          version: 2,
          versions: [
            { local_path: v1Path, version: 1 },
            { local_path: v2Path, version: 2 },
          ],
        },
        "The current record points to v2.",
      ),
    );

    const { resolveCanvasContextIdentity, verifyCanvasContextIdentity } =
      await import("@/lib/canvas-context-identity");
    const resolved = await resolveCanvasContextIdentity(projectId, {
      artifactId: "kf_history",
      kind: "keyframe",
      sourcePath,
      title: "Historical frame",
      version: {
        index: 0,
        path: v1Path,
        revision: 1,
        versionId: "v1",
      },
    });

    expect(resolved).toEqual({
      artifactId: "kf_history",
      contentHash: digest(v1),
      entityRevision: 1,
      kind: "keyframe",
      path: v1Path,
      title: "Historical frame",
      version: {
        index: 0,
        sha256: digest(v1),
        versionId: "v1",
      },
    });
    expect(resolved.contentHash).not.toBe(digest(v2));
    expect(await verifyCanvasContextIdentity(projectId, [resolved])).toEqual(
      [],
    );

    const changedV1 = Buffer.from("historical-version-one-changed");
    await workspace.writeWorkspaceBinaryFile(projectId, v1Path, changedV1);
    expect(await verifyCanvasContextIdentity(projectId, [resolved])).toEqual([
      {
        actualHash: digest(changedV1),
        entityId: "kf_history",
        expectedHash: digest(v1),
        reason: "hash_mismatch",
      },
    ]);
  });
});
