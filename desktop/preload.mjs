const { contextBridge, ipcRenderer } = require("electron");

const desktopPlatform =
  process.platform === "darwin" ? "macos" : process.platform;
const uiPreview = process.argv.includes("--video-fs-ui-preview=tab-activity")
  ? "tab-activity"
  : null;

contextBridge?.exposeInMainWorld?.(
  "videoFsDesktopEnvironment",
  Object.freeze({
    authSessionCleared: () => ipcRenderer.invoke("video-fs:auth-session-cleared"),
    authSessionConnected: () => ipcRenderer.invoke("video-fs:auth-session-connected"),
    companionHide: () => ipcRenderer.invoke("video-fs:companion-hide"),
    companionAttachmentRead: (projectId, hash) =>
      ipcRenderer.invoke("video-fs:companion-attachment-read", projectId, hash),
    companionAttachmentRemove: (projectId, hash) =>
      ipcRenderer.invoke("video-fs:companion-attachment-remove", projectId, hash),
    companionAttachmentStore: (projectId, attachment) =>
      ipcRenderer.invoke("video-fs:companion-attachment-store", projectId, attachment),
    companionComposeGet: (projectId) =>
      ipcRenderer.invoke("video-fs:companion-compose-get", projectId),
    companionComposeSet: (projectId, state) =>
      ipcRenderer.invoke("video-fs:companion-compose-set", projectId, state),
    companionOnProject: (callback) => {
      const listener = (_event, projectId) => callback(projectId ?? null);
      ipcRenderer.on("video-fs:companion-project", listener);
      return () =>
        ipcRenderer.removeListener("video-fs:companion-project", listener);
    },
    companionOpenProject: (projectId) =>
      ipcRenderer.invoke("video-fs:companion-open-project", projectId),
    mainOnOpenProject: (callback) => {
      const listener = (_event, projectId) => {
        if (typeof projectId === "string" && projectId) callback(projectId);
      };
      ipcRenderer.on("video-fs:open-project", listener);
      return () =>
        ipcRenderer.removeListener("video-fs:open-project", listener);
    },
    companionShow: () => ipcRenderer.invoke("video-fs:companion-show"),
    companionTitleSet: (projectId, name) =>
      ipcRenderer.invoke("video-fs:companion-title-set", projectId, name),
    companionToggle: () => ipcRenderer.invoke("video-fs:companion-toggle"),
    platform: desktopPlatform,
    uiPreview,
  }),
);

function markDesktopDocument() {
  const root = document.documentElement;
  if (!root) return false;
  if (root.dataset.videoFsDesktop !== desktopPlatform) {
    root.dataset.videoFsDesktop = desktopPlatform;
  }
  return true;
}

function ensureDesktopDocument() {
  if (markDesktopDocument()) return;
  queueMicrotask(markDesktopDocument);
}

// Preload runs for every renderer document, including an explicit reload and
// Chromium's renderer recovery path. Apply immediately, then re-apply if the
// document root is replaced during navigation or recovery.
ensureDesktopDocument();
document.addEventListener("readystatechange", ensureDesktopDocument);
document.addEventListener("DOMContentLoaded", ensureDesktopDocument);
window.addEventListener("pageshow", ensureDesktopDocument);

const documentObserver = new MutationObserver(ensureDesktopDocument);
documentObserver.observe(document, {
  attributes: true,
  attributeFilter: ["data-video-fs-desktop"],
  childList: true,
  subtree: true,
});
