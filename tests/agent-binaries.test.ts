import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { agentCliLaunch, commandShimTarget, localAgentCliEnv, resolveAgentBinary } from "@/lib/agent-binaries";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

// These launchers are copied from real installs on Windows.

/** `npm install -g @openai/codex`: a Node script behind the launcher. */
const NPM_NODE_LAUNCHER = [
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
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  "",
].join("\r\n");

/** `npm install -g @anthropic-ai/claude-code`: a program behind the launcher. */
const NPM_PROGRAM_LAUNCHER = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  "",
].join("\r\n");

/** npm's own launcher works out its script while it runs. */
const NPM_OWN_LAUNCHER = [
  ":: Created by npm, please don't edit manually.",
  "@ECHO OFF",
  "",
  "SETLOCAL",
  "",
  'SET "NODE_EXE=%~dp0\\node.exe"',
  'IF NOT EXIST "%NODE_EXE%" (',
  '  SET "NODE_EXE=node"',
  ")",
  "",
  'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
  'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
  "FOR /F \"delims=\" %%F IN ('CALL \"%NODE_EXE%\" \"%NPM_PREFIX_JS%\"') DO (",
  '  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"',
  ")",
  'IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (',
  '  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"',
  ")",
  "",
  '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
  "",
].join("\r\n");

/** `yarn global add @openai/codex`: the launcher on PATH forwards to a second one. */
const YARN_FIRST_LAUNCHER = '@"%~dp0\\..\\..\\Yarn\\Data\\global\\node_modules\\.bin\\codex.cmd"   %*\r\n';
const YARN_SECOND_LAUNCHER = [
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\..\\@openai\\codex\\bin\\codex.js" %*',
  ") ELSE (",
  "  @SETLOCAL",
  "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
  '  node  "%~dp0\\..\\@openai\\codex\\bin\\codex.js" %*',
  ")",
].join("\r\n");

const windowsEnvironment = { ComSpec: "C:\\Windows\\system32\\cmd.exe", NODE_ENV: "test" } as const;

describe("agent installation discovery", () => {
  // The two POSIX cases need a POSIX host: Windows has no execute bit, and its
  // paths hold the ":" that separates PATH entries here.
  it.skipIf(process.platform === "win32")("finds a native install even when the GUI PATH only contains system directories", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "video-fs-agent-path-")); directories.push(home);
    const directory = path.join(home, ".local", "bin");
    await mkdir(directory, { recursive: true });
    const binary = path.join(directory, "claude");
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const environment = localAgentCliEnv({ HOME: home, PATH: "/usr/bin:/bin", NODE_ENV: "test", FAL_KEY: "private-fixture" });
    expect(await resolveAgentBinary("claude", undefined, environment)).toBe(binary);
    expect(environment.FAL_KEY).toBeUndefined();
    expect(environment.PATH).toContain("/opt/homebrew/bin");
    expect(environment.PATH).toContain(path.join(home, ".volta", "bin"));
  });

  it.skipIf(process.platform === "win32")("respects an executable override and does not claim a missing or nonexecutable override is installed", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "video-fs-agent-override-")); directories.push(directory);
    expect(await resolveAgentBinary("codex", directory)).toBeNull();
    const binary = path.join(directory, "custom-codex");
    expect(await resolveAgentBinary("codex", binary)).toBeNull();
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    expect(await resolveAgentBinary("codex", binary)).toBeNull();
    await chmod(binary, 0o755);
    expect(await resolveAgentBinary("codex", binary)).toBe(binary);
  });

  it("finds Windows installs by extension in the folders their installers use", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "video-fs-agent-windows-")); directories.push(home);
    const system = path.join(home, "System32");
    const native = path.join(home, ".local", "bin");
    const npm = path.join(home, "AppData", "Roaming", "npm");
    for (const directory of [system, native, npm]) await mkdir(directory, { recursive: true });
    await writeFile(path.join(native, "claude.exe"), "");
    // npm leaves a shell script for Git Bash beside each launcher. Windows cannot start it.
    await writeFile(path.join(npm, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(path.join(npm, "codex.cmd"), NPM_NODE_LAUNCHER);
    const environment = localAgentCliEnv({
      APPDATA: path.join(home, "AppData", "Roaming"), FAL_KEY: "private-fixture", NODE_ENV: "test",
      Path: system, PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS", USERPROFILE: home,
    }, "win32");
    // Nothing rooted at "/" is added: Windows would read it against the current drive.
    expect(environment.PATH).toBe([system, native, npm].join(";"));
    expect(environment.Path).toBeUndefined();
    expect(environment.FAL_KEY).toBeUndefined();
    expect(await resolveAgentBinary("claude", undefined, environment, "win32")).toBe(path.join(native, "claude.exe"));
    expect(await resolveAgentBinary("codex", undefined, environment, "win32")).toBe(path.join(npm, "codex.cmd"));
  });

  it("accepts a Windows override with or without its extension", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "video-fs-agent-override-")); directories.push(directory);
    const binary = path.join(directory, "custom-codex.exe");
    expect(await resolveAgentBinary("codex", binary, windowsEnvironment, "win32")).toBeNull();
    await writeFile(binary, "");
    expect(await resolveAgentBinary("codex", binary, windowsEnvironment, "win32")).toBe(binary);
    expect(await resolveAgentBinary("codex", path.join(directory, "custom-codex"), windowsEnvironment, "win32")).toBe(binary);
    expect(await resolveAgentBinary("codex", directory, windowsEnvironment, "win32")).toBeNull();
  });
});

