import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  WebContentsView,
  dialog,
  globalShortcut,
  ipcMain,
  safeStorage,
  screen,
  session as electronSession,
  shell,
} from "electron";
import {
  projectIdFromAppUrl,
  setupAgentProject,
} from "./agent-setup.mjs";
import {
  parseHookInput,
  runAgentContextHook,
} from "./agent-context-hook.mjs";
import {
  deriveProjectBearerToken,
  resolveBoundProjectRoot,
  validateProjectId,
} from "./project-binding.mjs";
import {
  assertDesktopEndpointAvailable,
  readPrivateConnectionState,
  writePrivateConnectionState,
} from "./connection-state.mjs";
import { desktopWindowOptions } from "./window-options.mjs";
import {
  readCompanionWindowState,
  resolveCompanionBounds,
  writeCompanionWindowState,
} from "./companion-window-state.mjs";
import {
  garbageCollectCompanionAttachments,
  readCompanionAttachment,
  readCompanionCompose,
  removeCompanionAttachment,
  storeCompanionAttachment,
  writeCompanionCompose,
} from "./companion-compose-store.mjs";
import {
  clearDesktopAuthSession,
  readDesktopAuthSession,
  writeDesktopAuthSession,
} from "./auth-session-store.mjs";
import { desktopCloudConfiguration } from "./cloud-config.mjs";

const DESKTOP_NAME = "Video FS";
const DEFAULT_PORT = 3210;
const LAST_DESKTOP_PORT = 3220;
const STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_CLOUD_ORIGIN = "https://chat.impractical.ai";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Match the public mode compiled into the packaged renderer. In development
// load the same environment as Next so provider keys and mode flags agree.
if (!app.isPackaged) {
  const { default: nextEnv } = await import("@next/env");
  nextEnv.loadEnvConfig(repoRoot, true);
}
const desktopCloud = app.isPackaged
  ? JSON.parse(readFileSync(path.join(__dirname, "generated", "cloud-config.json"), "utf8"))
  : desktopCloudConfiguration();

app.setName(DESKTOP_NAME);

function argumentValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function stateFilePath() {
  return (
    process.env.VIDEO_FS_DESKTOP_STATE_FILE?.trim() ||
    path.join(app.getPath("userData"), "desktop-connection.json")
  );
}

function authSessionFilePath() {
  return path.join(app.getPath("userData"), "desktop-auth-session.bin");
}

function cloudOrigin() {
  const candidate =
    desktopCloud.origin || DEFAULT_CLOUD_ORIGIN;
  const url = new URL(candidate);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("NEXT_PUBLIC_DESKTOP_CLOUD_URL must be an HTTPS origin.");
  }
  return url.origin;
}

async function requestLocalSessionBridge(appUrl, token, body) {
  return fetch(new URL("/api/desktop/cloud-session", appUrl), {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "PATCH",
    signal: AbortSignal.timeout(15_000),
  });
}

async function persistDesktopSession(appUrl, token) {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn("[desktop] OS credential encryption unavailable; session will last until quit");
    return false;
  }
  const response = await requestLocalSessionBridge(appUrl, token, {
    action: "export",
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.refreshToken !== "string") return false;
  await writeDesktopAuthSession(
    authSessionFilePath(),
    body.refreshToken,
    safeStorage,
  );
  return true;
}

async function restoreDesktopSession(appUrl, token) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  let refreshToken;
  try {
    refreshToken = await readDesktopAuthSession(authSessionFilePath(), safeStorage);
  } catch (error) {
    console.warn(
      `[desktop] saved session could not be read: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return false;
  }
  if (!refreshToken) return false;
  const response = await requestLocalSessionBridge(appUrl, token, {
    action: "restore",
    refreshToken,
  }).catch(() => null);
  if (!response) return false;
  if (!response.ok) {
    if (response.status !== 401 && response.status !== 403) return false;
    await clearDesktopAuthSession(authSessionFilePath()).catch(() => {});
    return false;
  }
  // Refresh credentials rotate. Replace the encrypted copy immediately.
  await persistDesktopSession(appUrl, token).catch((error) => {
    console.warn(
      `[desktop] refreshed session could not be persisted: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  });
  return true;
}

