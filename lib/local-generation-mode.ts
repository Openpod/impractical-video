import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isLocalAppMode } from "@/lib/app-mode";
import { localProviderSettingsRoot } from "@/lib/local-provider-settings";

export type GenerationMode = "fal" | "credits";

export async function getGenerationMode(): Promise<GenerationMode> {
  if (!isLocalAppMode()) return "credits";
  try {
    const value = JSON.parse(await readFile(path.join(localProviderSettingsRoot(), "generation-mode.json"), "utf8"));
    if (value.mode === "fal" || value.mode === "credits") return value.mode;
    throw new Error("Invalid generation mode");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("Could not read your generation preference. Choose it again in setup.");
    }
  }
  return process.env.NEXT_PUBLIC_DESKTOP_CLOUD_ENABLED?.trim().toLowerCase() === "true" ? "credits" : "fal";
}

export async function saveGenerationMode(mode: GenerationMode) {
  if (!isLocalAppMode()) throw new Error("Local generation settings are unavailable.");
  const root = localProviderSettingsRoot();
  const temporary = path.join(root, `generation-mode.${randomUUID()}.tmp`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify({ mode }), { mode: 0o600, flag: "wx" });
    await rename(temporary, path.join(root, "generation-mode.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}
