import "server-only";

import { spawn, execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  agentCliLaunch,
  localAgentCliEnv,
  resolveAgentBinary,
  resolveCommand,
  stopAgentCli,
} from "@/lib/agent-binaries";

const execFileAsync = promisify(execFile);

/** Quietly pilots Claude/Codex install + sign-in so the user never sees a
 * terminal: the installer and the CLI's own login command run as hidden child
 * processes, and the provider's browser page is the only visible surface.
 * Credentials are stored by the CLIs themselves (keychain / ~/.codex) — the
 * app never reads or holds them. */

export type ConnectAgent = "claude" | "codex";

export type ConnectStage =
  | "awaiting_browser"
  | "connected"
  | "error"
  | "idle"
  | "installing";

type ConnectJob = {
  agent: ConnectAgent;
  child: ChildProcess | null;
  detail: string | null;
  stage: ConnectStage;
  startedAt: string;
};

const store = globalThis as typeof globalThis & {
  __videoFsAgentConnectJobs?: Map<ConnectAgent, ConnectJob>;
};
const jobs = store.__videoFsAgentConnectJobs ?? new Map<ConnectAgent, ConnectJob>();
store.__videoFsAgentConnectJobs = jobs;

const AGENT_NAMES: Record<ConnectAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** Fresh installs land in paths a GUI-launched app may not have. */
function connectEnv() {
  return localAgentCliEnv();
}

async function binaryAvailable(binary: ConnectAgent) {
  return Boolean(await resolveAgentBinary(binary));
}

function windowsSystemProgram(...segments: string[]) {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", ...segments);
}

const STATUS_COMMANDS: Record<ConnectAgent, string[]> = {
  claude: ["auth", "status"],
  codex: ["login", "status"],
};

