import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { agentSignedIn } from "@/lib/agent-connect";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// On Windows the two kinds of batch file an install can sit behind are started
// in different ways. Elsewhere a CLI is one executable file.
type Install = "batch file" | "executable" | "npm launcher";
const installs: Install[] = process.platform === "win32" ? ["npm launcher", "batch file"] : ["executable"];

/** Puts a stand-in CLI first on PATH. It answers the one command it expects
 * and fails any other, so a command line that arrives changed shows up. */
async function standIn(name: "claude" | "codex", install: Install, command: string[], reply: string, exitCode: number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "video-fs-agent-status-"));
  directories.push(directory);
  const script = path.join(directory, "node_modules", name, "bin", `${name}.js`);
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, [
    `if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(command))}) process.exit(64);`,
    `process.stdout.write(${JSON.stringify(reply)});`,
    `process.exitCode = ${exitCode};`,
    "",
  ].join("\n"));
  const target = `node_modules\\${name}\\bin\\${name}.js`;
  if (install === "executable") {
    await writeFile(path.join(directory, name), `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 });
  } else if (install === "npm launcher") {
    await writeFile(path.join(directory, `${name}.cmd`), [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      "",
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ") ELSE (",
      '  SET "_prog=node"',
      "  SET PATHEXT=%PATHEXT:;.JS;=;%",
      ")",
      "",
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
      "",
    ].join("\r\n"));
  } else {
    await writeFile(path.join(directory, `${name}.cmd`), ["@ECHO off", `node "%~dp0${target}" %1 %2`, "EXIT /b %ERRORLEVEL%", ""].join("\r\n"));
  }
  vi.stubEnv("PATH", `${directory}${path.delimiter}${process.env.PATH ?? ""}`);
}

describe.each(installs)("agent sign-in status from an installed %s", (install) => {
  it("believes Claude Code's own answer", async () => {
    await standIn("claude", install, ["auth", "status"], JSON.stringify({ loggedIn: true }), 0);
    expect(await agentSignedIn("claude")).toBe(true);
    // A signed-out Claude Code prints its answer and exits with 1.
    await standIn("claude", install, ["auth", "status"], JSON.stringify({ loggedIn: false }), 1);
    expect(await agentSignedIn("claude")).toBe(false);
  }, 30_000);

  it("takes Codex's exit code as its answer", async () => {
    await standIn("codex", install, ["login", "status"], "Logged in using ChatGPT\n", 0);
    expect(await agentSignedIn("codex")).toBe(true);
    await standIn("codex", install, ["login", "status"], "Not logged in\n", 1);
    expect(await agentSignedIn("codex")).toBe(false);
  }, 30_000);
});
