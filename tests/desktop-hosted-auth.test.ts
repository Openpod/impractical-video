import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const clerk = vi.hoisted(() => ({
  auth: vi.fn(),
  client: vi.fn(),
  getSession: vi.fn(),
  getToken: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: clerk.auth,
  clerkClient: clerk.client,
}));

import { POST as authorize } from "@/app/api/desktop/auth/authorize/route";
import { POST as exchange } from "@/app/api/desktop/auth/exchange/route";
import { POST as refresh } from "@/app/api/desktop/auth/refresh/route";
import {
  createDesktopAuthorizationCode,
  createDesktopRefreshCode,
  desktopPkceChallenge,
  verifyDesktopAuthorizationCode,
  verifyDesktopRefreshCode,
} from "@/lib/desktop-auth-code";
import {
  completeDesktopAuthAttempt,
  startDesktopAuthAttempt,
} from "@/lib/desktop-auth-attempt";
import {
  clearDesktopCloudSessionToken,
  getDesktopCloudSessionToken,
} from "@/lib/desktop-cloud";

const SECRET = "desktop-auth-test-secret-that-is-more-than-thirty-two-characters";
const VERIFIER = Buffer.alloc(32, 7).toString("base64url");

function clerkToken(exp = Math.floor(Date.now() / 1000) + 600) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp, sub: "user_desktop" })}.sig`;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INTERNAL_API_SECRET", SECRET);
  clerk.auth.mockResolvedValue({ sessionId: "sess_desktop_123", userId: "user_desktop_123" });
  clerk.getSession.mockResolvedValue({
    id: "sess_desktop_123",
    status: "active",
    userId: "user_desktop_123",
  });
  clerk.getToken.mockResolvedValue({ jwt: clerkToken() });
  clerk.client.mockResolvedValue({
    sessions: { getSession: clerk.getSession, getToken: clerk.getToken },
  });
});

afterEach(() => {
  clearDesktopCloudSessionToken();
  globalThis.__videoFsDesktopAuthAttempts = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("desktop auth codes", () => {
  it("binds a short-lived authorization code to its PKCE verifier", () => {
    const code = createDesktopAuthorizationCode(
      {
        challenge: desktopPkceChallenge(VERIFIER),
        sessionId: "sess_desktop_123",
        state: Buffer.alloc(32, 2).toString("base64url"),
        userId: "user_desktop_123",
      },
      { INTERNAL_API_SECRET: SECRET },
      1_000,
    );
    expect(
      verifyDesktopAuthorizationCode(code, VERIFIER, { INTERNAL_API_SECRET: SECRET }, 1_001),
    ).toMatchObject({ sessionId: "sess_desktop_123", userId: "user_desktop_123" });
    expect(() =>
      verifyDesktopAuthorizationCode(
        code,
        Buffer.alloc(32, 9).toString("base64url"),
        { INTERNAL_API_SECRET: SECRET },
        1_001,
      ),
    ).toThrow(/verifier/i);
    expect(() =>
      verifyDesktopAuthorizationCode(`${code}x`, VERIFIER, { INTERNAL_API_SECRET: SECRET }, 1_001),
    ).toThrow(/invalid/i);
    expect(() =>
      verifyDesktopAuthorizationCode(code, VERIFIER, { INTERNAL_API_SECRET: SECRET }, 1_121),
    ).toThrow(/expired/i);
  });

  it("signs refresh credentials separately from authorization codes", () => {
    const code = createDesktopRefreshCode(
      { sessionId: "sess_desktop_123", userId: "user_desktop_123" },
      { INTERNAL_API_SECRET: SECRET },
      2_000,
    );
    expect(verifyDesktopRefreshCode(code, { INTERNAL_API_SECRET: SECRET }, 2_001)).toMatchObject({
      kind: "refresh",
      sessionId: "sess_desktop_123",
    });
    expect(() =>
      verifyDesktopAuthorizationCode(code, VERIFIER, { INTERNAL_API_SECRET: SECRET }, 2_001),
    ).toThrow();
  });
});

describe("hosted desktop auth routes", () => {
  it("authorizes the hosted Clerk session, exchanges it, and refreshes it", async () => {
    vi.stubEnv("APP_MODE", "hosted");
    const state = Buffer.alloc(32, 4).toString("base64url");
    const challenge = desktopPkceChallenge(VERIFIER);
    const authorizeResponse = await authorize(
      new Request("https://chat.impractical.ai/api/desktop/auth/authorize", {
        body: JSON.stringify({ challenge, state }),
        headers: {
          "content-type": "application/json",
          origin: "https://chat.impractical.ai",
        },
        method: "POST",
      }),
    );
    expect(authorizeResponse.status).toBe(200);
    const { code } = (await authorizeResponse.json()) as { code: string };

    const exchangeResponse = await exchange(
      new Request("https://chat.impractical.ai/api/desktop/auth/exchange", {
        body: JSON.stringify({ code, verifier: VERIFIER }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(exchangeResponse.status).toBe(200);
    const exchangeBody = (await exchangeResponse.json()) as {
      refreshToken: string;
      token: string;
    };
    expect(exchangeBody.token).toBe(clerkToken());
    expect(clerk.getToken).toHaveBeenCalledWith("sess_desktop_123", undefined, 600);

    const refreshResponse = await refresh(
      new Request("https://chat.impractical.ai/api/desktop/auth/refresh", {
        body: JSON.stringify({ refreshToken: exchangeBody.refreshToken }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(refreshResponse.status).toBe(200);
    expect((await refreshResponse.json()).token).toBe(clerkToken());
  });

  it("rejects cross-origin authorization posts", async () => {
    vi.stubEnv("APP_MODE", "hosted");
    const response = await authorize(
      new Request("https://chat.impractical.ai/api/desktop/auth/authorize", {
        body: "{}",
        headers: { origin: "https://attacker.example" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(403);
    expect(clerk.auth).not.toHaveBeenCalled();
  });
});

describe("local desktop handoff", () => {
  it("accepts only the active state and retains the exchanged token in memory", async () => {
    vi.stubEnv("APP_MODE", "local");
    vi.stubEnv("VIDEO_FS_APP_URL", "http://127.0.0.1:3210");
    vi.stubEnv("NEXT_PUBLIC_DESKTOP_CLOUD_URL", "https://chat.impractical.ai");
    const authUrl = new URL(startDesktopAuthAttempt());
    expect(authUrl.origin).toBe("https://chat.impractical.ai");
    expect(authUrl.pathname).toBe("/desktop-auth");
    expect(authUrl.searchParams.get("callback")).toBe(
      "http://127.0.0.1:3210/api/desktop/auth/callback",
    );
    const state = authUrl.searchParams.get("state");
    const hostedFetch = vi.fn().mockResolvedValue(
      Response.json({ refreshToken: "refresh_code", token: clerkToken() }),
    );
    vi.stubGlobal("fetch", hostedFetch);

    await completeDesktopAuthAttempt({ code: "authorization_code", state });
    expect(getDesktopCloudSessionToken()).toBe(clerkToken());
    expect(hostedFetch).toHaveBeenCalledWith(
      "https://chat.impractical.ai/api/desktop/auth/exchange",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not invalidate an in-flight callback when a retry starts", async () => {
    vi.stubEnv("APP_MODE", "local");
    vi.stubEnv("VIDEO_FS_APP_URL", "http://127.0.0.1:3210");
    vi.stubEnv("NEXT_PUBLIC_DESKTOP_CLOUD_URL", "https://chat.impractical.ai");
    const first = new URL(startDesktopAuthAttempt());
    const second = new URL(startDesktopAuthAttempt());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          Response.json({ refreshToken: "refresh_code", token: clerkToken() }),
        ),
      ),
    );

    await completeDesktopAuthAttempt({
      code: "authorization_code_first",
      state: first.searchParams.get("state"),
    });
    await completeDesktopAuthAttempt({
      code: "authorization_code_second",
      state: second.searchParams.get("state"),
    });
  });

  it("never creates a callback outside the fixed loopback port range", () => {
    vi.stubEnv("APP_MODE", "local");
    vi.stubEnv("VIDEO_FS_APP_URL", "http://127.0.0.1:9000");
    expect(() => startDesktopAuthAttempt()).toThrow(/callback origin/i);
  });
});
