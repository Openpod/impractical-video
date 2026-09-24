"use client";

import {
  AudioLines,
  Clapperboard,
  Copy,
  Crop,
  FileText,
  Image as ImageIcon,
  Pause,
  PencilLine,
  Play,
  SlidersHorizontal,
  Sparkles,
  Target,
  Trash2,
  Trees,
  TriangleAlert,
  UserRound,
  Volume2,
  SkipBack,
  SkipForward,
  VolumeX,
  X,
} from "lucide-react";
import {
  artifactFocusIdentityMatches,
  type ArtifactFocusIdentity,
} from "@/opencut/host/artifact-focus-contract";
import { Markdown } from "@/app/markdown";
import type { CanonicalEditorPlacement } from "@/opencut/host/editor-placement-contract";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  areCanvasCardsDeletable,
  isCanvasCardDeletable,
} from "./canvas-selection";
import {
  CanvasLoadingPiece,
  canvasPieceKind,
  canvasPieceState,
} from "./canvas-loading-piece";

type InspectorVersion = {
  createdAt?: string | null;
  id?: string | null;
  isCurrent?: boolean;
  label?: string | null;
  src?: string | null;
};

export type CanvasInspectorCard = {
  artifactIds?: string[];
  aspectRatio?: string | null;
  canAdjust?: boolean;
  canDraw?: boolean;
  canDuplicate?: boolean;
  canStage?: boolean;
  canTrack?: boolean;
  canTrim?: boolean;
  duration?: number | null;
  id: string;
  isStaged?: boolean;
  kind: string;
  muted?: boolean;
  path: string;
  playbackRate?: number;
  previewSrc?: string | null;
  prompt?: {
    summary?: string | null;
    text?: string | null;
    title?: string | null;
  } | null;
  refCategory?: string | null;
  remediation?: string | null;
  selectedVersionIndex?: number;
  status: string;
  title: string;
  versions?: InspectorVersion[];
};

export type CanvasInspectorUsedCard = {
  id: string;
  kind: string;
  previewSrc?: string | null;
  refCategory?: string | null;
  title: string;
};

export type CanvasTimelineUsage = {
  durationTicks: number;
  id: string;
  relation: "artifact" | "selected-version";
  startTimeTicks: number;
  title: string;
  trackId: string;
  trackLabel: string;
  usesSelectedVersion: boolean | null;
};

export type CanvasInspectorAction =
  | "crop"
  | "delete"
  | "duplicate"
  | "draw"
  | "filters"
  | "mute"
  | "revise"
  | "stage"
  | "track"
  | "trim";

export type CanvasInspectorAdjustment = {
  changed: boolean;
  mode: "crop" | "filters";
  params: Record<string, number>;
  saving: boolean;
};

export type CanvasInspectorTrim = {
  changed: boolean;
  saving: boolean;
};

export type CanvasInspectorEditorFocusResult =
  | { status: "focused-placement" | "media-bin" }
  | { message: string; status: "stale" };

export function timelineUsageForCard({
  identity,
  placements,
}: {
  identity: ArtifactFocusIdentity;
  placements: CanonicalEditorPlacement[];
}): CanvasTimelineUsage[] {
  return placements.flatMap((placement) => {
    if (placement.identity.artifactId !== identity.artifactId) return [];
    const selectedVersionMatch = artifactFocusIdentityMatches(
      placement.identity,
      identity,
    );

    return [
      {
        durationTicks: placement.durationTicks,
        id: placement.elementId,
        relation: selectedVersionMatch
          ? ("selected-version" as const)
          : ("artifact" as const),
        startTimeTicks: placement.startTimeTicks,
        title: placement.elementId,
        trackId: placement.trackId,
        trackLabel: placement.trackLabel,
        usesSelectedVersion: selectedVersionMatch,
      },
    ];
  });
}

function remediationForCard(card: CanvasInspectorCard) {
  if (card.remediation?.trim()) return card.remediation.trim();
  const normalized = card.status.toLowerCase();
  if (normalized === "failed" || normalized === "error") {
    return "Review the failure, update the prompt or provider setup, then retry.";
  }
  if (normalized === "stale") {
    return "A dependency changed. Review impact before regenerating this piece.";
  }
  if (normalized === "awaiting-input" || normalized === "needs-assets") {
    return "Provide the missing input to continue.";
  }
  if (normalized === "cancelled" || normalized === "canceled") {
    return "This work was cancelled. Start it again when ready.";
  }
  return null;
}

