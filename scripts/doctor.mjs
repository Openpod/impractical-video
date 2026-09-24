import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd(), true);
let failed = false;
function check(label, ok, help, required = true) {
  console.log(`${ok ? "OK" : required ? "ERROR" : "OPTIONAL"} ${label}${ok ? "" : `: ${help}`}`);
  if (!ok && required) failed = true;
}
function installed(command, args = ["--version"]) {
  return spawnSync(command, args, { stdio: "ignore", timeout: 10_000 }).status === 0;
}
check("Node.js 22.13+", Number(process.versions.node.split(".")[0]) > 22 || (Number(process.versions.node.split(".")[0]) === 22 && Number(process.versions.node.split(".")[1]) >= 13), "Use the Node version in .nvmrc.");
check("Git", installed("git"), "Install Git for agent project setup.");
check("Local mode", process.env.APP_MODE === "local" && process.env.NEXT_PUBLIC_APP_MODE === "local", "Set APP_MODE=local and NEXT_PUBLIC_APP_MODE=local in .env.local.");
check("MCP credential", Boolean(process.env.PAPER_MCP_TOKEN?.trim()), "Run npm run setup on a fresh checkout, or set PAPER_MCP_TOKEN to a random secret.");
check("FFmpeg", installed("ffmpeg", ["-version"]) && installed("ffprobe", ["-version"]), "Install ffmpeg for media processing (brew install ffmpeg / apt install ffmpeg).", false);
check("Agent CLI", process.env.VIDEO_FS_COMPOSER_CLI ? installed(process.env.VIDEO_FS_COMPOSER_CLI) : installed("claude") || installed("codex"), "Install and sign into Claude Code or Codex for agent prompts.", false);
const dataRoot = process.env.VIDEO_FS_DATA_ROOT?.trim() || path.join(process.cwd(), "data", "projects");
const settingsRoot = process.env.VIDEO_FS_SETTINGS_ROOT?.trim() || path.join(path.dirname(dataRoot), "settings");
let falConfigured = Boolean(process.env.FAL_KEY?.trim());
try {
  const saved = JSON.parse(await readFile(path.join(settingsRoot, "providers.json"), "utf8"));
  falConfigured ||= typeof saved?.falKey === "string" && Boolean(saved.falKey.trim());
} catch (error) {
  if (error.code !== "ENOENT") {
    falConfigured = false;
    console.log("OPTIONAL Saved API settings could not be read. Replace or remove the key in Account → API keys.");
  }
}
check("fal key configured (not verified)", falConfigured, "Open Account → API keys to save your fal.ai key, or set FAL_KEY.", false);
process.exitCode = failed ? 1 : 0;