async function runMcpBridge() {
  const statePath = stateFilePath();
  // Agent sessions often (re)connect while the desktop app itself is still
  // booting — a hard endpoint check here killed the MCP subprocess and left
  // the whole session tool-less. Wait the app out instead: re-read the state
  // file each attempt (a restart rewrites it with a fresh token/URL).
  const deadline = Date.now() + 60_000;
  let state = await readPrivateConnectionState(statePath);
  for (;;) {
    try {
      await assertDesktopEndpointAvailable(state.appUrl);
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      state = await readPrivateConnectionState(statePath).catch(() => state);
    }
  }
  const projectId = validateProjectId(
    argumentValue("--project-id"),
    "project id",
  );
  await resolveBoundProjectRoot(state.dataRoot, projectId);

  process.env.VIDEO_FS_APP_URL = state.appUrl;
  process.env.PAPER_MCP_TOKEN = deriveProjectBearerToken(
    state.token,
    state.dataRoot,
    projectId,
  );
  process.env.VIDEO_FS_PROJECT_ID = projectId;

  const bridgePath = app.isPackaged
    ? path.join(__dirname, "generated", "paper-mcp.mjs")
    : path.join(repoRoot, "scripts", "paper-mcp.mjs");
  await import(pathToFileURL(bridgePath).href);
}

async function runAgentSetup() {
  const projectId = argumentValue("--project-id") || argumentValue("--setup-agent");
  const state = await readPrivateConnectionState(stateFilePath());
  await assertDesktopEndpointAvailable(state.appUrl);
  const result = await setupAgentProject({ projectId, state });
  process.stdout.write(
    result.conflicts.length
      ? `Video FS preserved existing ${result.conflicts.join(
          ", ",
        )}. Review .video-fs/CONNECT_AGENTS.md.\n`
      : `Video FS agent setup is ready for ${result.projectId}.\n`,
  );
}

async function runContextHook() {
  const input = parseHookInput(await readStdin());
  const result = await runAgentContextHook({
    agent: argumentValue("--agent"),
    input,
    projectId: argumentValue("--project-id"),
    statePath: stateFilePath(),
  });
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
}

if (process.argv.includes("--mcp")) {
  void runMcpBridge().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "MCP bridge failed."}\n`);
    app.exit(1);
  });
} else if (process.argv.includes("--agent-context-hook")) {
  void runContextHook()
    .then(() => app.exit(0))
    .catch(() => {
      process.stdout.write(
        `${JSON.stringify({
          continue: true,
          suppressOutput: false,
          systemMessage:
            "Video FS context was not injected: the local hook could not start.",
        })}\n`,
      );
      app.exit(0);
    });
} else if (process.argv.includes("--setup-agent") || argumentValue("--setup-agent")) {
  void runAgentSetup()
    .then(() => app.exit(0))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Agent setup failed."}\n`);
      app.exit(1);
    });
} else {
  void runDesktop().catch((error) => {
    console.error("[desktop] fatal startup error", error);
    app.exit(1);
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      value += chunk;
      if (Buffer.byteLength(value) > 256 * 1024) {
        reject(new Error("Hook input is too large."));
      }
    });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
}

