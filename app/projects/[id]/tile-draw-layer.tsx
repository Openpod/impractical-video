"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type DrawOverAnnotation =
  | {
      type: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      timestampSeconds: number;
    }
  | {
      type: "freehand";
      points: Array<{ x: number; y: number }>;
      timestampSeconds: number;
    };

export type DrawOverRegenerateRequest = {
  media: {
    kind: "image" | "video";
    src: string;
    sourceId?: string;
    sourcePath?: string;
    title: string;
  };
  frame: {
    fps: number | null;
    frameIndex: number | null;
    naturalHeight: number;
    naturalWidth: number;
    timestampSeconds: number;
  };
  annotations: DrawOverAnnotation[];
  instruction: string;
};

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function TileDrawLayer({
  marks,
  onAddMark,
  timestampSeconds,
  tool,
}: {
  marks: DrawOverAnnotation[];
  onAddMark: (mark: DrawOverAnnotation) => void;
  timestampSeconds: number;
  tool: "rect" | "freehand";
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [draft, setDraft] = useState<DrawOverAnnotation | null>(null);
  const [size, setSize] = useState({ height: 0, width: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      setSize({ height: rect.height, width: rect.width });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    measure();
    return () => observer.disconnect();
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const accent =
      getComputedStyle(canvas).getPropertyValue("--accent").trim() || "#ed1d24";
    ctx.lineWidth = Math.max(2, canvas.width / 320);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;
    for (const mark of draft ? [...marks, draft] : marks) {
      if (mark.type === "rect") {
        const x = mark.x * canvas.width;
        const y = mark.y * canvas.height;
        const width = mark.width * canvas.width;
        const height = mark.height * canvas.height;
        ctx.globalAlpha = 0.14;
        ctx.fillRect(x, y, width, height);
        ctx.globalAlpha = 1;
        ctx.strokeRect(x, y, width, height);
      } else {
        ctx.beginPath();
        mark.points.forEach((point, index) => {
          const x = point.x * canvas.width;
          const y = point.y * canvas.height;
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
    }
  }, [draft, marks]);

  useEffect(() => {
    draw();
  }, [draw, size]);

  function normalizedPoint(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - rect.left) / Math.max(1, rect.width)),
      y: clamp01((event.clientY - rect.top) / Math.max(1, rect.height)),
    };
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = normalizedPoint(event);
    setDraft(
      tool === "rect"
        ? {
            type: "rect",
            x: point.x,
            y: point.y,
            width: 0,
            height: 0,
            timestampSeconds,
          }
        : { type: "freehand", points: [point], timestampSeconds },
    );
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!draft) return;
    const point = normalizedPoint(event);
    setDraft((current) => {
      if (!current) return current;
      if (current.type === "rect") {
        return {
          ...current,
          width: point.x - current.x,
          height: point.y - current.y,
        };
      }
      return { ...current, points: [...current.points, point] };
    });
  }

  function finishDraft() {
    if (!draft) return;
    let nextMark: DrawOverAnnotation | null = null;
    if (draft.type === "rect") {
      const x = draft.width < 0 ? draft.x + draft.width : draft.x;
      const y = draft.height < 0 ? draft.y + draft.height : draft.y;
      const normalized = {
        ...draft,
        x: clamp01(x),
        y: clamp01(y),
        width: Math.abs(draft.width),
        height: Math.abs(draft.height),
      };
      if (normalized.width > 0.01 && normalized.height > 0.01) {
        nextMark = normalized;
      }
    } else if (draft.points.length > 1) {
      nextMark = draft;
    }
    setDraft(null);
    if (nextMark) onAddMark(nextMark);
  }

  return (
    <canvas
      ref={canvasRef}
      className="canvas-tile-draw-layer"
      aria-label="Draw on tile"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerCancel={finishDraft}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDraft}
    />
  );
}
