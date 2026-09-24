"use client";

import { memo, useId, useMemo } from "react";

function waveformPath(values: number[]) {
  const samples = values.length ? values : [0.18, 0.34, 0.22, 0.48, 0.3, 0.58, 0.24];
  const points = samples.map((value, index) => {
    const x = samples.length === 1 ? 50 : (index / (samples.length - 1)) * 100;
    const amplitude = Math.max(0.06, Math.min(1, value));
    return { amplitude, x };
  });
  const top = points
    .map(({ amplitude, x }) => `${x.toFixed(2)},${(50 - amplitude * 42).toFixed(2)}`)
    .join(" L");
  const bottom = [...points]
    .reverse()
    .map(({ amplitude, x }) => `${x.toFixed(2)},${(50 + amplitude * 42).toFixed(2)}`)
    .join(" L");
  return `M${top} L${bottom} Z`;
}

export const CanvasWaveform = memo(function CanvasWaveform({
  progress,
  values,
}: {
  progress: number;
  values?: number[];
}) {
  const path = useMemo(() => waveformPath(values ?? []), [values]);
  const width = Math.max(0, Math.min(100, progress * 100));
  const clipId = useId().replace(/:/g, "");
  return (
    <svg
      className="canvas-audio-wave"
      aria-hidden="true"
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
    >
      <path className="canvas-audio-wave-idle" d={path} />
      <clipPath id={clipId}>
        <rect className="canvas-audio-wave-progress" height="100" width={width} x="0" y="0" />
      </clipPath>
      <path
        className="canvas-audio-wave-played"
        clipPath={`url(#${clipId})`}
        d={path}
      />
    </svg>
  );
});
