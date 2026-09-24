import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const canonicalAria = {
  id: "8ddf588e-090c-48ff-9cc9-27d73d914fe2",
  kind: "character",
  title: "Aria Solaris",
};

beforeEach(() => {
  delete process.env.VIDEO_FS_PUBLIC_CATALOG_URL;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.VIDEO_FS_PUBLIC_CATALOG_URL;
});

describe("public catalog transport", () => {
  it("keeps the public Explore catalog available in local mode without credits or an account", async () => {
    vi.stubEnv("APP_MODE", "local");
    vi.stubEnv("NEXT_PUBLIC_DESKTOP_CLOUD_ENABLED", "false");
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ items: [canonicalAria] }));
    vi.stubGlobal("fetch", fetchMock);
    const { listPublicCatalogItems } = await import("@/lib/public-catalog");
    await expect(listPublicCatalogItems("/api/explore/references")).resolves.toEqual([canonicalAria]);
    expect(fetchMock).toHaveBeenCalledWith(new URL("https://chat.impractical.ai/api/explore/references"), expect.objectContaining({ headers: { Accept: "application/json" } }));
  });
  it("reads canonical stable IDs from the anonymous application endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [canonicalAria] }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { listPublicCatalogItems } = await import("@/lib/public-catalog");

    await expect(listPublicCatalogItems("/api/explore/references")).resolves.toEqual([
      canonicalAria,
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://chat.impractical.ai/api/explore/references"),
      expect.objectContaining({
        cache: "no-store",
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("never permits an insecure remote catalog endpoint", async () => {
    process.env.VIDEO_FS_PUBLIC_CATALOG_URL = "http://catalog.example.com";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { listPublicCatalogItems } = await import("@/lib/public-catalog");

    await expect(listPublicCatalogItems("/api/explore/references")).rejects.toThrow(
      /must use HTTPS/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
