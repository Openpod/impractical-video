import { constants } from "node:fs";
import { access, chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export function validateConnectionState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Desktop connection record must be an object.");
  }
  const appUrl = validateLoopbackUrl(value.appUrl);
  if (typeof value.token !== "string" || value.token.length < 32) {
    throw new Error("Desktop connection record has an invalid token.");
  }
  if (
    typeof value.dataRoot !== "string" ||
    !path.isAbsolute(value.dataRoot) ||
    !value.dataRoot.trim()
  ) {
    throw new Error("Desktop connection record has an invalid project root.");
  }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error("Desktop connection record has an invalid PID.");
  }
  if (typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt))) {
    throw new Error("Desktop connection record has an invalid launch timestamp.");
  }
  if (
    !value.mcp ||
    typeof value.mcp !== "object" ||
    typeof value.mcp.command !== "string" ||
    !path.isAbsolute(value.mcp.command) ||
    !Array.isArray(value.mcp.args) ||
    !value.mcp.args.every((argument) => typeof argument === "string")
  ) {
    throw new Error("Desktop connection record has an invalid MCP launcher.");
  }
  return { ...value, appUrl };
}

export function validateLoopbackUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error("Desktop connection URL is invalid.");
  }
  const allowedHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
  if (parsed.protocol !== "http:" || !allowedHosts.has(parsed.hostname) || parsed.username || parsed.password) {
    throw new Error("Desktop connection URL must use an unauthenticated loopback HTTP origin.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Desktop connection URL must not contain a path, query, or fragment.");
  }
  return parsed.origin;
}

export async function readPrivateConnectionState(filePath, { requireLivePid = true } = {}) {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    throw new Error(desktopUnavailableMessage());
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error("Video FS Desktop connection record permissions must be 0600.");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("Video FS Desktop connection record is owned by another user.");
  }
  const state = validateConnectionState(JSON.parse(await readFile(filePath, "utf8")));
  if (requireLivePid) {
    try {
      process.kill(state.pid, 0);
    } catch {
      throw new Error(desktopUnavailableMessage());
    }
  }
  return state;
}

export async function writePrivateConnectionState(filePath, value) {
  const state = validateConnectionState(value);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function assertDesktopEndpointAvailable(appUrl, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(appUrl, {
      headers: { accept: "text/html" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 500) {
      throw new Error(`Video FS Desktop returned HTTP ${response.status}.`);
    }
  } catch {
    throw new Error(desktopUnavailableMessage());
  } finally {
    clearTimeout(timeout);
  }
}

export function desktopUnavailableMessage() {
  return (
    "Video FS Desktop is unavailable. Open the desktop app, open this project, " +
    "then reconnect or restart your Claude/Codex session."
  );
}

export async function assertPathExists(filePath) {
  await access(filePath, constants.F_OK);
}
