import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { localAgentCliEnv, resolveAgentBinary } from "@/lib/agent-binaries";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("agent installation discovery", () => {
  it("finds a native install even when the GUI PATH only contains system directories", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "video-fs-agent-path-")); directories.push(home);
    const directory = path.join(home, ".local", "bin");
    await mkdir(directory, { recursive: true });
    const binary = path.join(directory, "claude");
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const environment = localAgentCliEnv({ HOME: home, PATH: "/usr/bin:/bin", NODE_ENV: "test", FAL_KEY: "private-fixture" });
    expect(await resolveAgentBinary("claude", undefined, environment)).toBe(binary);
    expect(environment.FAL_KEY).toBeUndefined();
    expect(environment.PATH).toContain("/opt/homebrew/bin");
    expect(environment.PATH).toContain(path.join(home, ".volta", "bin"));
  });

  it("respects an executable override and does not claim a missing or nonexecutable override is installed", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "video-fs-agent-override-")); directories.push(directory);
    expect(await resolveAgentBinary("codex", directory)).toBeNull();
    const binary = path.join(directory, "custom-codex");
    expect(await resolveAgentBinary("codex", binary)).toBeNull();
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    expect(await resolveAgentBinary("codex", binary)).toBeNull();
    await chmod(binary, 0o755);
    expect(await resolveAgentBinary("codex", binary)).toBe(binary);
  });
});
