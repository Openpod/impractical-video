"use client";

import { Scissors } from "lucide-react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

export function TrimTimeline({
  className = "",
  currentSeconds,
  duration,
  endSeconds,
  frames,
  hiddenSegmentIndexes = [],
  onEndPointerDown,
  onPointerDown,
  onPlayheadPointerDown,
  onRailContextMenu,
  onSegmentContextMenu,
  onSplitContextMenu,
  onSplitPointerDown,
  onStartPointerDown,
  playheadLabel = "Scrub trim preview",
  showTrimHandles = true,
  splitSeconds = [],
  startSeconds,
}: {
  className?: string;
  currentSeconds: number;
  duration: number;
  endSeconds: number;
  frames: string[];
  hiddenSegmentIndexes?: number[];
  onEndPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPlayheadPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onRailContextMenu?: (event: ReactMouseEvent<HTMLDivElement>, seconds: number) => void;
  onSegmentContextMenu?: (
    event: ReactMouseEvent<HTMLButtonElement>,
    segment: { endSeconds: number; index: number; seconds: number; startSeconds: number },
  ) => void;
  onSplitContextMenu?: (
    event: ReactMouseEvent<HTMLButtonElement>,
    index: number,
    seconds: number,
  ) => void;
  onSplitPointerDown?: (index: number, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onStartPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  playheadLabel?: string;
  showTrimHandles?: boolean;
  splitSeconds?: number[];
  startSeconds: number;
}) {
  const safeDuration = Math.max(0.01, duration);
  const clampedCurrent = Math.max(startSeconds, Math.min(endSeconds, currentSeconds));
  const splits = splitSeconds
    .filter((seconds) => seconds > startSeconds + 0.04 && seconds < endSeconds - 0.04)
    .sort((a, b) => a - b);
  const segmentEdges = [startSeconds, ...splits, endSeconds];

  return (
    <div className={`canvas-trim-editor ${className}`} onPointerDown={onPointerDown}>
      <div className="canvas-trim-time-row">
        <span>{startSeconds.toFixed(1)}s</span>
        <span>{endSeconds.toFixed(1)}s</span>
      </div>
      <div
        className="canvas-trim-rail"
        onContextMenu={(event) => {
          if (!onRailContextMenu) return;
          const target = event.target;
          if (
            target instanceof HTMLElement &&
            target.closest(".canvas-trim-split-marker, .canvas-trim-split-segment")
          ) {
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
          onRailContextMenu(event, ratio * safeDuration);
        }}
      >
        <div className="canvas-trim-frames" aria-hidden="true">
          {frames.map((frame, index) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={`trim-frame-${index}-${frame}`} src={frame} alt="" draggable={false} />
          ))}
        </div>
        <div
          className="canvas-trim-mask left"
          style={{ width: `${(startSeconds / safeDuration) * 100}%` }}
        />
        <div
          className="canvas-trim-mask right"
          style={{ left: `${(endSeconds / safeDuration) * 100}%` }}
        />
        <div
          className="canvas-trim-selected"
          style={{
            left: `${(startSeconds / safeDuration) * 100}%`,
            right: `${100 - (endSeconds / safeDuration) * 100}%`,
          }}
        />
        {splits.length ? (
          <div className="canvas-trim-split-segments">
            {segmentEdges.slice(0, -1).map((start, index) => {
              const end = segmentEdges[index + 1] ?? endSeconds;
              const hidden = hiddenSegmentIndexes.includes(index);
              return (
                <button
                  key={`trim-segment-${index}-${start}-${end}`}
                  className={`canvas-trim-split-segment ${hidden ? "is-hidden" : ""}`}
                  type="button"
                  aria-label={`${hidden ? "Hidden " : ""}Segment ${index + 1}`}
                  style={{
                    left: `${(start / safeDuration) * 100}%`,
                    width: `${((end - start) / safeDuration) * 100}%`,
                  }}
                  onContextMenu={(event) => {
                    if (!onSegmentContextMenu) return;
                    const rail = event.currentTarget.closest<HTMLElement>(".canvas-trim-rail");
                    const rect = rail?.getBoundingClientRect();
                    const ratio = rect
                      ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
                      : 0;
                    onSegmentContextMenu(event, {
                      endSeconds: end,
                      index,
                      seconds: ratio * safeDuration,
                      startSeconds: start,
                    });
                  }}
                />
              );
            })}
          </div>
        ) : null}
        {splits.map((seconds, index) => (
          <button
            key={`trim-split-${index}-${seconds}`}
            className="canvas-trim-split-marker"
            type="button"
            aria-label={`Split at ${seconds.toFixed(1)} seconds`}
            style={{ left: `${(seconds / safeDuration) * 100}%` }}
            onContextMenu={(event) => {
              if (!onSplitContextMenu) return;
              onSplitContextMenu(event, index, seconds);
            }}
            onPointerDown={(event) => onSplitPointerDown?.(index, event)}
          >
            <Scissors size={13} />
          </button>
        ))}
        <button
          className="canvas-trim-playhead"
          type="button"
          aria-label={playheadLabel}
          style={{ left: `${(clampedCurrent / safeDuration) * 100}%` }}
          onPointerDown={onPlayheadPointerDown}
        />
        {showTrimHandles ? (
          <>
            <button
              className="canvas-trim-handle start"
              type="button"
              aria-label="Trim start"
              style={{ left: `${(startSeconds / safeDuration) * 100}%` }}
              onPointerDown={onStartPointerDown}
            />
            <button
              className="canvas-trim-handle end"
              type="button"
              aria-label="Trim end"
              style={{ left: `${(endSeconds / safeDuration) * 100}%` }}
              onPointerDown={onEndPointerDown}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
