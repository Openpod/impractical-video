import path from "node:path";

export const MACOS_TITLE_BAR_HEIGHT = 44;
export const MACOS_TRAFFIC_LIGHT_POSITION = Object.freeze({ x: 14, y: 15 });

export function desktopWindowOptions({
  platform = process.platform,
  preloadDirectory,
  uiPreview = null,
} = {}) {
  if (!preloadDirectory || !path.isAbsolute(preloadDirectory)) {
    throw new Error("Desktop preload directory must be absolute.");
  }

  const macos = platform === "darwin";
  return {
    backgroundColor: "#0b0b0c",
    height: 900,
    minHeight: 640,
    minWidth: 960,
    show: false,
    title: "Video FS",
    ...(macos
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION,
        }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(preloadDirectory, "preload.mjs"),
      additionalArguments:
        uiPreview === "tab-activity"
          ? ["--video-fs-ui-preview=tab-activity"]
          : [],
      sandbox: true,
      webSecurity: true,
    },
    width: 1440,
  };
}
