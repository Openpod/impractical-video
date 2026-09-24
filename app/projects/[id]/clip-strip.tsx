"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SequenceClip } from "./sequence-player";

/**
 * Horizontal clip selector that keeps the ACTIVE clip centered. It runs both
 * directions, live:
 *  - playback drives it: when the playhead enters a new clip, that chip glides
 *    to the middle and the strip slides under it;
 *  - the user drives it: as the strip scrolls, the chip passing through the
 *    center is highlighted AND seeked in real time (the chip and scrubber
 *    roll along with the scroll); clicking a chip jumps to it.
 *
 * Two guards keep the directions from fighting:
 *  - `programmaticRef` marks scrolls WE initiate (centering a chip) so they
 *    don't loop back into selection;
 *  - `userScrollingRef` suppresses auto-centering while the human is actively
 *    scrolling, so live highlighting never yanks the strip out from under
 *    them. When they stop, the nearest chip eases to dead center.
 *
 * The highlight tracks an internal `selected` index, not the `activeIndex`
 * prop, because some players (WebCodecs) only update activeIndex from their
 * playback loop — driving it locally makes scroll/click feedback instant.
 */
export function ClipStrip({
  clips,
  activeIndex,
  onSelect,
}: {
  clips: Pick<SequenceClip, "id" | "title" | "placeholder" | "placeholderLabel">[];
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** True while WE animate a chip to center; suppresses scroll-select. */
  const programmaticRef = useRef(false);
  const programmaticTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True while the human is actively scrolling; suppresses auto-centering. */
  const userScrollingRef = useRef(false);
  /** Authoritative current index, read synchronously (state lags a render). */
  const lastIndexRef = useRef(activeIndex);

  const [selected, setSelected] = useState(activeIndex);
  const [prevActive, setPrevActive] = useState(activeIndex);

  // Playback (or any parent-driven change) wins: follow activeIndex when it
  // moves. Adjusting state during render (React's documented pattern) avoids a
  // cascading re-render from an effect.
  if (activeIndex !== prevActive) {
    setPrevActive(activeIndex);
    setSelected(activeIndex);
  }

  // Keep the synchronous index mirror in step with parent-driven changes
  // (ref-only, so it stays out of render).
  useEffect(() => {
    lastIndexRef.current = activeIndex;
  }, [activeIndex]);

  const centerChip = useCallback((index: number) => {
    const chip = chipRefs.current[index];
    if (!chip) return;
    programmaticRef.current = true;
    if (programmaticTimer.current) clearTimeout(programmaticTimer.current);
    chip.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    programmaticTimer.current = setTimeout(() => {
      programmaticRef.current = false;
    }, 500);
  }, []);

  // Ease the selected chip to dead center — but NOT while the user is dragging
  // (that would fight their scroll). So this fires for playback and clicks; the
  // settle handler centers after a user scroll stops.
  useEffect(() => {
    if (userScrollingRef.current) return;
    centerChip(selected);
  }, [centerChip, selected]);

  useEffect(
    () => () => {
      if (programmaticTimer.current) clearTimeout(programmaticTimer.current);
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  // Index of the chip whose center is nearest the container's center.
  const centeredIndex = useCallback(() => {
    const container = containerRef.current;
    if (!container) return lastIndexRef.current;
    const rect = container.getBoundingClientRect();
    const mid = rect.left + rect.width / 2;
    let best = lastIndexRef.current;
    let bestDist = Infinity;
    chipRefs.current.forEach((chip, index) => {
      if (!chip) return;
      const r = chip.getBoundingClientRect();
      const dist = Math.abs(r.left + r.width / 2 - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = index;
      }
    });
    return best;
  }, []);

  // Commit a selection: move the selected chip and seek the player. Deduped so a
  // burst of scroll events at the same chip only seeks once.
  const choose = useCallback(
    (index: number) => {
      if (lastIndexRef.current === index) return;
      lastIndexRef.current = index;
      setSelected(index);
      onSelect(index);
    },
    [onSelect],
  );

  // A real user gesture means the human is taking over.
  const yieldToUser = useCallback(() => {
    programmaticRef.current = false;
    if (programmaticTimer.current) clearTimeout(programmaticTimer.current);
    userScrollingRef.current = true;
  }, []);

  const handleScroll = useCallback(() => {
    if (programmaticRef.current) return; // our own centering scroll
    userScrollingRef.current = true;
    // Live: highlight + seek the chip passing through center as we scroll.
    choose(centeredIndex());
    // On settle, hand control back and ease the nearest chip to dead center.
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      userScrollingRef.current = false;
      const finalIndex = centeredIndex();
      choose(finalIndex);
      centerChip(finalIndex);
    }, 120);
  }, [centerChip, centeredIndex, choose]);

  if (!clips.length) return null;

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      onWheel={yieldToUser}
      onTouchStart={yieldToUser}
      onPointerDown={yieldToUser}
      className="clip-strip-scroll no-scrollbar flex items-center gap-2 overflow-x-auto py-1"
      style={{
        paddingInline: "50%",
        // Proximity (not mandatory) + no per-chip stop = a flick glides across
        // many chips like a spinning wheel and decelerates naturally; the JS
        // settle then eases the nearest one to dead center.
        scrollSnapType: "x proximity",
        overscrollBehaviorX: "contain",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {clips.map((clip, index) => {
        const active = index === selected;
        const generating = Boolean(clip.placeholder);
        return (
          <button
            key={`${clip.id}-${index}`}
            ref={(element) => {
              chipRefs.current[index] = element;
            }}
            onClick={() => {
              userScrollingRef.current = false;
              choose(index);
              centerChip(index);
            }}
            title={clip.title}
            style={{ scrollSnapAlign: "center" }}
            className={`shrink-0 whitespace-nowrap rounded-lg border px-3.5 py-2 text-xs transition-all duration-200 ${
              generating
                ? active
                  ? "scale-105 border-[rgba(237,29,36,0.42)] bg-[rgba(237,29,36,0.1)] font-semibold text-[#ed1d24] shadow-sm"
                  : "scale-95 border-[rgba(237,29,36,0.24)] bg-[rgba(237,29,36,0.06)] text-[#ed1d24] hover:border-[rgba(237,29,36,0.42)] hover:bg-[rgba(237,29,36,0.1)]"
                : active
                ? "scale-105 border-[var(--active)] bg-[var(--active)] font-semibold text-[var(--active-text)] shadow-none"
                : "scale-95 border-[var(--line)] bg-[var(--control-bg)] text-[var(--muted)] hover:border-[var(--line-strong)] hover:bg-[var(--control-hover)] hover:text-[var(--text)]"
            }`}
          >
            {clip.placeholder ? (
              <span className="clip-strip-generating">
                <Loader2 size={13} className="generating-clip-spinner" />
                {index + 1}. {clip.placeholderLabel ?? "Generating"}
              </span>
            ) : (
              <>
                {index + 1}. {clip.title}
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
