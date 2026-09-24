import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { md } from "./helpers";

vi.mock("server-only", () => ({}));

const originalEnvironment = { ...process.env };
const ticks = 120_000;
let dataRoot = "";
let projectId = "";
let workspace: typeof import("@/lib/workspace");
let artifact: Awaited<
  ReturnType<
    typeof import("@/lib/canvas-context-identity").resolveCanvasContextIdentity
  >
>;

function editorProject() {
  const at = new Date().toISOString();
  return {
    currentSceneId: "scene-main",
    metadata: {
      createdAt: at,
      duration: 0,
      id: "editor-project",
      name: "Editor agent test",
      updatedAt: at,
    },
    scenes: [
      {
        bookmarks: [],
        createdAt: at,
        id: "scene-main",
        isMain: true,
        name: "Main",
        tracks: {
          audio: [
            {
              elements: [],
              id: "audio-1",
              muted: false,
              name: "Audio 1",
              type: "audio",
            },
          ],
          main: {
            elements: [],
            hidden: false,
            id: "main-track",
            muted: false,
            name: "Main",
            type: "video",
          },
          overlay: [
            {
              elements: [],
              hidden: false,
              id: "overlay-1",
              muted: false,
              name: "Overlay 1",
              type: "video",
            },
          ],
        },
        updatedAt: at,
      },
    ],
    settings: {
      background: { color: "#000000", type: "color" },
      canvasSize: { height: 1080, width: 1920 },
      fps: { denominator: 1, numerator: 30 },
    },
    version: 1,
  };
}

async function writeEditorDocument() {
  await workspace.writeWorkspaceFile(
    projectId,
    "editor/opencut-project.json",
    JSON.stringify({
      mediaMap: {
        kf_editor: {
          kind: "image",
          mediaId: "media-kf-editor",
          name: "Editor frame",
          sourceKey: `/api/projects/${projectId}/media/keyframes/kf_editor.v1.png`,
        },
      },
      pendingPlacements: [],
      project: editorProject(),
      revision: 1,
      source: "client",
      updatedAt: new Date().toISOString(),
    }),
  );
}

function mutationBase(revision: number, suffix: string) {
  return {
    actor: { id: "codex-test", type: "agent" as const },
    baseEditorRevision: revision,
    commandId: `cmd-${suffix}`,
    idempotencyKey: `idem-${suffix}`,
    origin: "codex" as const,
    projectId,
    sceneId: "scene-main",
  };
}

function target(elementId: string, trackId: string) {
  return { artifact, elementId, trackId };
}

beforeEach(async () => {
  process.env = { ...originalEnvironment };
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "video-fs-editor-mcp-"));
  process.env.APP_MODE = "local";
  process.env.VIDEO_FS_DATA_ROOT = dataRoot;
  vi.resetModules();
  workspace = await import("@/lib/workspace");
  projectId = (await workspace.createProject("Editor agent test")).id;
  const mediaPath = "media/keyframes/kf_editor.v1.png";
  await workspace.writeWorkspaceBinaryFile(
    projectId,
    mediaPath,
    Buffer.from("exact-editor-frame"),
  );
  await workspace.writeWorkspaceFile(
    projectId,
    "keyframes/kf_editor.md",
    md(
      {
        id: "kf_editor",
        local_path: mediaPath,
        status: "generated",
        type: "keyframe",
        version: 1,
        versions: [{ local_path: mediaPath, version: 1 }],
      },
      "Editor frame",
    ),
  );
  const { resolveCanvasContextIdentity } = await import(
    "@/lib/canvas-context-identity"
  );
  artifact = await resolveCanvasContextIdentity(projectId, {
    artifactId: "kf_editor",
    kind: "keyframe",
    sourcePath: "keyframes/kf_editor.md",
    title: "Editor frame",
    version: {
      index: 0,
      path: mediaPath,
      revision: 1,
      versionId: "v1",
    },
  });
  await writeEditorDocument();
});

afterEach(async () => {
  process.env = { ...originalEnvironment };
  vi.resetModules();
  if (dataRoot) await rm(dataRoot, { force: true, recursive: true });
  dataRoot = "";
  projectId = "";
});

