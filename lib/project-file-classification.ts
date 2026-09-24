/**
 * Project-local files that configure terminal agents but are not video
 * artifacts. Keep this list exact: malformed records elsewhere must continue
 * to surface through the source-graph parser.
 */
export const PROJECT_SUPPORT_METADATA_PATHS = new Set([
  ".codex/config.toml",
  ".mcp.json",
  ".video-fs/CONNECT_AGENTS.md",
  ".video-fs/claude.mcp.json",
  ".video-fs/codex.config.toml",
  "AGENTS.md",
  "CLAUDE.md",
  "VIDEO_FS_AGENT_GUIDE.md",
]);

export function isProjectSupportMetadataPath(relativePath: string) {
  const normalized = relativePath.replaceAll("\\", "/");
  // Agent/runtime bookkeeping churns constantly (git index, CLI session
  // state, companion transcripts). None of it is a video artifact, and every
  // watcher event for it forces the canvas to refetch and remount players
  // mid-playback.
  if (
    normalized === ".git" || normalized.startsWith(".git/") ||
    normalized === ".claude" || normalized.startsWith(".claude/") ||
    normalized === ".codex" || normalized.startsWith(".codex/") ||
    normalized === ".video-fs" || normalized.startsWith(".video-fs/") ||
    normalized === "chat.json"
  ) {
    return true;
  }
  return PROJECT_SUPPORT_METADATA_PATHS.has(normalized);
}
