import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const projectId = "bound_context_project";
const attachmentId = `att_${"a".repeat(32)}`;
const token = "black-box-token-value";

type AppCall = {
  arguments: Record<string, unknown>;
  authorization: string | undefined;
  tool: string;
};

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function responseFor(call: AppCall) {
  const context = {
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
    contextRevision: 7,
    projectId,
    schema: "AgentContextSnapshot@1",
  };
  switch (call.tool) {
    case "load_workflow":
      return {
        workflow: {
          id: call.arguments.workflowId,
          title: "Vertical Story Episode",
        },
      };
    case "get_agent_context":
      return { context, staleEntities: [] };
    case "get_agent_context_status":
      return {
        contextRevision: 7,
        projectId,
        schema: "AgentContextSnapshot@1",
        visibleCount: 1,
      };
    case "get_agent_context_revision":
      return {
        context: { ...context, contextRevision: call.arguments.revision },
        staleEntities: [],
      };
    case "get_agent_context_attachment":
      return { attachment: context.attachments[0] };
    case "create_agent_turn_snapshot":
    case "rebase_agent_context":
      return {
        snapshot: {
          agent: call.arguments.agent,
          agentSessionId: call.arguments.agentSessionId,
          context,
          projectId,
          schema: "AgentContextTurnSnapshot@1",
          snapshotId: "turn_black-box",
          turnId: call.arguments.turnId,
          windowId: call.arguments.windowId,
        },
      };
    case "get_agent_turn_snapshot":
      return {
        snapshot: {
          agent: "codex",
          agentSessionId: "codex_session",
          context,
          projectId,
          schema: "AgentContextTurnSnapshot@1",
          snapshotId: call.arguments.snapshotId,
          turnId: "turn_request",
          windowId: "desktop_window",
        },
      };
    case "refresh_agent_context":
      return { context, refreshed: true, staleEntities: [] };
    case "get_connection_status":
      return {
        connected: true,
        context: { contextRevision: 7 },
        projectId,
        transport: "loopback",
      };
    case "editor_timeline_get":
      return {
        currentSceneId: "scene-main",
        project: { scenes: [] },
        revision: 3,
      };
    case "editor_edit":
      return {
        action: call.arguments.action,
        affectedElementIds: [call.arguments.elementId],
        command: "editor_edit",
        newRevision: 4,
        priorRevision: 3,
        schema: "EditorCommandReceipt@2",
      };
    case "agent_request_input":
      return {
        request: {
          answer: { choiceId: "opening", value: "kf_opening" },
          id: call.arguments.id,
          kind: "input",
          projectId,
          status: "resolved",
        },
      };
    case "agent_request_approval":
      return {
        request: {
          decision: { approved: false },
          id: call.arguments.id,
          kind: "approval",
          payloadHash: call.arguments.payloadHash,
          projectId,
          status: "resolved",
        },
      };
    default:
      return { error: `Unexpected tool ${call.tool}.` };
  }
}

function resourceText(
  content:
    | { blob: string; uri: string }
    | { text: string; uri: string }
    | undefined,
) {
  if (!content || !("text" in content)) {
    throw new Error("Expected a text MCP resource.");
  }
  return content.text;
}

let client: Client | null = null;
let transport: StdioClientTransport | null = null;
let closeServer: (() => Promise<void>) | null = null;

afterEach(async () => {
  await client?.close().catch(() => {});
  await transport?.close().catch(() => {});
  await closeServer?.().catch(() => {});
  client = null;
  transport = null;
  closeServer = null;
});

