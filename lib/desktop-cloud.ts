import "server-only";

import { isLocalAppMode } from "@/lib/app-mode";

const DEFAULT_CLOUD_APP_URL = "https://chat.impractical.ai";
const TOKEN_REFRESH_GRACE_SECONDS = 15;

type DesktopCloudSession = {
  expiresAt: number;
  refreshToken: string | null;
  token: string;
};

declare global {
  // The packaged Next server is a single local process. Keep the short-lived
  // Clerk token in memory so it disappears when Video FS quits.
  var __videoFsDesktopCloudSession: DesktopCloudSession | null | undefined;
}

export class DesktopCloudSessionError extends Error {
  constructor(message = "Sign in to connect Video FS Desktop to your account.") {
    super(message);
    this.name = "DesktopCloudSessionError";
  }
}

function jwtExpiration(token: string): number {
  const parts = token.split(".");
  if (parts.length !== 3) throw new DesktopCloudSessionError("The desktop session token is invalid.");
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    const expiresAt = Number(payload.exp);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
      throw new Error("missing expiry");
    }
    return expiresAt;
  } catch {
    throw new DesktopCloudSessionError("The desktop session token is invalid.");
  }
}

export function desktopCloudAppUrl(
  environment: Record<string, string | undefined> = process.env,
): string {
  const candidate =
    environment.NEXT_PUBLIC_DESKTOP_CLOUD_URL?.trim() || DEFAULT_CLOUD_APP_URL;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("NEXT_PUBLIC_DESKTOP_CLOUD_URL must be an HTTPS origin.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("NEXT_PUBLIC_DESKTOP_CLOUD_URL must contain only an origin.");
  }
  return parsed.origin;
}

export function setDesktopCloudSessionToken(token: string, refreshToken?: string | null): void {
  if (!isLocalAppMode()) {
    throw new Error("Desktop cloud sessions are only available in local app mode.");
  }
  const normalized = token.trim();
  const expiresAt = jwtExpiration(normalized);
  if (expiresAt <= Math.floor(Date.now() / 1000) + TOKEN_REFRESH_GRACE_SECONDS) {
    throw new DesktopCloudSessionError("The desktop session has expired. Sign in again.");
  }
  const normalizedRefresh = refreshToken?.trim() || null;
  globalThis.__videoFsDesktopCloudSession = {
    expiresAt,
    refreshToken: normalizedRefresh,
    token: normalized,
  };
}

export function clearDesktopCloudSessionToken(): void {
  globalThis.__videoFsDesktopCloudSession = null;
}

export function getDesktopCloudSessionToken(): string {
  if (!isLocalAppMode()) {
    throw new Error("Desktop cloud sessions are only available in local app mode.");
  }
  const session = globalThis.__videoFsDesktopCloudSession;
  if (
    !session ||
    session.expiresAt <= Math.floor(Date.now() / 1000) + TOKEN_REFRESH_GRACE_SECONDS
  ) {
    globalThis.__videoFsDesktopCloudSession = null;
    throw new DesktopCloudSessionError();
  }
  return session.token;
}

export function hasDesktopCloudSession(): boolean {
  try {
    getDesktopCloudSessionToken();
    return true;
  } catch {
    return false;
  }
}

export function getDesktopCloudSessionRefreshToken(): string | null {
  if (!isLocalAppMode()) {
    throw new Error("Desktop cloud sessions are only available in local app mode.");
  }
  return globalThis.__videoFsDesktopCloudSession?.refreshToken ?? null;
}

export async function restoreDesktopCloudSession(refreshToken: string): Promise<boolean> {
  if (!isLocalAppMode()) {
    throw new Error("Desktop cloud sessions are only available in local app mode.");
  }
  const normalizedRefresh = refreshToken.trim();
  if (!normalizedRefresh || normalizedRefresh.length > 4096) return false;
  const response = await fetch(`${desktopCloudAppUrl()}/api/desktop/auth/refresh`, {
    body: JSON.stringify({ refreshToken: normalizedRefresh }),
    cache: "no-store",
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(12_000),
  });
  const body = (await response.json().catch(() => null)) as
    | { refreshToken?: unknown; token?: unknown }
    | null;
  if (
    !response.ok ||
    typeof body?.token !== "string" ||
    typeof body.refreshToken !== "string"
  ) {
    clearDesktopCloudSessionToken();
    return false;
  }
  setDesktopCloudSessionToken(body.token, body.refreshToken);
  return true;
}

export async function refreshDesktopCloudSession(): Promise<boolean> {
  if (!isLocalAppMode()) {
    throw new Error("Desktop cloud sessions are only available in local app mode.");
  }
  const refreshToken = globalThis.__videoFsDesktopCloudSession?.refreshToken;
  if (!refreshToken) return hasDesktopCloudSession();
  return restoreDesktopCloudSession(refreshToken);
}

export async function desktopCloudFetch(
  pathname: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) {
    throw new Error("Desktop cloud requests require an absolute path.");
  }
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${getDesktopCloudSessionToken()}`);
  headers.set("x-video-fs-client", "desktop");
  return fetch(`${desktopCloudAppUrl()}${pathname}`, {
    ...init,
    cache: "no-store",
    headers,
  });
}

export async function cloneCloudResponse(response: Response): Promise<Response> {
  const headers = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");
  return new Response(await response.arrayBuffer(), {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
