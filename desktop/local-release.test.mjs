import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import nextEnv from "@next/env";
import { setupLocal } from "../scripts/setup-local.mjs";
import { desktopCloudConfiguration } from "./cloud-config.mjs";
import { writePrivateConnectionState } from "./connection-state.mjs";

/** Reads the data root the way the app, the doctor and the desktop shell do.
 * The loader skips names the process already has, so start without it. */
function loadedDataRoot(root) {
  delete process.env.VIDEO_FS_DATA_ROOT;
  const before = new Set(Object.keys(process.env));
  try {
    return nextEnv.loadEnvConfig(root, true, { info() {}, error() {} }, true).parsedEnv?.VIDEO_FS_DATA_ROOT;
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!before.has(key)) delete process.env[key];
    }
  }
}

test("fresh setup creates a private local environment and preserves existing credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-fs-setup-"));
  try {
    await copyFile(new URL("../.env.example", import.meta.url), path.join(root, ".env.example"));
    assert.equal(await setupLocal(root), true);
    const file = path.join(root, ".env.local");
    const contents = await readFile(file, "utf8");
    assert.match(contents, /^APP_MODE=local$/m);
    assert.match(contents, /^NEXT_PUBLIC_DESKTOP_CLOUD_ENABLED=false$/m);
    assert.match(contents, /^PAPER_MCP_TOKEN=[a-f0-9]{64}$/m);
    assert.equal(loadedDataRoot(root), path.join(root, "data", "projects"));
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    await writeFile(file, "FAL_KEY=keep-existing-value\n");
    assert.equal(await setupLocal(root), false);
    assert.equal(await readFile(file, "utf8"), "FAL_KEY=keep-existing-value\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the data root written by setup reads back unchanged from any checkout path", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "video-fs-setup-paths-"));
  try {
    // Env quoting goes wrong at a backslash followed by "n" or "r" and at an
    // apostrophe. Windows puts the backslash before every folder name; on other
    // systems it has to be part of the name.
    const names = ["repos", "new", "it's here", ...(process.platform === "win32" ? [] : ["windows\\repos\\new", "it's\\here"])];
    for (const name of names) {
      const root = path.join(parent, name);
      await mkdir(root);
      await copyFile(new URL("../.env.example", import.meta.url), path.join(root, ".env.example"));
      assert.equal(await setupLocal(root), true);
      assert.equal(loadedDataRoot(root), path.join(root, "data", "projects"));
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("desktop cloud access requires an explicit opt-in and a valid origin", () => {
  assert.equal(desktopCloudConfiguration({}).enabled, false);
  assert.deepEqual(desktopCloudConfiguration({ NEXT_PUBLIC_DESKTOP_CLOUD_ENABLED: "true", NEXT_PUBLIC_DESKTOP_CLOUD_URL: "https://studio.example" }), { enabled: true, origin: "https://studio.example" });
  assert.throws(() => desktopCloudConfiguration({ NEXT_PUBLIC_DESKTOP_CLOUD_URL: "https://user:password@example.com" }), /HTTPS origin/);
});

test("connection-state write failures preserve the original filesystem error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-fs-state-error-"));
  try {
    await assert.rejects(writePrivateConnectionState(path.join(root, "absent", "connection.json"), {
      appUrl: "http://localhost:3000", dataRoot: root, token: "a".repeat(64), pid: process.pid,
      startedAt: new Date().toISOString(), mcp: { command: process.execPath, args: [] },
    }), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