describe("packaged Paper MCP agent context", () => {
  it("binds tools/resources to one project and forwards no token in configuration", async () => {
    const calls: AppCall[] = [];
    const httpServer = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      if (request.url !== "/api/paper/tools" || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(await readBody(request)) as {
        arguments: Record<string, unknown>;
        tool: string;
      };
      const call: AppCall = {
        arguments: parsed.arguments,
        authorization: request.headers.authorization,
        tool: parsed.tool,
      };
      calls.push(call);
      if (call.tool === "get_project_status") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            code: "PROJECT_STATUS_UNAVAILABLE",
            error: "Project status is temporarily unavailable.",
            remediation: "Keep Video FS open, then retry.",
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseFor(call)));
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    closeServer = () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a loopback test server.");
    }

    const inheritedEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    transport = new StdioClientTransport({
      args: [path.join(process.cwd(), "scripts", "paper-mcp.mjs")],
      command: process.execPath,
      cwd: process.cwd(),
      env: {
        ...inheritedEnvironment,
        PAPER_MCP_TOKEN: token,
        VIDEO_FS_APP_URL: `http://127.0.0.1:${address.port}`,
        VIDEO_FS_PROJECT_ID: projectId,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "paper-context-test", version: "1.0.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "get_agent_context",
        "get_agent_context_status",
        "get_agent_context_revision",
        "get_agent_context_attachment",
        "create_agent_turn_snapshot",
        "get_agent_turn_snapshot",
        "refresh_agent_context",
        "rebase_agent_context",
        "get_connection_status",
        "agent_request_input",
        "agent_request_approval",
        "editor_timeline_get",
        "editor_edit",
        "editor_structure",
        "edit_media",
        "generate_audio",
        "load_workflow",
      ]),
    );
    // The five single-purpose timeline mutations are retired (commented out)
    // in favor of editor_edit; they must NOT be advertised.
    expect(tools.tools.map((tool) => tool.name)).not.toContain(
      "editor_timeline_insert",
    );
    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toEqual([
      "videofs://agent-context/current",
      "videofs://connection/status",
      "videofs://agent-context/status",
    ]);
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toEqual([
      "videofs://agent-context/revisions/{revision}",
      "videofs://agent-context/attachments/{attachment_id}",
      "videofs://agent-context/turns/{snapshot_id}",
    ]);

    const currentTool = await client.callTool({
      arguments: {},
      name: "get_agent_context",
    });
    expect(currentTool.isError).not.toBe(true);
    expect(currentTool.structuredContent).toMatchObject({
      context: { contextRevision: 7, projectId },
    });
    const workflowTool = await client.callTool({
      arguments: { workflow_id: "vertical-story-episode" },
      name: "load_workflow",
    });
    expect(workflowTool.isError).not.toBe(true);
    expect(workflowTool.structuredContent).toMatchObject({
      workflow: { id: "vertical-story-episode" },
    });
    expect(calls.find((call) => call.tool === "load_workflow")?.arguments).toEqual({
      projectId,
      workflowId: "vertical-story-episode",
    });
    const failedTool = await client.callTool({
      arguments: {},
      name: "get_project_status",
    });
    expect(failedTool.isError).toBe(true);
    expect(failedTool.structuredContent).toEqual({
      error: {
        code: "PROJECT_STATUS_UNAVAILABLE",
        message: "Project status is temporarily unavailable.",
        remediation: "Keep Video FS open, then retry.",
      },
      ok: false,
    });

    const turnTool = await client.callTool({
      arguments: {
        agent: "codex",
        agent_session_id: "codex_session",
        expected_context_revision: 7,
        turn_id: "turn_request",
        window_id: "desktop_window",
      },
      name: "create_agent_turn_snapshot",
    });
    expect(turnTool.structuredContent).toMatchObject({
      snapshot: {
        agent: "codex",
        context: { attachments: [{ attachmentId }], contextRevision: 7 },
        projectId,
      },
    });
    const refreshed = await client.callTool({
      arguments: {},
      name: "refresh_agent_context",
    });
    expect(refreshed.structuredContent).toMatchObject({
      context: { contextRevision: 7, projectId },
      refreshed: true,
      staleEntities: [],
    });
    const rebased = await client.callTool({
      arguments: {
        agent: "claude",
        agent_session_id: "claude_session",
        turn_id: "rebased_turn",
        window_id: "desktop_window",
      },
      name: "rebase_agent_context",
    });
    expect(rebased.structuredContent).toMatchObject({
      snapshot: {
        agent: "claude",
        context: { contextRevision: 7 },
        projectId,
      },
    });

    const currentResource = await client.readResource({
      uri: "videofs://agent-context/current",
    });
    expect(JSON.parse(resourceText(currentResource.contents[0]))).toMatchObject({
      context: { contextRevision: 7, projectId },
    });
    const revisionResource = await client.readResource({
      uri: "videofs://agent-context/revisions/3",
    });
    expect(JSON.parse(resourceText(revisionResource.contents[0]))).toMatchObject({
      context: { contextRevision: 3, projectId },
    });
    const attachmentResource = await client.readResource({
      uri: `videofs://agent-context/attachments/${attachmentId}`,
    });
    const attachmentPayload = JSON.parse(
      resourceText(attachmentResource.contents[0]),
    );
    expect(attachmentPayload).toEqual({
      attachment: expect.objectContaining({ attachmentId }),
    });
    expect(JSON.stringify(attachmentPayload)).not.toContain("createdAt");
    expect(JSON.stringify(attachmentPayload)).not.toContain("schema");
    expect(JSON.stringify(attachmentPayload)).not.toContain(token);
    const connectionResource = await client.readResource({
      uri: "videofs://connection/status",
    });
    expect(JSON.parse(resourceText(connectionResource.contents[0]))).toEqual({
      connected: true,
      context: { contextRevision: 7 },
      projectId,
      transport: "loopback",
    });
    const turnResource = await client.readResource({
      uri: "videofs://agent-context/turns/turn_black-box",
    });
    expect(JSON.parse(resourceText(turnResource.contents[0]))).toMatchObject({
      snapshot: {
        context: { contextRevision: 7 },
        projectId,
        snapshotId: "turn_black-box",
      },
    });

    const editorInsert = await client.callTool({
      arguments: {
        action: "insert",
        actor_id: "codex-session",
        agent: "codex",
        base_editor_revision: 3,
        command_id: "cmd-editor-insert",
        idempotency_key: "idem-editor-insert",
        payload: {
          artifact: {
            artifactId: "kf_exact",
            contentHash: "b".repeat(64),
            entityRevision: 2,
            kind: "keyframe",
            path: "media/keyframes/kf_exact.v2.png",
            title: "Exact frame",
            version: {
              index: 1,
              sha256: "b".repeat(64),
              versionId: "v2",
            },
          },
          durationTicks: 600000,
          elementId: "element-exact",
          placement: { mode: "explicit", trackId: "main-track" },
          startTimeTicks: 0,
        },
      },
      name: "editor_edit",
    });
    expect(editorInsert.structuredContent).toMatchObject({
      affectedElementIds: ["element-exact"],
      newRevision: 4,
      priorRevision: 3,
    });
    expect(
      calls.find((call) => call.tool === "editor_edit")?.arguments,
    ).toMatchObject({
      action: "insert",
      actor: { id: "codex-session", type: "agent" },
      artifact: {
        artifactId: "kf_exact",
        contentHash: "b".repeat(64),
        entityRevision: 2,
        path: "media/keyframes/kf_exact.v2.png",
        version: {
          index: 1,
          sha256: "b".repeat(64),
          versionId: "v2",
        },
      },
      baseEditorRevision: 3,
      commandId: "cmd-editor-insert",
      durationTicks: 600000,
      elementId: "element-exact",
      idempotencyKey: "idem-editor-insert",
      origin: "codex",
      placement: { mode: "explicit", trackId: "main-track" },
      projectId,
      startTimeTicks: 0,
    });

    const inputRequest = await client.callTool({
      arguments: {
        actor_id: "codex-session",
        choices: [
          { id: "opening", label: "Opening frame", value: "kf_opening" },
        ],
        originating_command: "editor_edit",
        question: "Which frame should lead?",
        request_id: "request_input_black_box",
      },
      name: "agent_request_input",
    });
    expect(inputRequest.structuredContent).toMatchObject({
      request: {
        answer: { choiceId: "opening", value: "kf_opening" },
        kind: "input",
        projectId,
        status: "resolved",
      },
    });
    expect(
      calls.find((call) => call.tool === "agent_request_input")?.arguments,
    ).toMatchObject({
      actor: { id: "codex-session", type: "agent" },
      choices: [{ id: "opening", value: "kf_opening" }],
      id: "request_input_black_box",
      kind: "input",
      projectId,
    });

    const approvalRequest = await client.callTool({
      arguments: {
        actor_id: "claude-session",
        destructive: true,
        estimated_cost_usd: 0.75,
        originating_command: "media.image.generate",
        payload_hash: "c".repeat(64),
        permissions: ["provider.generate"],
        proposed_command: "media.image.generate",
        question: "Generate the selected frame?",
        request_id: "request_approval_black_box",
      },
      name: "agent_request_approval",
    });
    expect(approvalRequest.structuredContent).toMatchObject({
      request: {
        decision: { approved: false },
        kind: "approval",
        payloadHash: "c".repeat(64),
        status: "resolved",
      },
    });

    const callsBeforeRejectedSwitch = calls.length;
    const rejectedSwitch = await client.callTool({
      arguments: { project_id: "other_project" },
      name: "get_agent_context",
    });
    expect(rejectedSwitch.isError).toBe(true);
    expect(calls).toHaveLength(callsBeforeRejectedSwitch);

    expect(calls).not.toHaveLength(0);
    expect(calls.every((call) => call.authorization === `Bearer ${token}`)).toBe(true);
    expect(calls.every((call) => call.arguments.projectId === projectId)).toBe(true);
    expect(
      calls.find((call) => call.tool === "create_agent_turn_snapshot")?.arguments,
    ).toMatchObject({
      agent: "codex",
      agentSessionId: "codex_session",
      expectedContextRevision: 7,
      projectId,
      turnId: "turn_request",
      windowId: "desktop_window",
    });
  });
});