function Section({
  children,
  defaultOpen = false,
  label,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  label: string;
}) {
  return (
    <details className="canvas-inspector-section" open={defaultOpen}>
      <summary>{label}</summary>
      <div className="canvas-inspector-section-body">{children}</div>
    </details>
  );
}

function ActionButton({
  children,
  danger = false,
  disabled = false,
  icon,
  onClick,
}: {
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={`canvas-inspector-action ${danger ? "is-danger" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

function ToolButton({
  children,
  danger = false,
  label,
  onClick,
}: {
  children: ReactNode;
  danger?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className={`canvas-inspector-tool${danger ? " is-danger" : ""}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function kindPresentation(
  card: Pick<CanvasInspectorUsedCard, "kind" | "refCategory">,
) {
  const category = card.refCategory?.toLowerCase() ?? "";
  if (category.includes("character")) {
    return { icon: UserRound, label: "Character" };
  }
  if (category.includes("environment")) {
    return { icon: Trees, label: "Environment" };
  }
  const kind = card.kind.toLowerCase();
  if (kind === "clip" || kind === "video") {
    return { icon: Clapperboard, label: "Video" };
  }
  if (kind === "audio") return { icon: AudioLines, label: "Audio" };
  if (kind === "image" || kind === "keyframe" || kind === "frame") {
    return { icon: ImageIcon, label: "Image" };
  }
  return { icon: FileText, label: card.kind };
}

function KindGlyph({
  card,
  size,
}: {
  card: Pick<CanvasInspectorUsedCard, "kind" | "refCategory">;
  size: number;
}) {
  const { icon: Icon } = kindPresentation(card);
  return <Icon aria-hidden size={size} />;
}

function previewAspectRatio(card: CanvasInspectorCard): CSSProperties {
  const raw = card.aspectRatio?.trim();
  if (!raw) return { aspectRatio: "1 / 1" };
  const parts = raw.split(/[:/]/).map((value) => Number(value.trim()));
  if (
    parts.length === 2 &&
    parts.every((value) => Number.isFinite(value) && value > 0)
  ) {
    return { aspectRatio: `${parts[0]} / ${parts[1]}` };
  }
  return { aspectRatio: "1 / 1" };
}

export type InspectorPlaybackState = {
  currentTime: number;
  duration: number;
  playing: boolean;
};

const PROMPT_CLAMP_CHARS = 320;

/** The prompt rendered as markdown (agent prompts often carry headings),
 * clamped to a readable excerpt with View more / See less. */
function InspectorPrompt({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsClamp = text.length > PROMPT_CLAMP_CHARS + 100;
  const shown =
    expanded || !needsClamp
      ? text
      : `${text.slice(0, PROMPT_CLAMP_CHARS).trimEnd()}…`;
  return (
    <section aria-label="Prompt" className="canvas-inspector-prompt">
      <h3>Prompt</h3>
      <div className="canvas-inspector-prompt-body">
        <Markdown text={shown} />
      </div>
      {needsClamp ? (
        <button
          className="canvas-inspector-prompt-toggle"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {expanded ? "See less" : "View more"}
        </button>
      ) : null}
    </section>
  );
}

function isPortraitAspect(raw: string | null | undefined) {
  const parts = (raw ?? "").trim().split(":").map((part) => Number(part));
  return parts.length === 2 && parts[0]! > 0 && parts[1]! > parts[0]!;
}

function InspectorPreview({
  adjustmentFilter,
  card,
  onDuration,
  onPlayback,
  previewMuted = true,
  scrubSeconds,
  trimWindow,
  videoRef,
}: {
  adjustmentFilter: string | null;
  card: CanvasInspectorCard;
  onDuration?: (duration: number) => void;
  onPlayback?: (playback: InspectorPlaybackState) => void;
  previewMuted?: boolean;
  scrubSeconds?: number | null;
  trimWindow?: { endSeconds: number; startSeconds: number } | null;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const trimWindowRef = useRef(trimWindow ?? null);
  useEffect(() => {
    trimWindowRef.current = trimWindow ?? null;
  }, [trimWindow]);

  // Report playback to the panel so the custom controls and the trim strip's
  // playhead stay live.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !onPlayback) return;
    const report = () =>
      onPlayback({
        currentTime: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        playing: !video.paused && !video.ended,
      });
    const events = ["timeupdate", "play", "pause", "ended", "loadedmetadata", "seeked"];
    for (const name of events) video.addEventListener(name, report);
    report();
    return () => {
      for (const name of events) video.removeEventListener(name, report);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.previewSrc, onPlayback]);

  // Live preview: playback speed applies to the drawer's player immediately.
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = card.playbackRate ?? 1;
  }, [card.playbackRate, card.previewSrc]);

  // Live preview: playback loops inside the draft trim window.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const clamp = () => {
      const window = trimWindowRef.current;
      if (!window) return;
      if (
        video.currentTime > window.endSeconds ||
        video.currentTime < window.startSeconds - 0.25
      ) {
        try {
          video.currentTime = window.startSeconds;
        } catch {
          // Seek can fail before metadata; the next timeupdate retries.
        }
      }
    };
    video.addEventListener("timeupdate", clamp);
    return () => video.removeEventListener("timeupdate", clamp);
  }, [card.previewSrc]);

  // Dragging a trim handle scrubs the player to that frame.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || scrubSeconds === null || scrubSeconds === undefined) return;
    try {
      video.currentTime = scrubSeconds;
    } catch {
      // Ignore seeks before metadata is ready.
    }
  }, [scrubSeconds]);

  if (!card.previewSrc) {
    // Unfinished pieces get the exact canvas-tile treatment (dot wave and
    // all), so the drawer mirrors what the tile shows.
    return (
      <div
        className="canvas-inspector-preview is-loading"
        style={previewAspectRatio(card)}
      >
        <CanvasLoadingPiece
          aspectRatio={card.aspectRatio}
          kind={canvasPieceKind(card.kind)}
          remediation={card.remediation}
          state={canvasPieceState(card.status)}
        />
      </div>
    );
  }
  if (card.kind === "clip" || card.kind === "video") {
    return (
      <div
        className={`canvas-inspector-preview is-player${
          isPortraitAspect(card.aspectRatio) ? " is-portrait" : ""
        }`}
        style={previewAspectRatio(card)}
      >
        <video
          key={card.previewSrc}
          autoPlay
          loop
          muted={previewMuted}
          onClick={(event) => {
            const video = event.currentTarget;
            if (video.paused) void video.play().catch(() => {});
            else video.pause();
          }}
          onLoadedMetadata={(event) => {
            const duration = event.currentTarget.duration;
            if (Number.isFinite(duration) && duration > 0) {
              onDuration?.(duration);
            }
          }}
          playsInline
          preload="metadata"
          ref={videoRef}
          src={card.previewSrc}
          style={adjustmentFilter ? { filter: adjustmentFilter } : undefined}
        />
      </div>
    );
  }
  if (card.kind === "audio") {
    return (
      <div
        className="canvas-inspector-preview is-audio"
        style={previewAspectRatio(card)}
      >
        <audio
          key={card.previewSrc}
          controls
          muted
          preload="metadata"
          src={card.previewSrc}
        />
      </div>
    );
  }
  return (
    <div
      className={`canvas-inspector-preview${
        isPortraitAspect(card.aspectRatio) ? " is-portrait" : ""
      }`}
      style={previewAspectRatio(card)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        draggable={false}
        loading="lazy"
        src={card.previewSrc}
        style={adjustmentFilter ? { filter: adjustmentFilter } : undefined}
      />
    </div>
  );
}

