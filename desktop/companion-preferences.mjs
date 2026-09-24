import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MODELS = new Set(["haiku", "opus", "sonnet"]);

export function normalizeCompanionPreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([projectId, model]) =>
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(projectId) &&
        MODELS.has(model),
    ),
  );
}

export async function readCompanionPreferences(filePath) {
  try {
    return normalizeCompanionPreferences(
      JSON.parse(await readFile(filePath, "utf8")),
    );
  } catch {
    return {};
  }
}

export async function writeCompanionPreferences(filePath, preferences) {
  const normalized = normalizeCompanionPreferences(preferences);
  await mkdir(path.dirname(filePath), { mode: 0o700, recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
