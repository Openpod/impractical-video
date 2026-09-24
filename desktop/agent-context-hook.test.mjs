import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseHookInput,
  runAgentContextHook,
} from "./agent-context-hook.mjs";
import { writePrivateConnectionState } from "./connection-state.mjs";
import { deriveProjectBearerToken } from "./project-binding.mjs";

const projectId = "hook-project";
const token = "private-rotating-token-that-never-leaves-state";
const attachmentId = `att_${"a".repeat(32)}`;
const versionHash = "b".repeat(64);
const contentHash = "c".repeat(64);

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "video-fs-hook-"));
  const dataRoot = path.join(directory, "projects");
  const projectRoot = path.join(dataRoot, projectId);
  const statePath = path.join(directory, "desktop-connection.json");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    path.join(projectRoot, "project.json"),
    `${JSON.stringify({ id: projectId, name: "Hook fixture" })}\n`,
  );
  return { dataRoot, directory, projectRoot, statePath };
}

function contextFixture() {
  const selected = {
    artifactId: "kf_selected",
    contentHash,
    entityRevision: 8,
    kind: "keyframe",
    path: "media/keyframes/kf_history.v1.png",
    title: "do not inject this full prompt or title",
    version: {
      index: 3,
      sha256: versionHash,
      versionId: "kf_selected.v4",
    },
  };
  const pinned = {
    artifactId: "character_hero",
    contentHash: null,
    entityRevision: 2,
    kind: "reference",
    path: "references/character_hero.md",
    title: "Hero",
    version: {
      index: 1,
      sha256: null,
      versionId: "character_hero.v2",
    },
  };
  return {
    activeView: "canvas",
    attachments: [
      {
        attachmentId,
        displayName: "brief.txt",
        media: { durationSeconds: null, height: null, width: null },
        mimeType: "text/plain",
        path: `media/agent-context/${"a".repeat(64)}.txt`,
        sha256: "a".repeat(64),
        size: 12,
      },
    ],
    binding: { appSessionId: "app-session", windowId: "window-main" },
    canvas: { focused: selected, pinned: [pinned], selected: [selected] },
    clearEpoch: 0,
    contextRevision: 7,
    editor: {
      documentRevision: null,
      fps: null,
      playheadTicks: null,
      sceneId: null,
      selectedElements: [],
      selectedKeyframes: [],
      selectedMaskPoints: null,
      selectedTrackIds: [],
      timeRange: null,
    },
    projectId,
    schema: "AgentContextSnapshot@1",
  };
}

async function startFixtureServer({
  context: suppliedContext,
  failTurn = false,
} = {}) {
  const calls = [];
  const context = suppliedContext ?? contextFixture();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    calls.push({
      authorization: request.headers.authorization,
      payload,
    });
    if (payload.tool === "get_agent_context") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ context, staleEntities: [] }));
      return;
    }
    if (payload.tool === "create_agent_turn_snapshot" && !failTurn) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          snapshot: {
            agent: payload.arguments.agent,
            agentSessionId: payload.arguments.agentSessionId,
            context,
            projectId,
            snapshotId: "turn_fixture",
            turnId: payload.arguments.turnId,
            windowId: payload.arguments.windowId,
          },
        }),
      );
      return;
    }
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "revision conflict" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    appUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function writeState(input, appUrl) {
  await writePrivateConnectionState(input.statePath, {
    appUrl,
    dataRoot: input.dataRoot,
    mcp: { args: ["--mcp"], command: "/Applications/Video FS" },
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token,
  });
}

function hookInput(input) {
  return {
    cwd: input.projectRoot,
    hook_event_name: "UserPromptSubmit",
    permission_mode: "default",
    session_id: "agent-session",
    turn_id: "turn-request",
    user_prompt:
      "FULL SECRET PROMPT provider_secret=fal-provider-value /private/source/path",
  };
}

