import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Canvas performance shell", () => {
  it("virtualizes media-heavy cards using a world-space spatial index", async () => {
    const source = await readFile(
      `${root}/app/projects/[id]/canvas-workspace.tsx`,
      "utf8",
    );

    expect(source).toContain("const CanvasGeometryShell = memo");
    expect(source).toContain("canvasWorldViewport");
    expect(source).toContain("cardSpatialIndex.query(visibleWorldRect)");
    expect(source).toContain('data-virtualized="true"');
    expect(source).toContain("if (!eagerCardIds.has(card.id))");
    expect(source).toContain("preload=\"metadata\"");
  });

  it("batches pan and drag state through animation frames and uses stable maps", async () => {
    const source = await readFile(
      `${root}/app/projects/[id]/canvas-workspace.tsx`,
      "utf8",
    );

    expect(source).toContain("const cardById = useMemo");
    expect(source).toContain("const groupById = useMemo");
    expect(source).toContain("const cardSpatialIndex = useMemo");
    expect(source).toContain("window.requestAnimationFrame(flushPointerMove)");
    expect(source).toContain("window.requestAnimationFrame(flushPan)");
    expect(source).toContain("dataset.canvasDragP95Ms");
  });

  it("keeps keyboard focus roving and secondary chrome inspection-scoped", async () => {
    const source = await readFile(
      `${root}/app/projects/[id]/canvas-workspace.tsx`,
      "utf8",
    );

    expect(source).toContain('role="listbox"');
    expect(source).toContain('role="option"');
    expect(source).toContain("tabIndex={selectedId === card.id ? 0 : -1}");
    expect(source).toContain("ArrowRight: [1, 0]");
    expect(source).toContain("{selected ? renderGenRefs(card) : null}");
  });

  it("uses compact token-based tiles and status indicators", async () => {
    const [source, styles] = await Promise.all([
      readFile(`${root}/app/projects/[id]/canvas-workspace.tsx`, "utf8"),
      readFile(`${root}/app/globals.css`, "utf8"),
    ]);

    expect(source).toContain("const CANVAS_CARD_WIDTH = 380");
    // Tile captions carry no status pills: state lives on the tile face and
    // the drawer, never as caption chips.
    expect(source).not.toContain('className="canvas-card-statuses"');
    expect(styles).toContain(".canvas-card-geometry-shell");
    expect(styles).not.toContain(".canvas-card-status.is-generating");
    expect(styles).toContain("max-height: 420px");
  });
});
