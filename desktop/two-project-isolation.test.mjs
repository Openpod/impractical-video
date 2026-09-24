import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  deriveProjectBearerToken,
  isProjectBearerAuthorized,
  resolveBoundProjectRoot,
} from "./project-binding.mjs";

const masterToken = "two-project-private-master-token-0000000000";
const projects = ["project-a", "project-b"];

async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "video-fs-two-project-"),
  );
  const dataRoot = path.join(directory, "projects");
  for (const projectId of projects) {
    await mkdir(path.join(dataRoot, projectId), { recursive: true });
    await writeFile(
      path.join(dataRoot, projectId, "project.json"),
      `${JSON.stringify({ id: projectId, name: projectId })}\n`,
    );
  }
  return { dataRoot, directory };
}

function textResult(result) {
  const block = result.content?.find((item) => item.type === "text");
  assert.ok(block && "text" in block);
  return JSON.parse(block.text);
}

async function connectHelper(appUrl, dataRoot, projectId) {
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry) => typeof entry[1] === "string",
    ),
  );
  const transport = new StdioClientTransport({
    args: [path.join(process.cwd(), "scripts", "paper-mcp.mjs")],
    command: process.execPath,
    cwd: process.cwd(),
    env: {
      ...inheritedEnvironment,
      PAPER_MCP_TOKEN: deriveProjectBearerToken(
        masterToken,
        dataRoot,
        projectId,
      ),
      VIDEO_FS_APP_URL: appUrl,
      VIDEO_FS_PROJECT_ID: projectId,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: `two-project-${projectId}`,
    version: "1.0.0",
  });
  await client.connect(transport);
  return { client, transport };
}

