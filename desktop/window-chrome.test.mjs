import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  MACOS_TITLE_BAR_HEIGHT,
  MACOS_TRAFFIC_LIGHT_POSITION,
  desktopWindowOptions,
} from "./window-options.mjs";

const desktopDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(desktopDirectory);

test("macOS keeps native framing while integrating app chrome", () => {
  const options = desktopWindowOptions({
    platform: "darwin",
    preloadDirectory: desktopDirectory,
  });

  assert.equal(options.titleBarStyle, "hiddenInset");
  assert.equal(MACOS_TITLE_BAR_HEIGHT, 44);
  assert.deepEqual(
    options.trafficLightPosition,
    MACOS_TRAFFIC_LIGHT_POSITION,
  );
  assert.equal(options.trafficLightPosition.y, 15);
  assert.equal(options.frame, undefined);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(
    options.webPreferences.preload,
    path.join(desktopDirectory, "preload.mjs"),
  );
  assert.deepEqual(options.webPreferences.additionalArguments, []);
});

test("non-macOS windows retain their native frame", () => {
  const options = desktopWindowOptions({
    platform: "win32",
    preloadDirectory: desktopDirectory,
  });

  assert.equal(options.titleBarStyle, undefined);
  assert.equal(options.trafficLightPosition, undefined);
  assert.equal(options.frame, undefined);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.contextIsolation, true);
});

test("tab activity preview is an explicit renderer-only additional argument", () => {
  const options = desktopWindowOptions({
    platform: "darwin",
    preloadDirectory: desktopDirectory,
    uiPreview: "tab-activity",
  });
  assert.deepEqual(options.webPreferences.additionalArguments, [
    "--video-fs-ui-preview=tab-activity",
  ]);
});