describe("agent launch on Windows", () => {
  it("reads which program a package manager's launcher starts", () => {
    expect(commandShimTarget(NPM_NODE_LAUNCHER)).toEqual({ interpreter: "node", target: "node_modules\\@openai\\codex\\bin\\codex.js" });
    expect(commandShimTarget(NPM_PROGRAM_LAUNCHER)).toEqual({ interpreter: null, target: "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" });
    expect(commandShimTarget('@"%~dp0\\node.exe"  "%~dp0\\node_modules\\tool\\cli.js" %*\r\n')).toEqual({ interpreter: "node", target: "node_modules\\tool\\cli.js" });
    expect(commandShimTarget('@python "%~dp0\\tool.py" %*\r\n')).toEqual({ interpreter: "other", target: "tool.py" });
    expect(commandShimTarget(NPM_OWN_LAUNCHER)).toBeNull();
  });

  it("starts the program behind a launcher instead of the batch file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "video-fs-agent-launcher-")); directories.push(directory);
    const prompt = ["exec", "--json", 'Line one\nLine "two" & %PATH%'];

    const codex = path.join(directory, "codex.cmd");
    const script = path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    await writeFile(codex, NPM_NODE_LAUNCHER);
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, "");
    expect(agentCliLaunch(codex, prompt, windowsEnvironment, "win32")).toEqual({ args: [script, ...prompt], command: "node" });
    // A Node installed beside the launcher is the one the launcher itself picks.
    const bundledNode = path.join(directory, "node.exe");
    await writeFile(bundledNode, "");
    expect(agentCliLaunch(codex, prompt, windowsEnvironment, "win32")).toEqual({ args: [script, ...prompt], command: bundledNode });

    const claude = path.join(directory, "claude.cmd");
    const program = path.join(directory, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    await writeFile(claude, NPM_PROGRAM_LAUNCHER);
    await mkdir(path.dirname(program), { recursive: true });
    await writeFile(program, "");
    expect(agentCliLaunch(claude, prompt, windowsEnvironment, "win32")).toEqual({ args: prompt, command: program });

    // A program needs no launcher, and other platforms start whatever was found.
    expect(agentCliLaunch(program, prompt, windowsEnvironment, "win32")).toEqual({ args: prompt, command: program });
    expect(agentCliLaunch(codex, prompt, windowsEnvironment, "linux")).toEqual({ args: prompt, command: codex });
  });

  it("follows a launcher that forwards to another launcher", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-fs-agent-yarn-")); directories.push(root);
    const modules = path.join(root, "Yarn", "Data", "global", "node_modules");
    const first = path.join(root, "prefix", "bin", "codex.cmd");
    const second = path.join(modules, ".bin", "codex.cmd");
    const script = path.join(modules, "@openai", "codex", "bin", "codex.js");
    for (const file of [first, second, script]) await mkdir(path.dirname(file), { recursive: true });
    await writeFile(first, YARN_FIRST_LAUNCHER);
    await writeFile(second, YARN_SECOND_LAUNCHER);
    await writeFile(script, "");
    expect(commandShimTarget(YARN_FIRST_LAUNCHER)).toEqual({ interpreter: null, target: "..\\..\\Yarn\\Data\\global\\node_modules\\.bin\\codex.cmd" });
    expect(commandShimTarget(YARN_SECOND_LAUNCHER)).toEqual({ interpreter: "node", target: "..\\@openai\\codex\\bin\\codex.js" });
    expect(agentCliLaunch(first, ["exec", "two words"], windowsEnvironment, "win32")).toEqual({ args: [script, "exec", "two words"], command: "node" });
    // A chain that never reaches a program is treated like any other batch file.
    await writeFile(second, YARN_FIRST_LAUNCHER);
    expect(() => agentCliLaunch(first, ["exec", "two words"], windowsEnvironment, "win32")).toThrow(/cannot receive this command safely/);
  });

  it("sends any other batch file through cmd.exe, and only with arguments cmd.exe leaves alone", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "video-fs-agent-batch-")); directories.push(directory);
    const npm = path.join(directory, "npm.cmd");
    await writeFile(npm, NPM_OWN_LAUNCHER);
    expect(agentCliLaunch(npm, ["install", "-g", "@openai/codex"], windowsEnvironment, "win32")).toEqual({
      args: ["/d", "/s", "/c", `""${npm}" install -g @openai/codex"`],
      command: "C:\\Windows\\system32\\cmd.exe",
      windowsVerbatimArguments: true,
    });
    for (const unsafe of ["two words", "a&b", "%PATH%", 'say "hi"', "line\nbreak", "caret^", ""]) {
      expect(() => agentCliLaunch(npm, ["exec", unsafe], windowsEnvironment, "win32")).toThrow(/cannot receive this command safely/);
    }
    // A launcher whose program is gone is treated like any other batch file.
    const codex = path.join(directory, "codex.cmd");
    await writeFile(codex, NPM_NODE_LAUNCHER);
    expect(() => agentCliLaunch(codex, ["exec", "two words"], windowsEnvironment, "win32")).toThrow(/cannot receive this command safely/);
  });

  it("hands a prompt to the program behind a launcher unchanged", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "video-fs-agent-prompt-")); directories.push(directory);
    const script = path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const launcher = path.join(directory, "codex.cmd");
    await writeFile(launcher, NPM_NODE_LAUNCHER);
    const args = ["exec", 'Line one\nLine "two" & more', "%PATH% ^ | < > !x!", "trailing\\", ""];
    const launch = agentCliLaunch(launcher, args, process.env, "win32");
    const { stdout } = await execFileAsync(launch.command, launch.args, {
      encoding: "utf8",
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    expect(JSON.parse(stdout)).toEqual(args);
  }, 30_000);
});
