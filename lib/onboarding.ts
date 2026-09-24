"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Per-device onboarding state. One localStorage object holds a boolean per
 * milestone the user has already seen (the welcome modal, each contextual
 * hint). Kept intentionally small and swappable — the same surface can later
 * be backed by Clerk publicMetadata / a Supabase user_prefs row for
 * cross-device persistence without touching call sites.
 */

const STORAGE_KEY = "impractical-onboarding-v1";

export type OnboardingFlag =
  | "welcome"
  | "studio-setup"
  | "project-tour"
  | "zoom-hint"
  | "focus-edit-hint"
  | "editor-hint";

type OnboardingState = Partial<Record<OnboardingFlag, boolean>>;

function read(): OnboardingState {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as OnboardingState;
  } catch {
    return {};
  }
}

function write(state: OnboardingState) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort — onboarding just re-shows if storage is unavailable.
  }
}

export function hasSeenOnboarding(flag: OnboardingFlag): boolean {
  return read()[flag] === true;
}

export function markOnboardingSeen(flag: OnboardingFlag) {
  const state = read();
  if (state[flag] === true) return;
  write({ ...state, [flag]: true });
}

/**
 * Reads a milestone flag SSR-safely: `seen` starts optimistically true so the
 * server render and first client paint never flash the modal/hint; once
 * mounted, `ready` flips and `seen` reflects real storage. Show a milestone
 * only when `ready && !seen`.
 */
export function useOnboardingFlag(flag: OnboardingFlag) {
  const [ready, setReady] = useState(false);
  const [seen, setSeen] = useState(true);

  useEffect(() => {
    setSeen(hasSeenOnboarding(flag));
    setReady(true);
  }, [flag]);

  const dismiss = useCallback(() => {
    markOnboardingSeen(flag);
    setSeen(true);
  }, [flag]);

  return { dismiss, ready, seen };
}
