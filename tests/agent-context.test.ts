import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const originalEnvironment = { ...process.env };
let dataRoot = "";
let projectId = "";

function emptyCanvas() {
  return { focused: null, pinned: [], selected: [] };
}

function emptyEditor() {
  return {
    documentRevision: null,
    fps: null,
    focusedArtifact: null,
    focusedPlacement: null,
    playheadTicks: null,
    sceneId: null,
    selectedElements: [],
    selectedKeyframes: [],
    selectedMaskPoints: null,
    selectedTrackIds: [],
    timeRange: null,
  };
}

function patchInput(overrides: Record<string, unknown> = {}) {
  return {
    activeView: "canvas",
    appSessionId: "app_session_1",
    attachmentIds: [],
    baseContextRevision: 0,
    canvas: emptyCanvas(),
    clear: false,
    editor: emptyEditor(),
    projectId,
    projectRevision: null,
    windowId: "window_1",
    ...overrides,
  };
}

async function loadContext() {
  return import("@/lib/agent-context");
}

async function allFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const candidate = path.join(directory, entry.name);
      return entry.isDirectory() ? allFiles(candidate) : [candidate];
    }),
  );
  return nested.flat();
}

beforeEach(async () => {
  process.env = { ...originalEnvironment };
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "video-fs-agent-context-"));
  process.env.APP_MODE = "local";
  process.env.VIDEO_FS_DATA_ROOT = dataRoot;
  vi.resetModules();
  const { createProject } = await import("@/lib/workspace");
  projectId = (await createProject("Agent context test")).id;
});

afterEach(async () => {
  process.env = { ...originalEnvironment };
  vi.resetModules();
  if (dataRoot) await rm(dataRoot, { force: true, recursive: true });
  dataRoot = "";
  projectId = "";
});

