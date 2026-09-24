import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const roots: string[] = [];

afterEach(async () => {
  delete process.env.APP_MODE;
  delete process.env.VIDEO_FS_DATA_ROOT;
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("local catalog filesystem adapter", () => {
  it("discovers reference portfolios and timeline videos with durable local details", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-fs-catalog-"));
    roots.push(root);
    const projectRoot = path.join(root, "demo");
    await mkdir(path.join(projectRoot, "references", "characters", "char_hero"), { recursive: true });
    await mkdir(path.join(projectRoot, "media", "characters"), { recursive: true });
    await mkdir(path.join(projectRoot, "media", "clips"), { recursive: true });
    await writeFile(
      path.join(projectRoot, "project.json"),
      JSON.stringify({
        createdAt: "2026-01-01T00:00:00.000Z",
        id: "demo",
        name: "Demo",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    await writeFile(
      path.join(projectRoot, "references", "characters", "char_hero", "reference.md"),
      `---\n{"id":"char_hero","type":"reference","category":"characters"}\n---\nHero: A steadfast explorer.`,
    );
    await writeFile(
      path.join(projectRoot, "references", "characters", "char_hero", "portfolio.md"),
      `---\n{"id":"hero_portfolio","type":"portfolio","reference_id":"char_hero","local_path":"media/characters/hero.png"}\n---\nHero portfolio`,
    );
    await writeFile(
      path.join(projectRoot, "timeline.json"),
      JSON.stringify([{
        id: "timeline_clip",
        kind: "video",
        local_path: "media/clips/arrival.mp4",
        title: "Arrival",
      }]),
    );
    await writeFile(path.join(projectRoot, "media", "characters", "hero.png"), "image");
    await writeFile(path.join(projectRoot, "media", "clips", "arrival.mp4"), "video");
    process.env.APP_MODE = "local";
    process.env.VIDEO_FS_DATA_ROOT = root;
    vi.resetModules();

    const { getLocalCatalogItem, listLocalCatalogItems } = await import("@/lib/local-catalog");
    const items = await listLocalCatalogItems();
    const hero = items.find((item) => item.title === "Hero");
    const video = items.find((item) => item.title === "Arrival");

    expect(hero).toMatchObject({
      kind: "character",
      posterUrl: "/api/projects/demo/media/characters/hero.png",
      sourceProjectId: "demo",
    });
    expect(video).toMatchObject({
      kind: "video",
      previewVideoUrl: "/api/projects/demo/media/clips/arrival.mp4",
    });
    await expect(getLocalCatalogItem(hero?.id ?? "")).resolves.toMatchObject({
      files: expect.arrayContaining([
        expect.objectContaining({ path: "references/characters/char_hero/reference.md" }),
      ]),
      metadata: expect.objectContaining({ local: true, projectId: "demo" }),
    });
  });
});
