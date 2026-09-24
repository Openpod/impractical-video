"use client";

/** Electron intercepts new-window navigation and hands HTTPS URLs to the
 * system browser. Hosted web keeps ordinary same-window navigation. */
export function openExternalOrNavigate(value: string): "external" | "navigated" {
  const url = new URL(value, window.location.href);
  if (url.protocol !== "https:" && url.origin !== window.location.origin) {
    throw new Error("Refusing to open an unsafe external URL.");
  }
  if (window.videoFsDesktopEnvironment?.platform) {
    window.open(url.href, "_blank", "noopener,noreferrer");
    return "external";
  }
  window.location.assign(url.href);
  return "navigated";
}
