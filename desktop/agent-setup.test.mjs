import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { setupAgentProject } from "./agent-setup.mjs";
import { assertDesktopEndpointAvailable } from "./connection-state.mjs";

const launcher = "/Applications/Video FS.app/Contents/MacOS/Video FS";
const execFileAsync = promisify(execFile);

async function fixture(projectId = "project-a") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "video-fs-agent-setup-"));
  const dataRoot = path.join(directory, "projects");
  const projectRoot = path.join(dataRoot, projectId);
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    path.join(projectRoot, "project.json"),
    `${JSON.stringify({ id: projectId, name: "Fixture" })}\n`,
    "utf8",
  );
  return {
    projectId,
    projectRoot,
    state: {
      appUrl: "http://127.0.0.1:3210",
      dataRoot,
      mcp: { args: ["--mcp"], command: launcher },
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token: "desktop-secret-token-that-must-never-be-written",
    },
  };
}

test("packaging manifest includes the self-contained setup helper", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("./package.json", import.meta.url), "utf8"),
  );
  assert.ok(manifest.build.files.includes("agent-setup.mjs"));
  assert.ok(manifest.build.files.includes("agent-context-hook.mjs"));
  assert.ok(manifest.build.files.includes("setup-agent.mjs"));
  assert.ok(manifest.build.files.includes("main.mjs"));
  assert.ok(
    manifest.build.extraResources.some(
      (entry) => entry.from === "../skills" && entry.to === "skills",
    ),
  );
});

test("fresh project receives Claude and Codex project-local configuration at mode 0600", async () => {
  const input = await fixture();
  const result = await setupAgentProject(input);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.codexProjectRoot, { status: "created" });
  for (const relativePath of [
    ".mcp.json",
    ".claude/settings.json",
    ".codex/config.toml",
    ".codex/hooks.json",
  ]) {
    assert.equal((await stat(path.join(input.projectRoot, relativePath))).mode & 0o777, 0o600);
  }
  assert.match(
    await readFile(path.join(input.projectRoot, "AGENTS.md"), "utf8"),
    /one external agent process per project[\s\S]*same-project\s+conflict resolution is not supported/,
  );
  const claudeSettings = JSON.parse(
    await readFile(
      path.join(input.projectRoot, ".claude", "settings.json"),
      "utf8",
    ),
  );
  assert.equal(claudeSettings.enableAllProjectMcpServers, true);
  assert.deepEqual(claudeSettings.enabledMcpjsonServers, ["video-fs"]);
  await assert.rejects(stat(path.join(input.projectRoot, ".claude", "skills", "adult-glamour-portfolio", "SKILL.md")), { code: "ENOENT" });
  assert.doesNotMatch(await readFile(path.join(input.projectRoot, "VIDEO_FS_AGENT_GUIDE.md"), "utf8"), /adult-glamour-portfolio/);
  for (const skill of [
    "internet-style-references",
    "reference-first-production",
  ]) {
    assert.match(
      await readFile(
        path.join(input.projectRoot, ".claude", "skills", skill, "SKILL.md"),
        "utf8",
      ),
      /^---\n/,
    );
  }
});

