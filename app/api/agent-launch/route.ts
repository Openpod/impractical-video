import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureAgentContextRoot } from "@/lib/agent-context/paths";
import { isLocalAppMode } from "@/lib/app-mode";
import { resolveAgentBinary } from "@/lib/agent-binaries";

const execFileAsync = promisify(execFile);

const requestSchema = z.object({
  agent: z.enum(["claude", "codex"]),
  projectId: z.string().min(1),
  /** Setup mode installs the CLI if missing, then starts it so the provider's
   * own sign-in flow runs (existing plan or new account) — the app never
   * touches credentials. */
  setup: z.boolean().default(false),
});

/** Official installers, shown verbatim in the user's own Terminal. */
const SETUP_COMMANDS = {
  claude:
    'command -v claude >/dev/null 2>&1 || curl -fsSL https://claude.ai/install.sh | bash; export PATH="$HOME/.local/bin:$PATH"; claude',
  codex:
    "command -v codex >/dev/null 2>&1 || npm install -g @openai/codex; codex",
} as const;

/** Escapes a path for use inside single quotes in a POSIX shell command. */
function shellSingleQuoted(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Escapes a string for embedding inside an AppleScript double-quoted string. */
function appleScriptQuoted(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Opens Terminal.app with a Claude/Codex session started in the project
 * directory, so the session binds to the project and its MCP toolchain. */
export async function POST(request: Request) {
  if (!isLocalAppMode(process.env)) {
    return NextResponse.json(
      { error: "Agent launch is only available in the desktop app." },
      { status: 403 },
    );
  }
  if (process.platform !== "darwin") {
    return NextResponse.json(
      { error: "Terminal launch is currently macOS-only." },
      { status: 501 },
    );
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid agent launch request." },
      { status: 400 },
    );
  }
  const { agent, projectId, setup } = parsed.data;

  let projectDirectory: string;
  try {
    ({ projectDirectory } = await ensureAgentContextRoot(projectId));
  } catch {
    return NextResponse.json(
      { error: "The project directory is unavailable." },
      { status: 404 },
    );
  }

  const binary = await resolveAgentBinary(agent);
  if (!setup && !binary) {
      return NextResponse.json(
        {
          error:
            agent === "claude"
              ? "Claude Code is not installed. Install the claude CLI first."
              : "Codex is not installed. Install the codex CLI first.",
        },
        { status: 404 },
      );
  }

  const shellCommand = `cd ${shellSingleQuoted(projectDirectory)} && ${
    setup ? SETUP_COMMANDS[agent] : shellSingleQuoted(binary!)
  }`;
  const script = [
    'tell application "Terminal"',
    "  activate",
    `  do script "${appleScriptQuoted(shellCommand)}"`,
    "end tell",
  ].join("\n");
  try {
    await execFileAsync("osascript", ["-e", script]);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Terminal could not open.",
      },
      { status: 500 },
    );
  }
  return NextResponse.json({ launched: agent, projectId });
}
