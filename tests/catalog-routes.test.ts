import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  ensureCurrentAppUser: vi.fn(),
  getLocalCatalogItem: vi.fn(),
  getPublishedItem: vi.fn(),
  getPublicCatalogItem: vi.fn(),
  listLocalCatalogItems: vi.fn(),
  listPublishedItems: vi.fn(),
  listPublicCatalogItems: vi.fn(),
  loadLibraryTree: vi.fn(),
  listLocalLibraryUploads: vi.fn(),
}));

vi.mock("@/lib/local-library", () => ({ listLocalLibraryUploads: services.listLocalLibraryUploads }));

vi.mock("@/lib/app-users", () => ({
  ensureCurrentAppUser: services.ensureCurrentAppUser,
}));
vi.mock("@/lib/local-catalog", () => ({
  getLocalCatalogItem: services.getLocalCatalogItem,
  listLocalCatalogItems: services.listLocalCatalogItems,
}));
vi.mock("@/lib/published-items", () => ({
  getPublishedItem: services.getPublishedItem,
  listOwnedPublishedItems: vi.fn(),
  listPublishedItems: services.listPublishedItems,
}));
vi.mock("@/lib/library", () => ({
  loadLibraryTree: services.loadLibraryTree,
}));
vi.mock("@/lib/public-catalog", () => ({
  getPublicCatalogItem: services.getPublicCatalogItem,
  listPublicCatalogItems: services.listPublicCatalogItems,
}));

const originalEnvironment = { ...process.env };
const localItem = { id: "local:project:reference:characters:hero", title: "Hero" };
const canonicalItem = {
  id: "8ddf588e-090c-48ff-9cc9-27d73d914fe2",
  kind: "character",
  title: "Aria Solaris",
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...originalEnvironment };
  services.ensureCurrentAppUser.mockResolvedValue(null);
  services.getLocalCatalogItem.mockResolvedValue(null);
  services.getPublishedItem.mockResolvedValue(null);
  services.getPublicCatalogItem.mockResolvedValue(canonicalItem);
  services.listLocalCatalogItems.mockResolvedValue([localItem]);
  services.listLocalLibraryUploads.mockResolvedValue([{ id: "local:library:example", title: "Uploaded audio" }]);
  services.listPublishedItems.mockResolvedValue([]);
  services.listPublicCatalogItems.mockResolvedValue([canonicalItem]);
  services.loadLibraryTree.mockResolvedValue({ folders: [], items: [], placements: [] });
});

describe("catalog mode routes", () => {
  it("keeps canonical and local Explore inventories separate in local mode", async () => {
    process.env.APP_MODE = "local";
    const { GET } = await import("@/app/api/explore/references/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      availability: "online",
      items: [canonicalItem],
      localItems: [localItem],
    });
    expect(services.listLocalCatalogItems).toHaveBeenCalledWith({
      includeReferences: true,
      includeVideos: false,
    });
    expect(services.ensureCurrentAppUser).not.toHaveBeenCalled();
    expect(services.listPublishedItems).not.toHaveBeenCalled();
    expect(services.listPublicCatalogItems).toHaveBeenCalledWith("/api/explore/references");
  });

  it("keeps public cloud Explore readable without authentication", async () => {
    delete process.env.APP_MODE;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://catalog.invalid";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
    services.listPublishedItems.mockResolvedValueOnce([localItem]);
    const { GET } = await import("@/app/api/explore/references/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.availability).toBe("online");
    expect(body.items).toContainEqual(localItem);
    expect(services.ensureCurrentAppUser).toHaveBeenCalledOnce();
    expect(services.listPublishedItems).toHaveBeenCalledTimes(5);
  });

  it("returns an explicit unavailable response when cloud catalog configuration is absent", async () => {
    delete process.env.APP_MODE;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { GET } = await import("@/app/api/explore/references/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ availability: "unavailable", items: [] });
    expect(services.ensureCurrentAppUser).not.toHaveBeenCalled();
    expect(services.listPublishedItems).not.toHaveBeenCalled();
  });

  it("combines local uploads and project assets without cloud credentials", async () => {
    process.env.APP_MODE = "local";
    const { GET } = await import("@/app/api/library/tree/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      availability: "online",
      folders: [],
      items: [],
      localItems: [{ id: "local:library:example", title: "Uploaded audio" }, localItem],
      placements: [],
    });
    expect(services.ensureCurrentAppUser).not.toHaveBeenCalled();
    expect(services.loadLibraryTree).not.toHaveBeenCalled();
  });

  it("keeps local assets visible while reporting the canonical catalog offline", async () => {
    process.env.APP_MODE = "local";
    services.listPublicCatalogItems.mockRejectedValueOnce(new Error("offline"));
    const { GET } = await import("@/app/api/explore/references/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      availability: "unavailable",
      items: [],
      localItems: [localItem],
    });
    expect(body.error).toMatch(/canonical Explore catalog is unavailable/i);
  });

  it("renders a local Explore detail without entering hosted auth or catalog paths", async () => {
    process.env.APP_MODE = "local";
    services.getLocalCatalogItem.mockResolvedValueOnce({
      ...localItem,
      description: "A local character.",
      files: [],
      isLiked: false,
      kind: "character",
      likeCount: 0,
      media: [],
      metadata: { local: true, projectName: "Local project" },
      publisher: null,
      tags: ["local"],
      useCount: 0,
    });
    const { default: PublishedItemDetailPage } = await import(
      "@/app/(shell)/explore/[id]/page"
    );

    await expect(
      PublishedItemDetailPage({
        params: Promise.resolve({ id: encodeURIComponent(localItem.id) }),
      }),
    ).resolves.toBeTruthy();
    expect(services.getLocalCatalogItem).toHaveBeenCalledWith(localItem.id);
    expect(services.ensureCurrentAppUser).not.toHaveBeenCalled();
    expect(services.getPublishedItem).not.toHaveBeenCalled();
  });

  it("loads canonical stable IDs through the public application endpoint in local mode", async () => {
    process.env.APP_MODE = "local";
    const { GET } = await import("@/app/api/published-items/[id]/route");
    const response = await GET(
      new Request(`http://localhost/api/published-items/${canonicalItem.id}`),
      { params: Promise.resolve({ id: canonicalItem.id }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(canonicalItem);
    expect(services.getPublicCatalogItem).toHaveBeenCalledWith(canonicalItem.id);
    expect(services.getPublishedItem).not.toHaveBeenCalled();
  });

  it("auth-gates cloud-private Library instead of returning a false empty state", async () => {
    delete process.env.APP_MODE;
    const { GET } = await import("@/app/api/library/tree/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.availability).toBe("auth-required");
    expect(body.error).toMatch(/sign in/i);
    expect(services.loadLibraryTree).not.toHaveBeenCalled();
  });
});
