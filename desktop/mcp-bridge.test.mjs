import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { writePrivateConnectionState } from "./connection-state.mjs";

const projectId = "mcp-bridge";
const token = "mcp-bridge-private-token-0000000000000000000";
const mainPath = fileURLToPath(new URL("./main.mjs", import.meta.url));

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "video-fs-mcp-bridge-"));
  const dataRoot = path.join(directory, "projects");
  const projectRoot = path.join(dataRoot, projectId);
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    path.join(projectRoot, "project.json"),
    `${JSON.stringify({ id: projectId, name: "MCP bridge" })}\n`,
  );
  return { dataRoot, statePath: path.join(directory, "desktop-connection.json") };
}

async function startApp() {
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    appUrl: `http://127.0.0.1:${address.port}`,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Writes one JSON-RPC request the way an agent does and resolves with the
 * reply that carries its id. */
function request(child, message) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const deadline = setTimeout(
      () => reject(new Error(`MCP bridge did not reply: ${stderr}`)),
      60_000,
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split("\n").slice(0, -1)) {
        let reply;
        try {
          reply = JSON.parse(line);
        } catch {
          continue;
        }
        if (reply?.id !== message.id) continue;
        clearTimeout(deadline);
        resolve(reply);
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(deadline);
      reject(new Error(`MCP bridge exited ${code} before replying: ${stderr}`));
    });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const forced = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(forced);
      resolve();
    });
    child.kill();
  });
}

test("desktop MCP bridge answers an agent over standard input and output", async () => {
  const input = await fixture();
  const app = await startApp();
  await writePrivateConnectionState(input.statePath, {
    appUrl: app.appUrl,
    dataRoot: input.dataRoot,
    mcp: { args: [mainPath, "--mcp"], command: electron },
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token,
  });
  const child = spawn(electron, [mainPath, "--mcp", "--project-id", projectId], {
    env: { ...process.env, VIDEO_FS_DESKTOP_STATE_FILE: input.statePath },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    const reply = await request(child, {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "codex", version: "0.0.0" },
        protocolVersion: "2025-06-18",
      },
    });
    assert.equal(reply.error, undefined);
    assert.equal(reply.result.serverInfo.name, "video-fs-paper-mode");
  } finally {
    await stop(child);
    await app.close();
  }
});
