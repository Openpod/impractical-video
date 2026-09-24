import { describe, expect, it } from "vitest";
import {
  CanvasSpatialIndex,
  canvasWorldViewport,
  resolveAllCollisions,
  resolveCollisionFreePlacement,
  spatialRectsIntersect,
} from "@/app/projects/[id]/canvas-spatial-index";

describe("CanvasSpatialIndex", () => {
  it("queries only boxes intersecting the world viewport", () => {
    const index = new CanvasSpatialIndex([
      { height: 200, id: "visible", width: 380, x: 40, y: 50 },
      { height: 200, id: "edge", width: 380, x: 1_100, y: 50 },
      { height: 200, id: "offscreen", width: 380, x: 4_000, y: 4_000 },
    ]);
    const viewport = canvasWorldViewport({
      height: 640,
      overscan: 240,
      pan: { x: 0, y: 0 },
      scale: 1,
      width: 960,
    });

    expect(index.query(viewport).map((box) => box.id).sort()).toEqual(["edge", "visible"]);
  });

  it("preserves multi-card geometry while resolving a colliding drop", () => {
    const boxes = [
      { height: 220, id: "fixed", width: 380, x: 0, y: 0 },
      { height: 220, id: "left", width: 380, x: 500, y: 0 },
      { height: 220, id: "right", width: 380, x: 930, y: 0 },
    ];
    const resolved = resolveCollisionFreePlacement({
      boxes,
      movingIds: ["left", "right"],
      proposed: {
        left: { x: 0, y: 0 },
        right: { x: 430, y: 0 },
      },
    });

    expect(resolved.right!.x - resolved.left!.x).toBe(430);
    expect(
      spatialRectsIntersect(
        { height: 220, width: 380, ...resolved.left! },
        boxes[0]!,
      ),
    ).toBe(false);
  });

  it("keeps 250-card collision queries comfortably below a frame budget", () => {
    const boxes = Array.from({ length: 250 }, (_, index) => ({
      height: 220,
      id: `card-${index}`,
      width: 380,
      x: (index % 10) * 430,
      y: Math.floor(index / 10) * 270,
    }));
    const index = new CanvasSpatialIndex(boxes);
    const started = performance.now();
    for (let sample = 0; sample < 1_000; sample += 1) {
      index.query({ height: 640, width: 960, x: sample % 100, y: sample % 150 });
    }
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(100);
  });

  it("lays out 250 mixed shell sizes with no intersections greater than one pixel", () => {
    const boxes = Array.from({ length: 250 }, (_, index) => ({
      height: index % 9 === 0 ? 452 : index % 5 === 0 ? 412 : index % 4 === 0 ? 260 : 246,
      id: `tile-${index}`,
      width: index % 7 === 0 ? 420 : index % 3 === 0 ? 340 : 380,
      x: (index % 3) * 432,
      y: Math.floor(index / 3) * 320,
    }));
    const resolved = resolveAllCollisions(boxes, 28);
    const positioned = boxes.map((box) => ({ ...box, ...resolved[box.id]! }));

    for (let leftIndex = 0; leftIndex < positioned.length; leftIndex += 1) {
      const left = positioned[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < positioned.length; rightIndex += 1) {
        const right = positioned[rightIndex]!;
        const overlapWidth =
          Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
        const overlapHeight =
          Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
        expect(overlapWidth > 1 && overlapHeight > 1).toBe(false);
      }
    }
  });
});
