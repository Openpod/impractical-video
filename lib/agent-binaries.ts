import "server-only";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { userAgentCliEnv } from "@/lib/agent-cli-env";

/** Finder-launched apps do not inherit an interactive shell's PATH. Use the
 * same search environment for detection, authentication and actual execution. */
export function localAgentCliEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = source.HOME || homedir();
  const directories = [
    ...(source.PATH || "").split(path.delimiter),
    path.join(home, ".local", "bin"), path.join(home, ".volta", "bin"),
    path.join(home, ".npm-global", "bin"), path.join(home, ".npm", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
  ].filter(Boolean);
  return { ...userAgentCliEnv(source), PATH: [...new Set(directories)].join(path.delimiter) };
}

export async function resolveAgentBinary(
  agent: "claude" | "codex",
  override?: string,
  environment = localAgentCliEnv(),
): Promise<string | null> {
  const requested = override?.trim() || agent;
  const candidates = path.isAbsolute(requested)
    ? [requested]
    : (environment.PATH || "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, requested));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Try the next installation location. */ }
  }
  return null;
}
