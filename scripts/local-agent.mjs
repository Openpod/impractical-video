#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";
import { setupAgentProject } from "../desktop/agent-setup.mjs";
import { parseHookInput, runAgentContextHook } from "../desktop/agent-context-hook.mjs";
import { validateLoopbackUrl, writePrivateConnectionState } from "../desktop/connection-state.mjs";
import { deriveProjectBearerToken, resolveBoundProjectRoot, validateProjectId } from "../desktop/project-binding.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// stdout belongs to the MCP protocol; dotenv messages must never enter it.
nextEnv.loadEnvConfig(root, true, { info() {}, error(...args) { console.error(...args); } });
const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const projectId = validateProjectId(process.argv.includes("--project-id") ? option("--project-id") : process.env.VIDEO_FS_PROJECT_ID);
if (process.env.APP_MODE !== "local" || process.env.VIDEO_FS_REQUIRE_PROJECT_BINDING !== "true") {
  throw new Error("Local agent setup requires APP_MODE=local and VIDEO_FS_REQUIRE_PROJECT_BINDING=true. See .env.example.");
}
const dataRoot = path.resolve(process.env.VIDEO_FS_DATA_ROOT?.trim() || path.join(root, "data", "projects"));
await resolveBoundProjectRoot(dataRoot, projectId);
const appUrl = validateLoopbackUrl(process.env.VIDEO_FS_APP_URL || "http://localhost:3000");
const state = {
  appUrl, dataRoot, pid: process.pid, startedAt: new Date().toISOString(),
  token: process.env.PAPER_MCP_TOKEN,
  mcp: { command: process.execPath, args: [fileURLToPath(import.meta.url), "--mcp"] },
};
const projectToken = deriveProjectBearerToken(state.token, dataRoot, projectId);

if (process.argv.includes("--setup")) {
  const result = await setupAgentProject({ projectId, state });
  console.log(`Agent configuration ready in ${path.join(dataRoot, projectId)}.`);
  if (result.conflicts.length) console.log("Existing files were preserved. Review .video-fs/CONNECT_AGENTS.md.");
} else if (process.argv.includes("--agent-context-hook")) {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 256 * 1024) throw new Error("Hook input is too large.");
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "video-fs-hook-"));
  try {
    const statePath = path.join(temporary, "connection.json");
    await writePrivateConnectionState(statePath, state);
    const result = await runAgentContextHook({ agent: option("--agent"), input: parseHookInput(raw), projectId, statePath });
    process.stdout.write(`${JSON.stringify(result.output)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
} else if (process.argv.includes("--mcp")) {
  process.env.VIDEO_FS_APP_URL = appUrl;
  process.env.VIDEO_FS_PROJECT_ID = projectId;
  process.env.PAPER_MCP_TOKEN = projectToken;
  await import("./paper-mcp.mjs");
} else {
  throw new Error("Use --setup --project-id <id> or --mcp --project-id <id>.");
}
