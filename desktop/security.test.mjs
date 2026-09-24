import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readPrivateConnectionState,
  validateConnectionState,
  validateLoopbackUrl,
  writePrivateConnectionState,
} from "./connection-state.mjs";
import {
  deriveProjectBearerToken,
  isProjectBearerAuthorized,
  resolveBoundProjectId,
  resolveBoundProjectRoot,
  validateProjectId,
} from "./project-binding.mjs";

const binding = "project-a";

test("bound bridge accepts only its exact project id", () => {
  assert.equal(resolveBoundProjectId(undefined, binding), binding);
  assert.equal(resolveBoundProjectId(binding, binding), binding);
  assert.throws(() => resolveBoundProjectId("project-b", binding), /bound to project/);
});

test("project ids reject traversal, absolute paths, and sanitization collisions", () => {
  for (const invalid of [
    "../project-a",
    "/tmp/project-a",
    "project/a",
    "project.a",
    "project a",
    " project-a",
    "project-a ",
    "",
    "project-a/../../sentinel",
  ]) {
    assert.throws(() => validateProjectId(invalid), /paths and surrounding whitespace/);
  }
});

test("rejected project paths cannot mutate an outside-root sentinel", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "video-fs-desktop-boundary-"));
  const sentinelPath = path.join(directory, "outside-root-sentinel.txt");
  await writeFile(sentinelPath, "preserve-me\n", "utf8");

  for (const invalid of ["../outside-root-sentinel", sentinelPath, "project/../../outside"]) {
    assert.throws(
      () => resolveBoundProjectId(invalid, binding),
      /paths and surrounding whitespace/,
    );
  }

  assert.equal(await readFile(sentinelPath, "utf8"), "preserve-me\n");
});

test("derived desktop bearers are bound to one exact project and data root", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "video-fs-desktop-project-bearer-"),
  );
  const dataRoot = path.join(directory, "projects");
  const otherRoot = path.join(directory, "other-projects");
  const master = "master-token-that-remains-in-private-state-only";
  for (const root of [dataRoot, otherRoot]) {
    await mkdir(path.join(root, "project-a"), { recursive: true });
    await writeFile(
      path.join(root, "project-a", "project.json"),
      '{"id":"project-a"}\n',
    );
  }
  await mkdir(path.join(dataRoot, "project-b"), { recursive: true });
  await writeFile(
    path.join(dataRoot, "project-b", "project.json"),
    '{"id":"project-b"}\n',
  );

  const projectAToken = deriveProjectBearerToken(
    master,
    dataRoot,
    "project-a",
  );
  const projectBToken = deriveProjectBearerToken(
    master,
    dataRoot,
    "project-b",
  );
  assert.notEqual(projectAToken, projectBToken);
  assert.notEqual(
    projectAToken,
    deriveProjectBearerToken(master, otherRoot, "project-a"),
  );
  assert.equal(
    isProjectBearerAuthorized(
      `Bearer ${projectAToken}`,
      master,
      dataRoot,
      "project-a",
    ),
    true,
  );
  assert.equal(
    isProjectBearerAuthorized(
      `Bearer ${projectAToken}`,
      master,
      dataRoot,
      "project-b",
    ),
    false,
  );
  assert.equal(
    path.basename(await resolveBoundProjectRoot(dataRoot, "project-a")),
    "project-a",
  );
  await assert.rejects(
    () => resolveBoundProjectRoot(dataRoot, "../project-a"),
    /paths and surrounding whitespace/,
  );
});

test("connection state permits only loopback origins", () => {
  assert.equal(validateLoopbackUrl("http://127.0.0.1:3210"), "http://127.0.0.1:3210");
  assert.equal(validateLoopbackUrl("http://localhost:3210"), "http://localhost:3210");
  assert.throws(() => validateLoopbackUrl("http://0.0.0.0:3210"), /loopback/);
  assert.throws(() => validateLoopbackUrl("https://example.com"), /loopback/);
  assert.throws(() => validateLoopbackUrl("http://localhost:3210/path"), /must not contain/);
});

test("private state is atomically replaced at mode 0600 and stale records are rejected", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "video-fs-desktop-security-"));
  const filePath = path.join(directory, "desktop-connection.json");
  const base = {
    appUrl: "http://127.0.0.1:3210",
    dataRoot: path.join(directory, "projects"),
    mcp: { args: ["--mcp"], command: "/Applications/Video FS.app/Contents/MacOS/Video FS" },
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: "a".repeat(43),
  };
  await writePrivateConnectionState(filePath, base);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await readPrivateConnectionState(filePath)).token, base.token);

  const rotated = { ...base, token: "b".repeat(43) };
  await writePrivateConnectionState(filePath, rotated);
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).token, rotated.token);

  await chmod(filePath, 0o644);
  await assert.rejects(() => readPrivateConnectionState(filePath), /permissions must be 0600/);
});

test("connection record validation never accepts a relative project root or launcher", () => {
  const base = {
    appUrl: "http://127.0.0.1:3210",
    dataRoot: "/tmp/projects",
    mcp: { args: ["--mcp"], command: "/Applications/Video FS" },
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: "a".repeat(43),
  };
  assert.doesNotThrow(() => validateConnectionState(base));
  assert.throws(() => validateConnectionState({ ...base, dataRoot: "../projects" }), /project root/);
  assert.throws(
    () => validateConnectionState({ ...base, mcp: { args: [], command: "video-fs" } }),
    /MCP launcher/,
  );
});
