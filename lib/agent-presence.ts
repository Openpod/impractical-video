/** Live agent-session presence. The paper MCP server only runs while a Claude
 * or Codex session holds it open, and it heartbeats the app with its client
 * identity; a recent beat therefore means "that agent is connected right
 * now". Stored on globalThis so dev-mode module reloads don't drop it. */

const PRESENCE_TTL_MS = 75_000;

type AgentPresenceStore = {
  claude?: number;
  codex?: number;
  unknown?: number;
};

const store = globalThis as typeof globalThis & {
  __videoFsAgentPresence?: AgentPresenceStore;
};

export function recordAgentPresence(agent?: string | null) {
  const key =
    agent === "claude" ? "claude" : agent === "codex" ? "codex" : "unknown";
  store.__videoFsAgentPresence = {
    ...store.__videoFsAgentPresence,
    [key]: Date.now(),
  };
}

function fresh(at: number | undefined) {
  return Boolean(at && Date.now() - at < PRESENCE_TTL_MS);
}

export function readAgentPresence() {
  const presence = store.__videoFsAgentPresence ?? {};
  const claude = fresh(presence.claude);
  const codex = fresh(presence.codex);
  const unknown = fresh(presence.unknown);
  return {
    agent: claude && !codex ? "claude" : codex && !claude ? "codex" : null,
    claude,
    codex,
    connected: claude || codex || unknown,
  };
}
