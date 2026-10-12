import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { userAgentCliEnv } from "@/lib/agent-cli-env";

/** What Windows can start directly or through cmd.exe. An npm install also
 * leaves an extension-less sh script next to its .cmd launcher; that one is
 * for Git Bash and must never be picked. */
const WINDOWS_STARTABLE = new Set([".com", ".exe", ".bat", ".cmd"]);

/** Windows has one PATH whatever its spelling, but a copied environment keeps
 * the key it was copied with (usually `Path`). When a copy holds two spellings,
 * take the one Node hands to a child process: the first in sorted order. */
function environmentValue(environment: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform) {
  if (platform !== "win32") return environment[name];
  const key = Object.keys(environment).sort().find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : environment[key];
}

/** Finder-launched apps do not inherit an interactive shell's PATH. Use the
 * same search environment for detection, authentication and actual execution. */
export function localAgentCliEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const windows = platform === "win32";
  const delimiter = windows ? ";" : ":";
  const home = environmentValue(source, windows ? "USERPROFILE" : "HOME", platform) || homedir();
  const directories = [
    ...(environmentValue(source, "PATH", platform) || "").split(delimiter),
    path.join(home, ".local", "bin"),
    ...(windows
      // A running app does not see the PATH entry an installer has just added.
      // Rooted POSIX directories are left out: on Windows they would resolve
      // against the current drive, where any local account may create them.
      ? [path.join(environmentValue(source, "APPDATA", platform) || path.join(home, "AppData", "Roaming"), "npm")]
      : [
          path.join(home, ".volta", "bin"),
          path.join(home, ".npm-global", "bin"), path.join(home, ".npm", "bin"),
          "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
        ]),
  ].filter(Boolean);
  const environment = userAgentCliEnv(source);
  if (windows) {
    for (const key of Object.keys(environment)) {
      if (key.toUpperCase() === "PATH") delete environment[key];
    }
  }
  return { ...environment, PATH: [...new Set(directories)].join(delimiter) };
}

function candidateNames(requested: string, environment: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  if (platform !== "win32") return [requested];
  if (WINDOWS_STARTABLE.has(path.extname(requested).toLowerCase())) return [requested];
  const extensions = (environmentValue(environment, "PATHEXT", platform) || "")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => WINDOWS_STARTABLE.has(extension));
  return (extensions.length ? extensions : [".com", ".exe", ".bat", ".cmd"]).map((extension) => `${requested}${extension}`);
}

/** Finds a command the way the platform's own shell would: PATH order, and on
 * Windows the PATHEXT extensions inside each directory. */
export async function resolveCommand(
  requested: string,
  environment = localAgentCliEnv(),
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const windows = platform === "win32";
  const names = candidateNames(requested, environment, platform);
  const directories = path.isAbsolute(requested)
    ? [null]
    : (environmentValue(environment, "PATH", platform) || "").split(windows ? ";" : ":").filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = directory === null ? name : path.join(directory, name);
      try {
        // Windows has no execute bit: there the extension decides what can start.
        if (!windows) await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) return candidate;
      } catch { /* Try the next installation location. */ }
    }
  }
  return null;
}

export async function resolveAgentBinary(
  agent: "claude" | "codex",
  override?: string,
  environment = localAgentCliEnv(),
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  return resolveCommand(override?.trim() || agent, environment, platform);
}

export type AgentCliLaunch = {
  args: string[];
  command: string;
  /** Set when the arguments are already one cmd.exe command line. */
  windowsVerbatimArguments?: boolean;
};

/** What a package manager's .cmd launcher forwards to: the script or program
 * beside it, and the interpreter it is run with ("node", null when the target
 * runs by itself, "other" for anything else). Such a launcher ends in
 * `<interpreter> "%dp0%\<target>" %*`. Where that line appears twice, the last
 * is the one that runs when the launcher's own directory has no node.exe. */
export function commandShimTarget(shim: string): { interpreter: string | null; target: string } | null {
  let found: { interpreter: string | null; target: string } | null = null;
  for (const line of shim.split(/\r?\n/)) {
    const forwards = /^(.*?)"%(?:~dp0|dp0%)\\?([^"]+)"\s+%\*\s*$/.exec(line);
    if (!forwards) continue;
    const program = forwards[1].trim().replace(/^@/, "");
    const named = program.endsWith('"%_prog%"')
      ? /SET "_prog=([A-Za-z0-9_.-]+)"/i.exec(shim)?.[1] ?? "other"
      : program;
    const interpreter = named === "" || named.endsWith("&")
      ? null
      : /(?:^|[\\"\s])node(?:\.exe)?"?$/i.test(named) ? "node" : "other";
    found = { interpreter, target: forwards[2] };
  }
  return found;
}

/** Turns a resolved command into what can actually be spawned.
 *
 * Node refuses to start .cmd and .bat files without a shell, and cmd.exe
 * cannot carry a prompt safely: it splits on `&`, expands `%NAME%` and stops at
 * the first newline. A package manager's launcher only forwards to a script or
 * a program, so start that directly and every argument arrives unchanged. Any
 * other batch file goes through cmd.exe, and only with arguments that have no
 * meaning to it. */
export function agentCliLaunch(
  file: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): AgentCliLaunch {
  const extension = path.extname(file).toLowerCase();
  if (platform !== "win32" || (extension !== ".cmd" && extension !== ".bat")) {
    return { args, command: file };
  }
  // Yarn's launcher forwards to a second launcher, which starts the program.
  let launcher = file;
  for (let hop = 0; hop < 4; hop += 1) {
    const directory = path.dirname(launcher);
    let shim: ReturnType<typeof commandShimTarget> = null;
    try {
      shim = commandShimTarget(readFileSync(launcher, "utf8"));
    } catch { /* Unreadable launchers take the cmd.exe route below. */ }
    const target = shim ? path.join(directory, ...shim.target.split(/[\\/]+/)) : null;
    if (!shim || !target || !existsSync(target)) break;
    if (shim.interpreter === "node") {
      const bundledNode = path.join(directory, "node.exe");
      return { args: [target, ...args], command: existsSync(bundledNode) ? bundledNode : "node" };
    }
    if (shim.interpreter !== null) break;
    if (/\.(?:exe|com)$/i.test(target)) return { args, command: target };
    if (!/\.(?:cmd|bat)$/i.test(target)) break;
    launcher = target;
  }
  if (/["%]/.test(file) || !args.every((argument) => /^[A-Za-z0-9@_.:=+/\\-]+$/.test(argument))) {
    throw new Error(
      `${path.basename(file)} is a batch file that cannot receive this command safely. Use the program it starts instead.`,
    );
  }
  return {
    args: ["/d", "/s", "/c", `""${file}"${args.map((argument) => ` ${argument}`).join("")}"`],
    command: environmentValue(environment, "COMSPEC", platform) || "cmd.exe",
    windowsVerbatimArguments: true,
  };
}

/** Stops an agent CLI and whatever it started. A Windows kill ends only the
 * one process it names, and the npm launchers run the real program as a child. */
export function stopAgentCli(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (process.platform !== "win32" || !child.pid) {
    child.kill(signal);
    return;
  }
  spawn(
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
    ["/pid", String(child.pid), "/t", "/f"],
    { stdio: "ignore", windowsHide: true },
  ).on("error", () => child.kill(signal));
}