describe("canonical Editor timeline commands", () => {
  it("runs insert/move/trim/split/remove with CAS, exact identity, idempotency, events, and recoverable history", async () => {
    const {
      executeEditorTimelineCommand,
      getEditorTimeline,
    } = await import("@/lib/editor-timeline-commands");
    const { editorEventBus } = await import("@/lib/editor-events");
    const events: Array<{ commandId: string; kind: string }> = [];
    const listener = (event: { commandId: string; kind: string }) =>
      events.push(event);
    editorEventBus.on("project", listener as never);
    try {
      expect((await getEditorTimeline(projectId)).revision).toBe(1);
      const insertInput = {
        ...mutationBase(1, "insert"),
        artifact,
        durationTicks: ticks * 10,
        elementId: "element-kf-editor",
        startTimeTicks: 0,
        tool: "editor_timeline_insert" as const,
        trackId: "main-track",
      };
      const inserted = await executeEditorTimelineCommand(insertInput);
      expect(inserted).toMatchObject({
        affectedElementIds: ["element-kf-editor"],
        idempotentReplay: false,
        newRevision: 2,
        priorRevision: 1,
        recoverable: true,
      });
      expect(await executeEditorTimelineCommand(insertInput)).toMatchObject({
        idempotentReplay: true,
        newRevision: 2,
      });

      await expect(
        executeEditorTimelineCommand({
          ...mutationBase(1, "stale"),
          newStartTimeTicks: ticks,
          target: target("element-kf-editor", "main-track"),
          targetTrackId: "overlay-1",
          tool: "editor_timeline_move",
        }),
      ).rejects.toMatchObject({ code: "EDITOR_REVISION_CONFLICT" });

      const moved = await executeEditorTimelineCommand({
        ...mutationBase(2, "move"),
        newStartTimeTicks: ticks,
        target: target("element-kf-editor", "main-track"),
        targetTrackId: "overlay-1",
        tool: "editor_timeline_move",
      });
      expect(moved).toMatchObject({ newRevision: 3, priorRevision: 2 });

      const trimmed = await executeEditorTimelineCommand({
        ...mutationBase(3, "trim"),
        durationTicks: ticks * 8,
        target: target("element-kf-editor", "overlay-1"),
        tool: "editor_timeline_trim",
        trimEndTicks: ticks,
        trimStartTicks: ticks,
      });
      expect(trimmed.newRevision).toBe(4);

      const split = await executeEditorTimelineCommand({
        ...mutationBase(4, "split"),
        rightElementId: "element-kf-editor-right",
        splitTimeTicks: ticks * 5,
        target: target("element-kf-editor", "overlay-1"),
        tool: "editor_timeline_split",
      });
      expect(split).toMatchObject({
        affectedElementIds: [
          "element-kf-editor",
          "element-kf-editor-right",
        ],
        newRevision: 5,
      });

      const removed = await executeEditorTimelineCommand({
        ...mutationBase(5, "remove"),
        targets: [target("element-kf-editor-right", "overlay-1")],
        tool: "editor_timeline_remove",
      });
      expect(removed).toMatchObject({
        affectedElementIds: ["element-kf-editor-right"],
        newRevision: 6,
        recoverable: true,
      });
      const removedInverse = removed.inverse;
      if (!("tracks" in removedInverse)) {
        throw new Error("Expected a tracks inverse on the remove receipt.");
      }
      expect(
        removedInverse.tracks.overlay[0]?.elements.map(
          (element: { id: string }) => element.id,
        ),
      ).toContain("element-kf-editor-right");

      const doc = JSON.parse(
        await workspace.readWorkspaceFile(
          projectId,
          "editor/opencut-project.json",
        ),
      );
      expect(doc.revision).toBe(6);
      expect(doc.source).toBe("agent");
      expect(doc.commandHistory).toHaveLength(5);
      expect(doc.commandHistory.at(-1)).toMatchObject({
        actor: { id: "codex-test", type: "agent" },
        command: "editor_timeline_remove",
        origin: "codex",
        recoverable: true,
        status: "completed",
      });
      expect(
        doc.project.scenes[0].tracks.overlay[0].elements.map(
          (element: { id: string }) => element.id,
        ),
      ).toEqual(["element-kf-editor"]);
    } finally {
      editorEventBus.off("project", listener as never);
    }
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandId: "cmd-insert",
          kind: "editor.command.accepted",
        }),
        expect.objectContaining({
          commandId: "cmd-insert",
          kind: "editor.command.completed",
        }),
        expect.objectContaining({
          commandId: "cmd-stale",
          kind: "editor.command.failed",
        }),
        expect.objectContaining({
          commandId: "cmd-remove",
          kind: "editor.command.completed",
        }),
      ]),
    );
  });

  it("rejects changed Canvas bytes and preserves the editor document", async () => {
    const { executeEditorTimelineCommand } = await import(
      "@/lib/editor-timeline-commands"
    );
    await executeEditorTimelineCommand({
      ...mutationBase(1, "insert"),
      artifact,
      durationTicks: ticks * 5,
      elementId: "element-exact",
      startTimeTicks: 0,
      tool: "editor_timeline_insert",
      trackId: "main-track",
    });
    await workspace.writeWorkspaceBinaryFile(
      projectId,
      artifact.path,
      Buffer.from("changed-after-context"),
    );
    await expect(
      executeEditorTimelineCommand({
        ...mutationBase(2, "move-after-change"),
        newStartTimeTicks: ticks,
        target: target("element-exact", "main-track"),
        targetTrackId: "overlay-1",
        tool: "editor_timeline_move",
      }),
    ).rejects.toMatchObject({
      code: "EDITOR_ARTIFACT_MISMATCH",
      status: 409,
    });
    const doc = JSON.parse(
      await workspace.readWorkspaceFile(
        projectId,
        "editor/opencut-project.json",
      ),
    );
    expect(doc.revision).toBe(2);
    expect(doc.project.scenes[0].tracks.main.elements[0].startTime).toBe(0);
  });

  it("validates and inserts a versionless uploaded Canvas artifact by its exact record identity", async () => {
    const uploadId = "upload_editor_fixture";
    const uploadRecord = `uploads/${uploadId}.md`;
    const uploadMedia = `media/uploads/${uploadId}.png`;
    await workspace.writeWorkspaceBinaryFile(
      projectId,
      uploadMedia,
      Buffer.from("uploaded-editor-frame"),
    );
    await workspace.writeWorkspaceFile(
      projectId,
      uploadRecord,
      md(
        {
          id: uploadId,
          kind: "image",
          local_path: uploadMedia,
          status: "active",
          type: "upload",
        },
        "Uploaded frame",
      ),
    );
    const { resolveCanvasContextIdentity } = await import(
      "@/lib/canvas-context-identity"
    );
    const uploadArtifact = await resolveCanvasContextIdentity(projectId, {
      artifactId: uploadId,
      kind: "image",
      sourcePath: uploadRecord,
      title: "Uploaded frame",
      version: null,
    });
    const editorDoc = JSON.parse(
      await workspace.readWorkspaceFile(
        projectId,
        "editor/opencut-project.json",
      ),
    );
    editorDoc.mediaMap[uploadId] = {
      kind: "image",
      mediaId: "media-upload",
      name: "Uploaded frame",
      sourceKey: `/api/projects/${projectId}/media/uploads/${uploadId}.png`,
    };
    await workspace.writeWorkspaceFile(
      projectId,
      "editor/opencut-project.json",
      JSON.stringify(editorDoc),
    );
    const { executeEditorTimelineCommand } = await import(
      "@/lib/editor-timeline-commands"
    );
    await expect(
      executeEditorTimelineCommand({
        ...mutationBase(1, "upload-insert"),
        artifact: uploadArtifact,
        durationTicks: ticks * 3,
        elementId: "element-upload",
        startTimeTicks: 0,
        tool: "editor_timeline_insert",
        trackId: "main-track",
      }),
    ).resolves.toMatchObject({
      affectedElementIds: ["element-upload"],
      newRevision: 2,
    });
  });

  it("exposes revisioned commands through the authenticated Paper endpoint", async () => {
    process.env.PAPER_MCP_TOKEN = "editor-route-token";
    const route = await import("@/app/api/paper/tools/route");
    const request = (
      tool: string,
      arguments_: Record<string, unknown>,
      authorized = true,
    ) =>
      route.POST(
        new Request("http://local/api/paper/tools", {
          body: JSON.stringify({ arguments: arguments_, tool }),
          headers: {
            ...(authorized
              ? { authorization: "Bearer editor-route-token" }
              : {}),
            "content-type": "application/json",
          },
          method: "POST",
        }),
      );
    expect(
      (await request("editor_timeline_get", { projectId }, false)).status,
    ).toBe(401);
    const current = await request("editor_timeline_get", { projectId });
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ revision: 1 });

    const inserted = await request("editor_timeline_insert", {
      ...mutationBase(1, "route-insert"),
      artifact,
      durationTicks: ticks * 4,
      elementId: "element-route",
      startTimeTicks: 0,
      trackId: "main-track",
    });
    expect(inserted.status).toBe(200);
    expect(await inserted.json()).toMatchObject({
      affectedElementIds: ["element-route"],
      newRevision: 2,
      priorRevision: 1,
    });
  });
});

