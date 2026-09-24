import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import nextEnv from "@next/env";

const { parsedEnv = {} } = nextEnv.loadEnvConfig(process.cwd(), true);
const temporary = await mkdtemp(path.join(os.tmpdir(), "video-fs-smoke-"));
const cleared = Object.fromEntries(Object.keys(parsedEnv).map((key) => [key, ""]));
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:SECRET|TOKEN|KEY|PASSWORD|NEXT_PUBLIC_|VIDEO_FS_)/.test(key))),
  ...cleared,
  APP_MODE: "local", NEXT_PUBLIC_APP_MODE: "local", NEXT_PUBLIC_DESKTOP_CLOUD_ENABLED: "false",
  FAL_KEY: "", CLERK_SECRET_KEY: "", OPENROUTER_API_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "", NEXT_PUBLIC_SUPABASE_URL: "",
  VIDEO_FS_DATA_ROOT: path.join(temporary, "projects"),
  VIDEO_FS_SETTINGS_ROOT: path.join(temporary, "settings"),
  PAPER_MCP_TOKEN: "smoke-only-token-not-a-production-credential",
  NEXT_TELEMETRY_DISABLED: "1",
};
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "localhost", "--port", "3317"], { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.once("error", (error) => { console.error(error); process.exitCode = 1; });
child.once("exit", async (code) => {
  await rm(temporary, { recursive: true, force: true });
  process.exitCode = code ?? 0;
});
