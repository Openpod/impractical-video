import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import electron from "electron";
import { setupAgentProject } from "./agent-setup.mjs";
import { writePrivateConnectionState } from "./connection-state.mjs";
import { deriveProjectBearerToken } from "./project-binding.mjs";

const projectId = "codex-hook-compat";
const token = "codex-hook-compat-private-token-000000000000";
const snapshotId = "turn_codex_compat";
const selectedSha = "a".repeat(64);
const contentSha = "b".repeat(64);
const mainPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "main.mjs",
);

async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "video-fs-codex-compat-"),
  );
  const dataRoot = path.join(directory, "projects");
  const projectRoot = path.join(dataRoot, projectId);
  const statePath = path.join(directory, "desktop-connection.json");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    path.join(projectRoot, "project.json"),
    `${JSON.stringify({ id: projectId, name: "Codex hook compatibility" })}\n`,
  );
  return { dataRoot, directory, projectRoot, statePath };
}

function context() {
  const selected = {
    artifactId: "kf_codex",
    contentHash: contentSha,
    entityRevision: 4,
    kind: "keyframe",
    path: "media/keyframes/kf_history.v1.png",
    title: "private title is not injected",
    version: {
      index: 2,
      sha256: selectedSha,
      versionId: "kf_codex.v3",
    },
  };
  return {
    activeView: "canvas",
    attachments: [],
    binding: { appSessionId: "app-session", windowId: "window-main" },
    canvas: { focused: selected, pinned: [], selected: [selected] },
    clearEpoch: 0,
    contextRevision: 12,
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

async function startServer() {
  const calls = [];
  const current = context();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    calls.push({
      authorization: request.headers.authorization,
      payload,
    });
    response.setHeader("content-type", "application/json");
    if (payload.tool === "get_agent_context") {
      response.end(JSON.stringify({ context: current, staleEntities: [] }));
      return;
    }
    if (payload.tool === "create_agent_turn_snapshot") {
      response.end(
        JSON.stringify({
          snapshot: {
            agent: "codex",
            agentSessionId: payload.arguments.agentSessionId,
            context: current,
            projectId,
            snapshotId,
            turnId: payload.arguments.turnId,
            windowId: "window-main",
          },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "unknown tool" }));
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

function runInstalledHook({ projectRoot, statePath }) {
  const args = [
    mainPath,
    "--agent-context-hook",
    "--agent",
    "codex",
    "--project-id",
    projectId,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(electron, args, {
      env: {
        ...process.env,
        VIDEO_FS_DESKTOP_STATE_FILE: statePath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Installed hook exited ${code}: ${stderr}`));
        return;
      }
      resolve({ args, output: JSON.parse(stdout), stderr });
    });
    child.stdin.end(
      JSON.stringify({
        cwd: projectRoot,
        hook_event_name: "UserPromptSubmit",
        permission_mode: "default",
        session_id: "codex-session",
        turn_id: "codex-turn",
        user_prompt: "prompt content must not be echoed",
      }),
    );
  });
}

test("installed token-free Codex UserPromptSubmit launcher freezes and injects exact context", async () => {
  const input = await fixture();
  const server = await startServer();
  const state = {
    appUrl: server.appUrl,
    dataRoot: input.dataRoot,
    mcp: { args: [mainPath, "--mcp"], command: electron },
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token,
  };
  await writePrivateConnectionState(input.statePath, state);
  await setupAgentProject({ projectId, state });

  try {
    const hooks = JSON.parse(
      await readFile(
        path.join(input.projectRoot, ".codex", "hooks.json"),
        "utf8",
      ),
    );
    const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.equal(
      command,
      [
        electron,
        mainPath,
        "--agent-context-hook",
        "--agent",
        "codex",
        "--project-id",
        projectId,
      ].join(" "),
    );
    assert.doesNotMatch(command, new RegExp(token));

    const result = await runInstalledHook(input);
    const additionalContext =
      result.output.hookSpecificOutput.additionalContext;
    assert.equal(
      additionalContext,
      [
        "<video-fs-context>",
        `turn_snapshot: ${snapshotId}`,
        "context_revision: 12",
        "active_view: canvas",
        `resource: videofs://agent-context/turns/${snapshotId}`,
        `selected: keyframe:kf_codex path=media/keyframes/kf_history.v1.png version=kf_codex.v3 index=2 version_sha256=${selectedSha} content_sha256=${contentSha} entity_revision=4`,
        "pinned: none",
        `focused: keyframe:kf_codex path=media/keyframes/kf_history.v1.png version=kf_codex.v3 index=2 version_sha256=${selectedSha} content_sha256=${contentSha} entity_revision=4`,
        "ready_attachments: none",
        "</video-fs-context>",
      ].join("\n"),
    );
    assert.equal(result.output.continue, true);
    assert.equal(result.output.suppressOutput, true);
    assert.equal(
      result.output.hookSpecificOutput.hookEventName,
      "UserPromptSubmit",
    );
    assert.doesNotMatch(
      JSON.stringify(result.output),
      /prompt content|private title|private-token/,
    );
    assert.deepEqual(
      server.calls.map((call) => call.payload.tool),
      ["get_agent_context", "create_agent_turn_snapshot"],
    );
    assert.deepEqual(server.calls[1].payload.arguments, {
      agent: "codex",
      agentSessionId: "codex-session",
      expectedContextRevision: 12,
      projectId,
      turnId: "codex-turn",
      windowId: "window-main",
    });
    assert.ok(
      server.calls.every(
        (call) =>
          call.authorization ===
          `Bearer ${deriveProjectBearerToken(
            token,
            input.dataRoot,
            projectId,
          )}`,
      ),
    );
  } finally {
    await server.close();
  }
});
