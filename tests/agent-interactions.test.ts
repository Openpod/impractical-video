import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const originalEnvironment = { ...process.env };
let dataRoot = "";
let projectId = "";

async function loadInteractions() {
  return import("@/lib/agent-interactions");
}

beforeEach(async () => {
  process.env = { ...originalEnvironment };
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "video-fs-agent-requests-"));
  process.env.APP_MODE = "local";
  process.env.VIDEO_FS_DATA_ROOT = dataRoot;
  vi.resetModules();
  const { createProject } = await import("@/lib/workspace");
  projectId = (await createProject("Agent request test")).id;
});

afterEach(async () => {
  process.env = { ...originalEnvironment };
  vi.resetModules();
  if (dataRoot) await rm(dataRoot, { force: true, recursive: true });
});

describe("durable agent input and approval requests", () => {
  it("persists typed input, emits lifecycle events, and answers exactly once", async () => {
    const interactions = await loadInteractions();
    const { agentInteractionEventBus } = await import(
      "@/lib/agent-interaction-events"
    );
    const eventKinds: string[] = [];
    const onEvent = (event: { kind: string }) => eventKinds.push(event.kind);
    agentInteractionEventBus.on("project", onEvent as never);
    const now = new Date("2026-07-25T12:00:00.000Z");
    try {
      const created = await interactions.createAgentInteraction(
        {
          actor: { id: "codex-turn-1", type: "agent" },
          choices: [
            { id: "opening", label: "Opening frame", value: "kf_opening" },
            { id: "closing", label: "Closing frame", value: "kf_closing" },
          ],
          expiresInSeconds: 300,
          id: "request_input_1",
          kind: "input",
          originatingCommand: "editor_timeline_insert",
          projectId,
          question: "Which frame should lead?",
        },
        { now },
      );

      expect(created).toMatchObject({
        actor: { id: "codex-turn-1", type: "agent" },
        createdAt: now.toISOString(),
        expiresAt: "2026-07-25T12:05:00.000Z",
        id: "request_input_1",
        kind: "input",
        originatingCommand: "editor_timeline_insert",
        status: "awaiting",
      });
      expect(eventKinds).toEqual(["agent.interaction.awaiting"]);

      const resolved = await interactions.resolveAgentInteraction(
        projectId,
        created.id,
        {
          answer: { choiceId: "opening", value: "kf_opening" },
          kind: "input",
        },
        { now: new Date("2026-07-25T12:01:00.000Z") },
      );
      expect(resolved).toMatchObject({
        answer: { choiceId: "opening", value: "kf_opening" },
        status: "resolved",
      });
      expect(eventKinds).toEqual([
        "agent.interaction.awaiting",
        "agent.interaction.resolved",
      ]);
      await expect(
        interactions.resolveAgentInteraction(
          projectId,
          created.id,
          { answer: { value: "different" }, kind: "input" },
          { now: new Date("2026-07-25T12:02:00.000Z") },
        ),
      ).rejects.toMatchObject({
        code: "AGENT_INTERACTION_RESOLVED",
        status: 409,
      });

      const recordPath = path.join(
        dataRoot,
        projectId,
        ".video-fs",
        "agent-requests",
        "request_input_1.json",
      );
      expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(recordPath, "utf8"))).toMatchObject({
        projectId,
        question: "Which frame should lead?",
        status: "resolved",
      });
      const { getProjectSnapshot } = await import("@/lib/workspace");
      const snapshot = await getProjectSnapshot(projectId);
      expect(
        snapshot.files.some((file) =>
          file.path.startsWith(".video-fs/agent-requests/"),
        ),
      ).toBe(false);
      expect(snapshot.check.issues).toEqual([]);
    } finally {
      agentInteractionEventBus.off("project", onEvent as never);
    }
  });

  it("binds approval to a command/hash and denies by default on expiry", async () => {
    const interactions = await loadInteractions();
    const { agentInteractionEventBus } = await import(
      "@/lib/agent-interaction-events"
    );
    const eventKinds: string[] = [];
    const onEvent = (event: { kind: string }) => eventKinds.push(event.kind);
    agentInteractionEventBus.on("project", onEvent as never);
    try {
      const created = await interactions.createAgentInteraction(
        {
          actor: { id: "claude-turn-2", type: "agent" },
          destructive: true,
          estimatedCostUsd: 1.25,
          expiresInSeconds: 30,
          id: "approval_delete_1",
          kind: "approval",
          originatingCommand: "canvas.tile.archive_many",
          payloadHash: "a".repeat(64),
          permissions: ["project.write", "provider.spend"],
          projectId,
          proposedCommand: "canvas.tile.archive_many",
          question: "Archive the selected pieces?",
        },
        { now: new Date("2026-07-25T12:00:00.000Z") },
      );
      expect(created).toMatchObject({
        decision: null,
        destructive: true,
        estimatedCostUsd: 1.25,
        payloadHash: "a".repeat(64),
        permissions: ["project.write", "provider.spend"],
        status: "awaiting",
      });

      const expired = await interactions.expireAgentInteraction(
        projectId,
        created.id,
        { now: new Date("2026-07-25T12:00:31.000Z") },
      );
      expect(expired).toMatchObject({
        decision: { approved: false, note: "Expired without approval." },
        status: "expired",
      });
      expect(eventKinds).toEqual([
        "agent.interaction.awaiting",
        "agent.interaction.expired",
      ]);
    } finally {
      agentInteractionEventBus.off("project", onEvent as never);
    }
  });

  it("hydrates awaiting requests after a module restart without storing payloads", async () => {
    const interactions = await loadInteractions();
    await interactions.createAgentInteraction({
      actor: { id: "codex-turn-3", type: "agent" },
      destructive: false,
      estimatedCostUsd: null,
      expiresInSeconds: 300,
      id: "approval_restart_1",
      kind: "approval",
      originatingCommand: "media.image.generate",
      payloadHash: "b".repeat(64),
      permissions: ["provider.generate"],
      projectId,
      proposedCommand: "media.image.generate",
      question: "Generate the selected frame?",
    });
    vi.resetModules();
    const restored = await loadInteractions();
    const records = await restored.listAgentInteractions(projectId, {
      now: new Date(Date.now() + 1_000),
    });
    expect(records[0]).toMatchObject({
      id: "approval_restart_1",
      status: "awaiting",
    });
    const serialized = await readFile(
      path.join(
        dataRoot,
        projectId,
        ".video-fs",
        "agent-requests",
        "approval_restart_1.json",
      ),
      "utf8",
    );
    expect(serialized).not.toContain("providerPayload");
    expect(serialized).not.toContain("PAPER_MCP_TOKEN");
  });
});
