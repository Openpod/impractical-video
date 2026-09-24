import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const bridge = vi.hoisted(() => ({
  clerkUser: vi.fn(),
  currentUser: vi.fn(),
  getBalance: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ currentUser: bridge.clerkUser }));
vi.mock("@/lib/app-users", () => ({ ensureCurrentAppUser: bridge.currentUser }));
vi.mock("@/lib/credits-service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/credits-service")>();
  return { ...original, getCreditBalance: bridge.getBalance };
});

import {
  DELETE as clearSession,
  PATCH as persistSession,
  POST as syncSession,
} from "@/app/api/desktop/cloud-session/route";
import { GET as getDesktopAccount } from "@/app/api/desktop/account/route";
import { POST as initiateUpload } from "@/app/api/desktop/fal/upload/route";
import {
  clearDesktopCloudSessionToken,
  getDesktopCloudSessionToken,
  setDesktopCloudSessionToken,
} from "@/lib/desktop-cloud";

function clerkToken() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp: Math.floor(Date.now() / 1000) + 60 })}.sig`;
}

afterEach(() => {
  clearDesktopCloudSessionToken();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
  bridge.currentUser.mockResolvedValue({ userId: "user_desktop" });
  bridge.clerkUser.mockResolvedValue(null);
  bridge.getBalance.mockResolvedValue({ total: 100 });
});

describe("desktop account bridge", () => {
  it("returns the signed-in hosted account instead of the local workspace identity", async () => {
    vi.stubEnv("APP_MODE", "hosted");
    bridge.currentUser.mockResolvedValue({
      email: "simar@example.com",
      name: "Simar Kohli",
      userId: "user_signed_in",
    });
    bridge.clerkUser.mockResolvedValue({
      createdAt: Date.UTC(2025, 0, 2),
      firstName: "Simar",
      imageUrl: "https://images.example/avatar.png",
      lastName: "Kohli",
      username: "simar",
    });

    const response = await getDesktopAccount();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: {
        createdAt: "2025-01-02T00:00:00.000Z",
        email: "simar@example.com",
        firstName: "Simar",
        fullName: "Simar Kohli",
        id: "user_signed_in",
        imageUrl: "https://images.example/avatar.png",
        username: "simar",
      },
    });
  });

  it("proxies the authenticated production account into the local desktop shell", async () => {
    vi.stubEnv("APP_MODE", "local");
    const token = clerkToken();
    setDesktopCloudSessionToken(token);
    const hostedFetch = vi.fn().mockResolvedValue(
      Response.json({
        user: {
          email: "simar@example.com",
          fullName: "Simar Kohli",
          id: "user_signed_in",
        },
      }),
    );
    vi.stubGlobal("fetch", hostedFetch);

    const response = await getDesktopAccount();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: {
        email: "simar@example.com",
        fullName: "Simar Kohli",
        id: "user_signed_in",
      },
    });
    expect(hostedFetch).toHaveBeenCalledWith(
      "https://chat.impractical.ai/api/desktop/account",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    const headers = hostedFetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("x-video-fs-client")).toBe("desktop");
  });
});

describe("desktop cloud session route", () => {
  it("validates a Clerk token with production before retaining it in memory", async () => {
    vi.stubEnv("APP_MODE", "local");
    const token = clerkToken();
    const hostedFetch = vi.fn().mockResolvedValue(Response.json({ balance: 100 }));
    vi.stubGlobal("fetch", hostedFetch);

    const response = await syncSession(
      new Request("http://127.0.0.1/api/desktop/cloud-session", {
        headers: { authorization: `Bearer ${token}` },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(getDesktopCloudSessionToken()).toBe(token);
    expect(hostedFetch).toHaveBeenCalledWith(
      "https://chat.impractical.ai/api/credits",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${token}` }) }),
    );
    expect((await clearSession()).status).toBe(200);
    expect(() => getDesktopCloudSessionToken()).toThrow(/sign in/i);
  });

  it("does not expose the local session setter from the hosted app", async () => {
    vi.stubEnv("APP_MODE", "hosted");
    const response = await syncSession(
      new Request("https://chat.impractical.ai/api/desktop/cloud-session", { method: "POST" }),
    );
    expect(response.status).toBe(404);
  });

  it("exports renewable credentials only to the authenticated Electron process", async () => {
    vi.stubEnv("APP_MODE", "local");
    vi.stubEnv("PAPER_MCP_TOKEN", "local-process-secret");
    const refreshToken = `${"a".repeat(64)}.${"b".repeat(43)}`;
    setDesktopCloudSessionToken(clerkToken(), refreshToken);

    const denied = await persistSession(
      new Request("http://127.0.0.1/api/desktop/cloud-session", {
        body: JSON.stringify({ action: "export" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
    );
    expect(denied.status).toBe(403);

    const response = await persistSession(
      new Request("http://127.0.0.1/api/desktop/cloud-session", {
        body: JSON.stringify({ action: "export" }),
        headers: {
          authorization: "Bearer local-process-secret",
          "content-type": "application/json",
        },
        method: "PATCH",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ refreshToken });
  });
});

describe("desktop fal upload route", () => {
  it("rejects invalid file metadata before requesting fal storage", async () => {
    vi.stubEnv("APP_MODE", "hosted");
    const falFetch = vi.fn();
    vi.stubGlobal("fetch", falFetch);
    const response = await initiateUpload(
      new Request("https://chat.impractical.ai/api/desktop/fal/upload", {
        body: JSON.stringify({ contentType: "text/html", fileName: "page.html", size: 12 }),
        method: "POST",
      }),
    );
    expect(response.status).toBe(400);
    expect(falFetch).not.toHaveBeenCalled();
  });

  it("returns a short-lived direct upload target without exposing the fal key", async () => {
    vi.stubEnv("APP_MODE", "hosted");
    vi.stubEnv("FAL_KEY", "server-fal-secret");
    const falFetch = vi.fn().mockResolvedValue(
      Response.json({
        file_url: "https://v3.fal.media/files/reference.png",
        upload_url: "https://storage.example/upload/signed",
      }),
    );
    vi.stubGlobal("fetch", falFetch);
    const response = await initiateUpload(
      new Request("https://chat.impractical.ai/api/desktop/fal/upload", {
        body: JSON.stringify({ contentType: "image/png", fileName: "reference.png", size: 1_024 }),
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      uploadUrl: "https://storage.example/upload/signed",
      url: "https://v3.fal.media/files/reference.png",
    });
    expect(JSON.stringify(body)).not.toContain("server-fal-secret");
    expect(falFetch).toHaveBeenCalledWith(
      expect.stringContaining("/storage/upload/initiate"),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Key server-fal-secret" }) }),
    );
  });
});
