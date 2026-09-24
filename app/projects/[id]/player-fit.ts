"use client";

import { useEffect, useState, type CSSProperties, type RefObject } from "react";

export function useContainedPlayerRect(
  containerRef: RefObject<HTMLElement | null>,
  aspectRatio: number,
): CSSProperties {
  const [size, setSize] = useState<{ height: number; width: number } | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !Number.isFinite(aspectRatio) || aspectRatio <= 0) return;

    const update = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const frameRatio = rect.width / rect.height;
      const next =
        frameRatio > aspectRatio
          ? { width: rect.height * aspectRatio, height: rect.height }
          : { width: rect.width, height: rect.width / aspectRatio };

      setSize((current) => {
        const width = Math.round(next.width);
        const height = Math.round(next.height);
        if (current?.width === width && current.height === height) return current;
        return { width, height };
      });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [aspectRatio, containerRef]);

  return {
    aspectRatio,
    height: size ? `${size.height}px` : "100%",
    width: size ? `${size.width}px` : "100%",
  };
}
