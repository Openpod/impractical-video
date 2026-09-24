"use client";

import { ArrowUp, ChevronLeft, ChevronRight, FileText, Loader2, PencilLine, Plus, Video, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";

export type StoryboardPromptAttachment = {
  id: string;
  label: string;
  src: string | null;
  kind: "keyframe" | "reference";
};

export type StoryboardPromptDraft = {
  id: string;
  sourceId: string;
  subject: "keyframe" | "clip" | "reference";
  title: string;
  status: string;
  duration?: number | null;
  aspectRatio?: string | null;
  kind: "final" | "planned";
  summary: string;
  text: string;
  canCopy: boolean;
  sourcePath: string;
  attachments: StoryboardPromptAttachment[];
};

export type StoryboardMediaVersion = {
  id: string;
  src: string | null;
  label: string;
  isCurrent: boolean;
  /** Exact project-relative media file used for byte-identity resolution. */
  path?: string | null;
  /** Durable artifact revision represented by this historical render. */
  revision?: number | null;
};

export type StoryboardFrame = {
  aspectRatio?: string | null;
  id: string;
  title: string;
  status: string;
  src: string | null;
  path: string;
  prompt: StoryboardPromptDraft;
  /** True while the agent is generating this frame (gray shimmer card). */
  generating?: boolean;
  /** Browse-only render history; arrows appear only when more than one exists. */
  versions?: StoryboardMediaVersion[];
};

export type StoryboardClipPrompt = StoryboardPromptDraft & {
  clipId: string;
};

export type StoryboardItem =
  | { kind: "frame"; frame: StoryboardFrame }
  | {
      kind: "motion";
      label: string;
      src?: string | null;
      prompt?: StoryboardClipPrompt;
      /** Browse-only render history; arrows appear only when more than one exists. */
      versions?: StoryboardMediaVersion[];
    }
  | { kind: "cut"; label: string };

const CARD_WIDTH = 330;
/** Matches the maximum focus scale below; slots reserve this footprint so a
 * scaled card fills its own slot instead of covering adjacent connectors. */
const MAX_SCALE = 1.15;
const SLOT_WIDTH = Math.ceil(CARD_WIDTH * MAX_SCALE);

function cssAspectRatio(value: string | null | undefined) {
  if (value === "9:16") return "9 / 16";
  if (value === "1:1") return "1 / 1";
  return "16 / 9";
}

function seekVideoTileToMiddle(video: HTMLVideoElement) {
  if (!Number.isFinite(video.duration) || video.duration <= 0) return;
  const target = Math.min(video.duration * 0.5, Math.max(0, video.duration - 0.08));
  if (Math.abs(video.currentTime - target) < 0.05) return;
  try {
    video.currentTime = target;
  } catch {
    // Some browsers reject seeks until more data is buffered; keep the first
    // frame rather than failing the storyboard render.
  }
}

function isFocusableItem(
  item: StoryboardItem,
): item is
  | Extract<StoryboardItem, { kind: "frame" }>
  | (Extract<StoryboardItem, { kind: "motion" }> & { prompt: StoryboardClipPrompt }) {
  return item.kind === "frame" || (item.kind === "motion" && Boolean(item.prompt));
}

/** Pair each item with its focus ordinal (frames and clip prompts only). */
function withFocusOrdinals(items: StoryboardItem[]) {
  let next = 0;
  return items.map((item) => ({
    item,
    ordinal: isFocusableItem(item) ? next++ : -1,
  }));
}

function currentVersionIndex(versions: StoryboardMediaVersion[]) {
  const active = versions.findIndex((version) => version.isCurrent);
  return active >= 0 ? active : Math.max(0, versions.length - 1);
}

function VersionStrip({
  versions,
  index,
  onStep,
}: {
  versions: StoryboardMediaVersion[];
  index: number;
  onStep: (next: number) => void;
}) {
  if (versions.length <= 1) return null;
  return (
    <div
      className="storyboard-version-strip"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="storyboard-version-arrow"
        disabled={index <= 0}
        aria-label="Previous version"
        title="Previous version"
        onClick={(event) => {
          event.stopPropagation();
          onStep(index - 1);
        }}
      >
        <ChevronLeft size={15} />
      </button>
      <button
        type="button"
        className="storyboard-version-arrow"
        disabled={index >= versions.length - 1}
        aria-label="Next version"
        title="Next version"
        onClick={(event) => {
          event.stopPropagation();
          onStep(index + 1);
        }}
      >
        <ChevronRight size={15} />
      </button>
    </div>
  );
}

/**
 * Horizontal storyboard in FILM order: keyframes as cards, the gaps between
 * them carrying the edit — a quiet arrow where a clip's motion flows through
 * (continuous chains read as uninterrupted arrows through shared frames), a
 * slash chip where a cut lands. Scroll-snaps to center; the centered card
 * scales up. Clicking a side card centers it; clicking the centered card
 * opens its source file.
 */
export function StoryboardStrip({
  focusRequest,
  isSending = false,
  items,
  onOpenFile,
  onSavePrompt,
}: {
  focusRequest?: { id: string; kind: "clip" | "keyframe"; nonce: number } | null;
  isSending?: boolean;
  items: StoryboardItem[];
  onOpenFile: (path: string) => void;
  onSavePrompt?: (prompt: StoryboardPromptDraft, text: string) => Promise<void>;
}) {
  const frames = items.filter(
    (item): item is Extract<StoryboardItem, { kind: "frame" }> =>
      item.kind === "frame",
  );
  const sequencedItems = withFocusOrdinals(items);
  const focusableItems = sequencedItems.filter(
    (
      entry,
    ): entry is {
      item:
        | Extract<StoryboardItem, { kind: "frame" }>
        | (Extract<StoryboardItem, { kind: "motion" }> & { prompt: StoryboardClipPrompt });
      ordinal: number;
    } => entry.ordinal >= 0 && isFocusableItem(entry.item),
  );
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const slotRefs = useRef<(HTMLDivElement | null)[]>([]);
  const rafRef = useRef(0);
  const [centeredIndex, setCenteredIndex] = useState(0);
  const [versionSelection, setVersionSelection] = useState<Record<string, number>>({});
  const [promptDraft, setPromptDraft] = useState({ id: "", text: "" });
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [localAttachments, setLocalAttachments] = useState<
    { id: string; label: string; src: string | null; fileKind: "image" | "file"; fileType: string }[]
  >([]);
  const [expandedMedia, setExpandedMedia] = useState<{
    kind: "image" | "video";
    src: string;
    title: string;
  } | null>(null);
  const [expandedMediaClosing, setExpandedMediaClosing] = useState(false);
  const expandedMediaCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dismissedAttachments, setDismissedAttachments] = useState<{
    ids: Set<string>;
    promptId: string;
  }>(() => ({ ids: new Set(), promptId: "" }));
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const selectedItem = focusableItems[centeredIndex]?.item ?? focusableItems[0]?.item ?? null;
  const selectedPrompt =
    selectedItem?.kind === "frame"
      ? selectedItem.frame.prompt
      : selectedItem?.kind === "motion"
        ? selectedItem.prompt
        : null;
  const draftText =
    selectedPrompt && promptDraft.id === selectedPrompt.id
      ? promptDraft.text
      : selectedPrompt?.text ?? "";
  // Drag-to-pan with momentum. We manage snapping ourselves (CSS scroll-snap
  // is off) so a release glides — projecting the throw and easing to the
  // nearest frame — instead of flicking instantly to a snap point.
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startScroll: number;
    moved: boolean;
    lastT: number;
    lastScroll: number;
    velocity: number; // px per ms
  }>({ active: false, startX: 0, startScroll: 0, moved: false, lastT: 0, lastScroll: 0, velocity: 0 });
  const suppressClickRef = useRef(false);
  const momentumRef = useRef(0);
  const wheelTimerRef = useRef(0);

  const DRAG_THRESHOLD = 6;
  /** How far a release throw projects, in ms of the last velocity. Short so it
   * doesn't fling well past a frame and then crawl back. */
  const THROW_PROJECTION_MS = 110;

  function clampScroll(value: number) {
    const scroller = scrollerRef.current;
    if (!scroller) return value;
    return Math.max(0, Math.min(value, scroller.scrollWidth - scroller.clientWidth));
  }

  /** Scroll position at which slot `index` (or the nearest slot) is centered. */
  function slotCenterScroll(index: number): number | null {
    const scroller = scrollerRef.current;
    const slot = slotRefs.current[index];
    if (!scroller || !slot) return null;
    return slot.offsetLeft + slot.offsetWidth / 2 - scroller.clientWidth / 2;
  }

  function nearestSlotScroll(target: number): number {
    let best = target;
    let bestDist = Infinity;
    slotRefs.current.forEach((slot) => {
      const scroller = scrollerRef.current;
      if (!slot || !scroller) return;
      const center = slot.offsetLeft + slot.offsetWidth / 2 - scroller.clientWidth / 2;
      const dist = Math.abs(center - target);
      if (dist < bestDist) {
        bestDist = dist;
        best = center;
      }
    });
    return best;
  }

  function animateScrollTo(target: number, duration = 260) {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    cancelAnimationFrame(momentumRef.current);
    const start = scroller.scrollLeft;
    const end = clampScroll(target);
    if (Math.abs(end - start) < 0.5) return;
    // easeOutQuart arrives fast and decelerates late — feels immediate.
    const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);
    let startT = 0; // set on first frame, from rAF's own timestamp
    const step = (now: number) => {
      if (startT === 0) startT = now;
      const p = Math.min(1, (now - startT) / duration);
      scroller.scrollLeft = start + (end - start) * easeOutQuart(p);
      if (p < 1) momentumRef.current = requestAnimationFrame(step);
    };
    momentumRef.current = requestAnimationFrame(step);
  }

  /** Glide from a throw velocity, then settle on the frame it lands nearest. */
  function settleFromVelocity(velocity: number) {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const projected = scroller.scrollLeft + velocity * THROW_PROJECTION_MS;
    const target = nearestSlotScroll(projected);
    const distance = Math.abs(target - scroller.scrollLeft);
    // Quick settle: scales gently with distance but stays snappy, no crawl.
    animateScrollTo(target, Math.max(150, Math.min(340, distance * 0.7)));
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    cancelAnimationFrame(momentumRef.current);
    dragRef.current = {
      active: true,
      startX: event.clientX,
      startScroll: scroller.scrollLeft,
      moved: false,
      lastT: event.timeStamp,
      lastScroll: scroller.scrollLeft,
      velocity: 0,
    };
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const scroller = scrollerRef.current;
    if (!drag.active || !scroller) return;
    const dx = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) > DRAG_THRESHOLD) {
      drag.moved = true;
      scroller.setPointerCapture(event.pointerId);
      scroller.style.cursor = "grabbing";
    }
    if (!drag.moved) return;
    scroller.scrollLeft = clampScroll(drag.startScroll - dx);
    // Smoothed instantaneous velocity for the release throw.
    const dt = event.timeStamp - drag.lastT;
    if (dt > 0) {
      const v = (scroller.scrollLeft - drag.lastScroll) / dt;
      drag.velocity = drag.velocity * 0.7 + v * 0.3;
      drag.lastT = event.timeStamp;
      drag.lastScroll = scroller.scrollLeft;
    }
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const scroller = scrollerRef.current;
    if (!drag.active) return;
    drag.active = false;
    if (scroller) {
      scroller.style.cursor = "";
      if (scroller.hasPointerCapture?.(event.pointerId)) {
        scroller.releasePointerCapture(event.pointerId);
      }
    }
    suppressClickRef.current = drag.moved;
    if (drag.moved) settleFromVelocity(drag.velocity);
  }

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // Native, non-passive wheel: we must preventDefault, otherwise the browser
    // ALSO scrolls the container natively and we double-scroll (the "fighting"
    // feel). With default prevented, our controlled scroll is the only motion;
    // the settle is debounced until wheeling fully stops so it never yanks
    // mid-scroll.
    const onWheel = (event: WheelEvent) => {
      const delta =
        Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (delta === 0) return;
      event.preventDefault();
      cancelAnimationFrame(momentumRef.current);
      scroller.scrollLeft = clampScroll(scroller.scrollLeft + delta);
      window.clearTimeout(wheelTimerRef.current);
      wheelTimerRef.current = window.setTimeout(() => {
        animateScrollTo(nearestSlotScroll(scroller.scrollLeft), 200);
      }, 130);
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    const update = () => {
      // Single coordinate space: scroller content coords (offsetLeft is reliable
      // because the scroller is position:relative, so it is the offsetParent).
      const viewportCenter = scroller.scrollLeft + scroller.clientWidth / 2;
      let best = 0;
      let bestDistance = Infinity;
      slotRefs.current.forEach((slot, ordinal) => {
        const card = slot?.firstElementChild as HTMLElement | null;
        if (!slot || !card) {
          return;
        }
        const center = slot.offsetLeft + slot.offsetWidth / 2;
        const distance = Math.abs(center - viewportCenter);
        const t = Math.min(1, distance / (CARD_WIDTH * 1.1));
        const scale = MAX_SCALE - 0.28 * t;
        card.style.transform = `scale(${scale.toFixed(3)})`;
        card.style.opacity = String(1 - 0.45 * t);
        slot.style.zIndex = String(100 - Math.round(t * 100));
        if (distance < bestDistance) {
          bestDistance = distance;
          best = ordinal;
        }
      });

      setCenteredIndex((current) => (current === best ? current : best));
    };
    const onScroll = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onWheel);
      observer.disconnect();
      cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  function centerCard(index: number) {
    const target = slotCenterScroll(index);
    if (target !== null) animateScrollTo(target);
  }

  function resolveVersionIndex(key: string, versions: StoryboardMediaVersion[]) {
    const stored = versionSelection[key];
    if (typeof stored === "number" && stored >= 0 && stored < versions.length) return stored;
    return currentVersionIndex(versions);
  }

  function stepVersion(key: string, next: number, versions: StoryboardMediaVersion[]) {
    const clamped = Math.max(0, Math.min(next, versions.length - 1));
    setVersionSelection((current) => ({ ...current, [key]: clamped }));
  }

  async function savePrompt() {
    if (!selectedPrompt || !onSavePrompt || draftText.trim() === selectedPrompt.text.trim()) return;
    setSavingPrompt(true);
    try {
      await onSavePrompt(selectedPrompt, draftText);
    } finally {
      setSavingPrompt(false);
    }
  }

  function removeLocalAttachment(id: string) {
    setLocalAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.src) URL.revokeObjectURL(removed.src);
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  function removeAttachment(id: string) {
    if (localAttachments.some((attachment) => attachment.id === id)) {
      removeLocalAttachment(id);
      return;
    }
    const promptId = selectedPrompt?.id ?? "";
    setDismissedAttachments((current) => {
      const ids = current.promptId === promptId ? new Set(current.ids) : new Set<string>();
      ids.add(id);
      return { ids, promptId };
    });
  }

  const openExpandedMedia = useCallback((media: { kind: "image" | "video"; src: string; title: string }) => {
    if (expandedMediaCloseTimerRef.current) {
      clearTimeout(expandedMediaCloseTimerRef.current);
      expandedMediaCloseTimerRef.current = null;
    }
    setExpandedMediaClosing(false);
    setExpandedMedia(media);
  }, []);

  useEffect(() => {
    if (!focusRequest) return;
    const match = focusableItems.find(({ item }) => {
      if (focusRequest.kind === "keyframe") {
        return item.kind === "frame" && item.frame.id === focusRequest.id;
      }
      return item.kind === "motion" && item.prompt?.clipId === focusRequest.id;
    });
    if (!match) return;
    const frame = window.requestAnimationFrame(() => {
      setCenteredIndex(match.ordinal);
      centerCard(match.ordinal);
      const item = match.item;
      if (item.kind === "frame" && item.frame.src) {
        openExpandedMedia({ kind: "image", src: item.frame.src, title: item.frame.title });
      } else if (item.kind === "motion" && item.src && item.prompt) {
        openExpandedMedia({ kind: "video", src: item.src, title: item.prompt.title });
      }
    });
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce, focusRequest?.id, focusRequest?.kind, items, openExpandedMedia]);

  const closeExpandedMedia = useCallback(() => {
    if (!expandedMedia || expandedMediaClosing) return;
    setExpandedMediaClosing(true);
    if (expandedMediaCloseTimerRef.current) clearTimeout(expandedMediaCloseTimerRef.current);
    expandedMediaCloseTimerRef.current = setTimeout(() => {
      setExpandedMedia(null);
      setExpandedMediaClosing(false);
      expandedMediaCloseTimerRef.current = null;
    }, 180);
  }, [expandedMedia, expandedMediaClosing]);

  useEffect(
    () => () => {
      cancelAnimationFrame(momentumRef.current);
      window.clearTimeout(wheelTimerRef.current);
      if (expandedMediaCloseTimerRef.current) clearTimeout(expandedMediaCloseTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!expandedMedia) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeExpandedMedia();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeExpandedMedia, expandedMedia]);

  // When a new generation starts, bring its placeholder to center so the
  // frame visibly pops in where the viewer is looking.
  const previousGeneratingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const generatingNow = new Set(
      frames.filter((item) => item.frame.generating).map((item) => item.frame.id),
    );
    const newest = [...generatingNow].find(
      (id) => !previousGeneratingRef.current.has(id),
    );
    previousGeneratingRef.current = generatingNow;
    if (!newest) return;
    const index = sequencedItems.find(
      ({ item }) => item.kind === "frame" && item.frame.id === newest,
    )?.ordinal;
    if (typeof index === "number" && index >= 0) centerCard(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames.map((item) => `${item.frame.id}:${item.frame.generating ? 1 : 0}`).join("|")]);

  if (!frames.length) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm" style={{ color: "var(--muted)" }}>
        No keyframes yet — they appear here as the agent plans and generates them.
      </div>
    );
  }

  const promptChanged = selectedPrompt
    ? draftText.trim() !== selectedPrompt.text.trim()
    : false;
  const dismissedAttachmentIds =
    dismissedAttachments.promptId === selectedPrompt?.id
      ? dismissedAttachments.ids
      : new Set<string>();
  const attachments = [
    ...(selectedPrompt?.attachments ?? []).map((attachment) => ({
      ...attachment,
      fileKind: attachment.src ? "image" as const : "file" as const,
      fileType: "File",
    })),
    ...localAttachments.map((attachment) => ({
      ...attachment,
      kind: "reference" as const,
      removable: true,
    })),
  ].filter((attachment) => !dismissedAttachmentIds.has(attachment.id));

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* flex-1 so the horizontal scrollbar sits flush with the panel bottom. */}
      <div
        ref={scrollerRef}
        className="storyboard-scroller relative flex min-h-0 flex-1 items-center gap-2 overflow-x-auto overflow-y-hidden"
        style={{
          paddingInline: `calc(50% - ${SLOT_WIDTH / 2}px)`,
          scrollbarWidth: "thin",
          cursor: "grab",
          userSelect: "none",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {sequencedItems.map(({ item, ordinal }, itemIndex) => {
          if (item.kind === "motion") {
            const prompt = item.prompt;
            if (prompt) {
              const focused = ordinal === centeredIndex;
              const versions = item.versions ?? [];
              const versionKey = `clip:${prompt.clipId}`;
              const versionIndex = resolveVersionIndex(versionKey, versions);
              const displaySrc = versions.length
                ? versions[versionIndex]?.src ?? item.src ?? null
                : item.src ?? null;
              return (
                <div
                  key={`m-${itemIndex}`}
                  ref={(element) => {
                    slotRefs.current[ordinal] = element;
                  }}
                  className="flex shrink-0 cursor-pointer justify-center"
                  style={{ width: SLOT_WIDTH }}
                  onClick={() => {
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
                    if (!focused) {
                      centerCard(ordinal);
                      return;
                    }
                    if (displaySrc) {
                      openExpandedMedia({
                        kind: "video",
                        src: displaySrc,
                        title: prompt.title,
                      });
                    }
                  }}
                  title={`${prompt.title} — ${prompt.status}${focused && displaySrc ? " (click to expand)" : ""}`}
                >
                  <div className="storyboard-tile-shell" style={{ width: CARD_WIDTH }}>
                    <VersionStrip
                      versions={versions}
                      index={versionIndex}
                      onStep={(next) => stepVersion(versionKey, next, versions)}
                    />
                    <div
                      className={`storyboard-motion-card ${displaySrc ? "has-media" : ""} ${focused ? "focused" : ""}`}
                      style={{ aspectRatio: cssAspectRatio(prompt.aspectRatio) }}
                    >
                      {displaySrc ? (
                        <video
                          key={displaySrc}
                          className="storyboard-motion-video"
                          src={displaySrc}
                          muted
                          playsInline
                          preload="auto"
                          onLoadedMetadata={(event) => seekVideoTileToMiddle(event.currentTarget)}
                        />
                      ) : null}
                      {displaySrc ? (
                        <div
                          className="storyboard-tile-action-tray"
                          onClick={(event) => event.stopPropagation()}
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          <button
                            className="storyboard-tile-action-button"
                            type="button"
                            title="Open clip editor"
                            aria-label="Open clip editor"
                            onClick={(event) => {
                              event.stopPropagation();
                              openExpandedMedia({
                                kind: "video",
                                src: displaySrc,
                                title: prompt.title,
                              });
                            }}
                          >
                            <PencilLine size={15} />
                          </button>
                        </div>
                      ) : null}
                      <span className="storyboard-motion-duration">
                        {prompt.duration ? `${prompt.duration}s` : item.label || "clip"}
                      </span>
                      <div className="storyboard-motion-icon">
                        <Video size={17} />
                      </div>
                    </div>
                    <div className="storyboard-frame-title">
                      {versions.length > 1 ? (
                        <span
                          className="storyboard-version-title-tag"
                          title={versions[versionIndex]?.isCurrent ? "Current render" : "Viewing older render"}
                        >
                          {versions[versionIndex]?.label ?? `v${versionIndex + 1}`}
                        </span>
                      ) : null}
                      <span className="storyboard-frame-title-text">clip prompt</span>
                    </div>
                  </div>
                </div>
              );
            }
            return (
              <div
                key={`m-${itemIndex}`}
                className="storyboard-connector flex shrink-0 flex-col items-center gap-0.5"
                style={{ width: 44 }}
              >
                <span className="text-xl leading-none">→</span>
                <span className="text-[10px] leading-none">{item.label}</span>
              </div>
            );
          }
          if (item.kind === "cut") {
            return (
              <div
                key={`c-${itemIndex}`}
                className="storyboard-cut flex shrink-0 flex-col items-center gap-1"
                style={{ width: 58 }}
              >
                <span
                  className="storyboard-cut-mark block h-10 w-1 rounded-full"
                  style={{ transform: "rotate(18deg)" }}
                />
                <span className="text-center text-[10px] font-semibold uppercase leading-tight tracking-wide">
                  {item.label}
                </span>
              </div>
            );
          }
          const index = ordinal;
          const frame = item.frame;
          const focused = index === centeredIndex;
          const versions = frame.versions ?? [];
          const versionKey = `keyframe:${frame.id}`;
          const versionIndex = resolveVersionIndex(versionKey, versions);
          const displaySrc =
            !frame.generating && versions.length
              ? versions[versionIndex]?.src ?? frame.src ?? null
              : frame.src ?? null;
          return (
            // Slot reserves the max-scale footprint; the card scales inside
            // it, so the focused image never covers neighboring connectors.
            <div
              key={`${frame.id}-${itemIndex}`}
              ref={(element) => {
                slotRefs.current[index] = element;
              }}
              className="flex shrink-0 cursor-pointer justify-center"
              style={{ width: SLOT_WIDTH }}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                if (!focused) {
                  centerCard(index);
                  return;
                }
                if (displaySrc && !frame.generating) {
                  openExpandedMedia({
                    kind: "image",
                    src: displaySrc,
                    title: frame.title,
                  });
                  return;
                }
                onOpenFile(frame.path);
              }}
              title={`${frame.id} — ${frame.status}${focused && displaySrc ? " (click to expand)" : ""}`}
            >
              <div className="storyboard-tile-shell" style={{ width: CARD_WIDTH }}>
                {frame.generating ? null : (
                  <VersionStrip
                    versions={versions}
                    index={versionIndex}
                    onStep={(next) => stepVersion(versionKey, next, versions)}
                  />
                )}
                <div
                  className="storyboard-frame-media relative overflow-hidden"
                  style={{
                    aspectRatio: cssAspectRatio(frame.aspectRatio),
                    background: frame.generating ? "var(--surface-3)" : "var(--surface-2)",
                  }}
                >
                  {displaySrc ? (
                    // Keyed by src: a fresh element mounts when the image
                    // lands (or regenerates), replaying the pop animation.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={displaySrc}
                      alt={frame.title}
                      src={displaySrc}
                      className="board-pop h-full w-full object-cover"
                      loading="lazy"
                      draggable={false}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-xs" style={{ color: "var(--muted)" }}>
                      {frame.generating ? "generating…" : frame.status}
                    </div>
                  )}
                  {frame.generating ? <span className="board-shimmer" /> : null}
                  {displaySrc && !frame.generating ? (
                    <div
                      className="storyboard-tile-action-tray"
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <button
                        className="storyboard-tile-action-button"
                        type="button"
                        title="Open frame editor"
                        aria-label="Open frame editor"
                        onClick={(event) => {
                          event.stopPropagation();
                          openExpandedMedia({
                            kind: "image",
                            src: displaySrc,
                            title: frame.title,
                          });
                        }}
                      >
                        <PencilLine size={15} />
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="storyboard-frame-title">
                  {versions.length > 1 ? (
                    <span
                      className="storyboard-version-title-tag"
                      title={versions[versionIndex]?.isCurrent ? "Current render" : "Viewing older render"}
                    >
                      {versions[versionIndex]?.label ?? `v${versionIndex + 1}`}
                    </span>
                  ) : null}
                  <span className="storyboard-frame-title-text">{frame.title}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {expandedMedia ? (
        <div
          className={`storyboard-keyframe-expanded ${expandedMediaClosing ? "is-closing" : ""}`}
          role="dialog"
          aria-label={`Expanded ${expandedMedia.kind === "video" ? "clip" : "keyframe"}: ${expandedMedia.title}`}
          onClick={closeExpandedMedia}
        >
          <div
            className="storyboard-keyframe-expanded-frame"
            onClick={(event) => event.stopPropagation()}
          >
            {expandedMedia.kind === "video" ? (
              <video
                className="storyboard-keyframe-expanded-image storyboard-keyframe-expanded-video"
                src={expandedMedia.src}
                controls
                autoPlay
                muted
                playsInline
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="storyboard-keyframe-expanded-image"
                src={expandedMedia.src}
                alt={expandedMedia.title}
                draggable={false}
              />
            )}
            <button
              className="storyboard-keyframe-expanded-close"
              type="button"
              aria-label={`Close expanded ${expandedMedia.kind === "video" ? "clip" : "keyframe"}`}
              onClick={closeExpandedMedia}
            >
              <X size={18} />
            </button>
          </div>
        </div>
      ) : null}
      {selectedPrompt ? (
        <form
          className="storyboard-floating-prompt"
          onSubmit={(event) => {
            event.preventDefault();
            void savePrompt();
          }}
        >
          {attachments.length ? (
            <div className="storyboard-floating-attachments">
              {attachments.map((attachment) => (
                (() => {
                  const fileType =
                    "fileType" in attachment && typeof attachment.fileType === "string"
                      ? attachment.fileType
                      : "File";
                  return (
                    <div
                      key={attachment.id}
                      className={`storyboard-floating-attachment ${attachment.src ? "image" : "file"}`}
                      title={attachment.label}
                    >
                      {attachment.src ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={attachment.src} alt="" draggable={false} />
                      ) : (
                        <>
                          <span className="composer-file-icon">
                            <FileText size={21} />
                          </span>
                          <span className="composer-file-meta">
                            <span className="composer-file-name">{attachment.label}</span>
                            <span className="composer-file-type">{fileType}</span>
                          </span>
                        </>
                      )}
                      <button
                        className="composer-attachment-remove"
                        type="button"
                        title={`Remove ${attachment.label}`}
                        onClick={() => removeAttachment(attachment.id)}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  );
                })()
              ))}
            </div>
          ) : null}
          <div className="storyboard-floating-input-row">
            <TextareaAutosize
              className="storyboard-floating-textarea"
              minRows={1}
              maxRows={7}
              value={draftText}
              onChange={(event) => {
                if (!selectedPrompt) return;
                setPromptDraft({ id: selectedPrompt.id, text: event.target.value });
              }}
              placeholder={
                selectedPrompt.kind === "final"
                  ? "Edit final prompt..."
                  : selectedPrompt.subject === "clip"
                    ? "Edit planned clip prompt..."
                    : "Edit planned keyframe prompt..."
              }
              spellCheck={false}
            />
          </div>
          <div className="storyboard-floating-controls">
            <button
              className="storyboard-floating-add"
              type="button"
              title="Add image"
              onClick={() => uploadInputRef.current?.click()}
            >
              <Plus size={18} />
            </button>
            <input
              ref={uploadInputRef}
              className="hidden"
              type="file"
              accept="image/*,.pdf,application/pdf"
              multiple
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                if (!files.length) return;
                setLocalAttachments((current) => [
                  ...current,
                  ...files.map((file) => ({
                    id: `${file.name}-${file.lastModified}-${file.size}`,
                    label: file.name,
                    src: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
                    fileKind: file.type.startsWith("image/") ? "image" as const : "file" as const,
                    fileType: file.type.includes("pdf") ? "PDF" : file.type || "File",
                  })),
                ]);
                event.currentTarget.value = "";
              }}
            />
            {onSavePrompt ? (
              <button
                className="storyboard-floating-submit"
                disabled={!promptChanged || savingPrompt || isSending}
                type="submit"
                title="Submit prompt"
                aria-label="Submit prompt"
              >
                {savingPrompt || isSending ? (
                  <Loader2 size={17} className="spin" />
                ) : (
                  <ArrowUp size={18} />
                )}
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