function formatTrimSeconds(seconds: number) {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  const tenths = Math.floor((seconds - whole) * 10);
  return `${minutes}:${String(secs).padStart(2, "0")}.${tenths}`;
}

/** Extracts evenly spaced thumbnail frames from a video for the filmstrip
 * track. Generated once per source, entirely client-side. */
function useFilmstrip(src: string | null, frameCount = 8) {
  const [frames, setFrames] = useState<string[]>([]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFrames([]);
    if (!src) return;
    let cancelled = false;
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.src = src;
    const captured: string[] = [];
    const canvas = document.createElement("canvas");
    const cleanup = () => {
      video.removeAttribute("src");
      video.load();
    };
    video.addEventListener("loadedmetadata", () => {
      if (cancelled || !Number.isFinite(video.duration) || video.duration <= 0) {
        return;
      }
      const height = 52;
      const width = Math.max(
        28,
        Math.round((video.videoWidth / video.videoHeight) * height) || 92,
      );
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return;
      let index = 0;
      const capture = () => {
        if (cancelled) return cleanup();
        context.drawImage(video, 0, 0, width, height);
        try {
          captured.push(canvas.toDataURL("image/jpeg", 0.62));
        } catch {
          return cleanup(); // Tainted canvas (remote media): no filmstrip.
        }
        index += 1;
        if (index >= frameCount) {
          setFrames([...captured]);
          return cleanup();
        }
        video.currentTime = ((index + 0.5) / frameCount) * video.duration;
      };
      video.addEventListener("seeked", capture);
      video.currentTime = (0.5 / frameCount) * video.duration;
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [src, frameCount]);
  return frames;
}

/** The always-visible trimmer beneath a video: a filmstrip track with in/out
 * handles. Dragging previews the frame live; the footer commits the cut. */
function InspectorTrimStrip({
  draft,
  filmstripSrc = null,
  onChange,
  onScrub,
  onSeek,
  playheadSeconds,
}: {
  draft: { duration: number; endSeconds: number; startSeconds: number };
  filmstripSrc?: string | null;
  onChange: (draft: {
    duration: number;
    endSeconds: number;
    startSeconds: number;
  }) => void;
  onScrub: (seconds: number) => void;
  onSeek: (seconds: number) => void;
  playheadSeconds: number;
}) {
  const frames = useFilmstrip(filmstripSrc);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<"end" | "start" | null>(null);

  const secondsAtPointer = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * draft.duration;
  };

  const moveHandle = (edge: "end" | "start", clientX: number) => {
    const seconds = secondsAtPointer(clientX);
    const minGap = Math.min(0.1, draft.duration / 2);
    const next =
      edge === "start"
        ? {
            ...draft,
            startSeconds: Math.min(
              Math.max(0, seconds),
              draft.endSeconds - minGap,
            ),
          }
        : {
            ...draft,
            endSeconds: Math.max(
              Math.min(draft.duration, seconds),
              draft.startSeconds + minGap,
            ),
          };
    onChange(next);
    onScrub(edge === "start" ? next.startSeconds : next.endSeconds);
  };

  const handleHandlePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    const edge =
      event.currentTarget.dataset.trimEdge === "end"
        ? ("end" as const)
        : ("start" as const);
    dragRef.current = edge;
    moveHandle(edge, event.clientX);
    const onMove = (moveEvent: PointerEvent) => {
      if (dragRef.current) moveHandle(dragRef.current, moveEvent.clientX);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const seekAt = (clientX: number) => {
    const seconds = Math.max(
      draft.startSeconds,
      Math.min(draft.endSeconds, secondsAtPointer(clientX)),
    );
    onSeek(seconds);
  };

  // Anywhere on the track that isn't a trim handle scrubs the playhead.
  const handleTrackPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const target = event.target as HTMLElement;
    if (target.closest(".canvas-inspector-trim-handle")) return;
    event.preventDefault();
    seekAt(event.clientX);
    const onMove = (moveEvent: PointerEvent) => seekAt(moveEvent.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startPercent = (draft.startSeconds / draft.duration) * 100;
  const endPercent = (draft.endSeconds / draft.duration) * 100;
  const playheadPercent = Math.max(
    0,
    Math.min(100, (playheadSeconds / draft.duration) * 100),
  );

  return (
    <div className="canvas-inspector-trim">
      <div
        className={`canvas-inspector-trim-track${frames.length ? " has-filmstrip" : ""}`}
        onPointerDown={handleTrackPointerDown}
        ref={trackRef}
      >
        <div aria-hidden className="canvas-inspector-trim-clip">
          {frames.length ? (
            <div aria-hidden className="canvas-inspector-filmstrip">
              {frames.map((frame, index) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img alt="" draggable={false} key={index} src={frame} />
              ))}
            </div>
          ) : null}
          <div
            className="canvas-inspector-trim-range"
            style={{
              left: `${startPercent}%`,
              width: `${Math.max(0, endPercent - startPercent)}%`,
            }}
          />
        </div>
        <button
          aria-label="Trim start"
          aria-valuemax={draft.endSeconds}
          aria-valuemin={0}
          aria-valuenow={draft.startSeconds}
          className="canvas-inspector-trim-handle is-start"
          data-trim-edge="start"
          onPointerDown={handleHandlePointerDown}
          role="slider"
          style={{ left: `${startPercent}%` }}
          type="button"
        />
        <button
          aria-label="Trim end"
          aria-valuemax={draft.duration}
          aria-valuemin={draft.startSeconds}
          aria-valuenow={draft.endSeconds}
          className="canvas-inspector-trim-handle is-end"
          data-trim-edge="end"
          onPointerDown={handleHandlePointerDown}
          role="slider"
          style={{ left: `${endPercent}%` }}
          type="button"
        />
        <span
          aria-hidden
          className="canvas-inspector-trim-playhead"
          style={{ left: `${playheadPercent}%` }}
        />
      </div>
      <div className="canvas-inspector-trim-times">
        <span>{formatTrimSeconds(draft.startSeconds)}</span>
        <span>
          {formatTrimSeconds(draft.endSeconds - draft.startSeconds)} selected
        </span>
        <span>{formatTrimSeconds(draft.endSeconds)}</span>
      </div>
    </div>
  );
}

export const CanvasTileInspector = memo(function CanvasTileInspector({
  adjustment,
  cards,
  onAction,
  onActivateVersion,
  onAdjustmentChange,
  onAdjustmentDiscard,
  onAdjustmentSave,
  adjustmentFilter = null,
  onOpenChange,
  onPlaybackRateChange,
  onRename,
  onTrimDiscard,
  onTrimDraftChange,
  onTrimSave,
  onLivePlayback,
  open,
  usedCards = [],
  trim,
  trimDraft = null,
}: {
  adjustment?: CanvasInspectorAdjustment | null;
  adjustmentFilter?: string | null;
  cards: CanvasInspectorCard[];
  onAction: (action: CanvasInspectorAction) => void;
  onActivateVersion: (index: number) => void;
  onAdjustmentChange: (key: string, value: number) => void;
  onAdjustmentDiscard: () => void;
  onAdjustmentSave: () => void;
  onOpenChange: (open: boolean) => void;
  onPlaybackRateChange: (rate: number) => void;
  onRename: (title: string) => void;
  onTrimDiscard: () => void;
  onTrimDraftChange?: (draft: {
    duration: number;
    endSeconds: number;
    startSeconds: number;
  }) => void;
  onTrimSave: (mode: "new" | "version") => void;
  /** Live playback mirror for the canvas tile: the drawer is the master
   * player and the tile follows (time, play state). */
  onLivePlayback?: (
    cardId: string,
    playback: InspectorPlaybackState,
  ) => void;
  open: boolean;
  usedCards?: CanvasInspectorUsedCard[];
  trim?: CanvasInspectorTrim | null;
  trimDraft?: {
    duration: number;
    endSeconds: number;
    startSeconds: number;
  } | null;
}) {
  const card = cards.length === 1 ? cards[0]! : null;
  const [renameState, setRenameState] = useState<{
    editing: boolean;
    id: string;
    value: string;
  }>({ editing: false, id: card?.id ?? "", value: card?.title ?? "" });
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [scrubSeconds, setScrubSeconds] = useState<number | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const [playback, setPlayback] = useState<InspectorPlaybackState>({
    currentTime: 0,
    duration: 0,
    playing: false,
  });
  const [previewMuted, setPreviewMuted] = useState(true);
  const cardId = card?.id ?? null;
  useEffect(() => {
    // A newly focused tile starts muted; audio is an explicit opt-in.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreviewMuted(true);
  }, [cardId]);
  const handlePlayback = useCallback(
    (next: InspectorPlaybackState) => {
      setPlayback(next);
      if (cardId) onLivePlayback?.(cardId, next);
    },
    [cardId, onLivePlayback],
  );
  const [drawerWidth, setDrawerWidth] = useState(400);
  const drawerWidthRef = useRef(400);
  useEffect(() => {
    const stored = Number(localStorage.getItem("canvas-inspector-width"));
    if (Number.isFinite(stored) && stored >= 340 && stored <= 880) {
      drawerWidthRef.current = stored;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDrawerWidth(stored);
    }
  }, []);
  const applyDrawerWidth = (next: number) => {
    const clamped = Math.round(
      Math.min(Math.max(next, 340), Math.min(880, window.innerWidth * 0.7)),
    );
    drawerWidthRef.current = clamped;
    setDrawerWidth(clamped);
    try {
      localStorage.setItem("canvas-inspector-width", String(clamped));
    } catch {
      // Width still applies for this session without storage.
    }
  };
  const handleResizeStart = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    const onMove = (moveEvent: PointerEvent) =>
      applyDrawerWidth(window.innerWidth - moveEvent.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const drawerStyle: CSSProperties = {
    flexBasis: drawerWidth,
    minWidth: drawerWidth,
    width: drawerWidth,
  };
  const seekPreview = (seconds: number) => {
    const video = previewVideoRef.current;
    if (!video) return;
    try {
      video.currentTime = seconds;
    } catch {
      // Seeks before metadata settle on the next attempt.
    }
  };
  const togglePreviewPlayback = () => {
    const video = previewVideoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  };
  const renaming = renameState.editing && renameState.id === card?.id;
  const renameDraft =
    renameState.id === card?.id ? renameState.value : (card?.title ?? "");

  useEffect(() => {
    if (renaming) renameInputRef.current?.select();
  }, [renaming]);

  const common = useMemo(() => {
    if (cards.length < 2) return null;
    const kinds = new Set(cards.map((entry) => entry.kind));
    const statuses = new Set(cards.map((entry) => entry.status));
    return {
      kind: kinds.size === 1 ? cards[0]!.kind : "Mixed",
      status: statuses.size === 1 ? cards[0]!.status : "Mixed",
    };
  }, [cards]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    onOpenChange(false);
  };

  if (!cards.length || !open) return null;

  if (!card && common) {
    const allStageable = cards.every((entry) => entry.canStage);
    const allStaged = allStageable && cards.every((entry) => entry.isStaged);
    return (
      <aside
        aria-label={`${cards.length} selected`}
        className="canvas-inspector-region is-open"
        onKeyDown={handleKeyDown}
        style={drawerStyle}
      >
        <header className="canvas-inspector-header">
          <h2>{cards.length} selected</h2>
          <button
            className="canvas-inspector-close"
            aria-label="Close inspector"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            <X size={17} />
          </button>
        </header>
        <div className="canvas-inspector-scroll">
          <Section defaultOpen label="Selection">
            <dl className="canvas-inspector-properties">
              <div>
                <dt>Type</dt>
                <dd>{common.kind}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{common.status}</dd>
              </div>
              <div>
                <dt>Selection</dt>
                <dd>{cards.length} selected</dd>
              </div>
            </dl>
            {common.kind === "Mixed" || common.status === "Mixed" ? (
              <p className="canvas-inspector-mixed">
                Mixed values are preserved unless changed explicitly.
              </p>
            ) : null}
          </Section>
          <Section defaultOpen label="Batch actions">
            <div className="canvas-inspector-actions">
              {allStageable ? (
                <ActionButton
                  icon={allStaged ? <X size={15} /> : <Sparkles size={15} />}
                  onClick={() => onAction("stage")}
                >
                  {allStaged
                    ? "Remove all from composer"
                    : "Add all to composer"}
                </ActionButton>
              ) : null}
              {cards.every((entry) => entry.canDuplicate) ? (
                <ActionButton
                  icon={<Copy size={15} />}
                  onClick={() => onAction("duplicate")}
                >
                  Duplicate pieces
                </ActionButton>
              ) : null}
              {areCanvasCardsDeletable(cards) ? (
                <ActionButton
                  danger
                  icon={<Trash2 size={15} />}
                  onClick={() => onAction("delete")}
                >
                  Delete {cards.length} pieces
                </ActionButton>
              ) : null}
            </div>
          </Section>
        </div>
      </aside>
    );
  }

  if (!card) return null;
  const prompt =
    card.prompt?.text?.trim() || card.prompt?.summary?.trim() || null;
  const remediation = remediationForCard(card);
  const versions = card.versions ?? [];
  const selectedVersionIndex =
    card.selectedVersionIndex ?? Math.max(0, versions.length - 1);
  const isVideo = card.kind === "clip" || card.kind === "video";
  const playbackRate = card.playbackRate ?? 1;

  const commitRename = () => {
    const title = renameDraft.trim();
    if (title && title !== card.title) onRename(title);
    setRenameState({ editing: false, id: card.id, value: title || card.title });
  };

  const cycleSpeed = () => {
    const steps = [0.5, 1, 1.5, 2];
    const currentIndex = steps.findIndex(
      (step) => Math.abs(step - playbackRate) < 0.01,
    );
    const next = steps[(currentIndex + 1) % steps.length] ?? 1;
    onPlaybackRateChange(next);
  };

  return (
    <aside
      aria-label={`Inspector for ${card.title}`}
      className="canvas-inspector-region is-open"
      onKeyDown={handleKeyDown}
      style={drawerStyle}
    >
      <span
        aria-hidden
        className="canvas-inspector-resize"
        onDoubleClick={() => applyDrawerWidth(drawerWidth < 560 ? 640 : 400)}
        onPointerDown={handleResizeStart}
        title="Drag to resize. Double-click to expand."
      />
      <div className="canvas-inspector-scroll">
        <header className="canvas-inspector-title-row">
          <span
            aria-label={kindPresentation(card).label}
            className="canvas-inspector-kind"
            role="img"
            title={kindPresentation(card).label}
          >
            <KindGlyph card={card} size={15} />
          </span>
          {renaming ? (
            <input
              aria-label="Name"
              className="canvas-inspector-title-input"
              onBlur={commitRename}
              onChange={(event) =>
                setRenameState({
                  editing: true,
                  id: card.id,
                  value: event.currentTarget.value,
                })
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitRename();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setRenameState({
                    editing: false,
                    id: card.id,
                    value: card.title,
                  });
                }
              }}
              ref={renameInputRef}
              value={renameDraft}
            />
          ) : (
            <h2
              onDoubleClick={() => {
                if (card.path === "#") return;
                setRenameState({
                  editing: true,
                  id: card.id,
                  value: card.title,
                });
              }}
              title={card.path === "#" ? card.title : "Double-click to rename"}
            >
              {card.title}
            </h2>
          )}
          <button
            aria-label="Close"
            className="canvas-inspector-close"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            <X size={15} />
          </button>
        </header>

        <InspectorPreview
          adjustmentFilter={adjustmentFilter}
          card={card}
          onDuration={(duration) => {
            if (isVideo && onTrimDraftChange && !trimDraft) {
              onTrimDraftChange({
                duration,
                endSeconds: duration,
                startSeconds: 0,
              });
            }
          }}
          onPlayback={handlePlayback}
          scrubSeconds={scrubSeconds}
          trimWindow={trimDraft}
          previewMuted={previewMuted}
          videoRef={previewVideoRef}
        />

        {isVideo && card.previewSrc ? (
          <div className="canvas-inspector-player">
            <button
              aria-label={playback.playing ? "Pause" : "Play"}
              className="canvas-inspector-player-toggle"
              onClick={togglePreviewPlayback}
              type="button"
            >
              {playback.playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button
              aria-label="Back 5 seconds"
              className="canvas-inspector-player-toggle"
              onClick={() => seekPreview(Math.max(0, playback.currentTime - 5))}
              type="button"
            >
              <SkipBack size={15} />
            </button>
            <button
              aria-label="Forward 5 seconds"
              className="canvas-inspector-player-toggle"
              onClick={() =>
                seekPreview(
                  Math.min(
                    playback.duration || card.duration || 0,
                    playback.currentTime + 5,
                  ),
                )
              }
              type="button"
            >
              <SkipForward size={15} />
            </button>
            <button
              aria-label={previewMuted ? "Unmute preview" : "Mute preview"}
              aria-pressed={!previewMuted}
              className="canvas-inspector-player-toggle"
              onClick={() => setPreviewMuted((current) => !current)}
              type="button"
            >
              {previewMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
            <span className="canvas-inspector-player-spacer" />
            <span className="canvas-inspector-player-time">
              {formatTrimSeconds(playback.currentTime)}
              <em aria-hidden>/</em>
              {formatTrimSeconds(
                playback.duration || trimDraft?.duration || card.duration || 0,
              )}
            </span>
          </div>
        ) : null}

        {isVideo && card.canTrim && trimDraft ? (
          <InspectorTrimStrip
            draft={trimDraft}
            filmstripSrc={card.previewSrc ?? null}
            onChange={(draft) => onTrimDraftChange?.(draft)}
            onScrub={setScrubSeconds}
            onSeek={seekPreview}
            playheadSeconds={playback.currentTime}
          />
        ) : null}

        <div
          aria-label="Tools"
          className="canvas-inspector-toolbar"
          role="toolbar"
        >
          {isVideo ? (
            <ToolButton
              label={card.muted ? "Unmute" : "Mute"}
              onClick={() => onAction("mute")}
            >
              {card.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </ToolButton>
          ) : null}
          {card.canAdjust ? (
            <>
              <ToolButton label="Crop" onClick={() => onAction("crop")}>
                <Crop size={15} />
              </ToolButton>
              <ToolButton label="Adjust" onClick={() => onAction("filters")}>
                <SlidersHorizontal size={15} />
              </ToolButton>
            </>
          ) : null}
          {card.canDraw ? (
            <ToolButton label="Draw" onClick={() => onAction("draw")}>
              <PencilLine size={15} />
            </ToolButton>
          ) : null}
          {card.canTrack ? (
            <ToolButton
              label="Track object"
              onClick={() => onAction("track")}
            >
              <Target size={15} />
            </ToolButton>
          ) : null}
          {isVideo ? (
            <button
              aria-label={`Playback speed ${playbackRate}×`}
              className="canvas-inspector-speed"
              onClick={cycleSpeed}
              title="Playback speed"
              type="button"
            >
              {playbackRate}×
            </button>
          ) : null}
          <span aria-hidden className="canvas-inspector-toolbar-spacer" />
          {card.canDuplicate ? (
            <ToolButton
              label="Duplicate"
              onClick={() => onAction("duplicate")}
            >
              <Copy size={15} />
            </ToolButton>
          ) : null}
          {isCanvasCardDeletable(card) ? (
            <ToolButton
              danger
              label="Delete"
              onClick={() => onAction("delete")}
            >
              <Trash2 size={15} />
            </ToolButton>
          ) : null}
        </div>


        {remediation ? (
          <div className="canvas-inspector-remediation" role="status">
            <TriangleAlert aria-hidden size={16} />
            <span>{remediation}</span>
          </div>
        ) : null}

        {adjustment?.mode === "filters" ? (
          <div className="canvas-inspector-adjustments">
            {Object.entries(adjustment.params).map(([key, value]) => (
              <label key={key}>
                <span className="canvas-inspector-adjust-head">
                  <span>{key}</span>
                  <output>{Math.round(value)}</output>
                </span>
                <input
                  aria-label={`${key} amount`}
                  max={100}
                  min={0}
                  onChange={(event) =>
                    onAdjustmentChange(key, Number(event.currentTarget.value))
                  }
                  style={{
                    background: `linear-gradient(to right, #ed1d24 ${value}%, var(--surface-3) ${value}%)`,
                  }}
                  type="range"
                  value={value}
                />
              </label>
            ))}
          </div>
        ) : null}

        {prompt ? <InspectorPrompt text={prompt} /> : null}

        {usedCards.length ? (
          <section
            aria-label="Dependencies"
            className="canvas-inspector-prompt"
          >
            <h3>Uses</h3>
            <div className="canvas-inspector-uses">
              {usedCards.map((used) => (
                <span
                  className="canvas-inspector-use-chip"
                  key={used.id}
                  title={`${used.title} · ${kindPresentation(used).label}`}
                >
                  {used.previewSrc &&
                  (used.kind === "clip" || used.kind === "video") ? (
                    <video
                      muted
                      playsInline
                      preload="metadata"
                      src={used.previewSrc}
                    />
                  ) : used.previewSrc && used.kind !== "audio" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      alt=""
                      draggable={false}
                      loading="lazy"
                      src={used.previewSrc}
                    />
                  ) : (
                    <span className="canvas-inspector-use-thumb-glyph">
                      <KindGlyph card={used} size={13} />
                    </span>
                  )}
                  <span className="canvas-inspector-use-name">
                    {used.title}
                  </span>
                  <span aria-hidden className="canvas-inspector-use-kind">
                    <KindGlyph card={used} size={12} />
                  </span>
                </span>
              ))}
            </div>
          </section>
        ) : null}

        {versions.length > 1 ? (
          <section aria-label="Versions" className="canvas-inspector-prompt">
            <h3>Versions</h3>
            <div className="canvas-inspector-used-grid">
              {versions.map((version, index) => (
                <button
                  aria-pressed={index === selectedVersionIndex}
                  className={`canvas-inspector-used-tile is-version${index === selectedVersionIndex ? " is-active" : ""}`}
                  key={version.id ?? version.src ?? index}
                  onClick={() => onActivateVersion(index)}
                  title={version.label || `Version ${index + 1}`}
                  type="button"
                >
                  {version.src && isVideo ? (
                    <video
                      muted
                      playsInline
                      preload="metadata"
                      src={version.src}
                    />
                  ) : version.src ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img alt="" draggable={false} src={version.src} />
                  ) : (
                    <span className="canvas-inspector-used-glyph">
                      {index + 1}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {trim?.changed || adjustment?.changed ? (
          <div className="canvas-inspector-footer">
            <button
              className="canvas-inspector-cta"
              onClick={() => {
                if (trim?.changed) onTrimDiscard();
                if (adjustment?.changed) onAdjustmentDiscard();
              }}
              type="button"
            >
              Cancel
            </button>
            {trim?.changed ? (
              <button
                className="canvas-inspector-cta"
                disabled={Boolean(trim?.saving || adjustment?.saving)}
                onClick={() => onTrimSave("new")}
                title="Keep the original and add the trimmed cut as a new tile linked to it"
                type="button"
              >
                Save as new
              </button>
            ) : null}
            <button
              className="canvas-inspector-cta is-primary"
              disabled={Boolean(trim?.saving || adjustment?.saving)}
              onClick={() => {
                if (trim?.changed) onTrimSave("version");
                if (adjustment?.changed) onAdjustmentSave();
              }}
              type="button"
            >
              {trim?.saving || adjustment?.saving ? "Saving…" : "Save"}
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  );
});
