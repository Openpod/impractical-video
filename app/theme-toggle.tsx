"use client";

import { Moon, Sun } from "lucide-react";

export function ThemeToggle({ nativeTitle = true }: { nativeTitle?: boolean }) {
  function toggleTheme() {
    const root = document.documentElement;
    const current = root.getAttribute("data-theme") === "light" ? "light" : "dark";
    const next = current === "light" ? "dark" : "light";
    root.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
  }

  return (
    <button
      aria-label="Toggle light and dark theme"
      className="theme-toggle"
      onClick={toggleTheme}
      title={nativeTitle ? "Toggle theme" : undefined}
      type="button"
    >
      <span className="theme-toggle-thumb">
        <Sun className="theme-icon theme-icon-light" size={14} />
        <Moon className="theme-icon theme-icon-dark" size={14} />
      </span>
    </button>
  );
}