test("Claude hook freezes a revision-bound turn and injects compact safe context", async () => {
  const input = await fixture();
  const fixtureServer = await startFixtureServer();
  await writeState(input, fixtureServer.appUrl);
  try {
    const result = await runAgentContextHook({
      agent: "claude",
      input: hookInput(input),
      projectId,
      statePath: input.statePath,
    });
    assert.equal(result.contextInjected, true);
    assert.equal(result.snapshotId, "turn_fixture");
    const context = result.output.hookSpecificOutput.additionalContext;
    assert.match(context, /turn_snapshot: turn_fixture/);
    assert.match(context, /context_revision: 7/);
    assert.match(context, /active_view: canvas/);
    assert.match(
      context,
      new RegExp(
        `selected: keyframe:kf_selected path=media/keyframes/kf_history.v1.png version=kf_selected.v4 index=3 version_sha256=${versionHash} content_sha256=${contentHash} entity_revision=8`,
      ),
    );
    assert.match(
      context,
      /pinned: reference:character_hero path=references\/character_hero\.md version=character_hero\.v2 index=1/,
    );
    assert.match(context, new RegExp(`ready_attachments: ${attachmentId}`));
    assert.match(
      context,
      /resource: videofs:\/\/agent-context\/turns\/turn_fixture/,
    );
    for (const forbidden of [
      token,
      input.projectRoot,
      "FULL SECRET PROMPT",
      "fal-provider-value",
      "/private/source/path",
      "do not inject this full prompt or title",
      "brief.txt",
    ]) {
      assert.doesNotMatch(context, new RegExp(forbidden.replaceAll("/", "\\/")));
    }
    assert.deepEqual(
      fixtureServer.calls.map((call) => call.payload.tool),
      ["get_agent_context", "create_agent_turn_snapshot"],
    );
    assert.ok(
      fixtureServer.calls.every(
        (call) =>
          call.authorization ===
          `Bearer ${deriveProjectBearerToken(token, input.dataRoot, projectId)}`,
      ),
    );
    assert.deepEqual(fixtureServer.calls[1].payload.arguments, {
      agent: "claude",
      agentSessionId: "agent-session",
      expectedContextRevision: 7,
      projectId,
      turnId: "turn-request",
      windowId: "window-main",
    });
  } finally {
    await fixtureServer.close();
  }
});

test("Codex emits model-visible additional context with the same immutable resource", async () => {
  const input = await fixture();
  const fixtureServer = await startFixtureServer();
  await writeState(input, fixtureServer.appUrl);
  try {
    const result = await runAgentContextHook({
      agent: "codex",
      input: hookInput(input),
      projectId,
      statePath: input.statePath,
    });
    assert.equal(result.contextInjected, true);
    assert.equal(result.output.continue, true);
    assert.match(
      result.output.hookSpecificOutput.additionalContext,
      /videofs:\/\/agent-context\/turns\/turn_fixture/,
    );
    assert.match(
      result.output.hookSpecificOutput.additionalContext,
      /path=media\/keyframes\/kf_history\.v1\.png/,
    );
    assert.doesNotMatch(
      result.output.hookSpecificOutput.additionalContext,
      /FULL SECRET PROMPT|private-rotating-token|\/private\/source\/path/,
    );
  } finally {
    await fixtureServer.close();
  }
});

test("Editor media-bin focus injects exact artifact identity without inactive Canvas selection", async () => {
  const input = await fixture();
  const focusedArtifact = {
    artifactId: "clip_editor_history",
    contentHash,
    entityRevision: 9,
    kind: "video",
    path: "media/clips/clip_editor_history.v1.mp4",
    title: "not serialized",
    version: {
      index: 0,
      sha256: versionHash,
      versionId: "v1",
    },
  };
  const context = contextFixture();
  context.activeView = "editor";
  context.editor.focusedArtifact = focusedArtifact;
  const fixtureServer = await startFixtureServer({ context });
  await writeState(input, fixtureServer.appUrl);
  try {
    const result = await runAgentContextHook({
      agent: "claude",
      input: hookInput(input),
      projectId,
      statePath: input.statePath,
    });
    const compact = result.output.hookSpecificOutput.additionalContext;
    assert.match(
      compact,
      new RegExp(
        `editor_focused: video:clip_editor_history path=media/clips/clip_editor_history.v1.mp4 version=v1 index=0 version_sha256=${versionHash} content_sha256=${contentHash} entity_revision=9`,
      ),
    );
    assert.doesNotMatch(compact, /selected: keyframe:kf_selected/);
  } finally {
    await fixtureServer.close();
  }
});

