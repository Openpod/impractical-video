import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readPrivateConnectionState } from "./connection-state.mjs";
import { deriveProjectBearerToken, validateProjectId } from "./project-binding.mjs";

function argumentValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name) {
  const value = argumentValue(name);
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function inheritedEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
  );
}

function textResult(result) {
  const block = result.content?.find((item) => item.type === "text");
  assert.ok(block && "text" in block);
  assert.equal(result.isError, undefined, block.text);
  return JSON.parse(block.text);
}

async function connect(state, statePath, projectId) {
  const transport = new StdioClientTransport({
    args: [...state.mcp.args, "--project-id", projectId],
    command: state.mcp.command,
    env: {
      ...inheritedEnvironment(),
      VIDEO_FS_DESKTOP_STATE_FILE: statePath,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: `packaged-isolation-${projectId}`,
    version: "1.0.0",
  });
  await client.connect(transport);
  return { client, transport };
}

async function uploadAttachment(state, projectId, suffix) {
  const body = new FormData();
  body.append(
    "file",
    new File([`packaged attachment ${suffix}`], `${suffix}.txt`, {
      type: "text/plain",
    }),
  );
  const response = await fetch(
    `${state.appUrl}/api/projects/${projectId}/agent-context/attachments`,
    { body, method: "POST" },
  );
  assert.equal(response.status, 201);
  return (await response.json()).attachment;
}

async function bindContext(state, projectId, suffix, attachmentId) {
  const endpoint = `${state.appUrl}/api/projects/${projectId}/agent-context`;
  const currentResponse = await fetch(endpoint);
  assert.equal(currentResponse.status, 200);
  const current = (await currentResponse.json()).context;
  const response = await fetch(endpoint, {
    body: JSON.stringify({
      activeView: "canvas",
      appSessionId: `packaged-app-${suffix}`,
      attachmentIds: [attachmentId],
      baseContextRevision: current.contextRevision,
      canvas: { focused: null, pinned: [], selected: [] },
      clear: false,
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
      projectRevision: null,
      windowId: `packaged-window-${suffix}`,
    }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  assert.equal(response.status, 200);
}

async function main() {
  const statePath = requiredArgument("--state");
  const projectA = validateProjectId(requiredArgument("--project-a"));
  const projectB = validateProjectId(requiredArgument("--project-b"));
  assert.notEqual(projectA, projectB);
  const state = await readPrivateConnectionState(statePath);
  const [attachmentA, attachmentB] = await Promise.all([
    uploadAttachment(state, projectA, "only-project-a"),
    uploadAttachment(state, projectB, "only-project-b"),
  ]);
  await Promise.all([
    bindContext(state, projectA, "a", attachmentA.attachmentId),
    bindContext(state, projectB, "b", attachmentB.attachmentId),
  ]);
  const [helperA, helperB] = await Promise.all([
    connect(state, statePath, projectA),
    connect(state, statePath, projectB),
  ]);

  try {
    const [statusAResult, statusBResult, contextAResult, contextBResult] =
      await Promise.all([
        helperA.client.callTool({ arguments: {}, name: "get_project_status" }),
        helperB.client.callTool({ arguments: {}, name: "get_project_status" }),
        helperA.client.callTool({
          arguments: {},
          name: "get_agent_context_status",
        }),
        helperB.client.callTool({
          arguments: {},
          name: "get_agent_context_status",
        }),
      ]);
    const statusA = textResult(statusAResult);
    const statusB = textResult(statusBResult);
    const contextA = textResult(contextAResult);
    const contextB = textResult(contextBResult);
    assert.equal(statusA.project.id, projectA);
    assert.equal(statusB.project.id, projectB);
    assert.equal(contextA.projectId, projectA);
    assert.equal(contextB.projectId, projectB);

    const [turnAResult, turnBResult] = await Promise.all([
      helperA.client.callTool({
        arguments: {
          agent: "claude",
          agent_session_id: "packaged-session-a",
          expected_context_revision: contextA.contextRevision,
          turn_id: "packaged-turn-a",
          window_id: contextA.binding.windowId,
        },
        name: "create_agent_turn_snapshot",
      }),
      helperB.client.callTool({
        arguments: {
          agent: "codex",
          agent_session_id: "packaged-session-b",
          expected_context_revision: contextB.contextRevision,
          turn_id: "packaged-turn-b",
          window_id: contextB.binding.windowId,
        },
        name: "create_agent_turn_snapshot",
      }),
    ]);
    const turnA = textResult(turnAResult).snapshot;
    const turnB = textResult(turnBResult).snapshot;
    assert.equal(turnA.projectId, projectA);
    assert.equal(turnB.projectId, projectB);

    const attachmentAResult = await helperA.client.callTool({
      arguments: { attachment_id: attachmentA.attachmentId },
      name: "get_agent_context_attachment",
    });
    assert.equal(
      textResult(attachmentAResult).attachment.attachmentId,
      attachmentA.attachmentId,
    );
    const crossAttachment = await helperA.client.callTool({
      arguments: { attachment_id: attachmentB.attachmentId },
      name: "get_agent_context_attachment",
    });
    assert.equal(crossAttachment.isError, true);
    assert.doesNotMatch(JSON.stringify(crossAttachment), /only-project-b/i);

    const localCrossProject = await helperA.client.callTool({
      arguments: { project_id: projectB },
      name: "get_project_status",
    });
    assert.equal(localCrossProject.isError, true);
    await assert.rejects(
      () =>
        helperA.client.readResource({
          uri: `videofs://agent-context/turns/${turnB.snapshotId}`,
        }),
      (error) => {
        assert.doesNotMatch(String(error), new RegExp(projectB, "i"));
        assert.doesNotMatch(String(error), /packaged-session-b/i);
        return true;
      },
    );

    const bearerA = deriveProjectBearerToken(
      state.token,
      state.dataRoot,
      projectA,
    );
    const directCrossProject = await fetch(`${state.appUrl}/api/paper/tools`, {
      body: JSON.stringify({
        arguments: { projectId: projectB },
        tool: "get_project_status",
      }),
      headers: {
        authorization: `Bearer ${bearerA}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    assert.equal(directCrossProject.status, 401);
    assert.deepEqual(await directCrossProject.json(), {
      error: "Paper MCP endpoint is not authorized.",
    });

    process.stdout.write(
      `${JSON.stringify({
        crossProjectDirectStatus: directCrossProject.status,
        helperA: {
          contextRevision: contextA.contextRevision,
          projectId: projectA,
          snapshotId: turnA.snapshotId,
        },
        helperB: {
          contextRevision: contextB.contextRevision,
          projectId: projectB,
          snapshotId: turnB.snapshotId,
        },
        ok: true,
      })}\n`,
    );
  } finally {
    await Promise.allSettled([
      helperA.client.close(),
      helperB.client.close(),
      helperA.transport.close(),
      helperB.transport.close(),
    ]);
  }
}

await main();
