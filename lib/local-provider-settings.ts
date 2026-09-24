import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isLocalAppMode } from "@/lib/app-mode";

export type FalKeyStatus = {
  configured: boolean;
  source: "saved" | "environment" | "none";
  environmentConfigured: boolean;
};

export const MISSING_FAL_KEY =
  "FAL_KEY is not configured. Open Account → API keys and save your fal.ai key, then try again.";

export function localProviderSettingsRoot() {
  // Keep credentials outside projects so project exports and agent context
  // cannot accidentally include them. Packaged Electron supplies userData.
  const dataRoot = process.env.VIDEO_FS_DATA_ROOT?.trim() || path.join(process.cwd(), "data", "projects");
  const root = process.env.VIDEO_FS_SETTINGS_ROOT?.trim() || path.join(path.dirname(dataRoot), "settings");
  return root;
}

function settingsFile() { return path.join(localProviderSettingsRoot(), "providers.json"); }

async function readSavedKey(): Promise<string | null> {
  try {
    const settings = JSON.parse(await readFile(settingsFile(), "utf8"));
    if (typeof settings?.falKey !== "string" || !settings.falKey.trim()) {
      throw new Error("Invalid provider settings");
    }
    return settings.falKey.trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Do not include file contents or JSON parse errors containing credentials.
    throw new Error("Could not read saved API settings. Open Account → API keys to replace or remove the saved key.");
  }
}

export async function getFalKey(): Promise<string | null> {
  const environmentKey = process.env.FAL_KEY?.trim() || null;
  if (!isLocalAppMode()) return environmentKey;
  return (await readSavedKey()) || environmentKey;
}

export async function getFalKeyStatus(): Promise<FalKeyStatus> {
  const saved = isLocalAppMode() ? await readSavedKey() : null;
  const environmentConfigured = Boolean(process.env.FAL_KEY?.trim());
  return {
    configured: Boolean(saved) || environmentConfigured,
    source: saved ? "saved" : environmentConfigured ? "environment" : "none",
    environmentConfigured,
  };
}

export function validFalKey(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,2048}$/.test(value.trim()) && !/["'`]/.test(value);
}

export async function saveFalKey(value: string): Promise<void> {
  if (!isLocalAppMode()) throw new Error("Local API settings are unavailable.");
  if (!validFalKey(value)) throw new Error("Paste the complete fal.ai key without spaces or quotes.");
  const file = settingsFile();
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify({ falKey: value.trim() }) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeFalKey(): Promise<void> {
  if (!isLocalAppMode()) throw new Error("Local API settings are unavailable.");
  await rm(settingsFile(), { force: true });
}
