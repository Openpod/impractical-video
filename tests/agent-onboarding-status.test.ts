import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { agentOnboardingStatusFromFiles } from "@/lib/agent-onboarding-status";

const projectId = "onboarding-proof";

function generatedFiles(boundProjectId = projectId) {
  const contextHook = (agent: "claude" | "codex") =>
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                command: `/Applications/Video FS --agent-context-hook --agent ${agent} --project-id ${boundProjectId}`,
                type: "command",
              },
            ],
          },
        ],
      },
    });
  return {
    claudeConfig: JSON.stringify({
      mcpServers: {
        "video-fs": {
          args: ["--mcp", "--project-id", boundProjectId],
          command: "/Applications/Video FS",
          type: "stdio",
        },
      },
    }),
    claudeHook: contextHook("claude"),
    codexConfig: [
      "[mcp_servers.video-fs]",
      'command = "/Applications/Video FS"',
      `args = ["--mcp", "--project-id", "${boundProjectId}"]`,
      "",
      "[mcp_servers.personal]",
      'command = "personal"',
    ].join("\n"),
    codexHook: contextHook("codex"),
  };
}

describe("agent onboarding UI status", () => {
  it("recognizes exact project-bound Claude and Codex setup without returning contents", () => {
    expect(
      agentOnboardingStatusFromFiles(generatedFiles(), projectId, true),
    ).toEqual({
      claude: {
        configInstalled: true,
        contextHookInstalled: true,
      },
      codex: {
        configInstalled: true,
        contextHookInstalled: true,
      },
      desktopAvailable: true,
    });
  });

  it("does not call a config installed when it is bound to another project", () => {
    const status = agentOnboardingStatusFromFiles(
      generatedFiles(`${projectId}-extra`),
      projectId,
      true,
    );
    expect(status.claude.configInstalled).toBe(false);
    expect(status.codex.configInstalled).toBe(false);
    expect(status.claude.contextHookInstalled).toBe(false);
    expect(status.codex.contextHookInstalled).toBe(false);
  });

  it("treats malformed and unrelated user configuration as not installed", () => {
    expect(
      agentOnboardingStatusFromFiles(
        {
          claudeConfig: "{",
          claudeHook: JSON.stringify({ hooks: {} }),
          codexConfig:
            '[mcp_servers.personal]\ncommand = "personal"\nargs = []\n',
          codexHook: null,
        },
        projectId,
        false,
      ),
    ).toEqual({
      claude: {
        configInstalled: false,
        contextHookInstalled: false,
      },
      codex: {
        configInstalled: false,
        contextHookInstalled: false,
      },
      desktopAvailable: false,
    });
  });
});
