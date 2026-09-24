import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { isLocalAppMode } from "@/lib/app-mode";
import { assertDesktopAuthState, assertDesktopPkceVerifier } from "@/lib/desktop-auth-code";
import { desktopCloudAppUrl, setDesktopCloudSessionToken } from "@/lib/desktop-cloud";
import { DESKTOP_PORT_END, DESKTOP_PORT_START } from "@/lib/desktop-origins";

const ATTEMPT_TTL_MS = 15 * 60 * 1000;
const MAX_ACTIVE_ATTEMPTS = 8;

type DesktopAuthAttempt = {
  expiresAt: number;
  state: string;
  verifier: string;
};

declare global {
  var __videoFsDesktopAuthAttempts: Map<string, DesktopAuthAttempt> | undefined;
}

function activeAttempts(now = Date.now()): Map<string, DesktopAuthAttempt> {
  const attempts = globalThis.__videoFsDesktopAuthAttempts ?? new Map();
  globalThis.__videoFsDesktopAuthAttempts = attempts;
  for (const [state, attempt] of attempts) {
    if (attempt.expiresAt <= now) attempts.delete(state);
  }
  return attempts;
}

function callbackUrl(environment: Record<string, string | undefined>): string {
  const appUrl = new URL(environment.VIDEO_FS_APP_URL || "");
  const port = Number(appUrl.port);
  if (
    appUrl.protocol !== "http:" ||
    appUrl.hostname !== "127.0.0.1" ||
    port < DESKTOP_PORT_START ||
    port > DESKTOP_PORT_END ||
    appUrl.pathname !== "/" ||
    appUrl.search ||
    appUrl.hash
  ) {
    throw new Error("The desktop callback origin is invalid.");
  }
  return new URL("/api/desktop/auth/callback", appUrl).href;
}

export function startDesktopAuthAttempt(
  environment: Record<string, string | undefined> = process.env,
): string {
  if (!isLocalAppMode(environment)) throw new Error("Desktop auth is only available locally.");
  const now = Date.now();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const attempts = activeAttempts(now);
  while (attempts.size >= MAX_ACTIVE_ATTEMPTS) {
    const oldest = attempts.keys().next().value as string | undefined;
    if (!oldest) break;
    attempts.delete(oldest);
  }
  attempts.set(state, {
    expiresAt: now + ATTEMPT_TTL_MS,
    state,
    verifier,
  });
  const authorizeUrl = new URL("/desktop-auth", desktopCloudAppUrl(environment));
  authorizeUrl.searchParams.set("callback", callbackUrl(environment));
  authorizeUrl.searchParams.set(
    "challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  authorizeUrl.searchParams.set("state", state);
  return authorizeUrl.href;
}

export async function completeDesktopAuthAttempt(
  input: { code: unknown; state: unknown },
  environment: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!isLocalAppMode(environment)) throw new Error("Desktop auth is only available locally.");
  const state = assertDesktopAuthState(input.state);
  const attempts = activeAttempts();
  const attempt = attempts.get(state);
  if (!attempt) {
    throw new Error("This desktop sign-in attempt expired. Start again from the app.");
  }
  const verifier = assertDesktopPkceVerifier(attempt.verifier);
  const response = await fetch(`${desktopCloudAppUrl(environment)}/api/desktop/auth/exchange`, {
    body: JSON.stringify({ code: input.code, verifier }),
    cache: "no-store",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json().catch(() => null)) as
    | { refreshToken?: unknown; token?: unknown }
    | null;
  if (
    !response.ok ||
    typeof body?.token !== "string" ||
    typeof body.refreshToken !== "string"
  ) {
    throw new Error("The desktop session could not be connected.");
  }
  setDesktopCloudSessionToken(body.token, body.refreshToken);
  attempts.delete(state);
}