test("legacy app-owned Claude settings gain the explicit Video FS approval", async () => {
  const input = await fixture("legacy-claude-approval");
  await mkdir(path.join(input.projectRoot, ".claude"));
  await writeFile(
    path.join(input.projectRoot, ".claude", "settings.json"),
    `${JSON.stringify(
      {
        enableAllProjectMcpServers: true,
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  command:
                    "'/Applications/Video FS.app/Contents/MacOS/Video FS' --agent-context-hook --agent claude --project-id legacy-claude-approval",
                  timeout: 5,
                  type: "command",
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await setupAgentProject(input);

  const settings = JSON.parse(
    await readFile(
      path.join(input.projectRoot, ".claude", "settings.json"),
      "utf8",
    ),
  );
  assert.equal(settings.enableAllProjectMcpServers, true);
  assert.deepEqual(settings.enabledMcpjsonServers, ["video-fs"]);
});

test("fresh project becomes a valid Codex project root without user Git setup", async () => {
  const input = await fixture("codex-root");
  const first = await setupAgentProject(input);
  const second = await setupAgentProject(input);

  assert.deepEqual(first.codexProjectRoot, { status: "created" });
  assert.deepEqual(second.codexProjectRoot, { status: "existing" });
  const { stdout } = await execFileAsync("git", [
    "-C",
    input.projectRoot,
    "rev-parse",
    "--show-toplevel",
  ]);
  assert.equal(stdout.trim(), await realpath(input.projectRoot));
  await assert.rejects(
    () =>
      execFileAsync("git", [
        "-C",
        input.projectRoot,
        "config",
        "--get",
        "remote.origin.url",
      ]),
    (error) => error?.code === 1,
  );
  assert.match(
    await readFile(path.join(input.projectRoot, "AGENTS.md"), "utf8"),
    /No commit or remote was\s+created/,
  );
  assert.match(
    await readFile(
      path.join(input.projectRoot, ".video-fs", "CONNECT_AGENTS.md"),
      "utf8",
    ),
    /No Git initialization,[\s\S]*--skip-git-repo-check/,
  );
});

test("existing Claude and Codex configuration is preserved byte-for-byte", async () => {
  const input = await fixture();
  const claudeOriginal = '{"mcpServers":{"personal":{"command":"personal"}}}\n';
  const codexOriginal = '[mcp_servers.personal]\ncommand = "personal"\n';
  await mkdir(path.join(input.projectRoot, ".codex"));
  await writeFile(path.join(input.projectRoot, ".mcp.json"), claudeOriginal, "utf8");
  await writeFile(
    path.join(input.projectRoot, ".codex", "config.toml"),
    codexOriginal,
    "utf8",
  );

  const result = await setupAgentProject(input);
  assert.deepEqual(result.conflicts.slice(0, 2), [".mcp.json", ".codex/config.toml"]);
  assert.equal(await readFile(path.join(input.projectRoot, ".mcp.json"), "utf8"), claudeOriginal);
  assert.equal(
    await readFile(path.join(input.projectRoot, ".codex", "config.toml"), "utf8"),
    codexOriginal,
  );
  assert.match(
    await readFile(path.join(input.projectRoot, ".video-fs", "CONNECT_AGENTS.md"), "utf8"),
    /preserved byte-for-byte/,
  );
});

test("existing hook configuration is preserved and receives content-addressed conflict copies", async () => {
  const input = await fixture();
  const claudeOriginal = '{"hooks":{"UserPromptSubmit":[]}}\n';
  const codexOriginal = '{"description":"personal hooks","hooks":{}}\n';
  await Promise.all([
    mkdir(path.join(input.projectRoot, ".claude")),
    mkdir(path.join(input.projectRoot, ".codex")),
  ]);
  await writeFile(
    path.join(input.projectRoot, ".claude", "settings.json"),
    claudeOriginal,
    "utf8",
  );
  await writeFile(
    path.join(input.projectRoot, ".codex", "hooks.json"),
    codexOriginal,
    "utf8",
  );

  const first = await setupAgentProject(input);
  const second = await setupAgentProject(input);
  assert.ok(first.conflicts.includes(".claude/settings.json"));
  assert.ok(first.conflicts.includes(".codex/hooks.json"));
  assert.deepEqual(second.conflicts, first.conflicts);
  assert.equal(
    await readFile(
      path.join(input.projectRoot, ".claude", "settings.json"),
      "utf8",
    ),
    claudeOriginal,
  );
  assert.equal(
    await readFile(path.join(input.projectRoot, ".codex", "hooks.json"), "utf8"),
    codexOriginal,
  );
  const conflicts = await readdir(
    path.join(input.projectRoot, ".video-fs", "conflicts"),
  );
  assert.equal(
    conflicts.filter((name) => name.startsWith("claude-settings-video-fs-"))
      .length,
    1,
  );
  assert.equal(
    conflicts.filter((name) => name.startsWith("codex-hooks-video-fs-")).length,
    1,
  );
  assert.match(
    await readFile(
      path.join(input.projectRoot, ".video-fs", "CONNECT_AGENTS.md"),
      "utf8",
    ),
    /Until it is merged and trusted, prompts continue normally/,
  );
});

test("all generated agent setup files are token-free", async () => {
  const input = await fixture();
  await setupAgentProject(input);
  for (const relativePath of [
    ".mcp.json",
    ".claude/settings.json",
    ".codex/config.toml",
    ".codex/hooks.json",
    "CLAUDE.md",
    "AGENTS.md",
    "VIDEO_FS_AGENT_GUIDE.md",
    ".video-fs/claude.mcp.json",
    ".video-fs/codex.config.toml",
    ".video-fs/CONNECT_AGENTS.md",
  ]) {
    assert.doesNotMatch(
      await readFile(path.join(input.projectRoot, relativePath), "utf8"),
      new RegExp(input.state.token),
    );
  }
});

test("both generated launchers bind exactly the opened project", async () => {
  const input = await fixture("bound-project");
  await setupAgentProject(input);
  const claude = JSON.parse(
    await readFile(path.join(input.projectRoot, ".mcp.json"), "utf8"),
  );
  assert.deepEqual(claude.mcpServers["video-fs"], {
    args: ["--mcp", "--project-id", "bound-project"],
    command: launcher,
    type: "stdio",
  });
  const codex = await readFile(
    path.join(input.projectRoot, ".codex", "config.toml"),
    "utf8",
  );
  assert.match(codex, /args = \["--mcp", "--project-id", "bound-project"\]/);
  assert.doesNotMatch(codex, /project-a|project-b/);

  const claudeHooks = JSON.parse(
    await readFile(
      path.join(input.projectRoot, ".claude", "settings.json"),
      "utf8",
    ),
  );
  const codexHooks = JSON.parse(
    await readFile(path.join(input.projectRoot, ".codex", "hooks.json"), "utf8"),
  );
  const claudeCommand =
    claudeHooks.hooks.UserPromptSubmit[0].hooks[0].command;
  const codexCommand = codexHooks.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.match(
    claudeCommand,
    /--agent-context-hook --agent claude --project-id bound-project$/,
  );
  assert.match(
    codexCommand,
    /--agent-context-hook --agent codex --project-id bound-project$/,
  );
  assert.equal(
    claudeCommand.replace("--agent claude", "--agent codex"),
    codexCommand,
  );
});

test("agent setup is idempotent after Video FS owns all generated files", async () => {
  const input = await fixture();
  const first = await setupAgentProject(input);
  const second = await setupAgentProject(input);
  assert.deepEqual(first.conflicts, []);
  assert.deepEqual(second.conflicts, []);
  assert.deepEqual(second.created, []);
});

test("disconnected bridge error tells the user how to recover and hides fetch internals", async () => {
  await assert.rejects(
    () => assertDesktopEndpointAvailable("http://127.0.0.1:1", 100),
    (error) => {
      assert.match(error.message, /Open the desktop app/);
      assert.match(error.message, /reconnect or restart/);
      assert.doesNotMatch(error.message, /fetch failed|ECONNREFUSED/i);
      return true;
    },
  );
});