/** Signed-in check through each CLI's own status command. */
export async function agentSignedIn(agent: ConnectAgent) {
  try {
    const environment = connectEnv();
    const binary = await resolveAgentBinary(agent, undefined, environment);
    if (!binary) return false;
    const launch = agentCliLaunch(binary, STATUS_COMMANDS[agent], environment);
    const { stdout } = await execFileAsync(launch.command, launch.args, {
      env: environment,
      timeout: 8000,
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    if (agent === "codex") return true;
    const parsed = JSON.parse(stdout.trim()) as { loggedIn?: boolean };
    return parsed.loggedIn === true;
  } catch {
    return false;
  }
}

/** Each provider's own installer: Claude's script for the platform, Codex from npm. */
async function installCommand(
  agent: ConnectAgent,
  environment: NodeJS.ProcessEnv,
): Promise<[string, string[]]> {
  if (agent === "claude") {
    if (process.platform !== "win32") {
      return ["/bin/bash", ["-c", "curl -fsSL https://claude.ai/install.sh | bash"]];
    }
    // An app started from PowerShell 7 inherits its module path, which hides
    // Windows PowerShell's own Get-FileHash from the installer. Without the
    // variable Windows PowerShell falls back to its own modules.
    for (const key of Object.keys(environment)) {
      if (key.toUpperCase() === "PSMODULEPATH") delete environment[key];
    }
    return [
      windowsSystemProgram("WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"],
    ];
  }
  const npm = await resolveCommand("npm", environment);
  if (!npm) throw new Error("npm was not found. Install Node.js, then connect Codex again.");
  return [npm, ["install", "-g", "@openai/codex"]];
}

const LOGIN_COMMANDS: Record<ConnectAgent, string[]> = {
  claude: ["auth", "login", "--claudeai"],
  codex: ["login"],
};

function setStage(job: ConnectJob, stage: ConnectStage, detail?: string | null) {
  job.stage = stage;
  job.detail = detail ?? null;
}

/** Opens the provider's sign-in page in the default browser. The address is
 * handed over as a single argument and never passes through a shell. */
function openInBrowser(url: string) {
  const [command, args]: [string, string[]] =
    process.platform === "win32"
      ? [windowsSystemProgram("rundll32.exe"), ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  spawn(command, args, { stdio: "ignore", windowsHide: true }).on("error", () => {});
}

/** Starts a CLI command for a job. Resolving the program is asynchronous, so a
 * cancel or a newer job may have taken over by the time it is found. */
async function startJobProcess(
  job: ConnectJob,
  stage: ConnectStage,
  resolve: (environment: NodeJS.ProcessEnv) => Promise<[string, string[]]>,
) {
  const environment = connectEnv();
  const [command, args] = await resolve(environment);
  if (jobs.get(job.agent) !== job || job.stage !== stage) return null;
  const launch = agentCliLaunch(command, args, environment);
  const child = spawn(launch.command, launch.args, {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  });
  job.child = child;
  return child;
}

async function startLogin(job: ConnectJob) {
  setStage(job, "awaiting_browser");
  let child: ChildProcess | null;
  try {
    child = await startJobProcess(job, "awaiting_browser", async (environment) => {
      const binary = await resolveAgentBinary(job.agent, undefined, environment);
      if (!binary) {
        throw new Error(`${AGENT_NAMES[job.agent]} could not be found after installing. Restart the app and connect again.`);
      }
      return [binary, LOGIN_COMMANDS[job.agent]];
    });
  } catch (error) {
    setStage(job, "error", error instanceof Error ? error.message : "Sign-in could not start.");
    return;
  }
  if (!child) return;
  let output = "";
  let opened = false;
  const scan = (chunk: string) => {
    output = `${output}${chunk}`.slice(-8000);
    if (opened) return;
    // Most CLI login flows open the browser themselves; if this one only
    // prints the URL, open it for the user so no terminal is ever needed.
    const url = /https:\/\/[^\s"'\])]+/.exec(chunk)?.[0];
    if (url && /login|auth|oauth|authorize|sso/i.test(url)) {
      opened = true;
      openInBrowser(url);
    }
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", scan);
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", scan);
  child.on("error", (error) => {
    job.child = null;
    setStage(job, "error", error.message);
  });
  child.on("close", (code) => {
    job.child = null;
    if (job.stage === "idle") return; // cancelled
    if (code === 0) {
      setStage(job, "connected");
    } else {
      setStage(
        job,
        "error",
        output.trim().slice(-300) || "Sign-in did not complete.",
      );
    }
  });
}

export async function startAgentConnect(agent: ConnectAgent) {
  const existing = jobs.get(agent);
  if (
    existing &&
    (existing.stage === "installing" || existing.stage === "awaiting_browser")
  ) {
    return agentConnectStatus(agent);
  }
  const job: ConnectJob = {
    agent,
    child: null,
    detail: null,
    stage: "idle",
    startedAt: new Date().toISOString(),
  };
  jobs.set(agent, job);

  if (await binaryAvailable(agent)) {
    if (await agentSignedIn(agent)) {
      setStage(job, "connected");
      return agentConnectStatus(agent);
    }
    await startLogin(job);
    return agentConnectStatus(agent);
  }

  setStage(job, "installing");
  let child: ChildProcess | null;
  try {
    child = await startJobProcess(job, "installing", (environment) => installCommand(agent, environment));
  } catch (error) {
    setStage(job, "error", error instanceof Error ? error.message : "The installer could not start.");
    return agentConnectStatus(agent);
  }
  if (!child) return agentConnectStatus(agent);
  let output = "";
  const capture = (chunk: string) => {
    output = `${output}${chunk}`.slice(-8000);
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", capture);
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", capture);
  child.on("error", (error) => {
    job.child = null;
    setStage(job, "error", error.message);
  });
  child.on("close", (code) => {
    job.child = null;
    if (job.stage === "idle") return; // cancelled
    if (code === 0) {
      void startLogin(job);
    } else {
      setStage(
        job,
        "error",
        output.trim().slice(-300) || "The installer did not complete.",
      );
    }
  });
  return agentConnectStatus(agent);
}

export function cancelAgentConnect(agent: ConnectAgent) {
  const job = jobs.get(agent);
  if (!job) return false;
  setStage(job, "idle");
  if (job.child) stopAgentCli(job.child);
  job.child = null;
  return true;
}

export async function agentConnectStatus(agent: ConnectAgent) {
  const installed = await binaryAvailable(agent);
  const job = jobs.get(agent);
  const stage = job?.stage ?? "idle";
  // A login completed outside the panel (or in a previous app run) still
  // counts: the CLI's own status is the source of truth once no job runs.
  if (stage === "idle" || stage === "connected") {
    const signedIn = await agentSignedIn(agent);
    return {
      agent,
      installed,
      detail: null,
      signedIn,
      stage: signedIn ? ("connected" as const) : ("idle" as const),
    };
  }
  return {
    agent,
    installed,
    detail: job?.detail ?? null,
    signedIn: false,
    stage,
  };
}
