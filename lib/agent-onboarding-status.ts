import "server-only";

import { isLocalAppMode } from "@/lib/app-mode";
import { readWorkspaceFile } from "@/lib/workspace";

export type AgentOnboardingStatus = {
  claude: {
    configInstalled: boolean;
    contextHookInstalled: boolean;
  };
  codex: {
    configInstalled: boolean;
    contextHookInstalled: boolean;
  };
  desktopAvailable: boolean;
};

type AgentOnboardingFiles = {
  claudeConfig: string | null;
  claudeHook: string | null;
  codexConfig: string | null;
  codexHook: string | null;
};

function projectArgumentMatches(args: unknown, projectId: string) {
  if (!Array.isArray(args)) return false;
  const projectFlag = args.indexOf("--project-id");
  return (
    projectFlag >= 0 &&
    typeof args[projectFlag + 1] === "string" &&
    args[projectFlag + 1] === projectId
  );
}

function parseObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function tomlSection(value: string | null, heading: string) {
  if (!value) return "";
  const lines = value.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${heading}]`);
  if (start < 0) return "";
  const end = lines.findIndex(
    (line, index) =>
      index > start && line.trim().startsWith("[") && line.trim().endsWith("]"),
  );
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

function commandStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(commandStrings);
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(commandStrings);
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasBoundContextHook(
  config: Record<string, unknown> | null,
  agent: "claude" | "codex",
  projectId: string,
) {
  const projectPattern = escapeRegularExpression(projectId);
  return commandStrings(config).some(
    (command) =>
      /(?:^|\s)--agent-context-hook(?:\s|$)/.test(command) &&
      new RegExp(`(?:^|\\s)--agent\\s+${agent}(?=\\s|$)`).test(command) &&
      new RegExp(
        `(?:^|\\s)--project-id\\s+${projectPattern}(?=\\s|$)`,
      ).test(command),
  );
}

export function agentOnboardingStatusFromFiles(
  files: AgentOnboardingFiles,
  projectId: string,
  desktopAvailable: boolean,
): AgentOnboardingStatus {
  const claudeConfig = parseObject(files.claudeConfig);
  const claudeServers =
    claudeConfig?.mcpServers && typeof claudeConfig.mcpServers === "object"
      ? (claudeConfig.mcpServers as Record<string, unknown>)
      : null;
  const claudeServer =
    claudeServers?.["video-fs"] &&
    typeof claudeServers["video-fs"] === "object"
      ? (claudeServers["video-fs"] as Record<string, unknown>)
      : null;

  const claudeHook = parseObject(files.claudeHook);
  const codexConfigSection = tomlSection(
    files.codexConfig,
    "mcp_servers.video-fs",
  );
  const codexHook = parseObject(files.codexHook);

  return {
    claude: {
      configInstalled: Boolean(
        typeof claudeServer?.command === "string" &&
          projectArgumentMatches(claudeServer.args, projectId),
      ),
      contextHookInstalled: hasBoundContextHook(
        claudeHook,
        "claude",
        projectId,
      ),
    },
    codex: {
      configInstalled:
        codexConfigSection.includes("command =") &&
        codexConfigSection.includes("--project-id") &&
        codexConfigSection.includes(JSON.stringify(projectId)),
      contextHookInstalled: hasBoundContextHook(codexHook, "codex", projectId),
    },
    desktopAvailable,
  };
}

function desktopConnectionIsAvailable() {
  if (!isLocalAppMode()) return false;
  const token = process.env.PAPER_MCP_TOKEN?.trim();
  const rawUrl = process.env.VIDEO_FS_APP_URL?.trim();
  if (!token || !rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

export async function readAgentOnboardingStatus(
  projectId: string,
): Promise<AgentOnboardingStatus> {
  const readOptional = (relativePath: string) =>
    readWorkspaceFile(projectId, relativePath).catch(() => null);
  const [claudeConfig, claudeHook, codexConfig, codexHook] = await Promise.all([
    readOptional(".mcp.json"),
    readOptional(".claude/settings.json"),
    readOptional(".codex/config.toml"),
    readOptional(".codex/hooks.json"),
  ]);
  return agentOnboardingStatusFromFiles(
    { claudeConfig, claudeHook, codexConfig, codexHook },
    projectId,
    desktopConnectionIsAvailable(),
  );
}
