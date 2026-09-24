import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultCompanionBounds,
  normalizeCompanionWindowState,
  readCompanionWindowState,
  resolveCompanionBounds,
  writeCompanionWindowState,
} from "./companion-window-state.mjs";
import {
  normalizeCompanionPreferences,
  readCompanionPreferences,
  writeCompanionPreferences,
} from "./companion-preferences.mjs";

const primary = {
  id: 1,
  workArea: { height: 900, width: 1440, x: 0, y: 0 },
};
const second = {
  id: 2,
  workArea: { height: 1080, width: 1920, x: 1440, y: 0 },
};

test("rejects malformed or undersized state", () => {
  assert.equal(normalizeCompanionWindowState(null), null);
  assert.equal(
    normalizeCompanionWindowState({
      bounds: { height: 100, width: 100, x: 0, y: 0 },
    }),
    null,
  );
});

test("restores exact cross-display bounds without main-window clamping", () => {
  const state = normalizeCompanionWindowState({
    bounds: { height: 700, width: 430, x: 1600, y: 120 },
    displayId: 2,
    fullScreen: false,
    maximized: false,
  });
  assert.deepEqual(
    resolveCompanionBounds(state, [primary, second], primary),
    state.bounds,
  );
});

test("falls back safely when the saved display is absent", () => {
  const state = normalizeCompanionWindowState({
    bounds: { height: 700, width: 430, x: 1600, y: 120 },
    displayId: 99,
  });
  assert.deepEqual(
    resolveCompanionBounds(state, [primary], primary),
    defaultCompanionBounds(primary),
  );
});

test("persists mode-0600 window/display state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "video-fs-companion-state-"));
  const file = path.join(directory, "companion-window.json");
  const state = {
    bounds: { height: 700, width: 430, x: 1600, y: 120 },
    displayId: 2,
    fullScreen: true,
    maximized: false,
  };
  await writeCompanionWindowState(file, state);
  assert.deepEqual(await readCompanionWindowState(file), state);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(JSON.parse(await readFile(file, "utf8")));
});

test("persists only supported per-project models with mode-0600", async () => {
  assert.deepEqual(
    normalizeCompanionPreferences({
      "../escape": "opus",
      "project-a": "sonnet",
      "project-b": "made-up",
    }),
    { "project-a": "sonnet" },
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), "video-fs-companion-prefs-"));
  const file = path.join(directory, "companion-preferences.json");
  await writeCompanionPreferences(file, {
    "project-a": "opus",
    "project-b": "haiku",
  });
  assert.deepEqual(await readCompanionPreferences(file), {
    "project-a": "opus",
    "project-b": "haiku",
  });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
