# Desktop integration

This directory owns the Electron shell, local MCP bridge, agent setup, and
desktop packaging. Read `desktop/README.md` and `SECURITY.md` before changing
their trust boundaries.

- Keep the app server and MCP connection on loopback. The private desktop
  connection record contains the bearer token; generated project guides,
  `.mcp.json`, `.codex/config.toml`, and hooks must remain token-free.
- Keep MCP credentials bound to one validated project and data root. Use the
  checks in `project-binding.mjs`; do not construct project paths from raw
  request IDs or relax the realpath containment check.
- Preserve existing user-authored agent configuration. Fresh projects link
  `CLAUDE.md` → `AGENTS.md` → `VIDEO_FS_AGENT_GUIDE.md`; setup refreshes the
  app-owned guide. If this changes, cover fresh, repeated, and customized
  project setup in `agent-setup.test.mjs`.
- Maintain owner-only permissions for private connection state and generated
  configuration. Keep secrets out of packaged artifacts and source exports.
- Use temporary project fixtures and mock provider calls in tests. Run the
  relevant `node --test desktop/<name>.test.mjs` files; run
  `npm run test:desktop` when Electron is installed. Use
  `npm run desktop:release:check` when preparing a signed macOS release; it
  requires signing and notarization credentials.