describe("editor_edit and editor_structure families", () => {
  it("runs element mutations end to end: insert, update (params/retime), duplicate, split, ripple remove, text", async () => {
    await writeEditorDocument();
    const { executeEditorEditCommand } = await import(
      "@/lib/editor-edit-commands"
    );

    const inserted = await executeEditorEditCommand({
      ...mutationBase(1, "edit-insert"),
      action: "insert",
      artifact,
      durationTicks: 2 * ticks,
      elementId: "el-a",
      placement: { mode: "explicit", trackId: "main-track" },
      startTimeTicks: 0,
    });
    expect(inserted).toMatchObject({
      action: "insert",
      affectedElementIds: ["el-a"],
      command: "editor_edit",
      newRevision: 2,
      schema: "EditorCommandReceipt@2",
    });
    expect(inserted.suggestedCheck).toContain("editor_timeline_get");

    // Params + visibility in ONE update.
    const updated = await executeEditorEditCommand({
      ...mutationBase(2, "edit-update"),
      action: "update",
      hidden: true,
      params: { opacity: 0.5, volume: -6 },
      target: { elementId: "el-a", trackId: "main-track" },
    });
    expect(updated.newRevision).toBe(3);
    let doc = JSON.parse(
      await workspace.readWorkspaceFile(projectId, "editor/opencut-project.json"),
    );
    const element = doc.project.scenes[0].tracks.main.elements.find(
      (entry: { id: string }) => entry.id === "el-a",
    );
    expect(element.hidden).toBe(true);
    expect(element.params).toMatchObject({ opacity: 0.5, volume: -6 });

    // Retime is rejected for non-retimable element types (image here).
    await expect(
      executeEditorEditCommand({
        ...mutationBase(3, "edit-retime-image"),
        action: "update",
        retime: { rate: 2 },
        target: { elementId: "el-a", trackId: "main-track" },
      }),
    ).rejects.toMatchObject({ code: "EDITOR_VALIDATION_FAILED" });

    const duplicated = await executeEditorEditCommand({
      ...mutationBase(3, "edit-duplicate"),
      action: "duplicate",
      newElementId: "el-a-copy",
      target: { elementId: "el-a", trackId: "main-track" },
    });
    expect(duplicated.affectedElementIds).toEqual(["el-a-copy"]);

    const text = await executeEditorEditCommand({
      ...mutationBase(4, "edit-text"),
      action: "insert_text",
      content: "Hello from the agent",
      durationTicks: ticks,
      elementId: "el-text",
      params: { fontSize: 64 },
      startTimeTicks: 0,
    });
    expect(text.affectedElementIds).toEqual(["el-text"]);
    doc = JSON.parse(
      await workspace.readWorkspaceFile(projectId, "editor/opencut-project.json"),
    );
    const textTrack = doc.project.scenes[0].tracks.overlay.find(
      (track: { type: string }) => track.type === "text",
    );
    expect(textTrack).toBeDefined();
    expect(textTrack.elements[0]).toMatchObject({
      id: "el-text",
      params: { content: "Hello from the agent", fontSize: 64 },
      type: "text",
    });

    const split = await executeEditorEditCommand({
      ...mutationBase(5, "edit-split"),
      action: "split",
      retainSide: "both",
      rightElementId: "el-a-right",
      splitTimeTicks: Math.round(ticks / 2),
      target: { elementId: "el-a", trackId: "main-track" },
    });
    expect(split.affectedElementIds).toEqual(["el-a", "el-a-right"]);

    const removed = await executeEditorEditCommand({
      ...mutationBase(6, "edit-remove"),
      action: "remove",
      ripple: true,
      targets: [{ elementId: "el-a", trackId: "main-track" }],
    });
    expect(removed.newRevision).toBe(7);
    doc = JSON.parse(
      await workspace.readWorkspaceFile(projectId, "editor/opencut-project.json"),
    );
    const right = doc.project.scenes[0].tracks.main.elements.find(
      (entry: { id: string }) => entry.id === "el-a-right",
    );
    // Ripple closed the gap left by the removed left half.
    expect(right.startTime).toBe(0);
  });

  it("runs structure mutations: tracks, scenes, bookmarks, settings, undo", async () => {
    await writeEditorDocument();
    const { executeEditorStructureCommand } = await import(
      "@/lib/editor-edit-commands"
    );

    const trackAdded = await executeEditorStructureCommand({
      ...mutationBase(1, "structure-track-add"),
      action: "track_add",
      name: "Music",
      trackId: "audio-2",
      trackType: "audio",
    });
    expect(trackAdded).toMatchObject({
      command: "editor_structure",
      newRevision: 2,
      schema: "EditorCommandReceipt@2",
      summary: { action: "track_add", trackId: "audio-2" },
    });

    await executeEditorStructureCommand({
      ...mutationBase(2, "structure-track-mute"),
      action: "track_update",
      muted: true,
      trackId: "audio-1",
    });

    await expect(
      executeEditorStructureCommand({
        ...mutationBase(3, "structure-remove-main"),
        action: "track_remove",
        trackId: "main-track",
      }),
    ).rejects.toMatchObject({ code: "EDITOR_VALIDATION_FAILED" });

    await executeEditorStructureCommand({
      ...mutationBase(3, "structure-track-remove"),
      action: "track_remove",
      trackId: "audio-2",
    });

    const sceneAdded = await executeEditorStructureCommand({
      ...mutationBase(4, "structure-scene-add"),
      action: "scene_add",
      name: "Scene B",
      newSceneId: "scene-b",
    });
    expect(sceneAdded.summary).toMatchObject({ sceneId: "scene-b" });

    await executeEditorStructureCommand({
      ...mutationBase(5, "structure-scene-switch"),
      action: "scene_switch",
      targetSceneId: "scene-b",
    });

    await executeEditorStructureCommand({
      ...mutationBase(6, "structure-bookmark"),
      action: "bookmark_set",
      note: "beat drop",
      timeTicks: 3 * ticks,
    });

    await executeEditorStructureCommand({
      ...mutationBase(7, "structure-settings"),
      action: "settings_update",
      fps: { denominator: 1, numerator: 24 },
    });

    let doc = JSON.parse(
      await workspace.readWorkspaceFile(projectId, "editor/opencut-project.json"),
    );
    expect(doc.project.currentSceneId).toBe("scene-b");
    expect(doc.project.scenes).toHaveLength(2);
    expect(doc.project.settings.fps).toEqual({ denominator: 1, numerator: 24 });
    expect(
      doc.project.scenes[0].bookmarks.find(
        (bookmark: { time: number }) => bookmark.time === 3 * ticks,
      ),
    ).toMatchObject({ note: "beat drop" });
    expect(doc.project.scenes[0].tracks.audio).toHaveLength(1);
    expect(doc.project.scenes[0].tracks.audio[0].muted).toBe(true);

    // Undo the settings change; the receipt inverse restores 30fps.
    const undone = await executeEditorStructureCommand({
      ...mutationBase(8, "structure-undo"),
      action: "undo",
    });
    expect(undone.summary.undidCommandId).toBe("cmd-structure-settings");
    doc = JSON.parse(
      await workspace.readWorkspaceFile(projectId, "editor/opencut-project.json"),
    );
    expect(doc.project.settings.fps).toEqual({ denominator: 1, numerator: 30 });
  });
});
