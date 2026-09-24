import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveProjectBearerToken } from "../desktop/project-binding.mjs";

vi.mock("server-only", () => ({}));

const originalEnvironment = { ...process.env };
const masterToken = "paper-project-binding-master-token-0000000000";
let dataRoot = "";

function toolRequest(projectId: string, bearer: string) {
  return new Request("http://127.0.0.1/api/paper/tools", {
    body: JSON.stringify({
      arguments: { projectId },
      tool: "get_project_status",
    }),
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
}

function workflowRequest(projectId: string, bearer: string) {
  return new Request("http://127.0.0.1/api/paper/tools", {
    body: JSON.stringify({
      arguments: { projectId, workflowId: "vertical-story-episode" },
      tool: "load_workflow",
    }),
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
}

beforeEach(async () => {
  process.env = { ...originalEnvironment };
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "video-fs-paper-binding-"));
  process.env.APP_MODE = "local";
  process.env.PAPER_MCP_TOKEN = masterToken;
  process.env.VIDEO_FS_DATA_ROOT = dataRoot;
  process.env.VIDEO_FS_REQUIRE_PROJECT_BINDING = "true";
  vi.resetModules();
});

afterEach(async () => {
  process.env = { ...originalEnvironment };
  vi.resetModules();
  if (dataRoot) await rm(dataRoot, { force: true, recursive: true });
  dataRoot = "";
});

describe("strict desktop Paper endpoint project binding", () => {
  it("accepts only the bearer derived for the exact project and root", async () => {
    const { createProject } = await import("@/lib/workspace");
    const projectA = await createProject("Isolation A");
    const projectB = await createProject("Isolation B");
    const tokenA = deriveProjectBearerToken(
      masterToken,
      dataRoot,
      projectA.id,
    );
    const tokenB = deriveProjectBearerToken(
      masterToken,
      dataRoot,
      projectB.id,
    );
    const route = await import("@/app/api/paper/tools/route");

    const accepted = await route.POST(toolRequest(projectA.id, tokenA));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      project: { id: projectA.id },
    });

    const workflow = await route.POST(workflowRequest(projectA.id, tokenA));
    expect(workflow.status).toBe(200);
    expect(await workflow.json()).toMatchObject({
      workflow: { id: "vertical-story-episode" },
    });

    const crossProject = await route.POST(toolRequest(projectB.id, tokenA));
    expect(crossProject.status).toBe(401);
    expect(await crossProject.json()).toEqual({
      error: "Paper MCP endpoint is not authorized.",
    });

    const otherRootToken = deriveProjectBearerToken(
      masterToken,
      path.join(dataRoot, "other-root"),
      projectA.id,
    );
    const otherRoot = await route.POST(
      toolRequest(projectA.id, otherRootToken),
    );
    expect(otherRoot.status).toBe(401);

    const projectBRequest = await route.POST(
      toolRequest(projectB.id, tokenB),
    );
    expect(projectBRequest.status).toBe(200);
    expect(await projectBRequest.json()).toMatchObject({
      project: { id: projectB.id },
    });
  });
});