describe("AgentContextSnapshot@1 storage", () => {
  it("preserves ordered Canvas multi-selection and records explicit clears", async () => {
    const { writeWorkspaceFile } = await import("@/lib/workspace");
    await writeWorkspaceFile(projectId, "keyframes/first.md", "first");
    await writeWorkspaceFile(projectId, "keyframes/second.md", "second");
    const { patchCurrentAgentContext, readAgentContextRevision } =
      await loadContext();
    const selected = [
      {
        artifactId: "first",
        contentHash: null,
        entityRevision: 2,
        kind: "keyframe",
        path: "keyframes/first.md",
        title: "First",
        version: { index: 1, sha256: null, versionId: "v2" },
      },
      {
        artifactId: "second",
        contentHash: null,
        entityRevision: 4,
        kind: "keyframe",
        path: "keyframes/second.md",
        title: "Second",
        version: { index: 0, sha256: null, versionId: "v1" },
      },
    ];
    const first = await patchCurrentAgentContext(
      projectId,
      patchInput({
        canvas: { focused: selected[1], pinned: [], selected },
      }) as never,
    );

    expect(first.schema).toBe("AgentContextSnapshot@1");
    expect(first.contextRevision).toBe(1);
    expect(first.canvas.selected.map((item) => item.artifactId)).toEqual([
      "first",
      "second",
    ]);
    expect(first.canvas.focused?.version?.versionId).toBe("v1");

    const cleared = await patchCurrentAgentContext(
      projectId,
      patchInput({
        baseContextRevision: 1,
        clear: true,
      }) as never,
    );
    expect(cleared.contextRevision).toBe(2);
    expect(cleared.clearEpoch).toBe(1);
    expect(cleared.canvas).toEqual(emptyCanvas());
    expect(cleared.editor).toEqual(emptyEditor());
    expect((await readAgentContextRevision(projectId, 1)).canvas.selected).toHaveLength(2);
  });

  it("uses compare-and-swap so concurrent writers cannot lose an update", async () => {
    const { patchCurrentAgentContext } = await loadContext();
    const results = await Promise.allSettled([
      patchCurrentAgentContext(
        projectId,
        patchInput({
          activeView: "editor",
          appSessionId: "session_a",
        }) as never,
      ),
      patchCurrentAgentContext(
        projectId,
        patchInput({
          activeView: "editor",
          appSessionId: "session_b",
        }) as never,
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejection?.reason).toMatchObject({
      code: "AGENT_CONTEXT_REVISION_CONFLICT",
      status: 409,
    });
  });

  it("does not allocate a revision when restart metadata changes but semantic context is identical", async () => {
    const {
      agentContextEventBus,
      patchCurrentAgentContext,
    } = await loadContext();
    const events: Array<{ kind: string; projectId: string }> = [];
    const listener = (event: { kind: string; projectId: string }) => {
      events.push(event);
    };
    agentContextEventBus.on("project", listener as never);
    try {
      const first = await patchCurrentAgentContext(
        projectId,
        patchInput({
          activeView: "editor",
          appSessionId: "app_before_restart",
          projectRevision: "workspace_revision_before",
          windowId: "window_before_restart",
        }) as never,
      );
      const contextDirectory = path.join(
        dataRoot,
        projectId,
        ".video-fs",
        "agent-context",
      );
      const currentPath = path.join(contextDirectory, "current.json");
      const before = await readFile(currentPath);
      const revisionsBefore = await readdir(
        path.join(contextDirectory, "revisions"),
      );

      const restarted = await patchCurrentAgentContext(
        projectId,
        patchInput({
          activeView: "editor",
          appSessionId: "app_after_restart",
          baseContextRevision: first.contextRevision,
          projectRevision: "workspace_revision_after",
          windowId: "window_after_restart",
        }) as never,
      );

      expect(restarted).toEqual(first);
      expect(await readFile(currentPath)).toEqual(before);
      expect(
        await readdir(path.join(contextDirectory, "revisions")),
      ).toEqual(revisionsBefore);
      expect(events).toEqual([
        expect.objectContaining({
          kind: "agent_context.changed",
          projectId,
        }),
      ]);
    } finally {
      agentContextEventBus.off("project", listener as never);
    }
  });

  it("acknowledges removed placement identity and clears the indicator count", async () => {
    const { writeWorkspaceFile } = await import("@/lib/workspace");
    const bytes = "editor-media-bin-v1";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeWorkspaceFile(
      projectId,
      "media/clips/editor_history.v1.mp4",
      bytes,
    );
    const { patchCurrentAgentContext, readAgentContextStatus } =
      await loadContext();
    const focusedArtifact = {
      artifactId: "editor_history",
      contentHash: sha256,
      entityRevision: 3,
      kind: "video",
      path: "media/clips/editor_history.v1.mp4",
      title: "Editor history",
      version: { index: 0, sha256, versionId: "v1" },
    };
    const snapshot = await patchCurrentAgentContext(
      projectId,
      patchInput({
        activeView: "editor",
        editor: {
          ...emptyEditor(),
          documentRevision: 8,
          focusedArtifact,
          focusedPlacement: {
            elementId: "placement-a",
            status: "removed",
          },
        },
      }) as never,
    );
    expect(snapshot.editor.focusedArtifact).toEqual(focusedArtifact);
    expect(snapshot.editor.focusedPlacement).toEqual({
      elementId: "placement-a",
      status: "removed",
    });
    const acknowledged = await readAgentContextStatus(projectId);
    expect(acknowledged.visibleCount).toBe(1);
    const { agentContextIndicatorPresentation } = await import(
      "@/app/projects/[id]/agent-context-publisher"
    );
    expect(
      agentContextIndicatorPresentation({
        approvalRequired: false,
        connected: true,
        contextRevision: snapshot.contextRevision,
        staleCount: 0,
        syncing: false,
        visibleCount: acknowledged.visibleCount,
      }).label,
    ).toBe("Agent sees 1 item");

    await patchCurrentAgentContext(
      projectId,
      patchInput({
        activeView: "editor",
        baseContextRevision: snapshot.contextRevision,
        clear: true,
      }) as never,
    );
    const cleared = await readAgentContextStatus(projectId);
    expect(cleared.visibleCount).toBe(0);
    expect(
      agentContextIndicatorPresentation({
        approvalRequired: false,
        connected: true,
        contextRevision: snapshot.contextRevision + 1,
        staleCount: 0,
        syncing: false,
        visibleCount: cleared.visibleCount,
      }).label,
    ).toBe("Context off");
  });

  it("emits structured, project-scoped context and turn events", async () => {
    const {
      agentContextEventBus,
      createAgentTurnSnapshot,
      patchCurrentAgentContext,
    } = await loadContext();
    const events: Array<{ kind: string; projectId: string }> = [];
    const listener = (event: { kind: string; projectId: string }) => {
      events.push(event);
    };
    agentContextEventBus.on("project", listener as never);
    try {
      await patchCurrentAgentContext(projectId, patchInput() as never);
      await createAgentTurnSnapshot(projectId, {
        agent: "codex",
        agentSessionId: "event_session",
        projectId,
        turnId: "event_turn",
        windowId: "window_1",
      });
    } finally {
      agentContextEventBus.off("project", listener as never);
    }
    expect(events).toEqual([
      expect.objectContaining({
        kind: "agent_context.changed",
        projectId,
      }),
      expect.objectContaining({
        kind: "agent_context.turn_snapshot",
        projectId,
      }),
    ]);
  });

  it("freezes independent immutable turn snapshots for two agent sessions", async () => {
    const {
      createAgentTurnSnapshot,
      patchCurrentAgentContext,
      readAgentTurnSnapshot,
    } = await loadContext();
    await patchCurrentAgentContext(projectId, patchInput() as never);
    const [claudeTurn, codexTurn] = await Promise.all([
      createAgentTurnSnapshot(projectId, {
        agent: "claude",
        agentSessionId: "claude_session",
        projectId,
        turnId: null,
        windowId: "window_1",
      }),
      createAgentTurnSnapshot(projectId, {
        agent: "codex",
        agentSessionId: "codex_session",
        projectId,
        turnId: "turn_1",
        windowId: "window_1",
      }),
    ]);
    await patchCurrentAgentContext(
      projectId,
      patchInput({ baseContextRevision: 1, clear: true }) as never,
    );

    expect(claudeTurn.context.contextRevision).toBe(1);
    expect(codexTurn.context.contextRevision).toBe(1);
    expect(claudeTurn.snapshotId).not.toBe(codexTurn.snapshotId);
    expect(
      (await readAgentTurnSnapshot(projectId, claudeTurn.snapshotId)).context
        .contextRevision,
    ).toBe(1);
    expect(
      (await readAgentTurnSnapshot(projectId, codexTurn.snapshotId)).context
        .contextRevision,
    ).toBe(1);
  });

  it("returns structured stale-entity and window-binding errors", async () => {
    const { writeWorkspaceFile } = await import("@/lib/workspace");
    const initial = Buffer.from("original");
    const digest = createHash("sha256").update(initial).digest("hex");
    await writeWorkspaceFile(projectId, "keyframes/stale.md", initial.toString());
    const { createAgentTurnSnapshot, patchCurrentAgentContext } =
      await loadContext();
    const artifact = {
      artifactId: "stale",
      contentHash: digest,
      entityRevision: 1,
      kind: "keyframe",
      path: "keyframes/stale.md",
      title: "Stale",
      version: null,
    };
    await patchCurrentAgentContext(
      projectId,
      patchInput({
        canvas: { focused: artifact, pinned: [], selected: [artifact] },
      }) as never,
    );

    await expect(
      createAgentTurnSnapshot(projectId, {
        agent: "codex",
        agentSessionId: "codex_session",
        projectId,
        turnId: "turn_wrong_window",
        windowId: "window_2",
      }),
    ).rejects.toMatchObject({ code: "AGENT_CONTEXT_BINDING_MISMATCH", status: 409 });

    await writeWorkspaceFile(projectId, "keyframes/stale.md", "changed");
    await expect(
      createAgentTurnSnapshot(projectId, {
        agent: "codex",
        agentSessionId: "codex_session",
        projectId,
        turnId: "turn_stale",
        windowId: "window_1",
      }),
    ).rejects.toMatchObject({
      code: "AGENT_CONTEXT_STALE",
      details: {
        staleEntities: [
          expect.objectContaining({
            entityId: "stale",
            reason: "hash_mismatch",
          }),
        ],
      },
      status: 409,
    });
  });
});

describe("agent-context attachments", () => {
  it("sanitizes names, deduplicates by SHA-256, and stores no source path", async () => {
    const { ingestAgentContextAttachment } = await loadContext();
    const bytes = new TextEncoder().encode("same bytes");
    const first = await ingestAgentContextAttachment({
      bytes,
      displayName: "/private/tmp/../../Secret notes?.txt",
      mimeType: "text/plain",
      projectId,
    });
    const second = await ingestAgentContextAttachment({
      bytes,
      displayName: "different-name.txt",
      mimeType: "text/plain",
      projectId,
    });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.manifest.attachmentId).toBe(first.manifest.attachmentId);
    expect(first.manifest.displayName).toBe("Secret notes_.txt");
    expect(first.manifest.path).toMatch(
      /^media\/agent-context\/[a-f0-9]{64}\.txt$/,
    );
    expect(JSON.stringify(first.manifest)).not.toContain("/private/tmp");
    expect(JSON.stringify(first.manifest)).not.toContain("..");
  });

  it("isolates invalid uploads and rejects project-relative traversal", async () => {
    const {
      ingestAgentContextAttachment,
      patchCurrentAgentContext,
      readCurrentAgentContext,
    } =
      await loadContext();
    await expect(
      ingestAgentContextAttachment({
        bytes: new Uint8Array([1, 2, 3]),
        displayName: "payload.exe",
        mimeType: "application/x-msdownload",
        projectId,
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_INVALID", status: 415 });

    await expect(
      patchCurrentAgentContext(
        projectId,
        patchInput({
          canvas: {
            focused: null,
            pinned: [],
            selected: [
              {
                artifactId: "escape",
                contentHash: null,
                entityRevision: null,
                kind: "file",
                path: "../../outside.txt",
                title: "Outside",
                version: null,
              },
            ],
          },
        }) as never,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(readCurrentAgentContext("../outside")).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
      status: 404,
    });

    const contextDirectory = path.join(
      dataRoot,
      projectId,
      ".video-fs",
      "agent-context",
    );
    const files = await allFiles(contextDirectory);
    expect(files.some((file) => file.endsWith(".exe"))).toBe(false);
    expect(files.some((file) => file.includes("payload"))).toBe(false);
  });

  it("recovers after module restart and never persists tokens or absolute roots", async () => {
    process.env.PAPER_MCP_TOKEN = "token_first_rotation_secret";
    const { ingestAgentContextAttachment, patchCurrentAgentContext } =
      await loadContext();
    const attachment = await ingestAgentContextAttachment({
      bytes: new TextEncoder().encode("restart proof"),
      displayName: `${dataRoot}/restart-proof.txt`,
      mimeType: "text/plain",
      projectId,
    });
    await patchCurrentAgentContext(
      projectId,
      patchInput({ attachmentIds: [attachment.manifest.attachmentId] }) as never,
    );

    process.env.PAPER_MCP_TOKEN = "token_second_rotation_secret";
    vi.resetModules();
    const { readCurrentAgentContext } = await loadContext();
    const recovered = await readCurrentAgentContext(projectId);
    expect(recovered.contextRevision).toBe(1);
    expect(recovered.attachments[0]?.sha256).toBe(attachment.manifest.sha256);

    const contextDirectory = path.join(
      dataRoot,
      projectId,
      ".video-fs",
      "agent-context",
    );
    const contents = (
      await Promise.all(
        (await allFiles(contextDirectory))
          .filter((file) => file.endsWith(".json"))
          .map((file) => readFile(file, "utf8")),
      )
    ).join("\n");
    expect(contents).not.toContain("token_first_rotation_secret");
    expect(contents).not.toContain("token_second_rotation_secret");
    expect(contents).not.toContain(dataRoot);
  });
});

describe("agent-context HTTP routes", () => {
  it("exposes current, revision, status, turn, and attachment APIs", async () => {
    const currentRoute = await import(
      "@/app/api/projects/[id]/agent-context/route"
    );
    const statusRoute = await import(
      "@/app/api/projects/[id]/agent-context/status/route"
    );
    const revisionRoute = await import(
      "@/app/api/projects/[id]/agent-context/revisions/[revision]/route"
    );
    const turnRoute = await import(
      "@/app/api/projects/[id]/agent-context/turn-snapshots/route"
    );
    const attachmentRoute = await import(
      "@/app/api/projects/[id]/agent-context/attachments/route"
    );
    const paperRoute = await import("@/app/api/paper/tools/route");
    const params = { params: Promise.resolve({ id: projectId }) };

    const form = new FormData();
    form.set("file", new File(["route attachment"], "route.txt", { type: "text/plain" }));
    const uploadedResponse = await attachmentRoute.POST(
      new Request(`http://local/api/projects/${projectId}/agent-context/attachments`, {
        body: form,
        method: "POST",
      }),
      params,
    );
    expect(uploadedResponse.status).toBe(201);
    const uploaded = await uploadedResponse.json();
    expect(uploaded.attachment).toEqual({
      attachmentId: uploaded.manifest.attachmentId,
      displayName: "route.txt",
      media: {
        durationSeconds: null,
        height: null,
        width: null,
      },
      mimeType: "text/plain",
      path: expect.stringMatching(
        /^media\/agent-context\/[a-f0-9]{64}\.txt$/,
      ),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      size: 16,
    });
    expect(uploaded.attachment).not.toHaveProperty("createdAt");
    expect(uploaded.attachment).not.toHaveProperty("schema");

    const patchResponse = await currentRoute.PATCH(
      new Request(`http://local/api/projects/${projectId}/agent-context`, {
        body: JSON.stringify(
          patchInput({ attachmentIds: [uploaded.manifest.attachmentId] }),
        ),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
      params,
    );
    expect(patchResponse.status).toBe(200);

    const [currentResponse, revisionResponse, statusResponse, turnResponse] =
      await Promise.all([
        currentRoute.GET(new Request("http://local"), params),
        revisionRoute.GET(new Request("http://local"), {
          params: Promise.resolve({ id: projectId, revision: "1" }),
        }),
        statusRoute.GET(new Request("http://local"), params),
        turnRoute.POST(
          new Request("http://local", {
            body: JSON.stringify({
              agent: "codex",
              agentSessionId: "route_session",
              expectedContextRevision: 1,
              projectId,
              turnId: "route_turn",
              windowId: "window_1",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
          params,
        ),
      ]);

    expect(currentResponse.status).toBe(200);
    expect((await currentResponse.json()).context.contextRevision).toBe(1);
    expect(revisionResponse.status).toBe(200);
    expect((await revisionResponse.json()).context.snapshotId).toBe("ctx_1");
    expect(statusResponse.status).toBe(200);
    const statusPayload = await statusResponse.json();
    expect(statusPayload).toMatchObject({
      contextRevision: 1,
      projectId,
      revisionCount: 1,
      setup: {
        claude: {
          configInstalled: false,
          contextHookInstalled: false,
        },
        codex: {
          configInstalled: false,
          contextHookInstalled: false,
        },
        desktopAvailable: false,
      },
      visibleCount: 1,
    });
    expect(JSON.stringify(statusPayload)).not.toContain(dataRoot);
    expect(turnResponse.status).toBe(201);
    const directTurn = (await turnResponse.json()).snapshot;
    expect(directTurn).toMatchObject({
      agentSessionId: "route_session",
      context: { contextRevision: 1 },
      projectId,
      windowId: "window_1",
    });
    expect(directTurn.context.attachments).toEqual([uploaded.attachment]);

    process.env.PAPER_MCP_TOKEN = "route-token-not-persisted";
    const unauthorized = await paperRoute.POST(
      new Request("http://local/api/paper/tools", {
        body: JSON.stringify({
          arguments: { projectId },
          tool: "get_agent_context",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(unauthorized.status).toBe(401);

    const paperRequest = (tool: string, arguments_: Record<string, unknown>) =>
      paperRoute.POST(
        new Request("http://local/api/paper/tools", {
          body: JSON.stringify({ arguments: arguments_, tool }),
          headers: {
            authorization: "Bearer route-token-not-persisted",
            "content-type": "application/json",
          },
          method: "POST",
        }),
      );
    const mcpCurrent = await paperRequest("get_agent_context", { projectId });
    expect(mcpCurrent.status).toBe(200);
    expect((await mcpCurrent.json()).context.attachments).toEqual([
      uploaded.attachment,
    ]);
    const mcpAttachment = await paperRequest("get_agent_context_attachment", {
      attachmentId: uploaded.attachment.attachmentId,
      projectId,
    });
    expect(mcpAttachment.status).toBe(200);
    expect(await mcpAttachment.json()).toEqual({
      attachment: uploaded.attachment,
    });
    const mcpTurn = await paperRequest("create_agent_turn_snapshot", {
      agent: "claude",
      agentSessionId: "mcp_session",
      expectedContextRevision: 1,
      projectId,
      turnId: "mcp_turn",
      windowId: "window_1",
    });
    expect(mcpTurn.status).toBe(200);
    const mcpTurnSnapshot = (await mcpTurn.json()).snapshot;
    expect(mcpTurnSnapshot).toMatchObject({
      agent: "claude",
      agentSessionId: "mcp_session",
      context: { attachments: [uploaded.attachment], contextRevision: 1 },
      turnId: "mcp_turn",
    });
    const mcpTurnRead = await paperRequest("get_agent_turn_snapshot", {
      projectId,
      snapshotId: mcpTurnSnapshot.snapshotId,
    });
    expect(mcpTurnRead.status).toBe(200);
    expect((await mcpTurnRead.json()).snapshot.snapshotId).toBe(
      mcpTurnSnapshot.snapshotId,
    );
    const refreshed = await paperRequest("refresh_agent_context", { projectId });
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({
      context: { contextRevision: 1, projectId },
      refreshed: true,
      staleEntities: [],
    });
    const connection = await paperRequest("get_connection_status", { projectId });
    expect(connection.status).toBe(200);
    expect(await connection.json()).toMatchObject({
      connected: true,
      context: { contextRevision: 1, projectId },
      projectId,
      transport: "loopback",
    });
    const rebased = await paperRequest("rebase_agent_context", {
      agent: "codex",
      agentSessionId: "rebase_session",
      projectId,
      turnId: "rebase_turn",
      windowId: "window_1",
    });
    expect(rebased.status).toBe(200);
    expect((await rebased.json()).snapshot).toMatchObject({
      agent: "codex",
      context: { contextRevision: 1 },
      projectId,
      turnId: "rebase_turn",
    });

    const conflictResponse = await currentRoute.PATCH(
      new Request("http://local", {
        body: JSON.stringify(patchInput()),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
      params,
    );
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toMatchObject({
      code: "AGENT_CONTEXT_REVISION_CONFLICT",
      currentContextRevision: 1,
      expectedContextRevision: 0,
    });
  });
});