test("simultaneous helpers remain isolated across context, interactions, receipts, and visible-project switches", async () => {
  const input = await fixture();
  const requests = [];
  let visibleProjectId = "project-a";
  const records = {
    "project-a": {
      attachmentId: `att_${"a".repeat(32)}`,
      cursor: "cursor-a-7",
      marker: "only-project-a",
      snapshotId: "turn_project-a",
    },
    "project-b": {
      attachmentId: `att_${"b".repeat(32)}`,
      cursor: "cursor-b-11",
      marker: "only-project-b",
      snapshotId: "turn_project-b",
    },
  };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const projectId = payload.arguments?.projectId;
    const authorized =
      typeof projectId === "string" &&
      isProjectBearerAuthorized(
        request.headers.authorization,
        masterToken,
        input.dataRoot,
        projectId,
      );
    if (!authorized) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Not authorized." }));
      return;
    }
    try {
      await resolveBoundProjectRoot(input.dataRoot, projectId);
    } catch {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Project unavailable." }));
      return;
    }
    requests.push({
      projectId,
      tool: payload.tool,
    });
    const record = records[projectId];
    let result;
    if (payload.tool === "get_project_status") {
      result = {
        eventCursor: record.cursor,
        marker: record.marker,
        projectId,
        visibleProjectId,
      };
    } else if (payload.tool === "get_agent_context_attachment") {
      if (payload.arguments.attachmentId !== record.attachmentId) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Attachment unavailable." }));
        return;
      }
      result = {
        attachment: {
          attachmentId: record.attachmentId,
          path: `media/agent-context/${record.marker}.txt`,
        },
      };
    } else if (payload.tool === "get_agent_turn_snapshot") {
      if (payload.arguments.snapshotId !== record.snapshotId) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Snapshot unavailable." }));
        return;
      }
      result = {
        snapshot: {
          marker: record.marker,
          projectId,
          snapshotId: record.snapshotId,
        },
      };
    } else if (payload.tool === "agent_request_input") {
      result = {
        request: {
          answer: { value: record.marker },
          id: payload.arguments.id,
          projectId,
          status: "resolved",
        },
      };
    } else if (payload.tool === "editor_edit") {
      result = {
        commandId: payload.arguments.commandId,
        idempotencyKey: payload.arguments.idempotencyKey,
        marker: record.marker,
        projectId,
      };
    } else {
      result = { marker: record.marker, projectId };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const appUrl = `http://127.0.0.1:${address.port}`;
  const [helperA, helperB] = await Promise.all(
    projects.map((projectId) =>
      connectHelper(appUrl, input.dataRoot, projectId),
    ),
  );

  try {
    const [statusA, statusB] = await Promise.all([
      helperA.client.callTool({ arguments: {}, name: "get_project_status" }),
      helperB.client.callTool({ arguments: {}, name: "get_project_status" }),
    ]);
    assert.deepEqual(textResult(statusA), {
      eventCursor: "cursor-a-7",
      marker: "only-project-a",
      projectId: "project-a",
      visibleProjectId: "project-a",
    });
    assert.deepEqual(textResult(statusB), {
      eventCursor: "cursor-b-11",
      marker: "only-project-b",
      projectId: "project-b",
      visibleProjectId: "project-a",
    });

    visibleProjectId = "project-b";
    const statusAAfterSwitch = await helperA.client.callTool({
      arguments: {},
      name: "get_project_status",
    });
    assert.deepEqual(textResult(statusAAfterSwitch), {
      eventCursor: "cursor-a-7",
      marker: "only-project-a",
      projectId: "project-a",
      visibleProjectId: "project-b",
    });

    const callsBeforeCrossProjectId = requests.length;
    const rejectedProjectId = await helperA.client.callTool({
      arguments: { project_id: "project-b" },
      name: "get_project_status",
    });
    assert.equal(rejectedProjectId.isError, true);
    assert.equal(requests.length, callsBeforeCrossProjectId);

    const crossAttachment = await helperA.client.callTool({
      arguments: { attachment_id: records["project-b"].attachmentId },
      name: "get_agent_context_attachment",
    });
    assert.equal(crossAttachment.isError, true);
    assert.doesNotMatch(JSON.stringify(crossAttachment), /only-project-b/);

    await assert.rejects(
      () =>
        helperA.client.readResource({
          uri: `videofs://agent-context/turns/${records["project-b"].snapshotId}`,
        }),
      /Snapshot unavailable/,
    );

    const [requestA, requestB] = await Promise.all([
      helperA.client.callTool({
        arguments: {
          actor_id: "agent-a",
          originating_command: "canvas.inspect",
          question: "Choose?",
          request_id: "shared-request-id",
        },
        name: "agent_request_input",
      }),
      helperB.client.callTool({
        arguments: {
          actor_id: "agent-b",
          originating_command: "canvas.inspect",
          question: "Choose?",
          request_id: "shared-request-id",
        },
        name: "agent_request_input",
      }),
    ]);
    assert.equal(textResult(requestA).request.projectId, "project-a");
    assert.equal(textResult(requestB).request.projectId, "project-b");

    const artifact = {
      artifact_id: "kf_shared",
      content_hash: "c".repeat(64),
      entity_revision: 1,
      kind: "keyframe",
      path: "media/keyframes/kf_shared.v1.png",
      version: {
        index: 0,
        sha256: "c".repeat(64),
        version_id: "kf_shared.v1",
      },
    };
    const [receiptA, receiptB] = await Promise.all([
      helperA.client.callTool({
        arguments: {
          actor_id: "agent-a",
          action: "insert",
          payload: { artifact, projectId: "project-b" },
          base_editor_revision: 0,
          command_id: "shared-command-id",
          duration_ticks: 120000,
          idempotency_key: "shared-idempotency-key",
          start_time_ticks: 0,
          track_id: "main",
        },
        name: "editor_edit",
      }),
      helperB.client.callTool({
        arguments: {
          actor_id: "agent-b",
          action: "insert",
          payload: { artifact },
          base_editor_revision: 0,
          command_id: "shared-command-id",
          duration_ticks: 120000,
          idempotency_key: "shared-idempotency-key",
          start_time_ticks: 0,
          track_id: "main",
        },
        name: "editor_edit",
      }),
    ]);
    assert.equal(textResult(receiptA).marker, "only-project-a");
    assert.equal(textResult(receiptB).marker, "only-project-b");

    assert.ok(
      requests.every(
        (entry) =>
          entry.projectId === "project-a" || entry.projectId === "project-b",
      ),
    );
  } finally {
    await Promise.all([
      helperA.client.close().catch(() => {}),
      helperB.client.close().catch(() => {}),
    ]);
    await Promise.all([
      helperA.transport.close().catch(() => {}),
      helperB.transport.close().catch(() => {}),
    ]);
    await new Promise((resolve) => server.close(resolve));
  }
});
