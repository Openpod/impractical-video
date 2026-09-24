#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { setupAgentProject } from "./agent-setup.mjs";
import {
  assertDesktopEndpointAvailable,
  readPrivateConnectionState,
} from "./connection-state.mjs";
import { validateProjectId } from "./project-binding.mjs";

const projectId = validateProjectId(
  argumentValue("--project-id") || process.argv[2] || "",
  "project id",
);
const statePath =
  process.env.VIDEO_FS_DESKTOP_STATE_FILE?.trim() ||
  path.join(os.homedir(), "Library", "Application Support", "Video FS", "desktop-connection.json");
const state = await readPrivateConnectionState(statePath);
await assertDesktopEndpointAvailable(state.appUrl);
const result = await setupAgentProject({ projectId, state });
console.log(
  result.conflicts.length
    ? `Video FS agent setup preserved existing ${result.conflicts.join(
        ", ",
      )}; review .video-fs/CONNECT_AGENTS.md.`
    : `Video FS agent setup is ready for ${projectId}.`,
);

function argumentValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
