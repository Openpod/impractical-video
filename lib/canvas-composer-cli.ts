import { spawn } from "node:child_process";
import { localAgentCliEnv, resolveAgentBinary } from "@/lib/agent-binaries";

/** How the local composer reaches the reasoner: the user's own Claude Code or
 * Codex CLI, headless, cwd-bound to the project so the desktop hooks inject
 * context and the video-fs MCP server provides every tool. No OpenRouter. */

export type CliComposerEvent =
  | {
      aspectRatio: string | null;
      revises: string | null;
      title: string | null;
      toolName: string;
      type: "tool_start";
    }
  | { toolName: string; type: "tool_end" };

export type CliComposerResult = {
  agent: "claude" | "codex";
  ok: boolean;
  text: string;
};

const CLI_TIMEOUT_MS = 15 * 60 * 1000;

/** MCP tool names → the composer protocol names the canvas client already
 * understands (placeholder kinds, ticker labels). */
const TOOL_NAME_MAP: Record<string, string> = {
  check_project: "checkProject",
  create_scene: "createScene",
  generate_clip: "generateVideo",
  generate_image: "generateImage",
  load_workflow: "loadWorkflow",
  scaffold_keyframe: "scaffoldKeyframe",
};

function mappedToolName(rawName: string) {
  const bare = rawName.replace(/^mcp__video-fs__/, "");
  return TOOL_NAME_MAP[bare] ?? bare;
}

async function firstAvailableBinary(): Promise<{
  agent: "claude" | "codex";
  binary: string;
} | null> {
  const override = process.env.VIDEO_FS_COMPOSER_CLI?.trim();
  if (override) {
    const agent = override.includes("codex") ? "codex" : "claude";
    const binary = await resolveAgentBinary(agent, override);
    return binary ? { agent, binary } : null;
  }
  for (const candidate of ["claude", "codex"] as const) {
    const binary = await resolveAgentBinary(candidate);
    if (binary) return { agent: candidate, binary };
  }
  return null;
}

function claudeArgs(prompt: string) {
  return [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
  ];
}

function codexArgs(prompt: string) {
  return ["exec", "--json", prompt];
}

/** Runs one composer request through the local CLI agent. Events stream tool
 * activity in the canvas protocol; the returned text is the agent's reply. */
export async function runCliComposer({
  cwd,
  onEvent,
  prompt,
}: {
  cwd: string;
  onEvent: (event: CliComposerEvent) => void;
  prompt: string;
}): Promise<CliComposerResult> {
  const resolved = await firstAvailableBinary();
  if (!resolved) {
    throw new Error(
      "No local agent CLI found. Install Claude Code (claude) or Codex (codex) so the prompt box can reach it.",
    );
  }
  const { agent, binary } = resolved;
  const args = agent === "claude" ? claudeArgs(prompt) : codexArgs(prompt);

  return await new Promise<CliComposerResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: localAgentCliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const toolNamesById = new Map<string, string>();
    let finalText = "";
    let stderrTail = "";
    let buffered = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("The local agent run timed out."));
    }, CLI_TIMEOUT_MS);

    const handleClaudeLine = (line: string) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event.type === "assistant") {
        const message = event.message as
          | { content?: Array<Record<string, unknown>> }
          | undefined;
        for (const block of message?.content ?? []) {
          if (block.type !== "tool_use") continue;
          const rawName = typeof block.name === "string" ? block.name : "tool";
          const toolName = mappedToolName(rawName);
          if (typeof block.id === "string") {
            toolNamesById.set(block.id, toolName);
          }
          const input =
            block.input && typeof block.input === "object"
              ? (block.input as Record<string, unknown>)
              : {};
          onEvent({
            aspectRatio:
              typeof input.aspect_ratio === "string" ? input.aspect_ratio : null,
            revises: null,
            title: typeof input.title === "string" ? input.title : null,
            toolName,
            type: "tool_start",
          });
        }
        return;
      }
      if (event.type === "user") {
        const message = event.message as
          | { content?: Array<Record<string, unknown>> }
          | undefined;
        for (const block of message?.content ?? []) {
          if (block.type !== "tool_result") continue;
          const toolUseId =
            typeof block.tool_use_id === "string" ? block.tool_use_id : null;
          const toolName =
            (toolUseId ? toolNamesById.get(toolUseId) : null) ?? "tool";
          onEvent({ toolName, type: "tool_end" });
        }
        return;
      }
      if (event.type === "result") {
        if (typeof event.result === "string") finalText = event.result;
      }
    };

    const handleCodexLine = (line: string) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      // Codex exec --json emits {type:"item.completed", item:{type, text,...}}
      // envelopes; agent_message items carry the reply text and mcp_tool_call
      // items the tool activity.
      const item = event.item as Record<string, unknown> | undefined;
      if (!item || typeof item !== "object") return;
      if (item.type === "agent_message" && typeof item.text === "string") {
        finalText = item.text;
      }
      if (item.type === "mcp_tool_call" && typeof item.tool === "string") {
        const toolName = mappedToolName(item.tool);
        if (event.type === "item.started") {
          onEvent({
            aspectRatio: null,
            revises: null,
            title: null,
            toolName,
            type: "tool_start",
          });
        }
        if (event.type === "item.completed") {
          onEvent({ toolName, type: "tool_end" });
        }
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (!line) continue;
        if (agent === "claude") handleClaudeLine(line);
        else handleCodexLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 || finalText) {
        resolve({ agent, ok: code === 0, text: finalText.trim() });
        return;
      }
      reject(
        new Error(
          stderrTail.trim() || `The local agent exited with code ${code}.`,
        ),
      );
    });
  });
}
