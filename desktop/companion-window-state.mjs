import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MIN_WIDTH = 320;
const MIN_HEIGHT = 340;

function finiteInteger(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

export function normalizeCompanionWindowState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const bounds = value.bounds;
  if (!bounds || typeof bounds !== "object" || Array.isArray(bounds)) return null;
  const x = finiteInteger(bounds.x);
  const y = finiteInteger(bounds.y);
  const width = finiteInteger(bounds.width);
  const height = finiteInteger(bounds.height);
  if (
    x === null ||
    y === null ||
    width === null ||
    height === null ||
    width < MIN_WIDTH ||
    height < MIN_HEIGHT
  ) {
    return null;
  }
  const displayId =
    typeof value.displayId === "string" || Number.isInteger(value.displayId)
      ? value.displayId
      : null;
  return {
    bounds: { height, width, x, y },
    displayId,
    fullScreen: value.fullScreen === true,
    maximized: value.maximized === true,
  };
}

export function defaultCompanionBounds(primaryDisplay) {
  const area = primaryDisplay.workArea;
  const width = Math.min(440, Math.max(MIN_WIDTH, area.width - 48));
  const height = Math.min(720, Math.max(MIN_HEIGHT, area.height - 80));
  return {
    height,
    width,
    x: area.x + area.width - width - 24,
    y: area.y + 40,
  };
}

export function resolveCompanionBounds(state, displays, primaryDisplay) {
  if (!state) return defaultCompanionBounds(primaryDisplay);
  const savedDisplay = displays.find(
    (display) => String(display.id) === String(state.displayId),
  );
  return savedDisplay ? state.bounds : defaultCompanionBounds(primaryDisplay);
}

export async function readCompanionWindowState(filePath) {
  try {
    return normalizeCompanionWindowState(
      JSON.parse(await readFile(filePath, "utf8")),
    );
  } catch {
    return null;
  }
}

export async function writeCompanionWindowState(filePath, state) {
  const normalized = normalizeCompanionWindowState(state);
  if (!normalized) throw new Error("Invalid companion window state.");
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