test("application chrome declares an opaque drag band and interactive no-drag regions", async () => {
  const [appShell, globals, preload, workbench, packageManifest] =
    await Promise.all([
      readFile(path.join(repositoryRoot, "app/app-shell.tsx"), "utf8"),
      readFile(path.join(repositoryRoot, "app/globals.css"), "utf8"),
      readFile(path.join(desktopDirectory, "preload.mjs"), "utf8"),
      readFile(
        path.join(
          repositoryRoot,
          "app/projects/[id]/project-workbench.tsx",
        ),
        "utf8",
      ),
      readFile(path.join(desktopDirectory, "package.json"), "utf8"),
    ]);

  assert.match(appShell, /<DesktopWindowChrome/);
  assert.match(workbench, /<DesktopWindowChrome/);
  assert.match(globals, /-webkit-app-region:\s*drag/);
  assert.match(globals, /-webkit-app-region:\s*no-drag/);
  assert.match(
    globals,
    /\.app-desktop-window-chrome\s*\{[\s\S]*?display:\s*none/,
  );
  assert.match(
    globals,
    /data-video-fs-desktop="macos"[^{}]*\.app-desktop-window-chrome\s*\{[\s\S]*?background:\s*var\(--desktop-chrome-bg\)/,
  );
  const desktopChromeRule = globals.match(
    /html\[data-video-fs-desktop="macos"\] \.app-desktop-window-chrome\s*\{([\s\S]*?)\}/,
  )?.[1];
  assert.ok(desktopChromeRule);
  assert.doesNotMatch(desktopChromeRule, /\bborder(?:-bottom)?:/);
  assert.doesNotMatch(desktopChromeRule, /\bbox-shadow:/);
  // The chrome band follows the theme: dark surface in dark mode, white in
  // light mode.
  assert.match(globals, /--desktop-chrome-bg:\s*var\(--surface\)/);
  assert.match(globals, /--desktop-chrome-bg:\s*#ffffff/);
  assert.match(globals, /--home-dot-ink:\s*rgb\(219 219 230\)/);
  assert.match(globals, /--home-dot-ink:\s*rgb\(24 24 27\)/);
  assert.match(globals, /--project-tab-activity-dot:\s*#f54048/);
  assert.match(
    globals,
    /\.agent-activity-status-button\.is-project-tab \.agent-activity-dot\s*\{[\s\S]*?background:\s*var\(--muted\)/,
  );
  const wave = globals.match(
    /@keyframes agent-activity-dot-wave\s*\{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(wave);
  assert.match(wave, /background:\s*var\(--muted\)/);
  assert.match(wave, /background:\s*var\(--project-tab-activity-dot\)/);
  assert.doesNotMatch(wave, /currentColor|#ed1d24|var\(--accent\)/);
  assert.match(
    globals,
    /prefers-reduced-motion:\s*reduce[\s\S]*?agent-activity-status-button \.agent-activity-dot[\s\S]*?animation:\s*none !important[\s\S]*?transform:\s*none !important/,
  );
  assert.match(globals, /data-video-fs-desktop="macos"/);
  assert.match(preload, /dataset\.videoFsDesktop\s*=\s*desktopPlatform/);
  assert.match(
    preload,
    /contextBridge\?\.exposeInMainWorld\?\.\(\s*"videoFsDesktopEnvironment"/,
  );
  assert.match(preload, /ensureDesktopDocument\(\)/);
  assert.match(preload, /readystatechange/);
  assert.match(preload, /DOMContentLoaded/);
  assert.match(preload, /pageshow/);
  assert.match(preload, /new MutationObserver\(ensureDesktopDocument\)/);

  const packagedFiles = JSON.parse(packageManifest).build.files;
  assert.ok(packagedFiles.includes("preload.mjs"));
  assert.ok(packagedFiles.includes("companion-compose-store.mjs"));
  assert.ok(packagedFiles.includes("window-options.mjs"));
});

test("preload reapplies desktop identity when Chromium replaces the renderer document", async () => {
  const preload = await readFile(
    path.join(desktopDirectory, "preload.mjs"),
    "utf8",
  );
  const documentListeners = new Map();
  const windowListeners = new Map();
  const exposed = new Map();
  let observerCallback = null;

  const document = {
    documentElement: { dataset: {} },
    addEventListener(type, callback) {
      documentListeners.set(type, callback);
    },
  };
  const window = {
    addEventListener(type, callback) {
      windowListeners.set(type, callback);
    },
  };
  const MutationObserver = class {
    constructor(callback) {
      observerCallback = callback;
    }

    observe() {}
  };

  vm.runInNewContext(preload, {
    MutationObserver,
    Object,
    document,
    process: { argv: ["electron"], platform: "darwin" },
    queueMicrotask,
    require(moduleName) {
      assert.equal(moduleName, "electron");
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            exposed.set(name, value);
          },
        },
      };
    },
    window,
  });

  assert.equal(
    exposed.get("videoFsDesktopEnvironment")?.platform,
    "macos",
  );
  assert.equal(exposed.get("videoFsDesktopEnvironment")?.uiPreview, null);
  assert.equal(document.documentElement.dataset.videoFsDesktop, "macos");

  document.documentElement = { dataset: {} };
  documentListeners.get("DOMContentLoaded")();
  assert.equal(document.documentElement.dataset.videoFsDesktop, "macos");

  document.documentElement = { dataset: {} };
  windowListeners.get("pageshow")();
  assert.equal(document.documentElement.dataset.videoFsDesktop, "macos");

  document.documentElement = { dataset: {} };
  observerCallback();
  assert.equal(document.documentElement.dataset.videoFsDesktop, "macos");
});

test("desktop main performs one bounded renderer recovery and keeps clean exits untouched", async () => {
  const main = await readFile(path.join(desktopDirectory, "main.mjs"), "utf8");
  assert.match(
    main,
    /await mainWindow\.loadURL[\s\S]*?mainWindow\.show\(\)[\s\S]*?mainWindow\.focus\(\)/,
  );
  assert.match(main, /webContents\.on\("dom-ready", markDesktopDocument\)/);
  assert.match(
    main,
    /document\.documentElement\.dataset\.videoFsDesktop/,
  );
  assert.match(main, /webContents\.on\("preload-error"/);
  assert.match(main, /let rendererRecoveryAttempts = 0/);
  assert.match(main, /details\.reason === "clean-exit"/);
  assert.match(main, /rendererRecoveryAttempts >= 1/);
  assert.match(main, /window\.webContents\.reload\(\)/);
  assert.match(
    main,
    /webContents\.on\("did-finish-load"[\s\S]*?rendererRecoveryAttempts = 0/,
  );
  assert.match(
    main,
    /webContents\.on\("did-finish-load"[\s\S]*?markDesktopDocument\(\)/,
  );
});

test("Home and project workspaces begin at or below the title-row bottom", async () => {
  const [appShell, globals, workbench] = await Promise.all([
    readFile(path.join(repositoryRoot, "app/app-shell.tsx"), "utf8"),
    readFile(path.join(repositoryRoot, "app/globals.css"), "utf8"),
    readFile(
      path.join(repositoryRoot, "app/projects/[id]/project-workbench.tsx"),
      "utf8",
    ),
  ]);

  const appChromeIndex = appShell.indexOf("<DesktopWindowChrome");
  const appSidebarIndex = appShell.indexOf('className="app-sidebar"');
  const projectChromeIndex = workbench.indexOf("<DesktopWindowChrome");
  const projectWorkspaceIndex = workbench.indexOf(
    'className="workbench-body',
  );

  assert.ok(appChromeIndex >= 0 && appChromeIndex < appSidebarIndex);
  assert.ok(
    projectChromeIndex >= 0 && projectChromeIndex < projectWorkspaceIndex,
  );
  assert.doesNotMatch(workbench, /className="workbench-nav"/);
  assert.match(
    globals,
    /grid-template-rows:\s*var\(--desktop-chrome-height\)\s+minmax\(0,\s*1fr\)/,
  );
  assert.match(
    globals,
    /\.app-shell\s*>\s*\.app-sidebar\s*\{[\s\S]*?grid-row:\s*2/,
  );
  assert.match(
    globals,
    /\.app-shell\s*>\s*\.app-main-col\s*\{[\s\S]*?grid-row:\s*2/,
  );

  const titleRowBottom = MACOS_TITLE_BAR_HEIGHT;
  const homeWorkspaceTop = MACOS_TITLE_BAR_HEIGHT;
  const projectWorkspaceTop = MACOS_TITLE_BAR_HEIGHT;
  assert.ok(homeWorkspaceTop >= titleRowBottom);
  assert.equal(projectWorkspaceTop, titleRowBottom);
});