test("offline and revision-race paths fail open without cached context", async () => {
  const input = await fixture();
  const fixtureServer = await startFixtureServer();
  await writeState(input, fixtureServer.appUrl);
  const first = await runAgentContextHook({
    agent: "claude",
    input: hookInput(input),
    projectId,
    statePath: input.statePath,
  });
  assert.equal(first.contextInjected, true);
  await fixtureServer.close();

  const offline = await runAgentContextHook({
    agent: "claude",
    input: hookInput(input),
    projectId,
    statePath: input.statePath,
  });
  assert.equal(offline.contextInjected, false);
  assert.equal(offline.output.continue, true);
  assert.match(offline.output.systemMessage, /not injected/);
  assert.doesNotMatch(JSON.stringify(offline.output), /turn_fixture|kf_selected/);

  const raceServer = await startFixtureServer({ failTurn: true });
  await writeState(input, raceServer.appUrl);
  try {
    const race = await runAgentContextHook({
      agent: "codex",
      input: hookInput(input),
      projectId,
      statePath: input.statePath,
    });
    assert.equal(race.contextInjected, false);
    assert.equal(race.output.continue, true);
    assert.doesNotMatch(JSON.stringify(race.output), /turn_fixture|kf_selected/);
  } finally {
    await raceServer.close();
  }
});

test("hook parsing ignores prompt text and outside-project execution fails open", async () => {
  const input = await fixture();
  const parsed = parseHookInput(JSON.stringify(hookInput(input)));
  assert.deepEqual(parsed, {
    cwd: input.projectRoot,
    sessionId: "agent-session",
    turnId: "turn-request",
  });
  assert.doesNotMatch(JSON.stringify(parsed), /FULL SECRET PROMPT/);

  const fixtureServer = await startFixtureServer();
  await writeState(input, fixtureServer.appUrl);
  try {
    const result = await runAgentContextHook({
      agent: "codex",
      input: { ...hookInput(input), cwd: input.directory },
      projectId,
      statePath: input.statePath,
    });
    assert.equal(result.contextInjected, false);
    assert.equal(result.output.continue, true);
    assert.equal(fixtureServer.calls.length, 0);
  } finally {
    await fixtureServer.close();
  }
});

test("compact context omits unresolved, absolute, and traversal artifact paths", async () => {
  const input = await fixture();
  const unsafeContext = contextFixture();
  unsafeContext.canvas.selected = [
    {
      ...unsafeContext.canvas.selected[0],
      artifactId: "kf_absolute",
      path: `${input.projectRoot}/media/keyframes/secret.png`,
    },
    {
      ...unsafeContext.canvas.selected[0],
      artifactId: "kf_traversal",
      path: "../outside.png",
    },
    {
      ...unsafeContext.canvas.selected[0],
      artifactId: "kf_unresolved",
      path: null,
    },
  ];
  unsafeContext.canvas.focused = unsafeContext.canvas.selected[0];
  const fixtureServer = await startFixtureServer({ context: unsafeContext });
  await writeState(input, fixtureServer.appUrl);
  try {
    const result = await runAgentContextHook({
      agent: "codex",
      input: hookInput(input),
      projectId,
      statePath: input.statePath,
    });
    assert.equal(result.contextInjected, true);
    const compact =
      result.output.hookSpecificOutput.additionalContext;
    assert.match(compact, /keyframe:kf_absolute path=none/);
    assert.match(compact, /keyframe:kf_traversal path=none/);
    assert.match(compact, /keyframe:kf_unresolved path=none/);
    assert.doesNotMatch(
      compact,
      new RegExp(
        `${input.projectRoot.replaceAll("/", "\\/")}|\\.\\.\\/outside\\.png`,
      ),
    );
  } finally {
    await fixtureServer.close();
  }
});
