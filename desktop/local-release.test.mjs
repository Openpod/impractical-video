import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setupLocal } from "../scripts/setup-local.mjs";
import { desktopCloudConfiguration } from "./cloud-config.mjs";
import { writePrivateConnectionState } from "./connection-state.mjs";

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
    assert.ok(contents.includes(JSON.stringify(path.join(root, "data", "projects"))));
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    await writeFile(file, "FAL_KEY=keep-existing-value\n");
    assert.equal(await setupLocal(root), false);
    assert.equal(await readFile(file, "utf8"), "FAL_KEY=keep-existing-value\n");
  } finally {
    await rm(root, { recursive: true, force: true });
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
