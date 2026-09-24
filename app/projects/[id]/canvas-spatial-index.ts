export type CanvasPoint = { x: number; y: number };

export type CanvasSpatialBox = CanvasPoint & {
  height: number;
  id: string;
  width: number;
};

export type CanvasSpatialRect = CanvasPoint & {
  height: number;
  width: number;
};

function intersects(left: CanvasSpatialRect, right: CanvasSpatialRect) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

export class CanvasSpatialIndex {
  readonly boxes = new Map<string, CanvasSpatialBox>();
  private readonly cells = new Map<string, Set<string>>();

  constructor(
    boxes: CanvasSpatialBox[] = [],
    private readonly cellSize = 480,
  ) {
    for (const box of boxes) this.upsert(box);
  }

  private cellKeys(rect: CanvasSpatialRect) {
    const startX = Math.floor(rect.x / this.cellSize);
    const endX = Math.floor((rect.x + Math.max(0, rect.width)) / this.cellSize);
    const startY = Math.floor(rect.y / this.cellSize);
    const endY = Math.floor((rect.y + Math.max(0, rect.height)) / this.cellSize);
    const keys: string[] = [];
    for (let x = startX; x <= endX; x += 1) {
      for (let y = startY; y <= endY; y += 1) keys.push(`${x}:${y}`);
    }
    return keys;
  }

  remove(id: string) {
    const box = this.boxes.get(id);
    if (!box) return;
    for (const key of this.cellKeys(box)) {
      const cell = this.cells.get(key);
      cell?.delete(id);
      if (!cell?.size) this.cells.delete(key);
    }
    this.boxes.delete(id);
  }

  upsert(box: CanvasSpatialBox) {
    this.remove(box.id);
    this.boxes.set(box.id, box);
    for (const key of this.cellKeys(box)) {
      const cell = this.cells.get(key) ?? new Set<string>();
      cell.add(box.id);
      this.cells.set(key, cell);
    }
  }

  query(rect: CanvasSpatialRect, excludedIds: ReadonlySet<string> = new Set()) {
    const ids = new Set<string>();
    for (const key of this.cellKeys(rect)) {
      for (const id of this.cells.get(key) ?? []) {
        if (!excludedIds.has(id)) ids.add(id);
      }
    }
    return [...ids]
      .map((id) => this.boxes.get(id))
      .filter((box): box is CanvasSpatialBox => Boolean(box && intersects(rect, box)));
  }
}

export function canvasWorldViewport({
  height,
  overscan = 240,
  pan,
  scale,
  width,
}: {
  height: number;
  overscan?: number;
  pan: CanvasPoint;
  scale: number;
  width: number;
}): CanvasSpatialRect {
  const safeScale = Math.max(0.01, scale);
  const worldOverscan = overscan / safeScale;
  return {
    height: height / safeScale + worldOverscan * 2,
    width: width / safeScale + worldOverscan * 2,
    x: -pan.x / safeScale - worldOverscan,
    y: -pan.y / safeScale - worldOverscan,
  };
}

export function findCollisionFreePoint({
  desired,
  height,
  id,
  index,
  gap = 48,
  width,
}: {
  desired: CanvasPoint;
  height: number;
  id: string;
  index: CanvasSpatialIndex;
  gap?: number;
  width: number;
}) {
  let point = { ...desired };
  for (let guard = 0; guard < 96; guard += 1) {
    const queryRect = {
      height: height + gap * 2,
      width: width + gap * 2,
      x: point.x - gap,
      y: point.y - gap,
    };
    const collisions = index.query(queryRect, new Set([id]));
    if (!collisions.length) return point;
    const bottom = Math.max(...collisions.map((box) => box.y + box.height));
    point = { x: point.x, y: bottom + gap };
  }
  return point;
}

export function resolveCollisionFreePlacement({
  boxes,
  movingIds,
  proposed,
  gap = 48,
}: {
  boxes: CanvasSpatialBox[];
  movingIds: string[];
  proposed: Record<string, CanvasPoint>;
  gap?: number;
}) {
  const moving = new Set(movingIds);
  const index = new CanvasSpatialIndex(boxes.filter((box) => !moving.has(box.id)));
  const next: Record<string, CanvasPoint> = {};
  const ordered = movingIds
    .map((id) => boxes.find((box) => box.id === id))
    .filter((box): box is CanvasSpatialBox => Boolean(box));
  if (!ordered.length) return next;
  const proposedBoxes = ordered.map((box) => ({
    ...box,
    x: proposed[box.id]?.x ?? box.x,
    y: proposed[box.id]?.y ?? box.y,
  }));
  const left = Math.min(...proposedBoxes.map((box) => box.x));
  const top = Math.min(...proposedBoxes.map((box) => box.y));
  const right = Math.max(...proposedBoxes.map((box) => box.x + box.width));
  const bottom = Math.max(...proposedBoxes.map((box) => box.y + box.height));
  const groupBox = {
    height: bottom - top,
    width: right - left,
    x: left,
    y: top,
  };
  const resolved = findCollisionFreePoint({
    desired: groupBox,
    gap,
    height: groupBox.height,
    id: "__moving_group__",
    index,
    width: groupBox.width,
  });
  const offset = { x: resolved.x - left, y: resolved.y - top };
  for (const box of proposedBoxes) {
    next[box.id] = { x: box.x + offset.x, y: box.y + offset.y };
  }
  return next;
}

/**
 * Reconciles an arbitrary set of stored boxes against their current measured
 * dimensions. The stable top-left order prevents image metadata arriving in a
 * different order from reshuffling the entire Canvas.
 */
export function resolveAllCollisions(
  boxes: CanvasSpatialBox[],
  gap = 48,
): Record<string, CanvasPoint> {
  const ordered = boxes
    .slice()
    .sort((left, right) => left.y - right.y || left.x - right.x || left.id.localeCompare(right.id));
  const index = new CanvasSpatialIndex();
  const positions: Record<string, CanvasPoint> = {};
  for (const box of ordered) {
    const point = findCollisionFreePoint({
      desired: { x: box.x, y: box.y },
      gap,
      height: box.height,
      id: box.id,
      index,
      width: box.width,
    });
    positions[box.id] = point;
    index.upsert({ ...box, ...point });
  }
  return positions;
}

export function spatialRectsIntersect(
  left: CanvasSpatialRect,
  right: CanvasSpatialRect,
) {
  return intersects(left, right);
}
