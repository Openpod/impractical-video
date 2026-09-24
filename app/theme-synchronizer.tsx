"use client";

import { useLayoutEffect } from "react";

type ThemePreference = "dark" | "light" | "system";

function resolveSystemTheme() {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function readThemePreference(): ThemePreference {
  const stored = window.localStorage.getItem("theme");
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function applyThemePreference(preference: ThemePreference) {
  const theme = preference === "system" ? resolveSystemTheme() : preference;
  document.documentElement.setAttribute("data-theme", theme);
}

export function ThemeSynchronizer() {
  useLayoutEffect(() => {
    const syncTheme = () => applyThemePreference(readThemePreference());
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onStorage = (event: StorageEvent) => {
      if (event.key === "theme") syncTheme();
    };

    syncTheme();
    media.addEventListener("change", syncTheme);
    window.addEventListener("storage", onStorage);

    return () => {
      media.removeEventListener("change", syncTheme);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return null;
}
