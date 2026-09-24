import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isBillingUiEnabled,
  isLocalAppMode,
  isLocalAppModeClient,
  LOCAL_APP_USER_ID,
} from "@/lib/app-mode";

const hosted = vi.hoisted(() => ({
  auth: vi.fn(),
  clerkMiddleware: vi.fn(),
  creditProvision: vi.fn(),
  currentUser: vi.fn(),
  from: vi.fn(),
  middleware: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@clerk/nextjs/server", () => ({
  auth: hosted.auth,
  clerkMiddleware: hosted.clerkMiddleware,
  currentUser: hosted.currentUser,
}));
vi.mock("@/lib/supabase", () => ({
  createServerClient: vi.fn(() => ({
    from: hosted.from,
  })),
}));
vi.mock("@/lib/credits-service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/credits-service")>();
  return {
    ...original,
    ensureCreditAccount: hosted.creditProvision,
  };
});

const originalEnvironment = { ...process.env };
const temporaryRoots: string[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...originalEnvironment };
  hosted.auth.mockResolvedValue({ userId: "hosted-user" });
  hosted.currentUser.mockResolvedValue(null);
  hosted.creditProvision.mockResolvedValue(undefined);
  hosted.upsert.mockResolvedValue({ error: null });
  hosted.from.mockReturnValue({ upsert: hosted.upsert });
  hosted.middleware.mockResolvedValue(new Response("hosted auth"));
  hosted.clerkMiddleware.mockReturnValue(hosted.middleware);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env = { ...originalEnvironment };
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
});

describe("explicit app mode", () => {
  it("does not infer local mode from storage or missing hosted credentials", () => {
    expect(isLocalAppMode({ VIDEO_FS_DATA_ROOT: "/tmp/projects" })).toBe(false);
    expect(isLocalAppMode({ NODE_ENV: "development" })).toBe(false);
    expect(isLocalAppMode({ APP_MODE: "local" })).toBe(true);
    expect(isLocalAppMode({ APP_MODE: "LOCAL" })).toBe(true);
  });

  it("uses the separately embedded client flag for billing chrome", () => {
    expect(isLocalAppModeClient({ NEXT_PUBLIC_APP_MODE: "local" })).toBe(true);
    expect(isBillingUiEnabled({ NEXT_PUBLIC_APP_MODE: "local" })).toBe(false);
    expect(
      isBillingUiEnabled({
        NEXT_PUBLIC_APP_MODE: "local",
        NEXT_PUBLIC_DESKTOP_CLOUD_ENABLED: "true",
      }),
    ).toBe(true);
    expect(isBillingUiEnabled({ NEXT_PUBLIC_APP_MODE: "cloud" })).toBe(true);
  });
});

describe("local identity and auth boundary", () => {
  it("returns the synthetic user without Clerk, Supabase, or credit provisioning", async () => {
    process.env.APP_MODE = "local";
    vi.stubEnv("NODE_ENV", "production");
    const { ensureCurrentAppUser } = await import("@/lib/app-users");

    await expect(ensureCurrentAppUser()).resolves.toEqual({
      email: null,
      name: "Local workspace",
      userId: LOCAL_APP_USER_ID,
    });
    expect(hosted.auth).not.toHaveBeenCalled();
    expect(hosted.currentUser).not.toHaveBeenCalled();
    expect(hosted.from).not.toHaveBeenCalled();
    expect(hosted.creditProvision).not.toHaveBeenCalled();
  });

  it("keeps ordinary production on the hosted Clerk and Supabase path", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.APP_MODE;
    const { ensureCurrentAppUser } = await import("@/lib/app-users");

    await expect(ensureCurrentAppUser()).resolves.toMatchObject({
      userId: "hosted-user",
    });
    expect(hosted.auth).toHaveBeenCalledOnce();
    expect(hosted.from).toHaveBeenCalledWith("app_users");
    expect(hosted.upsert).toHaveBeenCalledOnce();
    expect(hosted.creditProvision).toHaveBeenCalledWith("hosted-user");
  });

  it("bypasses Clerk middleware only when APP_MODE is explicitly local", async () => {
    const { default: middleware } = await import("@/middleware");
    const { NextRequest } = await import("next/server");
    const request = new NextRequest("http://localhost/api/projects");

    process.env.APP_MODE = "local";
    const localResponse = await middleware(request, {} as never);
    expect(localResponse).toBeDefined();
    expect(hosted.middleware).not.toHaveBeenCalled();

    delete process.env.APP_MODE;
    await middleware(request, {} as never);
    expect(hosted.middleware).toHaveBeenCalledOnce();
  });

  it("rejects remote hosts and cross-origin writes while permitting local MCP requests", async () => {
    process.env.APP_MODE = "local";
    const { default: middleware } = await import("@/middleware");
    const { NextRequest } = await import("next/server");
    const rejectedHeaders: Record<string, string>[] = [
      { host: "evil.example" },
      { host: "localhost:3000", origin: "https://evil.example" },
      { host: "localhost:3000", origin: "null" },
      { host: "localhost:3000", "sec-fetch-site": "cross-site" },
    ];
    for (const headers of rejectedHeaders) {
      const response = await middleware(new NextRequest("http://localhost:3000/api/projects", { method: "POST", headers }), {} as never);
      expect(response?.status).toBe(403);
    }
    const allowedHeaders: Record<string, string>[] = [{ host: "localhost:3000" }, { host: "localhost:3000", origin: "http://localhost:3000" }];
    for (const headers of allowedHeaders) {
      const response = await middleware(new NextRequest("http://localhost:3000/api/projects", { method: "POST", headers }), {} as never);
      expect(response?.status).toBe(200);
    }
  });
});

describe("local storage and billing boundary", () => {
  it("uses filesystem projects despite hosted Supabase env variables", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-fs-local-mode-"));
    temporaryRoots.push(root);
    process.env.APP_MODE = "local";
    process.env.VIDEO_FS_DATA_ROOT = root;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://hosted.invalid";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "must-not-be-used";
    const { createProject, listProjects } = await import("@/lib/workspace");

    const project = await createProject("Desktop proof", LOCAL_APP_USER_ID);
    await expect(listProjects(LOCAL_APP_USER_ID)).resolves.toContainEqual(project);
    expect(hosted.from).not.toHaveBeenCalled();
  });

  it("disables billing in production local mode without touching Supabase", async () => {
    process.env.APP_MODE = "local";
    vi.stubEnv("NODE_ENV", "production");
    const {
      billingEnabled,
      chargeForOp,
      getCreditBalance,
    } = await import("@/lib/credits-service");

    expect(billingEnabled()).toBe(false);
    await expect(getCreditBalance(LOCAL_APP_USER_ID)).resolves.toMatchObject({
      free: 150,
      total: 150,
    });
    await expect(
      chargeForOp({
        idempotencyKey: "local-proof",
        op: { kind: "image", tool: "generateImage", resolution: "1K" },
        userId: LOCAL_APP_USER_ID,
      }),
    ).resolves.toEqual({ ok: false, reason: "disabled" });
    expect(hosted.from).not.toHaveBeenCalled();
  });

  it("keeps billing enabled in ordinary production even with a filesystem path", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.VIDEO_FS_DATA_ROOT = "/tmp/test-only";
    delete process.env.APP_MODE;
    const { billingEnabled } = await import("@/lib/credits-service");
    expect(billingEnabled()).toBe(true);
  });
});
