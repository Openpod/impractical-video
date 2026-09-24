"use client";

/**
 * A signed-out visitor's "start a project" intent, preserved across the sign-up
 * redirect. When they add picks + type a prompt on the home/explore browse and
 * hit Start, we stash it here, send them to sign-up, and — once they're back
 * signed in — create the project, import the picks, and fire the prompt so they
 * land in a real project with their selections instead of an empty app.
 */

export type StartIntent = {
  pickIds: string[];
  prompt: string;
  ts: number;
};

const KEY = "impractical-start-intent-v1";
const MAX_AGE_MS = 60 * 60 * 1000; // ignore intents older than an hour

export function stashStartIntent(input: { pickIds: string[]; prompt: string }) {
  if (typeof window === "undefined") return;
  const pickIds = input.pickIds.filter((id) => typeof id === "string");
  if (!pickIds.length && !input.prompt.trim()) return; // nothing worth preserving
  try {
    localStorage.setItem(KEY, JSON.stringify({ pickIds, prompt: input.prompt, ts: Date.now() } satisfies StartIntent));
  } catch {
    // Best-effort — the user just lands on the app without continuation.
  }
}

export function readStartIntent(): StartIntent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StartIntent>;
    if (!parsed || !Array.isArray(parsed.pickIds)) return null;
    if (typeof parsed.ts === "number" && Date.now() - parsed.ts > MAX_AGE_MS) return null;
    return {
      pickIds: parsed.pickIds.filter((id): id is string => typeof id === "string"),
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
      ts: typeof parsed.ts === "number" ? parsed.ts : 0,
    };
  } catch {
    return null;
  }
}

export function clearStartIntent() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