async function runDesktop() {
  console.log(`[desktop] starting ${DESKTOP_NAME} (${app.isPackaged ? "packaged" : "development"})`);
  const hasLock = app.requestSingleInstanceLock();
  console.log(`[desktop] single-instance lock: ${hasLock ? "acquired" : "already held"}`);
  if (!hasLock) {
    app.quit();
    return;
  }

  const quitForSignal = () => app.quit();
  process.once("SIGINT", quitForSignal);
  process.once("SIGTERM", quitForSignal);

  let mainWindow = null;
  let nextServer = null;
  let shuttingDown = false;
  let connectionStatePath = null;
  const clearConnectionStateSync = () => {
    if (!connectionStatePath) return;
    try {
      rmSync(connectionStatePath, { force: true });
    } catch {
      // The asynchronous shutdown path reports server errors; process exit
      // cleanup is intentionally best-effort and must never expose state.
    }
  };
  process.once("exit", clearConnectionStateSync);

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    event.preventDefault();
    void stopServer(nextServer, connectionStatePath).finally(() => {
      process.removeListener("SIGINT", quitForSignal);
      process.removeListener("SIGTERM", quitForSignal);
      app.quit();
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  await app.whenReady();
  console.log("[desktop] Electron ready");

  try {
    const port = await choosePort(
      Number(argumentValue("--port") || process.env.VIDEO_FS_DESKTOP_PORT || DEFAULT_PORT),
    );
    const token = randomBytes(32).toString("base64url");
    // Next's development middleware proxy uses the configured hostname. On
    // macOS, binding dev to 127.0.0.1 while Next targets localhost (often ::1)
    // deadlocks every middleware request. Both values remain loopback-only.
    const host = app.isPackaged ? "127.0.0.1" : "localhost";
    const appUrl = `http://${host}:${port}`;
    const dataRoot =
      process.env.VIDEO_FS_DATA_ROOT?.trim() ||
      (app.isPackaged
        ? path.join(app.getPath("userData"), "projects")
        : path.join(repoRoot, "data", "projects"));

    await mkdir(dataRoot, { recursive: true });
    console.log(`[desktop] runtime: ${appUrl}; projects: ${dataRoot}`);
    connectionStatePath = stateFilePath();
    await mkdir(path.dirname(connectionStatePath), { recursive: true });
    const mcp = app.isPackaged
      ? { args: ["--mcp"], command: process.execPath }
      : {
          args: [path.join(repoRoot, "desktop", "main.mjs"), "--mcp"],
          command: process.execPath,
        };
    const connectionState = {
      appUrl,
      dataRoot,
      mcp,
      pid: process.pid,
      port,
      startedAt: new Date().toISOString(),
      token,
    };
    await writePrivateConnectionState(connectionStatePath, connectionState);

    nextServer = startNextServer({ dataRoot, host, port, token });
    await waitForServer(appUrl, nextServer);
    console.log("[desktop] embedded Next server ready");
    const restoredSession = await restoreDesktopSession(appUrl, token).catch(
      (error) => {
        console.warn(
          `[desktop] session restore failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
        return false;
      },
    );
    if (restoredSession) console.log("[desktop] restored encrypted account session");

    const scheduledProjects = new Set();
    const setUpProjectFromUrl = (candidate) => {
      const projectId = projectIdFromAppUrl(candidate, appUrl);
      if (!projectId || scheduledProjects.has(projectId)) return;
      scheduledProjects.add(projectId);
      void setupAgentProject({ projectId, state: connectionState })
        .then((result) => {
          if (result.conflicts.length) {
            console.warn(
              `[desktop] agent setup preserved existing configuration for ${projectId}: ${result.conflicts.join(
                ", ",
              )}; review .video-fs/CONNECT_AGENTS.md`,
            );
          } else {
            console.log(`[desktop] Claude/Codex setup ready for ${projectId}`);
          }
        })
        .catch((error) => {
          scheduledProjects.delete(projectId);
          console.error(
            `[desktop] agent setup failed for ${projectId}: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
        });
    };
    mainWindow = createMainWindow(appUrl, cloudOrigin());
    ipcMain.handle("video-fs:auth-session-connected", async (event) => {
      if (event.sender.id !== mainWindow?.webContents.id) return false;
      const persisted = await persistDesktopSession(appUrl, token).catch((error) => {
        console.warn(
          `[desktop] session persistence failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
        return false;
      });
      if (mainWindow && !mainWindow.isDestroyed()) {
        closeDesktopAuthView();
        if (process.platform === "darwin") app.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
      return persisted;
    });
    ipcMain.handle("video-fs:auth-session-cleared", async (event) => {
      if (event.sender.id !== mainWindow?.webContents.id) return false;
      await clearDesktopAuthSession(authSessionFilePath());
      await electronSession.defaultSession.clearStorageData({
        storages: ["cookies"],
      });
      await electronSession.defaultSession.clearStorageData({
        origin: cloudOrigin(),
        storages: ["indexdb", "localstorage"],
      });
      return true;
    });
    const updateCompanionProject = setUpCompanion(appUrl, mainWindow);
    const onProjectNavigation = (candidate) => {
      setUpProjectFromUrl(candidate);
      updateCompanionProject(candidate);
    };
    configureWindow(mainWindow, appUrl, onProjectNavigation);
    const startPath =
      argumentValue("--start-path") ||
      process.env.VIDEO_FS_DESKTOP_START_PATH?.trim() ||
      "/";
    await mainWindow.loadURL(new URL(startPath, appUrl).href);
    mainWindow.show();
    mainWindow.focus();
    onProjectNavigation(mainWindow.webContents.getURL());
    console.log(`[desktop] window loaded ${new URL(startPath, appUrl).pathname}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Desktop startup failed.";
    await dialog.showMessageBox({
      detail: message,
      message: "Video FS could not start its local server.",
      type: "error",
    });
    await stopServer(nextServer, connectionStatePath);
    app.exit(1);
  }
}


/* ---- Companion chat window -------------------------------------------- */
// A regular top-level window. It owns no main-window lifecycle or geometry and
// can live, maximize, or fullscreen on a different display.

let companionWindow = null;
let companionProjectId = null;
let companionProjectName = null;
let appQuitting = false;
let companionComposeWrite = Promise.resolve();

function companionNativeTitle() {
  return companionProjectName
    ? `Chat — ${companionProjectName}`
    : "Chat — Impractical";
}

function companionUrl(appUrl) {
  const url = new URL("/companion", appUrl);
  if (companionProjectId) url.searchParams.set("project", companionProjectId);
  return url.href;
}

function companionWindowStatePath() {
  return path.join(app.getPath("userData"), "companion-window.json");
}

function companionComposeRoot() {
  return path.join(app.getPath("userData"), "companion-compose");
}

let companionWindowStatePromise = null;

async function ensureCompanionWindow(appUrl) {
  if (companionWindow && !companionWindow.isDestroyed()) return companionWindow;
  companionWindowStatePromise ??= readCompanionWindowState(
    companionWindowStatePath(),
  );
  const stored = await companionWindowStatePromise;
  const bounds = resolveCompanionBounds(
    stored,
    screen.getAllDisplays(),
    screen.getPrimaryDisplay(),
  );
  companionWindow = new BrowserWindow({
    backgroundColor: "#161618",
    ...bounds,
    fullscreenable: true,
    maximizable: true,
    minHeight: 340,
    minWidth: 320,
    minimizable: true,
    resizable: true,
    show: false,
    skipTaskbar: false,
    title: companionNativeTitle(),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 14, y: 15 },
        }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.mjs"),
      sandbox: true,
      webSecurity: true,
    },
  });
  let persistTimer = null;
  const persist = () => {
    if (!companionWindow || companionWindow.isDestroyed()) return;
    const bounds = companionWindow.getBounds();
    const display = screen.getDisplayMatching(bounds);
    void writeCompanionWindowState(companionWindowStatePath(), {
      bounds,
      displayId: display.id,
      fullScreen: companionWindow.isFullScreen(),
      maximized: companionWindow.isMaximized(),
    }).catch((error) => {
      console.error(
        `[desktop] could not persist companion bounds: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    });
  };
  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 120);
  };
  for (const eventName of [
    "move",
    "resize",
    "maximize",
    "unmaximize",
    "enter-full-screen",
    "leave-full-screen",
  ]) {
    companionWindow.on(eventName, schedulePersist);
  }
  companionWindow.on("close", (event) => {
    if (appQuitting) return;
    event.preventDefault();
    persist();
    companionWindow?.hide();
  });
  companionWindow.on("closed", () => {
    if (persistTimer) clearTimeout(persistTimer);
    companionWindow = null;
  });
  companionWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url, appUrl)) void shell.openExternal(url);
    return { action: "deny" };
  });
  companionWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  companionWindow.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    companionWindow?.setTitle(companionNativeTitle());
  });
  configureWindow(companionWindow, appUrl, () => {});
  companionWindow.once("ready-to-show", () => {
    if (stored?.maximized) companionWindow?.maximize();
    if (stored?.fullScreen) companionWindow?.setFullScreen(true);
  });
  void companionWindow.loadURL(companionUrl(appUrl));
  return companionWindow;
}

function setUpCompanion(appUrl, mainWindow) {
  void garbageCollectCompanionAttachments(companionComposeRoot()).catch(
    (error) => {
      console.error(
        `[desktop] could not clean companion attachments: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    },
  );
  /** Shows + raises the companion so it is actually seen. On macOS, when the
   * main window is fullscreen, a plain show() opens the companion on a
   * DIFFERENT Space — the click appears to do nothing. Joining fullscreen
   * Spaces requires temporarily flipping fullscreenable off. */
  const surface = (window) => {
    const mainFullscreen =
      process.platform === "darwin" &&
      mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.isFullScreen();
    if (mainFullscreen) {
      window.setFullScreenable(false);
      window.setVisibleOnAllWorkspaces(true, {
        skipTransformProcessType: true,
        visibleOnFullScreenSpaces: true,
      });
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.moveTop();
    window.focus();
    if (mainFullscreen) {
      // Once surfaced on the fullscreen Space it stays; stop following every
      // Space and restore the window's own fullscreen capability.
      setTimeout(() => {
        if (window.isDestroyed()) return;
        window.setVisibleOnAllWorkspaces(false);
        window.setFullScreenable(true);
      }, 450);
    }
  };
  const toggle = async () => {
    const window = await ensureCompanionWindow(appUrl);
    // Three states, one button: hidden/minimized/buried -> surface; visible
    // and focused -> hide.
    if (window.isVisible() && !window.isMinimized() && window.isFocused()) {
      window.hide();
      return;
    }
    surface(window);
  };
  ipcMain.handle("video-fs:companion-toggle", () => toggle());
  ipcMain.handle("video-fs:companion-show", async () => {
    surface(await ensureCompanionWindow(appUrl));
  });
  ipcMain.handle("video-fs:companion-hide", () => {
    if (companionWindow && !companionWindow.isDestroyed()) {
      companionWindow.hide();
    }
  });
  ipcMain.handle("video-fs:companion-compose-get", (_event, projectId) =>
    readCompanionCompose(
      companionComposeRoot(),
      validateProjectId(projectId, "project id"),
    ),
  );
  ipcMain.handle(
    "video-fs:companion-compose-set",
    async (_event, projectId, state) => {
      const cleanProjectId = validateProjectId(projectId, "project id");
      companionComposeWrite = companionComposeWrite
        .catch(() => {})
        .then(() =>
          writeCompanionCompose(companionComposeRoot(), cleanProjectId, state),
        );
      return companionComposeWrite;
    },
  );
  ipcMain.handle(
    "video-fs:companion-attachment-store",
    async (_event, projectId, attachment) =>
      storeCompanionAttachment(
        companionComposeRoot(),
        validateProjectId(projectId, "project id"),
        attachment,
      ),
  );
  ipcMain.handle(
    "video-fs:companion-attachment-read",
    async (_event, projectId, hash) =>
      readCompanionAttachment(
        companionComposeRoot(),
        validateProjectId(projectId, "project id"),
        hash,
      ),
  );
  ipcMain.handle(
    "video-fs:companion-attachment-remove",
    async (_event, projectId, hash) =>
      removeCompanionAttachment(
        companionComposeRoot(),
        validateProjectId(projectId, "project id"),
        hash,
      ),
  );
  // The chat's project switcher drives the main app too: opening a project
  // there opens/activates its tab in the main window.
  ipcMain.handle(
    "video-fs:companion-open-project",
    (event, projectId) => {
      if (event.sender.id !== companionWindow?.webContents.id) {
        throw new Error("Project opening is companion-bound.");
      }
      const cleanProjectId = validateProjectId(projectId, "project id");
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      mainWindow.webContents.send("video-fs:open-project", cleanProjectId);
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      return true;
    },
  );
  ipcMain.handle("video-fs:companion-title-set", (event, projectId, name) => {
    if (event.sender.id !== companionWindow?.webContents.id) {
      throw new Error("Companion title updates are window-bound.");
    }
    if (projectId) validateProjectId(projectId, "project id");
    companionProjectName =
      typeof name === "string" && name.trim()
        ? name.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120)
        : null;
    const title = companionNativeTitle();
    companionWindow?.setTitle(title);
    return title;
  });
  if (!globalShortcut.isRegistered("Alt+Space")) {
    globalShortcut.register("Alt+Space", () => void toggle());
  }
  app.on("before-quit", () => {
    appQuitting = true;
  });
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
  });
  return (candidate) => {
    const projectId = projectIdFromAppUrl(candidate, appUrl);
    if (projectId === companionProjectId) return;
    companionProjectId = projectId;
    companionProjectName = null;
    companionWindow?.setTitle(companionNativeTitle());
    if (companionWindow && !companionWindow.isDestroyed()) {
      // Switching projects in the main app brings the chat along: re-point
      // it and float it in front without stealing keyboard focus.
      if (projectId) {
        companionWindow.showInactive();
        companionWindow.moveTop();
      }
      // Nudge, don't reload: the page follows the main window's project
      // unless the user has picked a different one in its switcher.
      companionWindow.webContents.send(
        "video-fs:companion-project",
        projectId,
      );
    }
  };
}

let desktopAuthView = null;
let desktopAuthViewOwner = null;
let desktopAuthViewResizeHandler = null;

function closeDesktopAuthView() {
  const view = desktopAuthView;
  const owner = desktopAuthViewOwner;
  const resizeHandler = desktopAuthViewResizeHandler;
  desktopAuthView = null;
  desktopAuthViewOwner = null;
  desktopAuthViewResizeHandler = null;
  if (owner && resizeHandler && !owner.isDestroyed()) {
    owner.removeListener("resize", resizeHandler);
  }
  if (owner && view && !owner.isDestroyed()) {
    try {
      owner.contentView.removeChildView(view);
    } catch {
      // The view may already be detached during window teardown.
    }
  }
  if (view && !view.webContents.isDestroyed()) view.webContents.close();
}

function expectedDesktopCallback(appUrl) {
  const runtime = new URL(appUrl);
  return `http://127.0.0.1:${runtime.port}/api/desktop/auth/callback`;
}

function desktopAuthUrl(candidate, appUrl, hostedOrigin) {
  try {
    const url = new URL(candidate);
    if (url.origin !== hostedOrigin || url.pathname !== "/desktop-auth") return null;
    if (url.searchParams.get("callback") !== expectedDesktopCallback(appUrl)) return null;
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(url.searchParams.get("challenge") || "")) return null;
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(url.searchParams.get("state") || "")) return null;
    return url;
  } catch {
    return null;
  }
}

function isDesktopCallback(candidate, appUrl) {
  try {
    const url = new URL(candidate);
    const expected = new URL(expectedDesktopCallback(appUrl));
    return url.origin === expected.origin && url.pathname === expected.pathname;
  } catch {
    return false;
  }
}

const AUTH_FLOW_HOSTS = new Set([
  "accounts.google.com",
  "github.com",
]);

function isAuthFlowUrl(candidate) {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return false;
    return (
      AUTH_FLOW_HOSTS.has(url.hostname) ||
      url.hostname.endsWith(".accounts.dev") ||
      url.hostname.endsWith(".clerk.accounts.dev") ||
      url.hostname.endsWith(".clerk.com")
    );
  } catch {
    return false;
  }
}

function openExternalFocused(url, fallbackWindow = null) {
  if (process.platform === "darwin") app.hide();
  void shell.openExternal(url, { activate: true }).catch((error) => {
    console.error(
      `[desktop] could not open the system browser: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    if (process.platform === "darwin") app.show();
    if (fallbackWindow && !fallbackWindow.isDestroyed()) {
      fallbackWindow.show();
      fallbackWindow.focus();
    }
  });
}

function openDesktopAuthView(candidate, ownerWindow, appUrl, hostedOrigin) {
  const url = desktopAuthUrl(candidate, appUrl, hostedOrigin);
  if (!url || url.searchParams.get("surface") !== "desktop") return false;
  if (desktopAuthView && !desktopAuthView.webContents.isDestroyed()) {
    desktopAuthView.webContents.focus();
    return true;
  }
  const authView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  desktopAuthView = authView;
  desktopAuthViewOwner = ownerWindow;
  authView.setBackgroundColor("#ed1c24");
  ownerWindow.contentView.addChildView(authView);
  const syncBounds = () => {
    if (ownerWindow.isDestroyed() || authView.webContents.isDestroyed()) return;
    const [width, height] = ownerWindow.getContentSize();
    authView.setBounds({ height, width, x: 0, y: 0 });
  };
  desktopAuthViewResizeHandler = syncBounds;
  ownerWindow.on("resize", syncBounds);
  ownerWindow.once("closed", closeDesktopAuthView);
  syncBounds();
  authView.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  authView.webContents.on("will-attach-webview", (event) => event.preventDefault());
  authView.webContents.setWindowOpenHandler(({ url: next }) => {
    const handoff = desktopAuthUrl(next, appUrl, hostedOrigin);
    if (handoff?.searchParams.get("surface") === "browser") {
      openExternalFocused(handoff.href, ownerWindow);
    } else if (isAuthFlowUrl(next)) {
      void authView.webContents.loadURL(next);
    } else {
      try {
        const external = new URL(next);
        if (external.protocol === "https:") openExternalFocused(external.href, ownerWindow);
      } catch {
        // Invalid and non-HTTPS popups stay blocked.
      }
    }
    return { action: "deny" };
  });
  authView.webContents.on("will-navigate", (event, next) => {
    try {
      const external = new URL(next);
      if (
        external.origin === hostedOrigin ||
        isDesktopCallback(next, appUrl) ||
        isAuthFlowUrl(next)
      ) {
        return;
      }
      event.preventDefault();
      if (external.protocol === "https:") openExternalFocused(external.href, ownerWindow);
    } catch {
      // Invalid and non-HTTPS navigation stays blocked.
      event.preventDefault();
    }
  });
  authView.webContents.on("did-navigate", (_event, next) => {
    if (!isDesktopCallback(next, appUrl)) return;
    setTimeout(() => {
      closeDesktopAuthView();
      if (process.platform === "darwin") app.show();
      if (!ownerWindow.isDestroyed()) {
        ownerWindow.show();
        ownerWindow.focus();
      }
    }, 350);
  });
  void authView.webContents.loadURL(url.href).then(() => {
    if (!authView.webContents.isDestroyed()) authView.webContents.focus();
  }).catch((error) => {
    console.error(
      `[desktop] could not load in-app sign-in: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    closeDesktopAuthView();
  });
  return true;
}

function createMainWindow(appUrl, hostedOrigin) {
  const uiPreview =
    argumentValue("--ui-preview") === "tab-activity"
      ? "tab-activity"
      : null;
  const window = new BrowserWindow(
    desktopWindowOptions({ preloadDirectory: __dirname, uiPreview }),
  );

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (openDesktopAuthView(url, window, appUrl, hostedOrigin)) {
      return { action: "deny" };
    }
    if (isExternalUrl(url, appUrl)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  return window;
}

function configureWindow(window, appUrl, setUpProjectFromUrl) {
  let rendererRecoveryAttempts = 0;
  const desktopPlatform =
    process.platform === "darwin" ? "macos" : process.platform;
  const markDesktopDocument = () =>
    window.webContents
      .executeJavaScript(
        `document.documentElement.dataset.videoFsDesktop = ${JSON.stringify(
          desktopPlatform,
        )};`,
        true,
      )
      .catch((error) => {
        console.error(
          `[desktop] could not mark renderer environment: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
  const markFullscreenState = () => {
    if (window.isDestroyed()) return;
    const script = window.isFullScreen()
      ? 'document.documentElement.dataset.videoFsDesktopFullscreen = "true";'
      : "delete document.documentElement.dataset.videoFsDesktopFullscreen;";
    return window.webContents.executeJavaScript(script, true).catch((error) => {
      console.error(
        `[desktop] could not mark renderer fullscreen state: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    });
  };
  window.on("enter-full-screen", markFullscreenState);
  window.on("leave-full-screen", markFullscreenState);
  window.webContents.on("will-navigate", (event, url) => {
    if (!isExternalUrl(url, appUrl)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  window.webContents.on("dom-ready", markDesktopDocument);
  window.webContents.on("dom-ready", markFullscreenState);
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(
      `[desktop] preload failed (${preloadPath}): ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  });
  window.webContents.on("did-finish-load", () => {
    rendererRecoveryAttempts = 0;
    void markDesktopDocument();
    void markFullscreenState();
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[desktop] renderer exited: ${details.reason}`);
    if (
      details.reason === "clean-exit" ||
      rendererRecoveryAttempts >= 1 ||
      window.isDestroyed()
    ) {
      return;
    }
    rendererRecoveryAttempts += 1;
    setTimeout(() => {
      if (!window.isDestroyed()) window.webContents.reload();
    }, 50);
  });
  window.webContents.on("did-navigate", (_event, url) => setUpProjectFromUrl(url));
  window.webContents.on("did-navigate-in-page", (_event, url) => setUpProjectFromUrl(url));
}

function isExternalUrl(candidate, appUrl) {
  try {
    return new URL(candidate).origin !== new URL(appUrl).origin;
  } catch {
    return true;
  }
}

function startNextServer({ dataRoot, host, port, token }) {
  const productionServer = path.join(process.resourcesPath, "standalone", "server.js");
  const developmentServer = path.join(repoRoot, "node_modules", "next", "dist", "bin", "next");
  const serverScript = app.isPackaged ? productionServer : developmentServer;
  const serverArguments = app.isPackaged
    ? [serverScript]
    : [serverScript, "dev", "--hostname", host, "--port", String(port)];
  const executable = app.isPackaged
    ? process.execPath
    : process.env.npm_node_execpath || process.execPath;
  const childEnvironment = {
    ...process.env,
    APP_MODE: "local",
    HOSTNAME: host,
    ...(app.isPackaged
      ? { NODE_PATH: path.join(process.resourcesPath, "standalone", "server_modules") }
      : {}),
    NEXT_PUBLIC_APP_MODE: "local",
    NEXT_PUBLIC_DESKTOP_CLOUD_ENABLED: String(desktopCloud.enabled),
    NEXT_PUBLIC_DESKTOP_CLOUD_URL: desktopCloud.origin,
    PAPER_MCP_TOKEN: token,
    VIDEO_FS_REQUIRE_PROJECT_BINDING: "true",
    PORT: String(port),
    VIDEO_FS_APP_URL: `http://127.0.0.1:${port}`,
    VIDEO_FS_DATA_ROOT: dataRoot,
    VIDEO_FS_SETTINGS_ROOT: process.env.VIDEO_FS_SETTINGS_ROOT?.trim() ||
      (app.isPackaged ? path.join(app.getPath("userData"), "settings") : path.join(path.dirname(dataRoot), "settings")),
    ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production" } : {}),
  };

  const child = spawn(executable, serverArguments, {
    cwd: app.isPackaged ? path.dirname(productionServer) : repoRoot,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[next] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[next] ${chunk}`));
  child.on("exit", (code, signal) => {
    console.log(`[desktop] Next server exited (code=${code}, signal=${signal}).`);
  });
  return child;
}

async function waitForServer(appUrl, child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Embedded Next server exited with code ${child.exitCode}.`);
    }
    try {
      const status = await requestStatus(appUrl);
      if (status >= 200 && status < 500) return;
      lastError = `HTTP ${status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "connection failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Embedded Next server did not become ready: ${lastError}`);
}

function requestStatus(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 2_000 }, (response) => {
      response.resume();
      resolve(response.statusCode || 0);
    });
    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("request timed out")));
  });
}

async function choosePort(preferredPort) {
  if (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort > 65535) {
    throw new Error(`Invalid desktop port: ${preferredPort}`);
  }
  const lastPort = preferredPort === DEFAULT_PORT ? LAST_DESKTOP_PORT : preferredPort;
  for (let candidate = preferredPort; candidate <= lastPort; candidate += 1) {
    if (await portIsAvailable(candidate)) return candidate;
  }
  throw new Error(
    preferredPort === DEFAULT_PORT
      ? `Video FS could not start because ports ${DEFAULT_PORT}-${LAST_DESKTOP_PORT} are in use.`
      : `Video FS could not start because port ${preferredPort} is in use.`,
  );
}

function portIsAvailable(port) {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve(true));
    });
  });
}

async function stopServer(child, statePath) {
  if (statePath) await rm(statePath, { force: true }).catch(() => {});
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
