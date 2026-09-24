import "server-only";

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { localAgentCliEnv, resolveAgentBinary } from "@/lib/agent-binaries";

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

/** Fresh installs land in paths a GUI-launched app may not have. */
function connectEnv() {
  return localAgentCliEnv();
}

async function binaryAvailable(binary: ConnectAgent) {
  return Boolean(await resolveAgentBinary(binary));
}

/** Signed-in check through each CLI's own status command. */
export async function agentSignedIn(agent: ConnectAgent) {
  try {
    if (agent === "claude") {
      const { stdout } = await execFileAsync(
        "/usr/bin/env",
        ["claude", "auth", "status"],
        { env: connectEnv(), timeout: 8000 },
      );
      const parsed = JSON.parse(stdout.trim()) as { loggedIn?: boolean };
      return parsed.loggedIn === true;
    }
    await execFileAsync("/usr/bin/env", ["codex", "login", "status"], {
      env: connectEnv(),
      timeout: 8000,
    });
    return true;
  } catch {
    return false;
  }
}

const INSTALL_COMMANDS: Record<ConnectAgent, [string, string[]]> = {
  claude: ["/bin/bash", ["-c", "curl -fsSL https://claude.ai/install.sh | bash"]],
  codex: ["/usr/bin/env", ["npm", "install", "-g", "@openai/codex"]],
};

const LOGIN_COMMANDS: Record<ConnectAgent, string[]> = {
  claude: ["claude", "auth", "login", "--claudeai"],
  codex: ["codex", "login"],
};

function setStage(job: ConnectJob, stage: ConnectStage, detail?: string | null) {
  job.stage = stage;
  job.detail = detail ?? null;
}

function startLogin(job: ConnectJob) {
  setStage(job, "awaiting_browser");
  const child = spawn("/usr/bin/env", LOGIN_COMMANDS[job.agent], {
    env: connectEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.child = child;
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
      spawn("open", [url], { stdio: "ignore" }).on("error", () => {});
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
    startLogin(job);
    return agentConnectStatus(agent);
  }

  setStage(job, "installing");
  const [command, args] = INSTALL_COMMANDS[agent];
  const child = spawn(command, args, {
    env: connectEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.child = child;
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
      startLogin(job);
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
  job.child?.kill("SIGTERM");
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
