#!/usr/bin/env node
// Backward-compatible entry point. All setup uses the conflict-preserving,
// token-free implementation shared with desktop.
const projectId = process.argv[2];
process.argv = [process.argv[0], process.argv[1], '--setup', '--project-id', projectId];
await import('./local-agent.mjs');
