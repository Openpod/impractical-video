"use client";

import {
  ArrowUp,
  AudioLines,
  Eye,
  Keyboard,
  MapPin,
  Brush,
  ChevronLeft,
  ChevronsUpDown,
  Crop,
  FileText,
  FastForward,
  Gauge,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Minimize2,
  Check,
  MoreHorizontal,
  Music2,
  Pause,
  PencilLine,
  Play,
  Plus,
  Rewind,
  RotateCcw,
  Package,
  Palette,
  Scissors,
  Search,
  Share2,
  SlidersHorizontal,
  Waves,
  Waypoints,
  Wrench,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  UserRound,
  Video,
  Youtube,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import TextareaAutosize from "react-textarea-autosize";
import type { TimelineItem } from "@/lib/workspace";
import type { CanonicalEditorPlacement } from "@/opencut/host/editor-placement-contract";
import type { VideoTrackingBox, VideoTrackingRecord } from "@/lib/video-object-tracking";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  TileDrawLayer,
  type DrawOverAnnotation,
  type DrawOverRegenerateRequest,
} from "./tile-draw-layer";
import { AttachmentTile } from "@/components/attachment-tile";
import { FloatingComposer } from "@/components/floating-composer";
import { FlowsModal, workflowTitleGradient } from "@/components/flows-modal";
import { TrimTimeline } from "./trim-timeline";
import type {
  StoryboardClipPrompt,
  StoryboardMediaVersion,
  StoryboardPromptDraft,
} from "./storyboard-strip";
import {
  CanvasSpatialIndex,
  canvasWorldViewport,
  findCollisionFreePoint,
  resolveAllCollisions,
  resolveCollisionFreePlacement,
  spatialRectsIntersect,
  type CanvasSpatialBox,
} from "./canvas-spatial-index";
import { CanvasWaveform } from "./canvas-waveform";
import {
  CanvasLoadingPiece,
  canvasPieceKind,
  canvasPieceState,
  canvasPieceStateLabel,
  resolvePieceAspectRatio,
  type CanvasPieceKind,
} from "./canvas-loading-piece";
import {
  readCanvasPlaybackState,
  writeCanvasPlaybackState,
  type CanvasPlaybackState,
} from "./canvas-playback-state";
import {
  areCanvasCardsDeletable,
  captureCanvasModifierSelectionIntent,
  isCanvasCardDeletable,
  nextCanvasSelection,
  preservesCanvasSelectionOnFocus,
  type CanvasModifierSelectionIntent,
} from "./canvas-selection";
import {
  CanvasTileInspector,
  type CanvasInspectorEditorFocusResult,
} from "./canvas-tile-inspector";
import type { AgentContextArtifact } from "./agent-context-publisher";
import type {
  CanvasAgentContextCandidate,
  CanvasAgentContextCandidateArtifact,
} from "./agent-context-publisher";
import type {
  ArtifactFocusIdentity,
} from "@/opencut/host/artifact-focus-contract";

export type CanvasCard = {
  aspectRatio?: string | null;
  /** Ratio declared by the tool call before the durable artifact exists. */
  toolAspectRatio?: string | null;
  /** Optional operation progress. Omitted means genuinely indeterminate. */
  progress?: number | null;
  /** Source conditioning ratio used when an operation has not chosen output geometry. */
  sourceAspectRatio?: string | null;
  /** Workflow/project ratio fallback used after explicit and source geometry. */
  workflowAspectRatio?: string | null;
  /** Safe user-facing recovery text from a durable operation receipt. */
  remediation?: string | null;
  /** Canonical semantic output kind; render fallback can remain image-shaped. */
  pieceKind?: CanvasPieceKind;
  /** Placeholder-only: render narrower than the standard card width. */
  displayWidth?: number | null;
  /** Set for reference/profile tiles: the reference category. */
  refCategory?: string | null;
  /** Tile media is a 3x3 contact sheet — zoom into the first cell. */
  sheetFallback?: boolean;
  duration?: number | null;
  generating?: boolean;
  /** Server-declared grouping (from canvas_group frontmatter): tiles that share
   * a group id are auto-arranged together on the canvas, e.g. a storyboard row. */
  group?: {
    id: string;
    index: number;
    layout?: "grid" | null;
    organizedAt?: string | null;
    title: string;
  } | null;
  id: string;
  /** Minified source thumbnails shown on in-flight composer placeholders. */
  refThumbs?: { id: string; thumb: string | null }[];
  kind: "audio" | "clip" | "image" | "keyframe" | "video";
  path: string;
  prompt?: StoryboardPromptDraft | StoryboardClipPrompt;
  src: string | null;
  status: string;
  title: string;
  tracks?: VideoTrackingRecord[];
  versions?: StoryboardMediaVersion[];
};

function deleteConfirmationDescription(cards: CanvasCard[]) {
  if (!cards.length) return "";
  const visibleTitles = cards.slice(0, 3).map((card) => `“${card.title}”`);
  const remaining = cards.length - visibleTitles.length;
  const titles =
    remaining > 0
      ? `${visibleTitles.join(", ")}, and ${remaining} more`
      : visibleTitles.join(cards.length === 2 ? " and " : ", ");
  return `${titles} will be removed from the Canvas. The project records remain recoverable.`;
}

/**
 * Dependency arrows drawn between tiles (what fed into what). Lives inside
 * .canvas-world so it inherits the pan/zoom transform — no coordinate math.
 * Renders behind the cards, so anchoring at tile centres is enough: the line
 * only shows in the gap between tiles, which keeps it accurate without
 * measuring every tile's real height.
 */
function CanvasLineageArrows({
  activeIds,
  edges,
  hoveredId,
  pinned,
  positions,
}: {
  activeIds: Set<string>;
  edges: { from: string; to: string; via: string }[];
  hoveredId: string | null;
  pinned: boolean;
  positions: Record<string, Point>;
}) {
  const visible = useMemo(() => {
    if (!edges.length) return [];
    const shown = edges.filter((edge) => {
      if (!positions[edge.from] || !positions[edge.to]) return false;
      if (pinned) return true;
      if (hoveredId && (edge.from === hoveredId || edge.to === hoveredId)) return true;
      return activeIds.has(edge.to) || activeIds.has(edge.from);
    });
    // De-dupe: two artifacts can be linked by more than one provenance field.
    const seen = new Set<string>();
    return shown.filter((edge) => {
      const key = `${edge.from}->${edge.to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [activeIds, edges, hoveredId, pinned, positions]);

  if (!visible.length) return null;

  const halfW = CANVAS_CARD_WIDTH / 2;
  const halfH = CANVAS_LINEAGE_NOMINAL_HEIGHT / 2;

  return (
    <svg className="canvas-lineage-layer" aria-hidden="true">
      <defs>
        {/* userSpaceOnUse so the head keeps a sane size independent of the
            (deliberately heavy) stroke width. A chevron reads lighter than a
            filled triangle at this weight. */}
        {(["idle", "live"] as const).map((tone) => (
          <marker
            id={`canvas-lineage-head-${tone}`}
            key={tone}
            markerHeight="20"
            markerUnits="userSpaceOnUse"
            markerWidth="22"
            orient="auto"
            refX="16"
            refY="10"
          >
            <path className={`canvas-lineage-head is-${tone}`} d="M4,3 L16,10 L4,17" />
          </marker>
        ))}
      </defs>
      {visible.map((edge) => {
        const from = positions[edge.from]!;
        const to = positions[edge.to]!;
        const x1 = from.x + halfW;
        const y1 = from.y + halfH;
        const x2 = to.x + halfW;
        const y2 = to.y + halfH;
        // Pull the head back toward the source so it lands outside the target
        // tile rather than under it.
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const inset = Math.min(len - 1, halfH + 34);
        const hx = x2 - (dx / len) * inset;
        const hy = y2 - (dy / len) * inset;
        // Ease the curve out along the dominant axis, so side-by-side tiles get
        // a flow-diagram S and stacked tiles bend vertically instead of looping.
        const cdx = hx - x1;
        const cdy = hy - y1;
        const horizontal = Math.abs(cdx) >= Math.abs(cdy);
        const span = horizontal ? Math.abs(cdx) : Math.abs(cdy);
        const bend = Math.min(300, Math.max(90, span * 0.42));
        const dir = horizontal ? Math.sign(cdx) || 1 : Math.sign(cdy) || 1;
        const c1 = horizontal ? `${x1 + dir * bend},${y1}` : `${x1},${y1 + dir * bend}`;
        const c2 = horizontal ? `${hx - dir * bend},${hy}` : `${hx},${hy - dir * bend}`;
        const live = activeIds.has(edge.to) || activeIds.has(edge.from);
        const d = `M${x1},${y1} C${c1} ${c2} ${hx},${hy}`;
        return (
          <g key={`${edge.from}->${edge.to}`}>
            <path
              className={`canvas-lineage-edge ${live ? "is-live" : ""}`}
              d={d}
              markerEnd={`url(#canvas-lineage-head-${live ? "live" : "idle"})`}
            />
            {/* A red shimmer travels along the light gray base line in the
                dependency's direction: a bright head with a tail that fades
                into the gray (three aligned dash layers, one period). */}
            <path className="canvas-lineage-pulse is-tail" d={d} />
            <path className="canvas-lineage-pulse is-mid" d={d} />
            <path className="canvas-lineage-pulse is-core" d={d} />
          </g>
        );
      })}
    </svg>
  );
}

export type CanvasPromptRequest = {
  card: CanvasCard;
  text: string;
};

export type CanvasDrawRequest = {
  card: CanvasCard;
  request: DrawOverRegenerateRequest;
};

export type CanvasDeleteRequest = {
  cards: CanvasCard[];
};

export type CanvasEditClipRequest = {
  card: CanvasCard;
  mode: "new" | "version";
  trim: {
    endSeconds: number;
    startSeconds: number;
  };
};

type Point = { x: number; y: number };
type RectSnapshot = {
  height: number;
  left: number;
  top: number;
  width: number;
};
type LocalTileKind = "audio" | "image" | "video";
type MarqueeSelection = {
  current: Point;
  start: Point;
} | null;
type TrimDraft = {
  cardId: string;
  duration: number;
  endSeconds: number;
  startSeconds: number;
} | null;
type CanvasConnection = {
  cardIds: string[];
  collapsed?: boolean;
  id: string;
  name: string;
};
type CanvasGroup = {
  cardIds: string[];
  color: string;
  height: number;
  id: string;
  layout?: "column" | "grid" | "row";
  minHeight?: number;
  minWidth?: number;
  title: string;
  width: number;
  x: number;
  y: number;
};
/** Icon for a ticker action, mirroring the chat transcript's tool rows. */
function ActionTickerIcon({ tool }: { tool?: string }) {
  const Icon =
    tool === "generateVideo" ||
    tool === "generateClip" ||
    tool === "generateVideoFromImage" ||
    tool === "generateVideoFromReferences"
      ? Video
      : tool === "generateImage" ||
          tool === "generateKeyframe" ||
          tool === "extractFrame" ||
          tool === "captureFrame" ||
          tool === "generateReferencePortfolio" ||
          tool === "injectCharacter"
        ? ImageIcon
        : tool === "generateSpeech" || tool === "generateMusic" || tool === "generateAudio"
          ? AudioLines
          : tool === "extractShots"
            ? Scissors
            : tool === "viewImage" || tool === "viewWorkspaceImage" || tool === "reviewKeyframes"
              ? Eye
              : tool === "webSearch" || tool === "searchImages"
                ? Search
                : tool === "readFile" ||
                    tool === "listFiles" ||
                    tool === "readVideoEditor" ||
                    tool === "writeFile" ||
                    tool === "patchFile"
                  ? FileText
                  : Wrench;
  return <Icon className="tool-call-icon" size={13} strokeWidth={2} aria-hidden />;
}

const IMAGE_ADJUST_PARAMS = [
  { key: "brightness", label: "Brightness" },
  { key: "contrast", label: "Contrast" },
  { key: "saturation", label: "Saturation" },
  { key: "warmth", label: "Warmth" },
  { key: "hue", label: "Hue" },
  { key: "sharpen", label: "Sharpen" },
  { key: "vignette", label: "Vignette" },
  { key: "blur", label: "Blur" },
] as const;
type ImageAdjustParamKey = (typeof IMAGE_ADJUST_PARAMS)[number]["key"];
const NEUTRAL_IMAGE_ADJUST: Record<ImageAdjustParamKey, number> = {
  blur: 0,
  brightness: 50,
  contrast: 50,
  hue: 50,
  saturation: 50,
  sharpen: 0,
  vignette: 0,
  warmth: 50,
};
type ImageAdjustState = {
  activeParam: ImageAdjustParamKey | null;
  cardId: string;
  crop: { height: number; width: number; x: number; y: number } | null;
  mode: "crop" | "filters";
  params: Record<ImageAdjustParamKey, number>;
  saving: boolean;
};
type SequenceReorderState = {
  cardId: string;
  connectionId: string;
} | null;
type TimelineContextTarget =
  | { cardId: string; seconds: number; type: "rail" }
  | {
      cardId: string;
      endSeconds: number;
      index: number;
      seconds: number;
      startSeconds: number;
      type: "segment";
    }
  | { cardId: string; index: number; seconds: number; type: "split" }
  | null;
type DragState = {
  groupSnapshots?: Record<string, CanvasGroup>;
  ids: string[];
} | null;
type GroupDropPreview = {
  group: CanvasGroup;
  groupId: string;
  positions: Record<string, Point>;
};
type StoredCanvasViewState = {
  autoGrouped?: string[];
  connections?: CanvasConnection[];
  groups?: CanvasGroup[];
  pan?: Point;
  positions?: Record<string, Point>;
  scale?: number;
  selectedId?: string | null;
  selectedIds?: string[];
  stagedCardIds?: string[];
};

type CanvasYoutubeImportResult = {
  importId?: string;
};

type CanvasYoutubeRequirement = {
  assetId: string;
  description?: string;
  kind?: string;
  label?: string;
  neededForShots?: string[];
  reason?: string;
  required?: boolean;
  resolvedPath?: string | null;
  status?: "missing" | "resolved";
};

type CanvasYoutubeRequirementPayload = {
  plan?: {
    blockingQuestions?: Array<{ question: string; reason?: string }>;
    readyToGenerate?: boolean;
  } | null;
  record?: {
    error?: string | null;
    id: string;
    slots?: CanvasYoutubeImportSlotSummary[];
    status: string;
  };
  requirements?: CanvasYoutubeRequirement[];
};

type CanvasImportState = {
  label: string;
  state: "idle" | "running" | "needs_input" | "done" | "failed";
};

type CanvasYoutubeImportSlotSummary = {
  status: string;
};

type CanvasYoutubeImportSummary = {
  error?: string | null;
  id: string;
  slots: CanvasYoutubeImportSlotSummary[];
  status: string;
  updatedAt?: string;
};

// Workflows are internal orchestration aids, not a mode the user must choose.
const FLOWS_ENABLED = false;

/** Tiles are passive, muted, looping mirrors — the drawer owns playback.
 * Flip to true to restore the legacy on-tile scrub/controls overlay. */
const TILE_PLAYBACK_CONTROLS = false;

const CANVAS_CARD_WIDTH = 380;
/** Approximate tile height, used only to anchor lineage arrows (drawn behind
 * the tiles, so small error is hidden under the card). */
const CANVAS_LINEAGE_NOMINAL_HEIGHT = 250;
const CANVAS_COLUMN_GAP = 432;
const CANVAS_ROW_GAP = 320;
const CANVAS_FOCUS_DURATION_MS = 170;
const CANVAS_FOCUS_PADDING = 48;
const MARQUEE_EDGE_PAN_ZONE = 72;
const MARQUEE_EDGE_PAN_MAX = 14;
const CANVAS_MEDIA_MAX_HEIGHT = 420;
const CANVAS_MEDIA_MIN_HEIGHT = 180;
const AUDIO_WAVE_SAMPLES = 96;

function youtubeImportStateFromRecord(record: {
  error?: string | null;
  slots?: CanvasYoutubeImportSlotSummary[];
  status: string;
}): CanvasImportState {
  const slots = record.slots ?? [];
  const total = slots.length;
  const completed = slots.filter((slot) => slot.status === "completed").length;
  const failed = slots.filter((slot) => slot.status === "failed").length;
  if (record.status === "needs_assets") {
    return { label: "Planner needs inputs", state: "needs_input" };
  }
  if (record.status === "generating") {
    return {
      label: total ? `Generating ${completed}/${total}${failed ? `, ${failed} failed` : ""}` : "Generating clips...",
      state: "running",
    };
  }
  if (record.status === "completed") {
    return { label: total ? `Import complete: ${completed}/${total}` : "Import complete", state: "done" };
  }
  if (record.status === "failed") {
    return { label: record.error || "Import failed", state: "failed" };
  }
  if (record.status === "planning" || record.status === "running" || record.status === "queued" || record.status === "source_ready") {
    return { label: "Planning YouTube import...", state: "running" };
  }
  return { label: "", state: "idle" };
}

function isTerminalYoutubeImportStatus(status: string | undefined) {
  return status === "completed" || status === "failed";
}
const CANVAS_CONNECTION_GAP = 44;
const CANVAS_CONNECTION_PADDING = 32;
const CANVAS_CONNECTION_TIMELINE = 82;
const CANVAS_CONNECTION_TIMELINE_GAP = 8;
const CONNECTION_PREROLL_SECONDS = 0.12;
const CANVAS_GROUP_PADDING = 40;
const CANVAS_GROUP_GAP = 40;
const CANVAS_GROUP_MIN_WIDTH = 360;
const CANVAS_GROUP_MIN_HEIGHT = 260;
const CANVAS_GROUP_COLORS = [
  "#ef4444",
  "#2563eb",
  "#16a34a",
  "#d97706",
  "#7c3aed",
  "#0891b2",
];

function cssAspectRatio(value: string | null | undefined) {
  if (value?.includes("/")) return value;
  if (value === "9:16") return "9 / 16";
  if (value === "1:1") return "1 / 1";
  return "16 / 9";
}

function measuredAspectRatio(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return `${Math.round(width)} / ${Math.round(height)}`;
}

function formatCanvasTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  return `${minutes}:${wholeSeconds.toString().padStart(2, "0")}`;
}

function connectionColorFromName(name: string) {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash << 5) - hash + name.charCodeAt(index);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 76% 54%)`;
}

function heightForAspectRatio(
  aspectRatio: string | null | undefined,
  baseWidth: number = CANVAS_CARD_WIDTH,
) {
  const [width, height] = cssAspectRatio(aspectRatio)
    .split("/")
    .map((part) => Number(part.trim()));
  if (width && height && Number.isFinite(width) && Number.isFinite(height)) {
    return Math.max(
      CANVAS_MEDIA_MIN_HEIGHT,
      Math.min(CANVAS_MEDIA_MAX_HEIGHT, baseWidth * (height / width)),
    ) + 32;
  }
  return Math.max(
    CANVAS_MEDIA_MIN_HEIGHT,
    Math.min(CANVAS_MEDIA_MAX_HEIGHT, baseWidth * (9 / 16)),
  ) + 32;
}

function cardWidth(card: CanvasCard | null | undefined) {
  return card?.displayWidth ?? CANVAS_CARD_WIDTH;
}

function cardHeight(card: CanvasCard, measuredRatio?: string) {
  if (card.kind === "audio") return 260;
  return heightForAspectRatio(
    resolvePieceAspectRatio({
      explicit: card.aspectRatio,
      intrinsic: measuredRatio,
      source: card.sourceAspectRatio,
      tool: card.toolAspectRatio,
      workflowDefault: card.workflowAspectRatio,
    }),
    cardWidth(card),
  );
}

function canvasPieceKindForCard(card: CanvasCard): CanvasPieceKind {
  if (card.pieceKind) return canvasPieceKind(card.pieceKind);
  if (card.refCategory) return canvasPieceKind(card.refCategory) === "object" ? "object" : "reference";
  return canvasPieceKind(card.kind);
}

export function canvasAgentContextArtifact(
  card: CanvasCard,
  versionIndex: number | null,
): CanvasAgentContextCandidateArtifact {
  const versions = card.versions ?? [];
  const selectedVersion =
    versionIndex !== null && versionIndex >= 0 && versionIndex < versions.length
      ? versions[versionIndex]
      : null;
  return {
    artifactId: card.id,
    kind: canvasPieceKindForCard(card),
    sourcePath: card.path,
    title: card.title || null,
    version: selectedVersion
      ? {
          index: versionIndex!,
          path: selectedVersion.path ?? null,
          revision: selectedVersion.revision ?? versionIndex! + 1,
          versionId:
            selectedVersion.label.replace(/[^A-Za-z0-9._:@-]/g, "_") ||
            `v${versionIndex! + 1}`,
        }
      : null,
  };
}

function fitScaleForRect(viewport: { height: number; width: number }, width: number, height: number) {
  const availableWidth = Math.max(120, viewport.width - CANVAS_FOCUS_PADDING * 2);
  const availableHeight = Math.max(120, viewport.height - CANVAS_FOCUS_PADDING * 2);
  return Math.min(1, availableWidth / width, availableHeight / height);
}

function easeOutCubic(value: number) {
  return 1 - Math.pow(1 - value, 3);
}

function drawVideoFrameToCoverCanvas(canvas: HTMLCanvasElement, video: HTMLVideoElement) {
  if (video.readyState < 2) return false;
  const context = canvas.getContext("2d");
  if (!context) return false;
  const cssWidth = Math.max(1, canvas.clientWidth || video.videoWidth || CANVAS_CARD_WIDTH);
  const cssHeight = Math.max(1, canvas.clientHeight || video.videoHeight || CANVAS_CARD_WIDTH * (9 / 16));
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const nextWidth = Math.round(cssWidth * ratio);
  const nextHeight = Math.round(cssHeight * ratio);
  if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
    canvas.width = nextWidth;
    canvas.height = nextHeight;
  }
  const sourceWidth = video.videoWidth || canvas.width;
  const sourceHeight = video.videoHeight || canvas.height;
  const scale = Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  context.fillStyle = "#050505";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  return true;
}

function currentVersionIndex(versions: StoryboardMediaVersion[]) {
  const active = versions.findIndex((version) => version.isCurrent);
  return active >= 0 ? active : Math.max(0, versions.length - 1);
}


let canvasKeySeed = Math.floor(Math.random() * 1e9);

function nextCanvasKey(prefix: string) {
  canvasKeySeed += 1;
  return `${prefix}-${canvasKeySeed.toString(36)}`;
}

/** Deterministic top-left → bottom-right gradient derived from a workflow's
 * title — the tile's stand-in "profile media" until it has a real image. */
const BROWSE_FILTERS: Array<[string, string | null]> = [
  ["All", null],
  ["Characters", "character"],
  ["Locations", "environment"],
  ["Objects", "prop"],
  ["Styles", "style"],
  ["Features", "feature"],
];

function browseKindLabel(kind?: string) {
  const entry = BROWSE_FILTERS.find(([, value]) => value === kind);
  // Singular, sentence-case: "Character", not the plural pill label.
  return entry && entry[1] ? entry[0].replace(/s$/, "") : "Reference";
}


function initialPosition(index: number): Point {
  const column = index % 3;
  const row = Math.floor(index / 3);
  return {
    x: column * CANVAS_COLUMN_GAP,
    y: row * CANVAS_ROW_GAP,
  };
}

const CanvasGeometryShell = memo(function CanvasGeometryShell({
  card,
  height,
  position,
}: {
  card: CanvasCard;
  height: number;
  position: Point;
}) {
  return (
    <div
      aria-hidden="true"
      className="canvas-card canvas-card-geometry-shell"
      data-card-id={card.id}
      data-virtualized="true"
      style={{
        height,
        transform: `translate(${position.x}px, ${position.y}px)`,
        width: cardWidth(card),
      }}
    />
  );
});

function canvasViewStorageKey(projectId: string) {
  return `video-fs:canvas-view:${projectId}`;
}

function readStoredCanvasView(projectId: string): StoredCanvasViewState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(canvasViewStorageKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredCanvasViewState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function activeVideoTrack(card: CanvasCard, staleTrackIds: Set<string>) {
  // Tracks that predate this canvas session are history, not live requests —
  // they should not keep overlaying boxes or progress chrome on the tile.
  const tracks = (card.tracks ?? []).filter((track) => !staleTrackIds.has(track.id));
  return tracks.find((track) => track.status === "queued" || track.status === "running")
    ?? tracks.find((track) => track.status === "completed" && track.boxes.length)
    ?? null;
}

function trackingBoxAtTime(track: VideoTrackingRecord | null, seconds: number): VideoTrackingBox | null {
  if (!track || track.status !== "completed" || !track.boxes.length) return null;
  const relativeTime = Math.max(track.frame.startTime, seconds);
  let best = track.boxes[0] ?? null;
  for (const box of track.boxes) {
    if (box.t > relativeTime) break;
    best = box;
  }
  return best;
}

export function CanvasWorkspace({
  actions = [],
  cards,
  composerVisible = true,
  focusRequest,
  editingCardIds,
  editorPlacements = [],
  isAborting = false,
  isSending = false,
  onAbort,
  onComposerRequest,
  onCreateRequest,
  onDeleteCards,
  onDrawRequest,
  onEditClip,
  onImportYoutube,
  onOpenFile,
  onOpenInEditor,
  onPromptRequest,
  onRefreshProject,
  browseItems,
  onBrowsePick,
  onRegisterOpenFlows,
  onRegisterOpenBrowse,
  onBrowseImport,
  onOpenShortcuts,
  onApplySnapshot,
  onAgentContextChange,
  onAgentContextClear,
  onRegisterUnstage,
  onShareProject,
  onSwitchView,
  onStagedRefsChange,
  onSelectedTileChange,
  onUploadFiles,
  onWorkflowPick,
  projectId,
  resolvedCanvasArtifacts = [],
  spawnOrigins,
  timeline = [],
  youtubeImports = [],
}: {
  /** Live composer action ticker entries (fade in on start, out on finish). */
  actions?: { key: string; label: string; leaving: boolean; tool?: string }[];
  cards: CanvasCard[];
  composerVisible?: boolean;
  focusRequest?: {
    artifact?: ArtifactFocusIdentity;
    id: string;
    ids?: string[];
    kind: "card" | "clip" | "keyframe";
    nonce: number;
    openInspector?: boolean;
  } | null;
  /** Tiles with an in-flight revision — shown with a working shimmer. */
  editingCardIds?: Set<string>;
  editorPlacements?: CanonicalEditorPlacement[];
  isAborting?: boolean;
  isSending?: boolean;
  onAbort?: () => void;
  /** Publishes the complete ordered Canvas selection and deliberate pins. */
  onAgentContextChange?: (context: CanvasAgentContextCandidate) => void;
  /** Records an explicit blank-click or Escape clear in the shared context log. */
  onAgentContextClear?: () => void;
  onComposerRequest?: (
    text: string,
    focus?: CanvasCard[] | null,
    options?: { imageModel?: string | null },
  ) => Promise<void>;
  onCreateRequest: (text: string) => Promise<void>;
  onDeleteCards: (request: CanvasDeleteRequest) => Promise<void>;
  onDrawRequest: (request: CanvasDrawRequest) => Promise<void>;
  onEditClip: (request: CanvasEditClipRequest) => Promise<void>;
  onImportYoutube: (url: string, brief?: string) => Promise<CanvasYoutubeImportResult | void>;
  onOpenFile: (path: string) => void;
  onOpenInEditor?: (request: {
    artifact: CanvasAgentContextCandidateArtifact;
    relink?: boolean;
    timelineElementId?: string | null;
  }) => Promise<CanvasInspectorEditorFocusResult>;
  onPromptRequest: (request: CanvasPromptRequest) => Promise<void>;
  onRefreshProject: () => Promise<void>;
  onUploadFiles?: (files: File[]) => Promise<void>;
  /** Optional notification after a workflow prefills the visible Canvas composer. */
  onWorkflowPick?: (text: string) => void;
  /** Mirrors the staged reference tray up to the host so the main chat
   * composer can show (and send) the same context. */
  onStagedRefsChange?: (refs: Array<{ aspectRatio: string | null; id: string; kind: string; src: string | null; title: string }>) => void;
  /** The single focused/selected tile, mirrored up so the chat agent can be
   * told what the user is looking at (edit-vs-create target). */
  onSelectedTileChange?: (tile: { id: string; kind: string; title: string } | null) => void;
  /** Hands the host an unstage function so remove works from either surface. */
  onRegisterUnstage?: (unstage: (id: string) => void) => void;
  /** Hands the host the Flows-modal opener (used by /workflows in chat). */
  onRegisterOpenFlows?: (open: () => void) => void;
  onRegisterOpenBrowse?: (open: () => void) => void;
  onBrowseImport?: (item: { id: string; title: string }) => void;
  onOpenShortcuts?: () => void;
  /** Fast path: apply a snapshot returned inline by an op (skips a refetch). */
  onApplySnapshot?: (snapshot: unknown) => void;
  onShareProject?: () => void;
  onSwitchView?: (view: "canvas" | "editor" | "plan") => void;
  browseItems?: Array<{ id: string; kind?: string; src?: string | null; title: string }>;
  onBrowsePick?: (item: { id: string; title: string }) => void;
  projectId: string;
  resolvedCanvasArtifacts?: AgentContextArtifact[];
  /** Finished-artifact id → placeholder id whose position it inherits. */
  spawnOrigins?: Record<string, string>;
  /** Canonical derived timeline document; never infer usage from Canvas groups. */
  timeline?: TimelineItem[];
  youtubeImports?: CanvasYoutubeImportSummary[];
}) {
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  // Captured once at mount: tracks that already existed are history, not live
  // requests, and must not re-render their overlays on the tiles.
  const [staleTrackIds] = useState(
    () => new Set(cards.flatMap((card) => (card.tracks ?? []).map((track) => track.id))),
  );
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const localUploadInputRef = useRef<HTMLInputElement | null>(null);
  const localCardsRef = useRef<CanvasCard[]>([]);
  const focusAnimationRef = useRef<number | null>(null);
  /** Nonce of the last focusRequest already animated — prevents re-animating
   * the same request when cards/positions recompute mid-run. */
  const handledFocusNonceRef = useRef<number | null>(null);
  const connectionPlaybackRef = useRef<{ connectionId: string; index: number } | null>(null);
  const connectionCanvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});
  const playbackStateRef = useRef<CanvasPlaybackState>(readCanvasPlaybackState(projectId));
  const projectIdRef = useRef(projectId);
  const inspectorReturnFocusRef = useRef<string | null>(null);
  const pendingModifierFocusRef =
    useRef<CanvasModifierSelectionIntent | null>(null);
  const [positions, setPositions] = useState<Record<string, Point>>(
    () => readStoredCanvasView(projectId).positions ?? {},
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    () => readStoredCanvasView(projectId).selectedId ?? cards[0]?.id ?? null,
  );
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    const stored = readStoredCanvasView(projectId);
    const persisted = stored.selectedIds?.filter((id) =>
      cards.some((card) => card.id === id),
    );
    if (persisted?.length) return [...new Set(persisted)];
    const initial = stored.selectedId ?? cards[0]?.id ?? null;
    return initial ? [initial] : [];
  });
  const [localCards, setLocalCards] = useState<CanvasCard[]>([]);
  const [localUploadKind, setLocalUploadKind] = useState<LocalTileKind>("image");
  const [measuredAspectRatios, setMeasuredAspectRatios] = useState<Record<string, string>>({});
  const [mediaCurrentTimes, setMediaCurrentTimes] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      Object.entries(playbackStateRef.current).map(([id, entry]) => [id, entry.currentTime]),
    ),
  );
  const [mediaDurations, setMediaDurations] = useState<Record<string, number>>({});
  const [frameStrips, setFrameStrips] = useState<Record<string, string[]>>({});
  const [marquee, setMarquee] = useState<MarqueeSelection>(null);
  const [connections, setConnections] = useState<CanvasConnection[]>(
    () => readStoredCanvasView(projectId).connections ?? [],
  );
  const [groups, setGroups] = useState<CanvasGroup[]>(
    () => readStoredCanvasView(projectId).groups ?? [],
  );
  /** Card ids the server-group effect has already placed once. A card in this
   * set is never auto-regrouped, so ungrouping/dragging out sticks. */
  const [autoGroupedCardIds, setAutoGroupedCardIds] = useState<Set<string>>(
    () => new Set(readStoredCanvasView(projectId).autoGrouped ?? []),
  );
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupCreateArmed, setGroupCreateArmed] = useState(false);
  const [groupDraft, setGroupDraft] = useState<MarqueeSelection>(null);
  const [sequenceReorder, setSequenceReorder] = useState<SequenceReorderState>(null);
  const [dragState, setDragState] = useState<DragState>(null);
  /** Original positions of the tiles in the active drag — group boxes are
   * sized against these so they stay frozen until the drop commits. */
  const cardDragOriginRef = useRef<Record<string, Point> | null>(null);
  const [groupDropPreview, setGroupDropPreview] = useState<GroupDropPreview | null>(null);
  const [connectionPreviewCardIds, setConnectionPreviewCardIds] = useState<Record<string, string>>({});
  const [overlayRect, setOverlayRect] = useState<RectSnapshot | null>(null);
  const [playingVideoId, setPlayingVideoId] = useState<string | null>(null);
  const [playingConnectionId, setPlayingConnectionId] = useState<string | null>(null);
  const [connectionPlaybackTimes, setConnectionPlaybackTimes] = useState<Record<string, number>>({});
  const [playbackRates, setPlaybackRates] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      Object.entries(playbackStateRef.current).map(([id, entry]) => [id, entry.playbackRate]),
    ),
  );
  const [unmutedCardIds, setUnmutedCardIds] = useState<string[]>([]);
  const [scrubbingCardId, setScrubbingCardId] = useState<string | null>(null);
  /** A locally created tile (duplicate, extract) to select+zoom once it lands. */
  const [pendingFocusCardId, setPendingFocusCardId] = useState<string | null>(null);
  const [audioWaveforms, setAudioWaveforms] = useState<Record<string, number[]>>({});
  const waveformFetchesRef = useRef<Set<string>>(new Set());
  const [trimDraft, setTrimDraft] = useState<TrimDraft>(null);
  const [trimModeCardId, setTrimModeCardId] = useState<string | null>(null);
  const [splitMarkers, setSplitMarkers] = useState<Record<string, number[]>>({});
  const [hiddenSegments, setHiddenSegments] = useState<Record<string, number[]>>({});
  const [timelineContextTarget, setTimelineContextTarget] = useState<TimelineContextTarget>(null);
  const [pendingSelectionId, setPendingSelectionId] = useState<string | null | undefined>();
  const [savingClipEdit, setSavingClipEdit] = useState(false);
  const [customPlaybackRate, setCustomPlaybackRate] = useState("1");
  const [versionSelection, setVersionSelection] = useState<
    Record<string, { count: number; index: number }>
  >({});
  const [focusedInspectorCardId, setFocusedInspectorCardId] = useState<string | null>(null);
  const [pan, setPan] = useState<Point>(
    () => readStoredCanvasView(projectId).pan ?? { x: 80, y: 120 },
  );
  const [scale, setScale] = useState(() => readStoredCanvasView(projectId).scale ?? 1);
  const panRef = useRef(pan);
  const [viewportSize, setViewportSize] = useState({ height: 900, width: 1440 });
  const [importUrl, setImportUrl] = useState("");
  const [importBrief, setImportBrief] = useState("");
  const [importProductDescription, setImportProductDescription] = useState("");
  const [importTargetAudience, setImportTargetAudience] = useState("");
  const [importKeyMessages, setImportKeyMessages] = useState("");
  const [importBrandGuidelines, setImportBrandGuidelines] = useState("");
  const [importCtaUrl, setImportCtaUrl] = useState("");
  const [importForbiddenConcepts, setImportForbiddenConcepts] = useState("");
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [pendingDeleteCards, setPendingDeleteCards] = useState<CanvasCard[] | null>(null);
  const [imageAdjust, setImageAdjust] = useState<ImageAdjustState | null>(null);
  /** Optional image-model override picked from the Tools pill; null = auto. */
  /** True while the viewport or tiles are actively moving; the focused
   * toolbar disables its glide transition so it stays glued to the tile. */
  const [viewInMotion, setViewInMotion] = useState(false);
  const viewMotionTimer = useRef<number | null>(null);
  /** Tiles explicitly staged as composer references via the hover + button. */
  const [stagedCardIds, setStagedCardIds] = useState<string[]>(() => {
    const stored = readStoredCanvasView(projectId);
    return [
      ...new Set(
        (stored.stagedCardIds ?? []).filter((id) =>
          cards.some((card) => card.id === id),
        ),
      ),
    ];
  });
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  /** Derived dependency graph (what fed into what) for the arrow overlay. */
  const [lineageEdges, setLineageEdges] = useState<{ from: string; to: string; via: string }[]>([]);
  /** Top-right toggle: keep every arrow on instead of only contextual ones. */
  const [arrowsPinned, setArrowsPinned] = useState(false);
  /** Live state while a dragged tile hovers the composer drop zone: drives the
   * minified ghost chip at the cursor and the dock highlight. */
  const [dockDropGhost, setDockDropGhost] = useState<{
    thumb: string | null;
    title: string;
    x: number;
    y: number;
  } | null>(null);
  const [activeImportId, setActiveImportId] = useState<string | null>(null);
  const [importRequirements, setImportRequirements] = useState<CanvasYoutubeRequirementPayload | null>(null);
  const [importState, setImportState] = useState<CanvasImportState>({ label: "", state: "idle" });
  const onRefreshProjectRef = useRef(onRefreshProject);
  const [draft, setDraft] = useState<{
    id: string;
    runMode?: "workflow";
    text: string;
  }>({ id: "", text: "" });
  const [workflowRecipes, setWorkflowRecipes] = useState<
    Array<{ category: string; description: string; id: string; title: string }>
  >([]);
  const [flowsModalOpen, setFlowsModalOpen] = useState(false);
  const [browseModalOpen, setBrowseModalOpen] = useState(false);
  const [browseModalQuery, setBrowseModalQuery] = useState("");
  const [browseModalFilter, setBrowseModalFilter] = useState("All");
  const [submitting, setSubmitting] = useState(false);
  const [drawMode, setDrawMode] = useState<{
    cardId: string;
    marks: DrawOverAnnotation[];
    tool: "rect" | "freehand";
  } | null>(null);
  const [drawSubmitting, setDrawSubmitting] = useState(false);
  const trimDraftRef = useRef<TrimDraft>(null);
  /** Optimistic tombstones: deleted tiles vanish immediately; the entry is
   * pruned once the server snapshot confirms, or restored if deletion fails. */
  const [deletedCardIds, setDeletedCardIds] = useState<Set<string>>(new Set());
  const allCards = useMemo(
    () => [...localCards, ...cards].filter((card) => !deletedCardIds.has(card.id)),
    [cards, localCards, deletedCardIds],
  );

  const rememberPlayback = useCallback(
    (cardId: string, update: Partial<CanvasPlaybackState[string]>) => {
      const current = playbackStateRef.current[cardId] ?? {
        currentTime: 0,
        muted: true,
        playbackRate: 1,
        selectedVersion: -1,
        wasPlaying: false,
      };
      playbackStateRef.current = {
        ...playbackStateRef.current,
        [cardId]: { ...current, ...update },
      };
      writeCanvasPlaybackState(projectId, playbackStateRef.current);
    },
    [projectId],
  );

  useEffect(() => {
    if (projectIdRef.current === projectId) return;
    for (const media of document.querySelectorAll<HTMLMediaElement>(
      "video[data-canvas-card-id], audio[data-canvas-card-id]",
    )) {
      media.pause();
      media.muted = true;
      media.removeAttribute("src");
      media.load();
    }
    for (const card of localCardsRef.current) {
      if (card.src?.startsWith("blob:")) URL.revokeObjectURL(card.src);
    }
    const restored = readCanvasPlaybackState(projectId);
    playbackStateRef.current = restored;
    projectIdRef.current = projectId;
    setPlayingVideoId(null);
    setPlayingConnectionId(null);
    setUnmutedCardIds([]);
    setMediaCurrentTimes(
      Object.fromEntries(Object.entries(restored).map(([id, entry]) => [id, entry.currentTime])),
    );
    setPlaybackRates(
      Object.fromEntries(Object.entries(restored).map(([id, entry]) => [id, entry.playbackRate])),
    );
    setFrameStrips({});
    setAudioWaveforms({});
    waveformFetchesRef.current.clear();
    setLocalCards([]);
    setFocusedInspectorCardId(null);
  }, [projectId]);

  // Tiles mid-generation or mid-edit flash their dependencies, so a tile
  // appearing or changing explains itself instead of just popping in.
  const activeLineageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const card of allCards) {
      if (card.generating || editingCardIds?.has(card.id)) ids.add(card.id);
    }
    return ids;
  }, [allCards, editingCardIds]);

  // Refresh the dependency graph as tiles come and go — it's derived from the
  // artifacts' provenance frontmatter, so the card count is a good enough signal.
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/projects/${projectId}/canvas/lineage`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { edges?: { from: string; to: string; via: string }[] } | null) => {
        if (!cancelled && Array.isArray(data?.edges)) setLineageEdges(data.edges);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, cards.length]);
  useEffect(() => {
    // Prune tombstones the server has confirmed gone.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDeletedCardIds((current) => {
      if (!current.size) return current;
      const liveIds = new Set(cards.map((card) => card.id));
      const next = new Set([...current].filter((id) => liveIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [cards]);

  useEffect(() => {
    trimDraftRef.current = trimDraft;
  }, [trimDraft]);

  useEffect(() => {
    onRefreshProjectRef.current = onRefreshProject;
  }, [onRefreshProject]);

  useEffect(() => {
    if (!onRegisterOpenFlows || !FLOWS_ENABLED) return;
    onRegisterOpenFlows(() => {
      setFlowsModalOpen(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRegisterOpenFlows]);

  useEffect(() => {
    if (!onRegisterOpenBrowse) return;
    onRegisterOpenBrowse(() => {
      setBrowseModalQuery("");
      setBrowseModalFilter("All");
      setBrowseModalOpen(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRegisterOpenBrowse]);

  useEffect(() => {
    if (!onRegisterUnstage) return;
    onRegisterUnstage((id: string) =>
      setStagedCardIds((current) => current.filter((entry) => entry !== id)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRegisterUnstage]);

  useEffect(() => {
    if (!onSelectedTileChange) return;
    const only = selectedIds.length <= 1 ? selectedId : null;
    const card = only ? cards.find((entry) => entry.id === only) : null;
    onSelectedTileChange(
      card ? { id: card.id, kind: canvasPieceKindForCard(card), title: card.title } : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selectedIds, cards]);

  useEffect(() => {
    if (!onStagedRefsChange) return;
    onStagedRefsChange(
      stagedCardIds
        .map((id) => cards.find((entry) => entry.id === id))
        .filter((entry): entry is CanvasCard => Boolean(entry))
        .map((entry) => ({
          aspectRatio: entry.aspectRatio ?? null,
          id: entry.id,
          kind: entry.kind,
          src: entry.src ?? null,
          title: entry.title,
        })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stagedCardIds, cards]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/workflows")
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          data: {
            workflows?: Array<{ category: string; description: string; id: string; title: string }>;
          } | null,
        ) => {
          if (!cancelled && Array.isArray(data?.workflows)) setWorkflowRecipes(data.workflows);
        },
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  const scaleRef = useRef(scale);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => {
      const rect = viewport.getBoundingClientRect();
      setViewportSize((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { height: rect.height, width: rect.width },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      canvasViewStorageKey(projectId),
      JSON.stringify({
        autoGrouped: [...autoGroupedCardIds],
        connections,
        groups,
        pan,
        positions,
        scale,
        selectedId,
        selectedIds,
        stagedCardIds,
      }),
    );
  }, [
    autoGroupedCardIds,
    connections,
    groups,
    pan,
    positions,
    projectId,
    scale,
    selectedId,
    selectedIds,
    stagedCardIds,
  ]);

  // Mirror group organization to the workspace (debounced) so the agents can
  // see the user's hand-made groups, not just frontmatter ones.
  const lastSyncedGroupsRef = useRef("");
  useEffect(() => {
    const payload = JSON.stringify({
      groups: groups.map((group) => ({
        cardIds: group.cardIds,
        id: group.id,
        title: group.title,
      })),
    });
    if (payload === lastSyncedGroupsRef.current) return;
    const handle = window.setTimeout(() => {
      lastSyncedGroupsRef.current = payload;
      void fetch(`/api/projects/${projectId}/canvas/state`, {
        body: payload,
        headers: { "content-type": "application/json" },
        method: "POST",
      }).catch(() => {});
    }, 1500);
    return () => window.clearTimeout(handle);
  }, [groups, projectId]);

  useEffect(() => {
    const collapsedConnections = connections.filter((connection) => connection.collapsed);
    if (!collapsedConnections.length) return;
    let frame: number | null = null;
    const paint = () => {
      for (const connection of collapsedConnections) {
        const canvas = connectionCanvasRefs.current[connection.id];
        if (!canvas) continue;
        const activeCardId = connectionPreviewCardIds[connection.id] ?? connection.cardIds[0];
        const viewport = viewportRef.current;
        const video =
          viewport && activeCardId
            ? viewport.querySelector<HTMLVideoElement>(`video[data-canvas-card-id="${activeCardId}"]`)
            : null;
        if (video) drawVideoFrameToCoverCanvas(canvas, video);
      }
      if (
        playingConnectionId &&
        collapsedConnections.some((connection) => connection.id === playingConnectionId)
      ) {
        frame = window.requestAnimationFrame(paint);
      }
    };
    paint();
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [connectionPreviewCardIds, connections, playingConnectionId]);

  useEffect(() => {
     
    setPositions((current) => {
      let changed = false;
      const next = { ...current };
      const cardById = new Map(allCards.map((entry) => [entry.id, entry]));
      const placementIndex = new CanvasSpatialIndex(
        Object.entries(next).flatMap(([id, position]): CanvasSpatialBox[] => {
          const card = cardById.get(id);
          if (!card) return [];
          return [
            {
              height: cardHeight(card, measuredAspectRatios[id]),
              id,
              width: cardWidth(card),
              ...position,
            },
          ];
        }),
      );
      const findFreeSpot = (desired: Point, selfId: string): Point => {
        const self = cardById.get(selfId);
        const width = cardWidth(self);
        const height = self ? cardHeight(self, measuredAspectRatios[selfId]) : 520;
        const spot = findCollisionFreePoint({
          desired,
          height,
          id: selfId,
          index: placementIndex,
          width,
        });
        placementIndex.upsert({ height, id: selfId, width, ...spot });
        return spot;
      };
      allCards.forEach((card, index) => {
        if (next[card.id]) return;
        changed = true;
        // Finished composer artifacts land exactly where their placeholder
        // blob was — no teleporting to a fresh grid slot.
        const originId = spawnOrigins?.[card.id];
        if (originId && next[originId]) {
          next[card.id] = next[originId];
          placementIndex.upsert({
            height: cardHeight(card, measuredAspectRatios[card.id]),
            id: card.id,
            width: cardWidth(card),
            ...next[card.id],
          });
          return;
        }
        // Composer placeholders spawn beside their first source tile so the
        // result lands where the user is looking; with no source they spawn
        // at the viewport center.
        if (card.id.startsWith("compose_")) {
          const sourceId = card.refThumbs?.[0]?.id;
          const sourcePosition = sourceId ? next[sourceId] : undefined;
          if (sourcePosition) {
            const sourceCard = sourceId ? cardById.get(sourceId) : null;
            const requestKey = card.id.split("_").slice(0, 2).join("_");
            const siblingCount = allCards.filter(
              (entry) =>
                entry.id !== card.id && entry.id.startsWith(requestKey) && next[entry.id],
            ).length;
            next[card.id] = findFreeSpot(
              {
                x: sourcePosition.x + cardWidth(sourceCard) + 90,
                y: sourcePosition.y + siblingCount * 140,
              },
              card.id,
            );
            return;
          }
          const viewportBox = viewportRef.current?.getBoundingClientRect();
          if (viewportBox) {
            const worldScale = scaleRef.current || 1;
            next[card.id] = findFreeSpot(
              {
                x:
                  (viewportBox.width / 2 - panRef.current.x) / worldScale -
                  cardWidth(card) / 2,
                y:
                  (viewportBox.height / 2 - panRef.current.y) / worldScale -
                  cardHeight(card, measuredAspectRatios[card.id]) / 2,
              },
              card.id,
            );
            return;
          }
        }
        next[card.id] = findFreeSpot(initialPosition(index), card.id);
      });
      return changed ? next : current;
    });
    setSelectedIds((current) => current.filter((id) => allCards.some((card) => card.id === id)));
    setStagedCardIds((current) => current.filter((id) => allCards.some((card) => card.id === id)));
    setSelectedId((current) =>
      current && allCards.some((card) => card.id === current) ? current : null,
    );
    setConnections((current) => {
      const validIds = new Set(allCards.map((card) => card.id));
      const next = current
        .map((connection) => ({
          ...connection,
          cardIds: connection.cardIds.filter((id) => validIds.has(id)),
        }))
        .filter((connection) => connection.cardIds.length > 1);
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
    setGroups((current) => {
      const validIds = new Set(allCards.map((card) => card.id));
      const next = current.map((group) => ({
        ...group,
        cardIds: group.cardIds.filter((id) => validIds.has(id)),
      }));
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- measured ratios only refine collision estimates; re-running on every image load is wasteful
  }, [allCards, spawnOrigins]);

  useEffect(() => {
    // Materialize server-declared groups (canvas_group frontmatter written by
    // the agents) into canvas groups laid out as rows. Each card is placed at
    // most ONCE (tracked in autoGroupedCardIds) — after that the user's manual
    // drags, ungroups, and deletions always win.
    const declared = new Map<string, { cards: CanvasCard[]; layout: "grid" | "row"; title: string }>();
    const placementKey = (card: CanvasCard) =>
      `${card.id}:${card.group?.id}:${card.group?.organizedAt ?? ""}`;
    for (const card of allCards) {
      if (!card.group) continue;
      // Placement is one-shot per (card, group, organize-stamp): re-organizing
      // a tile into a different group — or organizeCanvas restating the same
      // group (new stamp) — re-places it; otherwise the user's manual drags
      // win. A stamped tile is organize-managed: only its composite key blocks
      // it, so legacy plain-id entries can't pin it forever.
      const legacyBlocked = !card.group.organizedAt && autoGroupedCardIds.has(card.id);
      if (legacyBlocked || autoGroupedCardIds.has(placementKey(card))) {
        continue;
      }
      const entry =
        declared.get(card.group.id) ??
        ({ cards: [], layout: card.group.layout === "grid" ? "grid" : "row", title: card.group.title } as {
          cards: CanvasCard[];
          layout: "grid" | "row";
          title: string;
        });
      entry.cards.push(card);
      declared.set(card.group.id, entry);
    }
    if (!declared.size) return;

    let nextGroups = groups;
    const nextPositions: Record<string, Point> = {};
    // New groups stack below everything currently placed.
    let cursorY =
      allCards.reduce((max, card) => {
        const position = positions[card.id];
        if (!position) return max;
        return Math.max(max, position.y + cardHeight(card, measuredAspectRatios[card.id]));
      }, 0) + 160;
    let changed = false;

    const placedIds: string[] = [];
    const slugKey = (value: string) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    for (const [declaredId, entry] of declared) {
      const groupId = `srv-${declaredId}`;
      const orderedIds = entry.cards
        .slice()
        .sort((a, b) => (a.group?.index ?? 0) - (b.group?.index ?? 0))
        .map((card) => card.id);
      // Join the user's hand-made group when the declared group names it
      // (matched by title slug) — the agent placing "main_clips" must land in
      // the user's "Main clips" group, not spawn a sibling.
      const existing = nextGroups.find(
        (group) =>
          group.id === groupId ||
          slugKey(group.title) === slugKey(declaredId) ||
          (entry.title ? slugKey(group.title) === slugKey(entry.title) : false),
      );
      const keyById = new Map(entry.cards.map((card) => [card.id, placementKey(card)]));
      if (existing) {
        const missing = orderedIds.filter((id) => !existing.cardIds.includes(id));
        placedIds.push(...orderedIds.map((id) => keyById.get(id) ?? `${id}:${declaredId}`));
        if (!missing.length) {
          // Restated organize with no new members (stamped re-run): pull the
          // group's members back into its row — heals strays the user dragged
          // or that never got placed.
          if (existing.layout) {
            const layout = layoutGroupPositions(existing, existing.cardIds, existing.layout, {
              ...positions,
              ...nextPositions,
            });
            Object.assign(nextPositions, layout);
            const sized = autoSizeGroupToCards(existing, { ...positions, ...nextPositions });
            nextGroups = nextGroups.map((group) => (group.id === existing.id ? sized : group));
            changed = true;
          }
          continue;
        }
        // A tile reorganized here leaves its previous agent-made group
        // (user-made groups are never raided).
        nextGroups = nextGroups.map((group) =>
          group.id !== existing.id &&
          group.id.startsWith("srv-") &&
          group.cardIds.some((id) => missing.includes(id))
            ? { ...group, cardIds: group.cardIds.filter((id) => !missing.includes(id)) }
            : group,
        );
        const merged = { ...existing, cardIds: [...existing.cardIds, ...missing] };
        if (merged.layout) {
          const layout = layoutGroupPositions(merged, merged.cardIds, merged.layout, {
            ...positions,
            ...nextPositions,
          });
          Object.assign(nextPositions, layout);
        } else {
          // Free-form (hand-made) group: never reflow the user's tiles —
          // append the newcomers at the group's right edge and let the box
          // grow around them. Advance by real card widths so wide tiles
          // don't land on top of the next one.
          const cardById = new Map(allCards.map((card) => [card.id, card]));
          let cursorX = existing.x + existing.width + 40;
          for (const id of missing) {
            nextPositions[id] = { x: cursorX, y: existing.y + 44 };
            cursorX += cardWidth(cardById.get(id)) + 40;
          }
        }
        const sized = autoSizeGroupToCards(merged, { ...positions, ...nextPositions });
        nextGroups = nextGroups.map((group) => (group.id === existing.id ? sized : group));
        changed = true;
        continue;
      }
      // Leave cards alone if the user grouped them manually; a previous
      // AGENT-made (srv-) group releases its members when they're reorganized.
      const freeIds = orderedIds.filter(
        (id) =>
          !nextGroups.some(
            (group) => !group.id.startsWith("srv-") && group.cardIds.includes(id),
          ),
      );
      placedIds.push(...orderedIds.map((id) => keyById.get(id) ?? `${id}:${declaredId}`));
      if (!freeIds.length) continue;
      nextGroups = nextGroups.map((group) =>
        group.id.startsWith("srv-") && group.cardIds.some((id) => freeIds.includes(id))
          ? { ...group, cardIds: group.cardIds.filter((id) => !freeIds.includes(id)) }
          : group,
      );
      const draft: CanvasGroup = {
        cardIds: freeIds,
        color: CANVAS_GROUP_COLORS[nextGroups.length % CANVAS_GROUP_COLORS.length],
        height: CANVAS_GROUP_MIN_HEIGHT,
        id: groupId,
        layout: entry.layout,
        title: entry.title,
        width: CANVAS_GROUP_MIN_WIDTH,
        x: 0,
        y: cursorY,
      };
      const layout = layoutGroupPositions(draft, freeIds, entry.layout, {
        ...positions,
        ...nextPositions,
      });
      Object.assign(nextPositions, layout);
      const sized = autoSizeGroupToCards(draft, { ...positions, ...nextPositions });
      nextGroups = [...nextGroups, sized];
      cursorY = sized.y + sized.height + 160;
      changed = true;
    }

    if (placedIds.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAutoGroupedCardIds((current) => {
        const next = new Set(current);
        for (const id of placedIds) next.add(id);
        return next;
      });
    }
    if (!changed) return;
    setPositions((current) => ({ ...current, ...nextPositions }));
    setGroups(nextGroups);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCards, groups, positions, measuredAspectRatios, autoGroupedCardIds]);

  const cardById = useMemo(
    () => new Map(allCards.map((card) => [card.id, card])),
    [allCards],
  );
  const resolveVersionIndex = useCallback(
    (key: string, versions: StoryboardMediaVersion[]) => {
      const stored = versionSelection[key];
      // A pick only holds while the version list is unchanged — when an edit
      // adds a new version, the tile snaps to the latest automatically.
      if (
        stored &&
        stored.count === versions.length &&
        stored.index >= 0 &&
        stored.index < versions.length
      ) {
        return stored.index;
      }
      const cardId = key.slice(key.indexOf(":") + 1);
      const persisted = playbackStateRef.current[cardId]?.selectedVersion ?? -1;
      if (persisted >= 0 && persisted < versions.length) return persisted;
      return currentVersionIndex(versions);
    },
    [versionSelection],
  );
  const groupById = useMemo(
    () => new Map(groups.map((group) => [group.id, group])),
    [groups],
  );
  const selectedCard = selectedId ? cardById.get(selectedId) ?? null : null;
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedInspectorCards = useMemo(
    () =>
      selectedIds
        .map((id) => cardById.get(id))
        .filter((card): card is CanvasCard => Boolean(card)),
    [cardById, selectedIds],
  );
  const inspectorCard = focusedInspectorCardId
    ? cardById.get(focusedInspectorCardId) ?? null
    : null;
  const inspectorVisible =
    Boolean(focusedInspectorCardId) &&
    Boolean(focusedInspectorCardId && selectedIdSet.has(focusedInspectorCardId));
  const selectedVideoCard =
    selectedCard && (selectedCard.kind === "clip" || selectedCard.kind === "video")
      ? selectedCard
      : null;
  const selectedPrompt = selectedCard?.prompt ?? null;
  const activeDrawCard = drawMode ? cardById.get(drawMode.cardId) ?? null : null;
  const activeDrawIsVideo =
    activeDrawCard?.kind === "clip" || activeDrawCard?.kind === "video";
  const selectedActionCard =
    selectedCard && selectedCard.kind !== "audio" ? selectedCard : null;
  const composeTarget = activeDrawCard
    ? `draw:${activeDrawCard.id}`
    : selectedPrompt?.id ??
      (selectedActionCard ? `card:${selectedActionCard.id}` : "canvas-create");
  const draftText = composeTarget && draft.id === composeTarget ? draft.text : "";
  const workflowDraft = draft.id === composeTarget && draft.runMode === "workflow";
  // Any tagged tile is promptable via the composer agent — no prompt record
  // required (uploads/references have none).
  const promptChanged = draftText.trim().length > 0;
  const connectionByCardId = useMemo(() => {
    const map = new Map<string, CanvasConnection>();
    for (const connection of connections) {
      for (const id of connection.cardIds) map.set(id, connection);
    }
    return map;
  }, [connections]);
  // Everything that fed into this piece, per the provenance graph — rendered
  // as the "Made with" grid in the inspector.
  const inspectorUsedCards = useMemo(() => {
    if (!inspectorCard) return [];
    const usedIds = new Set(
      lineageEdges
        .filter((edge) => edge.to === inspectorCard.id)
        .map((edge) => edge.from),
    );
    return [...usedIds].flatMap((id) => {
      const used = cardById.get(id);
      if (!used) return [];
      return [
        {
          id: used.id,
          kind: canvasPieceKindForCard(used),
          previewSrc: displaySrc(used),
          refCategory: used.refCategory ?? null,
          title: used.title,
        },
      ];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardById, inspectorCard, lineageEdges]);
  const canonicalTimelineArtifactIds = useMemo(
    () =>
      new Set(
        editorPlacements.map((placement) => placement.identity.artifactId),
      ),
    [editorPlacements],
  );
  const lineageImpactByCard = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of lineageEdges) {
      counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1);
    }
    return counts;
  }, [lineageEdges]);
  const cardBoxes = useMemo(
    () =>
      allCards.flatMap((card): CanvasSpatialBox[] => {
        const position = positions[card.id];
        if (!position) return [];
        return [
          {
            height: cardHeight(card, measuredAspectRatios[card.id]),
            id: card.id,
            width: cardWidth(card),
            x: position.x,
            y: position.y,
          },
        ];
      }),
    [allCards, measuredAspectRatios, positions],
  );
  const cardSpatialIndex = useMemo(() => new CanvasSpatialIndex(cardBoxes), [cardBoxes]);
  useEffect(() => {
    if (cardBoxes.length < 2) return;
    const resolved = resolveAllCollisions(cardBoxes, 28);
    const frame = window.requestAnimationFrame(() => {
      setPositions((current) => {
        let changed = false;
        const next = { ...current };
        for (const [id, point] of Object.entries(resolved)) {
          const before = current[id];
          if (!before || Math.abs(before.x - point.x) > 1 || Math.abs(before.y - point.y) > 1) {
            next[id] = point;
            changed = true;
          }
        }
        return changed ? next : current;
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [cardBoxes]);
  const visibleWorldRect = useMemo(
    () =>
      canvasWorldViewport({
        height: viewportSize.height,
        pan,
        scale,
        width: viewportSize.width,
      }),
    [pan, scale, viewportSize],
  );
  const visibleCardIds = useMemo(
    () => new Set(cardSpatialIndex.query(visibleWorldRect).map((box) => box.id)),
    [cardSpatialIndex, visibleWorldRect],
  );
  const eagerCardIds = useMemo(() => {
    const ids = new Set(visibleCardIds);
    for (const id of selectedIds) ids.add(id);
    if (playingVideoId) ids.add(playingVideoId);
    if (hoveredCardId) ids.add(hoveredCardId);
    if (drawMode?.cardId) ids.add(drawMode.cardId);
    if (imageAdjust?.cardId) ids.add(imageAdjust.cardId);
    if (trimModeCardId) ids.add(trimModeCardId);
    if (scrubbingCardId) ids.add(scrubbingCardId);
    return ids;
  }, [
    drawMode?.cardId,
    hoveredCardId,
    imageAdjust?.cardId,
    playingVideoId,
    scrubbingCardId,
    selectedIds,
    trimModeCardId,
    visibleCardIds,
  ]);
  const collapsedConnectionCardIds = useMemo(
    () => new Set(connections.filter((connection) => connection.collapsed).flatMap((connection) => connection.cardIds)),
    [connections],
  );
  function selectOnly(id: string | null) {
    setSelectedId(id);
    setSelectedIds(id ? [id] : []);
    setSelectedGroupId(null);
  }

  const requestSelectOnly = useCallback((id: string | null) => {
    if (
      selectedVideoCard &&
      trimDraft?.cardId === selectedVideoCard.id &&
      (trimDraft.startSeconds > 0.05 || trimDraft.endSeconds < trimDraft.duration - 0.05) &&
      id !== selectedVideoCard.id
    ) {
      setPendingSelectionId(id);
      return false;
    }
    setSelectedId(id);
    setSelectedIds(id ? [id] : []);
    setSelectedGroupId(null);
    return true;
  }, [selectedVideoCard, setPendingSelectionId, setSelectedId, setSelectedIds, trimDraft]);

  function selectMany(ids: string[]) {
    const unique = [...new Set(ids)];
    setSelectedIds(unique);
    setSelectedId(unique[0] ?? null);
    setSelectedGroupId(null);
  }

  function selectGroup(id: string) {
    setSelectedGroupId(id);
    setSelectedId(null);
    setSelectedIds([]);
    setFocusedInspectorCardId(null);
  }

  function focusInspectorCard(id: string) {
    inspectorReturnFocusRef.current = id;
    setFocusedInspectorCardId(id);
  }

  function selectCardFromInteraction(
    id: string,
    options: { additive: boolean; range: boolean },
  ) {
    const next = nextCanvasSelection({
      additive: options.additive,
      allIds: allCards.map((card) => card.id),
      currentIds: selectedIds,
      primaryId: selectedId,
      range: options.range,
      targetId: id,
    });
    setSelectedIds(next.ids);
    setSelectedId(next.primaryId);
    setSelectedGroupId(null);
    if (next.primaryId) focusInspectorCard(next.primaryId);
    else setFocusedInspectorCardId(null);
    // A plain click focuses the tile: glide it to the visible center (the
    // animation accounts for the open drawer). Additive/range selections
    // stay put — the user is composing a set, not focusing one tile.
    if (!options.additive && !options.range && next.primaryId === id) {
      const card = allCards.find((entry) => entry.id === id);
      // One frame later: the drawer this selection opens must be mounted so
      // the centering accounts for the width it takes.
      if (card) {
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(() =>
            animateToCard(card, { neverZoomOut: true }),
          ),
        );
      }
    }
  }

  function requestDeleteConfirmation(targets: CanvasCard[]) {
    if (!areCanvasCardsDeletable(targets)) return false;
    setPendingDeleteCards(targets);
    return true;
  }

  function worldPointWithPan(clientX: number, clientY: number, currentPan: Point) {
    const viewport = viewportRef.current;
    if (!viewport) return { x: 0, y: 0 };
    const rect = viewport.getBoundingClientRect();
    return {
      x: (clientX - rect.left - currentPan.x) / scale,
      y: (clientY - rect.top - currentPan.y) / scale,
    };
  }

  function worldPoint(clientX: number, clientY: number) {
    return worldPointWithPan(clientX, clientY, panRef.current);
  }

  function edgePanDelta(clientX: number, clientY: number) {
    const viewport = viewportRef.current;
    if (!viewport) return { x: 0, y: 0 };
    const rect = viewport.getBoundingClientRect();
    let x = 0;
    let y = 0;
    if (clientX < rect.left + MARQUEE_EDGE_PAN_ZONE) {
      x = Math.min(1, (rect.left + MARQUEE_EDGE_PAN_ZONE - clientX) / MARQUEE_EDGE_PAN_ZONE);
    } else if (clientX > rect.right - MARQUEE_EDGE_PAN_ZONE) {
      x = -Math.min(1, (clientX - (rect.right - MARQUEE_EDGE_PAN_ZONE)) / MARQUEE_EDGE_PAN_ZONE);
    }
    if (clientY < rect.top + MARQUEE_EDGE_PAN_ZONE) {
      y = Math.min(1, (rect.top + MARQUEE_EDGE_PAN_ZONE - clientY) / MARQUEE_EDGE_PAN_ZONE);
    } else if (clientY > rect.bottom - MARQUEE_EDGE_PAN_ZONE) {
      y = -Math.min(1, (clientY - (rect.bottom - MARQUEE_EDGE_PAN_ZONE)) / MARQUEE_EDGE_PAN_ZONE);
    }
    return { x: x * MARQUEE_EDGE_PAN_MAX, y: y * MARQUEE_EDGE_PAN_MAX };
  }

  function orderedRect(start: Point, current: Point) {
    const x = Math.min(start.x, current.x);
    const y = Math.min(start.y, current.y);
    return {
      height: Math.abs(current.y - start.y),
      width: Math.abs(current.x - start.x),
      x,
      y,
    };
  }

  function cardWorldRect(card: CanvasCard) {
    const position = positions[card.id] ?? { x: 0, y: 0 };
    return {
      height: cardHeight(card, measuredAspectRatios[card.id]),
      width: cardWidth(card),
      x: position.x,
      y: position.y,
    };
  }

  function rectsIntersect(
    a: { height: number; width: number; x: number; y: number },
    b: { height: number; width: number; x: number; y: number },
  ) {
    return (
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y
    );
  }

  function normalizedGroupRect(rect: { height: number; width: number; x: number; y: number }) {
    return {
      height: Math.max(CANVAS_GROUP_MIN_HEIGHT, rect.height),
      width: Math.max(CANVAS_GROUP_MIN_WIDTH, rect.width),
      x: rect.x,
      y: rect.y,
    };
  }

  function groupLayoutForRect(rect: { height: number; width: number }) {
    const ratio = rect.width / Math.max(1, rect.height);
    if (ratio >= 2.65) return "row";
    if (ratio <= 0.68) return "column";
    return "grid";
  }

  function sortedIdsForGroupLayout(
    ids: string[],
    rect: { height: number; layout?: "column" | "grid" | "row"; width: number },
    sourcePositions: Record<string, Point> = positions,
  ) {
    const layout = rect.layout ?? groupLayoutForRect(rect);
    return [...new Set(ids)].sort((a, b) => {
      const left = sourcePositions[a] ?? positions[a] ?? { x: 0, y: 0 };
      const right = sourcePositions[b] ?? positions[b] ?? { x: 0, y: 0 };
      if (layout === "row") return left.x === right.x ? left.y - right.y : left.x - right.x;
      if (layout === "column") return left.y === right.y ? left.x - right.x : left.y - right.y;
      return left.y === right.y ? left.x - right.x : left.y - right.y;
    });
  }

  function layoutGroupPositions(
    group: CanvasGroup,
    ids: string[],
    layout: "column" | "grid" | "row",
    sourcePositions: Record<string, Point> = positions,
  ) {
    const orderedIds = sortedIdsForGroupLayout(
      ids.filter((id) => cardById.has(id)),
      { ...group, layout },
      sourcePositions,
    );
    if (!orderedIds.length) return {};
    const columns =
      layout === "row"
        ? orderedIds.length
        : layout === "column"
          ? 1
          : Math.max(2, Math.ceil(Math.sqrt(orderedIds.length)));
    const rows: string[][] = [];
    for (let index = 0; index < orderedIds.length; index += columns) {
      rows.push(orderedIds.slice(index, index + columns));
    }
    const rowHeights = rows.map((row) =>
      Math.max(
        ...row.map((id) => {
          const card = cardById.get(id);
          return card ? cardHeight(card, measuredAspectRatios[id]) : 0;
        }),
      ),
    );
    const nextPositions: Record<string, Point> = {};
    let cursorY = group.y + CANVAS_GROUP_PADDING;
    rows.forEach((row, rowIndex) => {
      // Advance by each card's ACTUAL width — spacing by the constant width
      // stacks wider tiles (clips, squares) on top of their neighbors.
      let cursorX = group.x + CANVAS_GROUP_PADDING;
      row.forEach((id) => {
        nextPositions[id] = { x: cursorX, y: cursorY };
        const card = cardById.get(id);
        cursorX += cardWidth(card) + CANVAS_GROUP_GAP;
      });
      cursorY += rowHeights[rowIndex] + CANVAS_GROUP_GAP;
    });
    return nextPositions;
  }

  function autoSizeGroupToCards(
    group: CanvasGroup,
    sourcePositions: Record<string, Point> = positions,
  ): CanvasGroup {
    const cardIds = group.cardIds.filter((id) => cardById.has(id));
    if (!cardIds.length) {
      const emptyRect = normalizedGroupRect(group);
      return {
        ...group,
        ...emptyRect,
        cardIds,
      };
    }
    const boxes = cardIds.map((id) => {
      const card = cardById.get(id)!;
      const position = sourcePositions[id] ?? positions[id] ?? { x: 0, y: 0 };
      return {
        bottom: position.y + cardHeight(card, measuredAspectRatios[id]),
        left: position.x,
        right: position.x + cardWidth(card),
        top: position.y,
      };
    });
    const left = Math.min(...boxes.map((box) => box.left));
    const right = Math.max(...boxes.map((box) => box.right));
    const top = Math.min(...boxes.map((box) => box.top));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    return {
      ...group,
      cardIds,
      height: Math.max(CANVAS_GROUP_MIN_HEIGHT, bottom - top + CANVAS_GROUP_PADDING * 2),
      width: Math.max(CANVAS_GROUP_MIN_WIDTH, right - left + CANVAS_GROUP_PADDING * 2),
      x: left - CANVAS_GROUP_PADDING,
      y: top - CANVAS_GROUP_PADDING,
    };
  }

  function groupSnapshotsForPositions(sourcePositions: Record<string, Point> = positions) {
    return Object.fromEntries(
      groups.map((group) => [group.id, autoSizeGroupToCards(group, sourcePositions)]),
    );
  }

  function buildGroupDropPreview(
    group: CanvasGroup,
    ids: string[],
    sourcePositions: Record<string, Point>,
  ): GroupDropPreview | null {
    const incomingIds = ids.filter((id) => cardById.has(id));
    if (!incomingIds.length) return null;
    const existingIds = group.cardIds.filter((id) => cardById.has(id) && !incomingIds.includes(id));
    const previewIds = [...existingIds, ...incomingIds];
    const layout = group.layout ?? groupLayoutForRect(group);
    const previewPositions = layoutGroupPositions(
      { ...group, layout },
      previewIds,
      layout,
      sourcePositions,
    );
    if (!Object.keys(previewPositions).length) return null;
    const sized = autoSizeGroupToCards(
      { ...group, cardIds: previewIds, layout },
      { ...sourcePositions, ...previewPositions },
    );
    return {
      group: {
        ...sized,
        height: Math.max(group.height, sized.height),
        width: Math.max(group.width, sized.width),
        x: group.x,
        y: group.y,
      },
      groupId: group.id,
      positions: previewPositions,
    };
  }

  function groupForDrop(ids: string[], sourcePositions: Record<string, Point>) {
    // Hit-test against the group's RENDERED box (its stored rect), not a rect
    // recomputed from member positions. The stored rect is what the user sees
    // and doesn't move during the drag, so: a small nudge inside the box
    // reorders (stays a member), crossing the visible border leaves.
    return groups.find((group) => {
      const remainingIds = group.cardIds.filter((id) => !ids.includes(id));
      const isSourceGroup = remainingIds.length !== group.cardIds.length;
      if (isSourceGroup && !remainingIds.length) return false;
      return ids.some((id) => {
        const card = allCards.find((entry) => entry.id === id);
        if (!card) return false;
        const position = sourcePositions[id] ?? positions[id] ?? { x: 0, y: 0 };
        // Membership by card CENTER: nudge inside the box → reorder in place;
        // center crossing the visible border → out.
        const centerX = position.x + cardWidth(card) / 2;
        const centerY = position.y + cardHeight(card, measuredAspectRatios[id]) / 2;
        return (
          centerX >= group.x &&
          centerX <= group.x + group.width &&
          centerY >= group.y &&
          centerY <= group.y + group.height
        );
      });
    });
  }

  function arrangeGroupList(
    groupList: CanvasGroup[],
    sourcePositions: Record<string, Point> = positions,
  ) {
    return {
      groups: groupList.map((group) => autoSizeGroupToCards(group, sourcePositions)),
      positions: {} as Record<string, Point>,
    };
  }

  function assignCardsToGroup(
    groupId: string,
    ids: string[],
    sourcePositions: Record<string, Point> = positions,
  ) {
    const nextGroups = groups.map((group) => {
      if (group.id === groupId) {
        return { ...group, cardIds: [...new Set([...group.cardIds, ...ids])] };
      }
      return { ...group, cardIds: group.cardIds.filter((id) => !ids.includes(id)) };
    });
    // Snap: re-run the target group's layout so the dropped tile takes a slot
    // instead of sitting wherever the cursor happened to be.
    const target = nextGroups.find((group) => group.id === groupId);
    const preview = target ? buildGroupDropPreview(target, ids, sourcePositions) : null;
    const snapPositions = preview?.positions ?? {};
    const mergedPositions = { ...sourcePositions, ...snapPositions };
    setGroups(
      nextGroups.map((group) =>
        preview && group.id === groupId
          ? preview.group
          : autoSizeGroupToCards(group, mergedPositions),
      ),
    );
    if (Object.keys(snapPositions).length) {
      setPositions((current) => ({ ...current, ...snapPositions }));
    }
  }

  function autoSizeGroupsForPositions(
    sourcePositions: Record<string, Point> = positions,
    groupList: CanvasGroup[] = groups,
  ) {
    setGroups(groupList.map((group) => autoSizeGroupToCards(group, sourcePositions)));
  }

  /** Cards dropped outside every group leave the one they were in; a group
   * emptied this way disappears. */
  function removeCardsFromGroups(
    ids: string[],
    sourcePositions: Record<string, Point> = positions,
  ) {
    // Removed cards are permanently the user's business now.
    setAutoGroupedCardIds((current) => new Set([...current, ...ids]));
    const idSet = new Set(ids);
    let changed = false;
    const next: CanvasGroup[] = [];
    for (const group of groups) {
      const remaining = group.cardIds.filter((id) => !idSet.has(id));
      if (remaining.length === group.cardIds.length) {
        next.push(autoSizeGroupToCards(group, sourcePositions));
        continue;
      }
      changed = true;
      if (remaining.length) {
        next.push(autoSizeGroupToCards({ ...group, cardIds: remaining }, sourcePositions));
      }
    }
    if (changed) setGroups(next);
    else autoSizeGroupsForPositions(sourcePositions);
  }

  function alignGroup(groupId: string, layout: "column" | "grid" | "row") {
    const group = groupById.get(groupId);
    if (!group || group.cardIds.length < 2) return;
    const sizedGroup = autoSizeGroupToCards(group);
    const nextPositions = {
      ...positions,
      ...layoutGroupPositions(sizedGroup, sizedGroup.cardIds, layout),
    };
    const nextGroups = groups.map((entry) =>
      entry.id === groupId
        ? autoSizeGroupToCards({ ...entry, layout }, nextPositions)
        : autoSizeGroupToCards(entry, nextPositions),
    );
    setPositions(nextPositions);
    setGroups(nextGroups);
    selectGroup(groupId);
  }

  function degroup(groupId: string) {
    const group = groupById.get(groupId);
    // Mark members as handled so the server-group effect can never resurrect
    // the group (covers groups created before handled-tracking existed).
    if (group?.cardIds.length) {
      setAutoGroupedCardIds((current) => new Set([...current, ...group.cardIds]));
    }
    setGroups((current) => current.filter((entry) => entry.id !== groupId));
    setSelectedGroupId(null);
    if (group?.cardIds.length) selectMany(group.cardIds);
  }

  function createGroupFromRect(rect: { height: number; width: number; x: number; y: number }) {
    const baseRect = normalizedGroupRect(rect);
    const hitIds = sortedIdsForGroupLayout(
      allCards
        .filter((card) => !collapsedConnectionCardIds.has(card.id))
        .filter((card) => rectsIntersect(rect, cardWorldRect(card)))
        .map((card) => card.id),
      baseRect,
    );
    const group: CanvasGroup = {
      ...normalizedGroupRect(
        hitIds.length
          ? {
              height: CANVAS_GROUP_MIN_HEIGHT,
              width: CANVAS_GROUP_MIN_WIDTH,
              x: baseRect.x,
              y: baseRect.y,
            }
          : baseRect,
      ),
      cardIds: [],
      color: CANVAS_GROUP_COLORS[groups.length % CANVAS_GROUP_COLORS.length],
      id: nextCanvasKey("group"),
      layout: groupLayoutForRect(baseRect),
      title: `Group ${groups.length + 1}`,
    };
    const nextGroup = autoSizeGroupToCards({ ...group, cardIds: hitIds });
    setGroups((current) => [...current, nextGroup]);
    if (hitIds.length) selectMany(hitIds);
    else selectGroup(nextGroup.id);
  }

  function startGroupCreation(event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (focusAnimationRef.current !== null) {
      window.cancelAnimationFrame(focusAnimationRef.current);
      focusAnimationRef.current = null;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = worldPoint(event.clientX, event.clientY);
    setGroupDraft({ current: start, start });
    const onPointerMove = (moveEvent: PointerEvent) => {
      setGroupDraft((current) =>
        current ? { ...current, current: worldPoint(moveEvent.clientX, moveEvent.clientY) } : null,
      );
    };
    const onPointerUp = (upEvent: PointerEvent) => {
      const end = worldPoint(upEvent.clientX, upEvent.clientY);
      const rect = orderedRect(start, end);
      setGroupDraft(null);
      setGroupCreateArmed(false);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (rect.width < 12 || rect.height < 12) return;
      createGroupFromRect(rect);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  useEffect(() => {
    // Any pan/zoom/drag tick marks the view as in-motion; it settles shortly
    // after movement stops so selection changes still glide.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setViewInMotion(true);
    if (viewMotionTimer.current !== null) window.clearTimeout(viewMotionTimer.current);
    viewMotionTimer.current = window.setTimeout(() => setViewInMotion(false), 220);
    return () => {
      if (viewMotionTimer.current !== null) window.clearTimeout(viewMotionTimer.current);
    };
  }, [pan, scale, positions, dragState]);

  const updateOverlayRect = useCallback(() => {
    const workspace = workspaceRef.current;
    const viewport = viewportRef.current;
    const cardId = selectedActionCard?.id;
    if (!workspace || !viewport || !cardId) {
      setOverlayRect(null);
      return;
    }
    const targetEl =
      viewport.querySelector<HTMLElement>(`[data-card-media-id="${cardId}"]`) ??
      viewport.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
    if (!targetEl) {
      setOverlayRect(null);
      return;
    }
    const workspaceBox = workspace.getBoundingClientRect();
    const cardBox = targetEl.getBoundingClientRect();
    setOverlayRect({
      height: cardBox.height,
      left: cardBox.left - workspaceBox.left,
      top: cardBox.top - workspaceBox.top,
      width: cardBox.width,
    });
  }, [selectedActionCard?.id]);

  function selectedVideoElement() {
    const viewport = viewportRef.current;
    if (!viewport || !selectedId) return null;
    return viewport.querySelector<HTMLVideoElement>(`video[data-canvas-card-id="${selectedId}"]`);
  }

  function videoElementForCard(cardId: string) {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    return viewport.querySelector<HTMLVideoElement>(`video[data-canvas-card-id="${cardId}"]`);
  }

  function findConnection(connectionId: string) {
    return connections.find((entry) => entry.id === connectionId) ?? null;
  }

  function stopConnectionPlayback() {
    const active = connectionPlaybackRef.current;
    if (active) {
      const connection = findConnection(active.connectionId);
      const cards = connection ? connectionCards(connection).filter(canConnect) : [];
      for (const card of cards) {
        const video = videoElementForCard(card.id);
        if (!video) continue;
        video.pause();
        video.muted = true;
      }
    }
    connectionPlaybackRef.current = null;
    setPlayingConnectionId(null);
  }

  function playConnectionIndex(connection: CanvasConnection, index: number, startSeconds = 0) {
    const playableCards = connectionCards(connection).filter(canConnect);
    const card = playableCards[index];
    if (!card) {
      stopConnectionPlayback();
      return;
    }
    connectionPlaybackRef.current = { connectionId: connection.id, index };
    setPlayingConnectionId(connection.id);
    setConnectionPreviewCardIds((current) => ({ ...current, [connection.id]: card.id }));
    window.requestAnimationFrame(() => {
      for (const otherCard of playableCards) {
        if (otherCard.id === card.id) continue;
        const otherVideo = videoElementForCard(otherCard.id);
        if (!otherVideo) continue;
        otherVideo.pause();
        otherVideo.muted = true;
      }
      const video = videoElementForCard(card.id);
      if (!video) return;
      video.loop = false;
      video.muted = !unmutedCardIds.includes(card.id);
      try {
        const targetTime = Math.max(0, Math.min(startSeconds, Math.max(0, video.duration || 0)));
        const alreadyPrerolled =
          targetTime <= 0.05 && !video.paused && !video.ended && video.currentTime < 0.35;
        if (!alreadyPrerolled) {
          video.currentTime = targetTime;
        }
      } catch {
        // Keep the current frame if the browser rejects an early seek.
      }
      void video.play().catch(() => {});
    });
  }

  function connectionOffsetForIndex(connection: CanvasConnection, index: number) {
    return connectionCards(connection)
      .filter(canConnect)
      .slice(0, index)
      .reduce((total, card) => total + (mediaDurations[card.id] ?? card.duration ?? 0), 0);
  }

  function seekConnectionToTime(connection: CanvasConnection, seconds: number, shouldPlay: boolean) {
    const playableCards = connectionCards(connection).filter(canConnect);
    if (!playableCards.length) return;
    const duration = connectionDuration(connection);
    const nextSeconds = Math.max(0, Math.min(seconds, Math.max(0, duration)));
    let remaining = nextSeconds;
    let targetIndex = 0;
    for (let index = 0; index < playableCards.length; index += 1) {
      const card = playableCards[index];
      const cardDuration = mediaDurations[card.id] ?? card.duration ?? 0;
      if (remaining <= cardDuration || index === playableCards.length - 1) {
        targetIndex = index;
        break;
      }
      remaining -= cardDuration;
    }
    const card = playableCards[targetIndex];
    setConnectionPlaybackTimes((current) => ({ ...current, [connection.id]: nextSeconds }));
    setConnectionPreviewCardIds((current) => ({ ...current, [connection.id]: card.id }));
    if (shouldPlay) {
      playConnectionIndex(connection, targetIndex, remaining);
      return;
    }
    window.requestAnimationFrame(() => {
      for (const otherCard of playableCards) {
        const otherVideo = videoElementForCard(otherCard.id);
        if (!otherVideo) continue;
        otherVideo.pause();
        otherVideo.muted = true;
      }
      const video = videoElementForCard(card.id);
      if (!video) return;
      video.pause();
      try {
        video.currentTime = Math.max(0, Math.min(remaining, Math.max(0, video.duration || 0)));
      } catch {
        // Keep the current frame if the browser rejects an early seek.
      }
    });
  }

  function toggleConnectionPlayback(connection: CanvasConnection) {
    if (playingConnectionId === connection.id) {
      stopConnectionPlayback();
      return;
    }
    seekConnectionToTime(connection, connectionPlaybackTimes[connection.id] ?? 0, true);
  }

  function stepConnectionPlayback(connection: CanvasConnection, deltaSeconds: number) {
    const current = connectionPlaybackTimes[connection.id] ?? 0;
    seekConnectionToTime(connection, current + deltaSeconds, playingConnectionId === connection.id);
  }

  function stepTilePlayback(cardId: string, deltaSeconds: number) {
    const video = videoElementForCard(cardId);
    if (!video) return;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    try {
      video.currentTime = Math.max(0, Math.min(duration || 0, video.currentTime + deltaSeconds));
    } catch {
      // Keep browser-selected time if the video is not seekable yet.
    }
  }

  function toggleTilePlayback(cardId: string) {
    const video = videoElementForCard(cardId);
    if (!video) return;
    stopConnectionPlayback();
    if (video.paused || video.ended) {
      if (video.ended) {
        try {
          video.currentTime = 0;
        } catch {
          // Keep browser-selected time if the video is not seekable yet.
        }
      }
      void video.play().catch(() => {});
      return;
    }
    video.pause();
  }

  function handleMediaPlay(cardId: string, media: HTMLVideoElement) {
    setPlayingVideoId(cardId);
    rememberPlayback(cardId, {
      currentTime: media.currentTime,
      muted: media.muted,
      playbackRate: media.playbackRate,
      wasPlaying: true,
    });
  }

  function handleMediaPause(cardId: string, media: HTMLVideoElement) {
    setPlayingVideoId((current) => (current === cardId ? null : current));
    rememberPlayback(cardId, {
      currentTime: media.currentTime,
      muted: media.muted,
      playbackRate: media.playbackRate,
      wasPlaying: false,
    });
  }

  useEffect(() => {
    let connectionStopFrame: number | null = null;
    if (playingVideoId && !visibleCardIds.has(playingVideoId)) {
      videoElementForCard(playingVideoId)?.pause();
    }
    if (playingConnectionId) {
      const connection = connections.find((entry) => entry.id === playingConnectionId);
      const bounds = connection ? connectionBounds(connection) : null;
      if (
        bounds &&
        !spatialRectsIntersect(visibleWorldRect, {
          height: bounds.height,
          width: bounds.width,
          x: bounds.left,
          y: bounds.top,
        })
      ) {
        connectionStopFrame = window.requestAnimationFrame(() => stopConnectionPlayback());
      }
    }
    // Playback is intentionally stopped when its media leaves the inspected
    // viewport; background decode/playback is never useful on the Canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => {
      if (connectionStopFrame !== null) window.cancelAnimationFrame(connectionStopFrame);
    };
  }, [playingConnectionId, playingVideoId, visibleCardIds, visibleWorldRect]);

  const waveformDemandIds = useMemo(() => {
    const ids = new Set(selectedIds);
    if (playingVideoId) ids.add(playingVideoId);
    if (scrubbingCardId) ids.add(scrubbingCardId);
    return ids;
  }, [playingVideoId, scrubbingCardId, selectedIds]);

  // Decode only explicitly inspected audio cards, then reduce each source to
  // a bounded sample set consumed by one SVG path.
  useEffect(() => {
    for (const id of waveformDemandIds) {
      const card = cardById.get(id);
      if (!card) continue;
      if (card.kind !== "audio") continue;
      const media = viewportRef.current?.querySelector<HTMLVideoElement>(
        `video[data-canvas-card-id="${card.id}"][data-audio-tile]`,
      );
      const src = media?.currentSrc || media?.src || card.src;
      if (
        !src ||
        audioWaveforms[card.id]?.length === AUDIO_WAVE_SAMPLES ||
        waveformFetchesRef.current.has(card.id)
      )
        continue;
      waveformFetchesRef.current.add(card.id);
      void (async () => {
        try {
          const response = await fetch(src);
          const encoded = await response.arrayBuffer();
          const AudioContextCtor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
          if (!AudioContextCtor) return;
          const context = new AudioContextCtor();
          const buffer = await context.decodeAudioData(encoded);
          void context.close().catch(() => {});
          const channel = buffer.getChannelData(0);
          const bucketSize = Math.max(1, Math.floor(channel.length / AUDIO_WAVE_SAMPLES));
          const stride = Math.max(1, Math.floor(bucketSize / 240));
          const peaks: number[] = [];
          let maxPeak = 0;
          for (let bar = 0; bar < AUDIO_WAVE_SAMPLES; bar += 1) {
            const from = bar * bucketSize;
            const to = Math.min(channel.length, from + bucketSize);
            let peak = 0;
            for (let index = from; index < to; index += stride) {
              const value = Math.abs(channel[index] ?? 0);
              if (value > peak) peak = value;
            }
            peaks.push(peak);
            if (peak > maxPeak) maxPeak = peak;
          }
          const normalized = peaks.map((peak) =>
            Math.max(0.06, maxPeak > 0 ? peak / maxPeak : 0),
          );
          setAudioWaveforms((current) => ({ ...current, [card.id]: normalized }));
        } catch {
          // Keep the deterministic fallback path if the audio can't be decoded.
        }
      })();
    }
  }, [audioWaveforms, cardById, waveformDemandIds]);

  function toggleTileMute(cardId: string) {
    setUnmutedCardIds((current) => {
      const unmuting = !current.includes(cardId);
      const next = unmuting ? [...current, cardId] : current.filter((id) => id !== cardId);
      rememberPlayback(cardId, { muted: !unmuting });
      const media = videoElementForCard(cardId);
      if (media) media.muted = !unmuting;
      return next;
    });
  }

  function startTileScrub(cardId: string, event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const rail = event.currentTarget;
    const video = videoElementForCard(cardId);
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    rail.setPointerCapture(event.pointerId);
    setScrubbingCardId(cardId);
    const wasPlaying = !video.paused && !video.ended;
    if (wasPlaying) video.pause();
    const seek = (clientX: number) => {
      const rect = rail.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      try {
        video.currentTime = ratio * video.duration;
      } catch {
        // Keep browser-selected time if the video is not seekable yet.
      }
    };
    seek(event.clientX);
    const onPointerMove = (moveEvent: PointerEvent) => seek(moveEvent.clientX);
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      setScrubbingCardId(null);
      if (wasPlaying) void video.play().catch(() => {});
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  // timeupdate only fires ~4x/second. Use a frame loop only while actual
  // playback or scrubbing is active; a hovered-but-paused tile is fully idle.
  useEffect(() => {
    const cardId = scrubbingCardId ?? playingVideoId;
    const viewport = viewportRef.current;
    if (!cardId || !viewport) return;
    const bar = viewport.querySelector<HTMLElement>(`[data-card-id="${cardId}"] .tile-scrub`);
    const video = viewport.querySelector<HTMLVideoElement>(
      `video[data-canvas-card-id="${cardId}"]`,
    );
    if (!bar || !video) return;
    const fill = bar.querySelector<HTMLElement>(".tile-scrub-fill");
    const dot = bar.querySelector<HTMLElement>(".tile-scrub-dot");
    const time = bar.querySelector<HTMLElement>(".tile-scrub-time");
    const waveProgress = viewport.querySelector<SVGRectElement>(
      `[data-card-id="${cardId}"] .canvas-audio-wave-progress`,
    );
    let frame = 0;
    const step = () => {
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const pct = duration ? `${(video.currentTime / duration) * 100}%` : "0%";
      if (fill) fill.style.width = pct;
      if (dot) dot.style.left = pct;
      if (waveProgress && duration) {
        waveProgress.setAttribute("width", String((video.currentTime / duration) * 100));
      }
      if (time && duration) {
        time.textContent = `${formatCanvasTime(video.currentTime)} / ${formatCanvasTime(duration)}`;
      }
      frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [playingVideoId, scrubbingCardId]);

  function setSelectedPlaybackRate(rate: number) {
    if (!selectedVideoCard) return;
    const next = Math.max(0.1, Math.min(4, rate));
    setPlaybackRates((existing) => ({ ...existing, [selectedVideoCard.id]: next }));
    rememberPlayback(selectedVideoCard.id, { playbackRate: next });
    const video = selectedVideoElement();
    if (video) video.playbackRate = next;
  }

  function applyCustomPlaybackRate() {
    const next = Number(customPlaybackRate);
    if (!Number.isFinite(next)) return;
    setSelectedPlaybackRate(next);
  }

  function toggleSelectedMute() {
    if (!selectedVideoCard) return;
    toggleTileMute(selectedVideoCard.id);
  }

  function handleVideoTimeUpdate(cardId: string, video: HTMLVideoElement) {
    const activeTrim = trimDraft?.cardId === cardId ? trimDraft : null;
    const activeConnection = connectionPlaybackRef.current;
    if (activeConnection) {
      const connection = findConnection(activeConnection.connectionId);
      const playableCards = connection ? connectionCards(connection).filter(canConnect) : [];
      const activeIndex =
        playableCards[activeConnection.index]?.id === cardId ? activeConnection.index : -1;
      if (connection && activeIndex >= 0) {
        const absoluteTime = connectionOffsetForIndex(connection, activeIndex) + video.currentTime;
        setConnectionPlaybackTimes((current) =>
          Math.abs((current[connection.id] ?? -1) - absoluteTime) < 0.03
            ? current
            : { ...current, [connection.id]: absoluteTime },
        );
        const startSeconds = activeTrim?.startSeconds ?? 0;
        const endSeconds =
          activeTrim?.endSeconds ??
          (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0);
        if (video.currentTime < startSeconds) {
          video.currentTime = startSeconds;
        } else {
          const hiddenEnd = hiddenSegmentEndForTime(
            cardId,
            video.currentTime,
            startSeconds,
            endSeconds,
          );
          if (hiddenEnd !== null) {
            video.currentTime = Math.min(hiddenEnd, Math.max(0, endSeconds));
          }
        }
        if (endSeconds > 0 && video.currentTime >= endSeconds - 0.04) {
          const nextIndex = activeIndex + 1;
          if (nextIndex < playableCards.length) {
            playConnectionIndex(connection, nextIndex);
          } else {
            stopConnectionPlayback();
          }
        } else if (endSeconds > 0 && endSeconds - video.currentTime <= CONNECTION_PREROLL_SECONDS) {
          const nextCard = playableCards[activeIndex + 1];
          const nextVideo = nextCard ? videoElementForCard(nextCard.id) : null;
          if (nextVideo && nextVideo.paused) {
            nextVideo.muted = true;
            try {
              nextVideo.currentTime = 0;
            } catch {
              // Keep the browser-selected frame if the video is not seekable yet.
            }
            void nextVideo.play().catch(() => {});
          }
        }
      }
    } else if (activeTrim) {
      const hiddenEnd = hiddenSegmentEndForTime(
        cardId,
        video.currentTime,
        activeTrim.startSeconds,
        activeTrim.endSeconds,
      );
      if (hiddenEnd !== null) {
        video.currentTime = Math.min(hiddenEnd, activeTrim.endSeconds);
      }
      if (video.currentTime >= activeTrim.endSeconds) {
        video.currentTime = activeTrim.startSeconds;
      } else if (video.currentTime < activeTrim.startSeconds) {
        video.currentTime = activeTrim.startSeconds;
      }
    }
    setMediaCurrentTimes((current) =>
      Math.abs((current[cardId] ?? -1) - video.currentTime) < 0.03
        ? current
        : { ...current, [cardId]: video.currentTime },
    );
    rememberPlayback(cardId, {
      currentTime: video.currentTime,
      muted: video.muted,
      playbackRate: video.playbackRate,
      wasPlaying: !video.paused && !video.ended,
    });
  }

  function resetTrimDraft(card: CanvasCard, duration: number) {
    setTrimDraft({
      cardId: card.id,
      duration,
      endSeconds: duration,
      startSeconds: 0,
    });
  }

  function trimChanged() {
    if (!trimDraft) return false;
    return trimDraft.startSeconds > 0.05 || trimDraft.endSeconds < trimDraft.duration - 0.05;
  }

  function previewTrimFrame(cardId: string, seconds: number, duration: number) {
    const video = selectedVideoElement();
    const previewTime = Math.max(0, Math.min(seconds, Math.max(0, duration - 0.02)));
    if (video) {
      try {
        video.currentTime = previewTime;
      } catch {
        // Some browsers reject seeks before metadata is ready; keep the trim state anyway.
      }
    }
    setMediaCurrentTimes((current) => ({ ...current, [cardId]: previewTime }));
  }

  function normalizeSplitMarkers(markers: number[], duration: number) {
    const clamped = markers
      .map((seconds) => Math.max(0.05, Math.min(Math.max(0.05, duration - 0.05), seconds)))
      .sort((a, b) => a - b);
    return clamped.reduce<number[]>((result, seconds) => {
      const previous = result[result.length - 1];
      if (previous !== undefined && Math.abs(previous - seconds) < 0.04) return result;
      result.push(seconds);
      return result;
    }, []);
  }

  function segmentEdgesForCard(cardId: string, startSeconds: number, endSeconds: number) {
    const markers = (splitMarkers[cardId] ?? [])
      .filter((seconds) => seconds > startSeconds + 0.04 && seconds < endSeconds - 0.04)
      .sort((a, b) => a - b);
    return [startSeconds, ...markers, endSeconds];
  }

  function setSegmentHidden(cardId: string, index: number, hidden: boolean) {
    setHiddenSegments((current) => {
      const existing = current[cardId] ?? [];
      const nextIndexes = hidden
        ? [...new Set([...existing, index])].sort((a, b) => a - b)
        : existing.filter((entry) => entry !== index);
      const next = { ...current };
      if (nextIndexes.length) next[cardId] = nextIndexes;
      else delete next[cardId];
      return next;
    });
  }

  function hiddenSegmentEndForTime(
    cardId: string,
    seconds: number,
    startSeconds: number,
    endSeconds: number,
  ) {
    const hiddenIndexes = hiddenSegments[cardId] ?? [];
    if (!hiddenIndexes.length) return null;
    const edges = segmentEdgesForCard(cardId, startSeconds, endSeconds);
    for (let index = 0; index < edges.length - 1; index += 1) {
      if (!hiddenIndexes.includes(index)) continue;
      const start = edges[index] ?? startSeconds;
      const end = edges[index + 1] ?? endSeconds;
      if (seconds >= start - 0.02 && seconds < end - 0.02) return end;
    }
    return null;
  }

  function addSplitMarker(cardId: string, seconds: number, duration: number) {
    if (duration <= 0.1) return;
    setSplitMarkers((current) => ({
      ...current,
      [cardId]: normalizeSplitMarkers([...(current[cardId] ?? []), seconds], duration),
    }));
    previewTrimFrame(cardId, seconds, duration);
  }

  function removeSplitMarker(cardId: string, index: number) {
    setSplitMarkers((current) => {
      const markers = current[cardId] ?? [];
      const nextMarkers = markers.filter((_, markerIndex) => markerIndex !== index);
      const next = { ...current };
      if (nextMarkers.length) next[cardId] = nextMarkers;
      else delete next[cardId];
      return next;
    });
  }

  function updateSplitMarker(cardId: string, index: number, seconds: number, duration: number) {
    setSplitMarkers((current) => {
      const markers = [...(current[cardId] ?? [])];
      if (markers[index] === undefined) return current;
      markers[index] = seconds;
      return { ...current, [cardId]: normalizeSplitMarkers(markers, duration) };
    });
    previewTrimFrame(cardId, seconds, duration);
  }

  function startSplitMarkerDrag(
    cardId: string,
    index: number,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    if (event.button !== 0) return;
    if (!trimDraft || trimDraft.cardId !== cardId) return;
    const rail = event.currentTarget.closest<HTMLElement>(".canvas-trim-rail");
    if (!rail) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const duration = trimDraft.duration;
    const updateFromClientX = (clientX: number) => {
      const box = rail.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
      updateSplitMarker(cardId, index, ratio * duration, duration);
    };
    const onPointerMove = (moveEvent: PointerEvent) => updateFromClientX(moveEvent.clientX);
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function updateTrimEdge(edge: "end" | "start", clientX: number) {
    const workspace = workspaceRef.current;
    if (!workspace || !overlayRect || !trimDraft) return;
    const workspaceBox = workspace.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (clientX - workspaceBox.left - overlayRect.left) / overlayRect.width),
    );
    const rawSeconds = ratio * trimDraft.duration;
    const nextSeconds =
      edge === "start"
        ? Math.min(Math.max(0, rawSeconds), trimDraft.endSeconds - 0.1)
        : Math.max(Math.min(trimDraft.duration, rawSeconds), trimDraft.startSeconds + 0.1);
    setTrimDraft((current) => {
      if (!current) return current;
      if (edge === "start") {
        return {
          ...current,
          startSeconds: nextSeconds,
        };
      }
      return {
        ...current,
        endSeconds: nextSeconds,
      };
    });
    previewTrimFrame(trimDraft.cardId, nextSeconds, trimDraft.duration);
  }

  function seekTrimPlayhead(clientX: number) {
    const workspace = workspaceRef.current;
    const video = selectedVideoElement();
    if (!workspace || !overlayRect || !trimDraft || !video) return;
    const workspaceBox = workspace.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (clientX - workspaceBox.left - overlayRect.left) / overlayRect.width),
    );
    const seconds = Math.max(
      trimDraft.startSeconds,
      Math.min(trimDraft.endSeconds, ratio * trimDraft.duration),
    );
    video.currentTime = seconds;
    setMediaCurrentTimes((current) => ({ ...current, [trimDraft.cardId]: seconds }));
  }

  function startTrimDrag(edge: "end" | "start", event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    updateTrimEdge(edge, event.clientX);
    const onPointerMove = (moveEvent: PointerEvent) => updateTrimEdge(edge, moveEvent.clientX);
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function startPlayheadDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    seekTrimPlayhead(event.clientX);
    const onPointerMove = (moveEvent: PointerEvent) => seekTrimPlayhead(moveEvent.clientX);
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function startConnectionPlayheadDrag(connection: CanvasConnection, event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    const rail = event.currentTarget.closest<HTMLElement>(".canvas-trim-rail");
    if (!rail) return;
    const shouldPlay = playingConnectionId === connection.id;
    const seek = (clientX: number) => {
      const rect = rail.getBoundingClientRect();
      if (rect.width <= 0) return;
      const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      seekConnectionToTime(connection, connectionDuration(connection) * percent, shouldPlay);
    };
    seek(event.clientX);
    const onPointerMove = (moveEvent: PointerEvent) => seek(moveEvent.clientX);
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  async function captureFrameStrip(cardId: string, src: string) {
    if (frameStrips[cardId]) return;
    const video = document.createElement("video");
    video.src = src;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("Could not load video frames."));
      });
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 54;
      const context = canvas.getContext("2d");
      if (!context) return;
      const frames: string[] = [];
      const count = 8;
      for (let index = 0; index < count; index += 1) {
        const time = Math.min(
          Math.max(0.01, (video.duration * index) / Math.max(1, count - 1)),
          Math.max(0.01, video.duration - 0.02),
        );
        await new Promise<void>((resolve) => {
          video.onseeked = () => resolve();
          video.currentTime = time;
        });
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL("image/jpeg", 0.72));
      }
      setFrameStrips((current) => (current[cardId] ? current : { ...current, [cardId]: frames }));
    } catch {
      setFrameStrips((current) => (current[cardId] ? current : { ...current, [cardId]: [] }));
    } finally {
      video.removeAttribute("src");
      video.load();
    }
  }

  function stepVersion(key: string, next: number, versions: StoryboardMediaVersion[]) {
    const clamped = Math.max(0, Math.min(next, versions.length - 1));
    setVersionSelection((current) => ({
      ...current,
      [key]: { count: versions.length, index: clamped },
    }));
    const cardId = key.slice(key.indexOf(":") + 1);
    rememberPlayback(cardId, { selectedVersion: clamped });
  }

  function displaySrc(card: CanvasCard) {
    const versions = card.versions ?? [];
    const key = `${card.kind}:${card.id}`;
    if (!versions.length) return card.src;
    return versions[resolveVersionIndex(key, versions)]?.src ?? card.src;
  }

  const agentCanvasContext = useMemo<CanvasAgentContextCandidate>(() => {
    const artifactForId = (id: string) => {
      const card = allCards.find((entry) => entry.id === id);
      if (!card) return null;
      const versions = card.versions ?? [];
      const versionIndex = versions.length
        ? resolveVersionIndex(`${card.kind}:${card.id}`, versions)
        : null;
      return canvasAgentContextArtifact(card, versionIndex);
    };
    const selected = selectedIds
      .map(artifactForId)
      .filter((item): item is CanvasAgentContextCandidateArtifact =>
        Boolean(item),
      );
    const pinned = stagedCardIds
      .map(artifactForId)
      .filter((item): item is CanvasAgentContextCandidateArtifact =>
        Boolean(item),
      );
    const focused =
      (selectedId
        ? [...selected, ...pinned].find(
            (item) => item.artifactId === selectedId,
          )
        : null) ?? null;
    return { focused, pinned, selected };
  }, [allCards, resolveVersionIndex, selectedId, selectedIds, stagedCardIds]);

  useEffect(() => {
    onAgentContextChange?.(agentCanvasContext);
  }, [agentCanvasContext, onAgentContextChange]);

  function canDrawOver(card: CanvasCard, src: string | null | undefined) {
    return Boolean(src) && (card.kind === "clip" || card.kind === "image" || card.kind === "video");
  }

  function startDrawing(card: CanvasCard) {
    if (!displaySrc(card)) return;
    if (!requestSelectOnly(card.id)) return;
    setDrawMode({ cardId: card.id, marks: [], tool: "rect" });
  }

  function canStage(card: CanvasCard) {
    return card.path !== "#" && !card.generating && card.kind !== "audio";
  }

  function toggleStaged(cardId: string) {
    setStagedCardIds((current) =>
      current.includes(cardId)
        ? current.filter((id) => id !== cardId)
        : [...current, cardId],
    );
  }

  /** Everything the next composer submit references: the focused tile is
   * included quietly, while explicit staged tiles are shown in the tray. */
  function composerFocusCards(tagged: CanvasCard | null) {
    const byId = new Map(allCards.map((entry) => [entry.id, entry]));
    const cards: CanvasCard[] = [];
    const seen = new Set<string>();
    for (const id of [...(tagged ? [tagged.id] : []), ...stagedCardIds]) {
      const entry = byId.get(id);
      if (!entry || seen.has(id) || !canStage(entry)) continue;
      seen.add(id);
      cards.push(entry);
    }
    return cards;
  }

  function composerReferenceThumb(card: CanvasCard) {
    return frameStrips[card.id]?.[0] ??
      (card.kind === "clip" || card.kind === "video" ? null : displaySrc(card));
  }

  function renderComposerReferenceMedia(card: CanvasCard, thumb: string | null) {
    if (thumb) {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumb} alt="" draggable={false} />
      );
    }

    const src = displaySrc(card);
    if ((card.kind === "clip" || card.kind === "video") && src) {
      return (
        <video
          src={src}
          muted
          playsInline
          preload="metadata"
          draggable={false}
        />
      );
    }

    return (
      <span className="canvas-dock-reference-icon">
        {card.kind === "image" || card.kind === "keyframe" ? (
          <ImageIcon size={18} />
        ) : (
          <Video size={18} />
        )}
      </span>
    );
  }

  function composerReferenceAspectClass(card: CanvasCard) {
    const [rawWidth, rawHeight] = (card.aspectRatio ?? "").split("/").map(Number);
    if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth <= 0 || rawHeight <= 0) {
      return "is-landscape";
    }

    const ratio = rawWidth / rawHeight;
    if (ratio > 1.2) return "is-landscape";
    if (ratio < 0.82) return "is-portrait";
    return "is-square";
  }

  async function commitRename(card: CanvasCard, nextTitle: string) {
    const title = nextTitle.trim();
    if (!title || title === card.title || card.path === "#") return;
    const response = await fetch(`/api/projects/${projectId}/canvas/rename-tile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: card.path, title }),
    });
    if (response.ok) await onRefreshProject();
  }

  function canAdjustImage(card: CanvasCard, src: string | null | undefined) {
    return (
      Boolean(src) &&
      (card.kind === "keyframe" || card.kind === "image") &&
      /^(keyframes|uploads)\//.test(card.path)
    );
  }

  function startImageAdjust(card: CanvasCard, mode: "crop" | "filters") {
    if (!requestSelectOnly(card.id)) return;
    setDrawMode(null);
    setImageAdjust((current) =>
      current?.cardId === card.id && current.mode === mode
        ? null
        : {
            activeParam: mode === "filters" ? "brightness" : null,
            cardId: card.id,
            crop: current?.cardId === card.id ? current.crop : null,
            mode,
            params:
              current?.cardId === card.id ? current.params : { ...NEUTRAL_IMAGE_ADJUST },
            saving: false,
          },
    );
  }

  function imageAdjustChanged(state: ImageAdjustState) {
    return (
      Boolean(state.crop) ||
      IMAGE_ADJUST_PARAMS.some((param) => state.params[param.key] !== NEUTRAL_IMAGE_ADJUST[param.key])
    );
  }

  function cssFilterForAdjust(params: ImageAdjustState["params"]) {
    const parts: string[] = [];
    if (params.brightness !== 50) {
      parts.push(`brightness(${(1 + (params.brightness - 50) / 100).toFixed(3)})`);
    }
    if (params.contrast !== 50) parts.push(`contrast(${(0.5 + params.contrast / 100).toFixed(3)})`);
    if (params.saturation !== 50) parts.push(`saturate(${(params.saturation / 50).toFixed(3)})`);
    if (params.warmth > 50) parts.push(`sepia(${((params.warmth - 50) / 140).toFixed(3)})`);
    if (params.warmth < 50) parts.push(`hue-rotate(${((50 - params.warmth) * 0.5).toFixed(1)}deg)`);
    if (params.hue !== 50) parts.push(`hue-rotate(${((params.hue - 50) * 1.8).toFixed(1)}deg)`);
    if (params.blur > 0) parts.push(`blur(${(params.blur / 20).toFixed(2)}px)`);
    // Sharpen has no CSS preview equivalent; it only shows after Apply.
    return parts.join(" ") || undefined;
  }

  async function applyImageAdjust(card: CanvasCard) {
    const state = imageAdjust;
    if (!state || state.cardId !== card.id || !imageAdjustChanged(state) || state.saving) return;
    setImageAdjust({ ...state, saving: true });
    try {
      const response = await fetch(`/api/projects/${projectId}/canvas/edit-image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          crop: state.crop,
          filters: state.params,
          path: card.path,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(typeof payload.error === "string" ? payload.error : "Edit failed.");
      }
      await onRefreshProject();
      setImageAdjust(null);
    } catch {
      setImageAdjust((current) =>
        current?.cardId === card.id ? { ...current, saving: false } : current,
      );
    }
  }

  function handleDrawMark(card: CanvasCard, mark: DrawOverAnnotation) {
    // Video tracking uses a single region, so a new mark replaces the last one.
    // Marks stay client-side until the composer sends them with the request.
    const isVideo = card.kind === "clip" || card.kind === "video";
    setDrawMode((current) =>
      current && current.cardId === card.id
        ? { ...current, marks: isVideo ? [mark] : [...current.marks, mark] }
        : current,
    );
  }

  async function submitDraw(
    card: CanvasCard,
    annotations: DrawOverAnnotation[],
    instruction: string,
  ) {
    const src = displaySrc(card);
    if (!src || !annotations.length || drawSubmitting) return;
    const isVideo = card.kind === "clip" || card.kind === "video";
    const element = viewportRef.current?.querySelector<HTMLElement>(
      `[data-canvas-card-id="${card.id}"]`,
    );
    let naturalWidth = 0;
    let naturalHeight = 0;
    if (element instanceof HTMLVideoElement) {
      naturalWidth = element.videoWidth;
      naturalHeight = element.videoHeight;
    } else if (element instanceof HTMLImageElement) {
      naturalWidth = element.naturalWidth;
      naturalHeight = element.naturalHeight;
    }
    setDrawSubmitting(true);
    try {
      await onDrawRequest({
        card,
        request: {
          media: {
            kind: isVideo ? "video" : "image",
            sourceId: card.id,
            sourcePath: card.path,
            src,
            title: card.title,
          },
          frame: {
            fps: null,
            frameIndex: null,
            naturalHeight: Math.round(naturalHeight || element?.clientHeight || 1),
            naturalWidth: Math.round(naturalWidth || element?.clientWidth || 1),
            timestampSeconds: annotations[0]?.timestampSeconds ?? 0,
          },
          annotations,
          instruction: instruction.trim(),
        },
      });
      setDrawMode(null);
      setDraft({ id: "", text: "" });
    } finally {
      setDrawSubmitting(false);
    }
  }

  /** Minified source assets on an in-flight placeholder: orbiting the blob
   * while imagining, then settling into a neat top-left row (3 + n more). */
  function renderGenRefs(card: CanvasCard) {
    if (!card.generating || !card.refThumbs?.length) return null;
    const orbiting = false;
    const visible = card.refThumbs.slice(0, 3);
    const extra = card.refThumbs.length - visible.length;
    return (
      <div className={`canvas-gen-refs ${orbiting ? "is-orbiting" : "is-settled"}`} aria-hidden="true">
        {visible.map((ref, index) => (
          <span
            key={ref.id}
            className="canvas-gen-ref"
            style={{ animationDelay: orbiting ? `${index * -2.4}s` : `${index * 60}ms` }}
          >
            {ref.thumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={ref.thumb} alt="" draggable={false} />
            ) : (
              <span className="canvas-gen-ref-icon">
                <Video size={11} />
              </span>
            )}
          </span>
        ))}
        {!orbiting && extra > 0 ? <span className="canvas-gen-ref is-more">+{extra}</span> : null}
      </div>
    );
  }

  function renderDrawToolbar(card: CanvasCard) {
    if (drawMode?.cardId !== card.id) return null;
    const isVideo = card.kind === "clip" || card.kind === "video";
    return (
      <div
        className="canvas-tile-draw-toolbar"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span className="canvas-tile-draw-hint">
          {isVideo
            ? "Draw around an object, then send the request below"
            : "Mark areas, then describe the change below"}
        </span>
        <button
          type="button"
          className={drawMode.tool === "rect" ? "is-active" : ""}
          title="Box"
          aria-label="Box tool"
          onClick={() => setDrawMode((current) => (current ? { ...current, tool: "rect" } : current))}
        >
          <Square size={16} />
        </button>
        <button
          type="button"
          className={drawMode.tool === "freehand" ? "is-active" : ""}
          title="Draw"
          aria-label="Freehand tool"
          onClick={() =>
            setDrawMode((current) => (current ? { ...current, tool: "freehand" } : current))
          }
        >
          <Brush size={16} />
        </button>
        <span className="canvas-tile-draw-separator" aria-hidden="true" />
        <button
          type="button"
          title="Undo mark"
          aria-label="Undo mark"
          disabled={!drawMode.marks.length}
          onClick={() =>
            setDrawMode((current) =>
              current ? { ...current, marks: current.marks.slice(0, -1) } : current,
            )
          }
        >
          <RotateCcw size={16} />
        </button>
        <button
          type="button"
          title="Clear marks"
          aria-label="Clear marks"
          disabled={!drawMode.marks.length}
          onClick={() =>
            setDrawMode((current) => (current ? { ...current, marks: [] } : current))
          }
        >
          <Trash2 size={16} />
        </button>
        <span className="canvas-tile-draw-separator" aria-hidden="true" />
        <button
          type="button"
          title="Exit drawing"
          aria-label="Exit drawing"
          onClick={() => setDrawMode(null)}
        >
          <X size={16} />
        </button>
      </div>
    );
  }

  function renderTileActions(card: CanvasCard) {
    const isVideo = card.kind === "clip" || card.kind === "video";
    const src = displaySrc(card);
    const trimming = trimModeCardId === card.id;
    const drawActive = drawMode?.cardId === card.id;
    const muted = !unmutedCardIds.includes(card.id);
    const adjusting = imageAdjust?.cardId === card.id ? imageAdjust : null;
    return (
      <div
        className={`canvas-tile-actions ${adjusting?.mode === "filters" ? "is-adjusting" : ""}`}
        role="toolbar"
        aria-label="Tile actions"
      >
            {adjusting?.mode === "filters" ? (
              <div className="canvas-image-params" onPointerDown={(event) => event.stopPropagation()}>
                {IMAGE_ADJUST_PARAMS.map((param) => {
                  const active = adjusting.activeParam === param.key;
                  return (
                    <div key={param.key} className="canvas-image-param">
                      {active ? (
                        <div className="canvas-image-slider">
                          <span>{Math.round(adjusting.params[param.key])}</span>
                          <div className="canvas-image-slider-track">
                            <input
                              type="range"
                              min={0}
                              max={100}
                              aria-label={`${param.label} amount`}
                              value={adjusting.params[param.key]}
                              onChange={(event) => {
                                const value = Number(event.currentTarget.value);
                                setImageAdjust((current) =>
                                  current?.cardId === card.id
                                    ? {
                                        ...current,
                                        params: { ...current.params, [param.key]: value },
                                      }
                                    : current,
                                );
                              }}
                            />
                          </div>
                        </div>
                      ) : null}
                      <button
                        type="button"
                        className={`canvas-image-param-button ${active ? "is-active" : ""}`}
                        onClick={() =>
                          setImageAdjust((current) =>
                            current?.cardId === card.id
                              ? { ...current, activeParam: active ? null : param.key }
                              : current,
                          )
                        }
                      >
                        {param.label}
                      </button>
                    </div>
                  );
                })}
                <span className="canvas-tile-actions-separator" aria-hidden="true" />
              </div>
            ) : null}
            {isVideo && card.status !== "local" ? (
              <button
                type="button"
                className={trimming ? "is-active" : ""}
                title={trimming ? "Hide trim timeline" : "Trim clip"}
                aria-label={trimming ? "Hide trim timeline" : "Trim clip"}
                onClick={() => {
                  if (trimming) {
                    setTrimModeCardId(null);
                    setFrameStrips((current) => {
                      if (!current[card.id]) return current;
                      const next = { ...current };
                      delete next[card.id];
                      return next;
                    });
                    return;
                  }
                  setTrimModeCardId(card.id);
                  if (src) void captureFrameStrip(card.id, src);
                }}
              >
                <Scissors size={17} />
              </button>
            ) : null}
            {canDrawOver(card, src) ? (
              <button
                type="button"
                className={drawActive ? "is-active" : ""}
                title={drawActive ? "Exit drawing" : "Draw on tile"}
                aria-label={drawActive ? "Exit drawing" : "Draw on tile"}
                onClick={() => (drawActive ? setDrawMode(null) : startDrawing(card))}
              >
                <PencilLine size={17} />
              </button>
            ) : null}
            {canAdjustImage(card, src) ? (
              <>
                <button
                  type="button"
                  className={adjusting?.mode === "crop" ? "is-active" : ""}
                  title={adjusting?.mode === "crop" ? "Exit crop" : "Crop image"}
                  aria-label={adjusting?.mode === "crop" ? "Exit crop" : "Crop image"}
                  onClick={() => startImageAdjust(card, "crop")}
                >
                  <Crop size={17} />
                </button>
                <button
                  type="button"
                  className={adjusting?.mode === "filters" ? "is-active" : ""}
                  title={adjusting?.mode === "filters" ? "Hide adjustments" : "Adjust image"}
                  aria-label={adjusting?.mode === "filters" ? "Hide adjustments" : "Adjust image"}
                  onClick={() => startImageAdjust(card, "filters")}
                >
                  <SlidersHorizontal size={17} />
                </button>
              </>
            ) : null}
            {adjusting && imageAdjustChanged(adjusting) ? (
              <>
                <span className="canvas-tile-actions-separator" aria-hidden="true" />
                <button
                  type="button"
                  className="canvas-tile-action-text"
                  onClick={() => setImageAdjust(null)}
                >
                  Discard
                </button>
                <button
                  type="button"
                  className="canvas-tile-action-text"
                  disabled={adjusting.saving}
                  onClick={() => void applyImageAdjust(card)}
                >
                  {adjusting.saving ? "Applying..." : "Apply"}
                </button>
              </>
            ) : null}
            {isVideo ? (
              <Menu
                onOpenChange={(open) => {
                  if (open) setCustomPlaybackRate(String(playbackRates[card.id] ?? 1));
                }}
              >
                <MenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Playback speed options"
                    title={`Playback speed: ${playbackRates[card.id] ?? 1}x`}
                  >
                    <Gauge size={17} />
                  </button>
                </MenuTrigger>
                <MenuContent align="center" side="top" sideOffset={10} className="canvas-speed-menu">
                  <MenuLabel>Playback speed</MenuLabel>
                  {[0.5, 1, 1.5, 2].map((rate) => (
                    <MenuItem key={rate} onSelect={() => setSelectedPlaybackRate(rate)}>
                      {rate}x
                    </MenuItem>
                  ))}
                  <MenuSeparator />
                  <div
                    className="canvas-speed-custom"
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") {
                        event.preventDefault();
                        applyCustomPlaybackRate();
                      }
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <span>Custom</span>
                    <input
                      type="number"
                      min={0.1}
                      max={4}
                      step={0.1}
                      value={customPlaybackRate}
                      aria-label="Custom playback speed"
                      onBlur={applyCustomPlaybackRate}
                      onChange={(event) => setCustomPlaybackRate(event.currentTarget.value)}
                    />
                    <span>x</span>
                  </div>
                </MenuContent>
              </Menu>
            ) : null}

            {trimming && trimDraft && trimChanged() ? (
              <>
                <span className="canvas-tile-actions-separator" aria-hidden="true" />
                <button
                  type="button"
                  className="canvas-tile-action-text"
                  onClick={() => resetTrimDraft(card, trimDraft.duration)}
                >
                  Discard
                </button>
                <button
                  type="button"
                  className="canvas-tile-action-text"
                  disabled={savingClipEdit}
                  onClick={() => void saveTrim("version").then(() => setTrimModeCardId(null))}
                >
                  {savingClipEdit ? "Saving..." : "Save"}
                </button>
                <button
                  type="button"
                  className="canvas-tile-action-text"
                  disabled={savingClipEdit}
                  onClick={() => void saveTrim("new").then(() => setTrimModeCardId(null))}
                >
                  Save as new
                </button>
              </>
            ) : null}
      </div>
    );
  }

  function renderLoadingPiece(card: CanvasCard) {
    const state = canvasPieceState(card.status, Boolean(card.generating));
    return (
      <CanvasLoadingPiece
        aspectRatio={card.aspectRatio}
        intrinsicAspectRatio={measuredAspectRatios[card.id]}
        kind={canvasPieceKindForCard(card)}
        label={state === "ready" ? "Media unavailable" : undefined}
        progress={card.progress}
        remediation={card.remediation}
        sourceAspectRatio={card.sourceAspectRatio}
        state={state}
        toolAspectRatio={card.toolAspectRatio}
        workflowAspectRatio={card.workflowAspectRatio}
      />
    );
  }

  function renderCanvasDock() {
    const card = selectedActionCard;
    const showForDraw = Boolean(card && activeDrawCard?.id === card.id);
    // The dock yields to the chat panel — one text input at a time. It stays
    // up mid-draw though, since draw requests (image edits and object tracking
    // alike) are only ever sent from here.
    const dockVisible = composerVisible || Boolean(activeDrawCard);
    const stagedChipCards = stagedCardIds
      .map((id) => allCards.find((entry) => entry.id === id))
      .filter((entry): entry is CanvasCard => Boolean(entry));
    const referenceCards = stagedChipCards.map((staged) => ({ card: staged }));
    const hasComposerReferences = referenceCards.length > 0;
    // Only tiles with no server identity (local blobs, in-flight placeholders)
    // can't be prompt-edited; everything else routes through the composer.
    const inputLocked =
      Boolean(card) && !showForDraw && (card!.path === "#" || Boolean(card!.generating));
    return (
      <div
        className={`canvas-dock ${dockVisible ? "" : "is-hidden"} ${
          hasComposerReferences ? "has-references" : ""
        }`}
      >
        <div className={`canvas-dock-shell ${dockDropGhost ? "is-receiving" : ""}`}>
          {actions.length ? (
            <div className="canvas-dock-pills">
              <div className="canvas-dock-ticker" aria-live="polite">
                {actions.map((action) => (
                  <span
                    key={action.key}
                    className={`canvas-dock-action tool-call running ${action.leaving ? "is-leaving" : ""}`}
                  >
                    <ActionTickerIcon tool={action.tool} />
                    <span className="tool-call-label">{action.label}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        <FloatingComposer
          value={draftText}
          aborting={isAborting}
          mentions={allCards
            .filter((entry) => entry.path !== "#" && !entry.generating)
            .map((entry) => ({
              id: entry.id,
              kind: entry.refCategory ? `${entry.refCategory} reference` : entry.kind,
              src: entry.src ?? null,
              title: entry.title,
            }))}
          browseItems={browseItems}
          onBrowsePick={onBrowsePick}
          slashItems={[
            ...(FLOWS_ENABLED
              ? [
                  {
                    description: "Browse and run production workflows",
                    icon: <Waves size={15} />,
                    id: "workflows",
                    run: () => {
                      setFlowsModalOpen(true);
                    },
                    title: "Flows",
                  },
                ]
              : []),
            {
              description: "Upload from computer",
              icon: <Plus size={15} />,
              id: "add-files",
              run: () => openLocalUpload("image"),
              title: "Add photos & files",
            },
            {
              description: "Share this project",
              icon: <Share2 size={15} />,
              id: "share",
              run: onShareProject,
              title: "Share",
            },
            {
              description: "Switch to the editor",
              icon: <Video size={15} />,
              id: "editor",
              run: () => onSwitchView?.("editor"),
              title: "Editor",
            },
            {
              description: "Switch to the plan",
              icon: <SlidersHorizontal size={15} />,
              id: "plan",
              run: () => onSwitchView?.("plan"),
              title: "Plan",
            },
            {
              description: "Trending public characters & references",
              icon: <Search size={15} />,
              id: "browse",
              run: () => {
                setBrowseModalQuery("");
                setBrowseModalFilter("All");
                setBrowseModalOpen(true);
              },
              title: "Browse",
            },
            {
              description: "Keyboard shortcuts",
              icon: <Keyboard size={15} />,
              id: "shortcuts",
              run: () => onOpenShortcuts?.(),
              title: "Shortcuts",
            },
          ]}
          onFiles={onUploadFiles ? (files) => void onUploadFiles(files) : undefined}
          placeholder={
            showForDraw
              ? activeDrawIsVideo
                ? "Optional note, then send to track the marked object"
                : "Describe the change for the marked areas"
              : card
                ? inputLocked
                  ? "This tile can't be prompt-edited — untag to create"
                  : "Describe your change or edit here"
                : "Ask for anything—create, change, combine, or finish"
          }
          textareaDisabled={inputLocked && !workflowDraft}
          sending={isSending || (showForDraw ? drawSubmitting : submitting)}
          onAbort={isSending && onAbort ? onAbort : null}
          submitTitle={isSending ? "The agent is working — wait for it to finish (or stop it in chat)" : "Generate change"}
          submitDisabled={
            isSending ||
            isAborting ||
            (workflowDraft
              ? !draftText.trim() || submitting
              : showForDraw
                ? !drawMode?.marks.length ||
                  (!activeDrawIsVideo && !draftText.trim()) ||
                  drawSubmitting
                : card
                  ? !promptChanged || submitting
                  : !draftText.trim() || submitting)
          }
          onChange={(text) => {
            if (!composeTarget) return;
            setDraft((current) => ({
              id: composeTarget,
              runMode: current.id === composeTarget ? current.runMode : undefined,
              text,
            }));
          }}
          onSubmit={() => {
            if (workflowDraft) {
              void submitWorkflow();
              return;
            }
            if (activeDrawCard && drawMode) {
              void submitDraw(activeDrawCard, drawMode.marks, draftText);
              return;
            }
            if (card) {
              void submitPrompt();
              return;
            }
            void submitCreate();
          }}
          tray={[
            ...referenceCards.map(({ card: referenceCard }) => (
              <AttachmentTile
                key={`ref-${referenceCard.id}`}
                aspectRatio={referenceCard.aspectRatio}
                kind={referenceCard.kind}
                name={referenceCard.title}
                src={composerReferenceThumb(referenceCard)}
                onRemove={() => toggleStaged(referenceCard.id)}
              />
            )),
            ...promptAttachments.map((attachment) => (
              <AttachmentTile
                key={`att-${attachment.id}`}
                kind={attachment.src ? "image" : "document"}
                name={attachment.label}
                src={attachment.src}
              />
            )),
          ]}
          controls={
            showForDraw && drawMode ? (
              <span className="canvas-draw-mark-count">
                {drawMode.marks.length
                  ? `${drawMode.marks.length} mark${drawMode.marks.length === 1 ? "" : "s"}`
                  : activeDrawIsVideo
                    ? "Draw a box around the object"
                    : "Draw on the tile to mark it"}
              </span>
            ) : (
              <>
                <button
                  className="storyboard-floating-add"
                  type="button"
                  title={card ? "Add reference by typing @id" : "Add media tile"}
                  onClick={() => (card ? onOpenFile(card.path) : openLocalUpload("image"))}
                >
                  <Plus size={18} />
                </button>
                {FLOWS_ENABLED ? (
                  <button
                    type="button"
                    className="canvas-dock-tool-button"
                    onClick={() => {
                      setFlowsModalOpen(true);
                    }}
                  >
                    <span className="canvas-dock-pill-label">Flows</span>
                  </button>
                ) : null}
              </>
            )
          }
        />
        </div>
      </div>
    );
  }

  function cardsForAction(card: CanvasCard) {
    const ids = selectedIdSet.has(card.id) ? selectedIds : [card.id];
    return ids.map((id) => cardById.get(id)).filter((entry): entry is CanvasCard => Boolean(entry));
  }

  function canConnect(card: CanvasCard) {
    return card.kind === "clip" || card.kind === "video";
  }

  function orderedForConnection(targets: CanvasCard[]) {
    return targets
      .filter(canConnect)
      .sort((a, b) => {
        const left = positions[a.id] ?? { x: 0, y: 0 };
        const right = positions[b.id] ?? { x: 0, y: 0 };
        return left.x === right.x ? left.y - right.y : left.x - right.x;
      });
  }

  function connectionForCard(cardId: string) {
    return connectionByCardId.get(cardId) ?? null;
  }

  function disconnectConnection(connectionId: string) {
    if (playingConnectionId === connectionId) stopConnectionPlayback();
    setConnections((current) => current.filter((connection) => connection.id !== connectionId));
    setConnectionPreviewCardIds((current) => {
      const next = { ...current };
      delete next[connectionId];
      return next;
    });
    setConnectionPlaybackTimes((current) => {
      const next = { ...current };
      delete next[connectionId];
      return next;
    });
  }

  function renameConnection(connectionId: string, name: string) {
    setConnections((current) =>
      current.map((connection) =>
        connection.id === connectionId ? { ...connection, name } : connection,
      ),
    );
  }

  function setConnectionCollapsed(connectionId: string, collapsed: boolean) {
    const connection = connections.find((entry) => entry.id === connectionId);
    setConnections((current) =>
      current.map((entry) => (entry.id === connectionId ? { ...entry, collapsed } : entry)),
    );
    if (connection && collapsed) {
      setConnectionPreviewCardIds((current) => ({
        ...current,
        [connection.id]: current[connection.id] ?? connection.cardIds[0],
      }));
      selectOnly(null);
    }
  }

  function connectCards(targets: CanvasCard[]) {
    const ordered = orderedForConnection(targets);
    if (ordered.length < 2) return;
    const connectedIds = new Set(ordered.map((card) => card.id));
    const baseX = Math.min(...ordered.map((card) => positions[card.id]?.x ?? 0));
    const baseY = Math.min(...ordered.map((card) => positions[card.id]?.y ?? 0));
    setPositions((current) => {
      const next = { ...current };
      ordered.forEach((card, index) => {
        next[card.id] = {
          x: baseX + index * (CANVAS_CARD_WIDTH + CANVAS_CONNECTION_GAP),
          y: baseY,
        };
      });
      return next;
    });
    setConnections((current) => {
      const trimmed = current
        .map((connection) => ({
          ...connection,
          cardIds: connection.cardIds.filter((id) => !connectedIds.has(id)),
        }))
        .filter((connection) => connection.cardIds.length > 1);
      return [
        ...trimmed,
        {
          cardIds: ordered.map((card) => card.id),
          collapsed: false,
          id: `connection-${Date.now()}`,
          name: `Sequence ${trimmed.length + 1}`,
        },
      ];
    });
    selectMany(ordered.map((card) => card.id));
  }

  function connectionCards(connection: CanvasConnection) {
    return connection.cardIds
      .map((id) => cardById.get(id))
      .filter((card): card is CanvasCard => Boolean(card));
  }

  function connectionBounds(connection: CanvasConnection) {
    const connectedCards = connectionCards(connection);
    if (connectedCards.length < 2) return null;
    if (connection.collapsed) {
      const firstCard = connectedCards[0];
      const position = positions[firstCard.id] ?? { x: 0, y: 0 };
      return {
        height:
          cardHeight(firstCard, measuredAspectRatios[firstCard.id]) +
          CANVAS_CONNECTION_TIMELINE +
          CANVAS_CONNECTION_TIMELINE_GAP +
          CANVAS_CONNECTION_PADDING * 2,
        left: position.x - CANVAS_CONNECTION_PADDING,
        top: position.y - CANVAS_CONNECTION_PADDING,
        width: CANVAS_CARD_WIDTH + CANVAS_CONNECTION_PADDING * 2,
      };
    }
    const boxes = connectedCards.map((card) => {
      const position = positions[card.id] ?? { x: 0, y: 0 };
      const editingCardTimeline =
        trimModeCardId === card.id && selectedId === card.id && trimDraft?.cardId === card.id
          ? CANVAS_CONNECTION_TIMELINE + CANVAS_CONNECTION_TIMELINE_GAP
          : 0;
      return {
        bottom: position.y + cardHeight(card, measuredAspectRatios[card.id]) + editingCardTimeline,
        left: position.x,
        right: position.x + cardWidth(card),
        top: position.y,
      };
    });
    const left = Math.min(...boxes.map((box) => box.left));
    const right = Math.max(...boxes.map((box) => box.right));
    const top = Math.min(...boxes.map((box) => box.top));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    return {
      height: bottom - top + CANVAS_CONNECTION_PADDING * 2,
      left: left - CANVAS_CONNECTION_PADDING,
      top: top - CANVAS_CONNECTION_PADDING,
      width: right - left + CANVAS_CONNECTION_PADDING * 2,
    };
  }

  function connectionDuration(connection: CanvasConnection) {
    return connection.cardIds.reduce((total, id) => {
      const card = cardById.get(id);
      if (!card) return total;
      return total + (mediaDurations[id] ?? card.duration ?? 0);
    }, 0);
  }

  async function deleteCards(targets: CanvasCard[]) {
    if (!areCanvasCardsDeletable(targets)) {
      throw new Error("Deletion eligibility invariant violated.");
    }
    const projectTargets = targets.filter(isCanvasCardDeletable);
    // Vanish immediately; restore on failure.
    const tombstoneIds = projectTargets.map((card) => card.id);
    if (tombstoneIds.length) {
      setDeletedCardIds((current) => new Set([...current, ...tombstoneIds]));
    }

    try {
      await onDeleteCards({ cards: projectTargets });
    } catch {
      // Server refused — resurrect the tiles and preserve every related state.
      setDeletedCardIds((current) => {
        const next = new Set(current);
        for (const id of tombstoneIds) next.delete(id);
        return next;
      });
      return;
    }
    const deletedIds = new Set(projectTargets.map((card) => card.id));
    setConnections((current) =>
      current
        .map((connection) => ({
          ...connection,
          cardIds: connection.cardIds.filter((id) => !deletedIds.has(id)),
        }))
        .filter((connection) => connection.cardIds.length > 1),
    );
    const arrangedGroups = arrangeGroupList(
      groups
        .map((group) => ({
          ...group,
          cardIds: group.cardIds.filter((id) => !deletedIds.has(id)),
        }))
        // A group whose tiles were all deleted goes with them.
        .filter((group, index) => group.cardIds.length > 0 || groups[index]!.cardIds.length === 0),
    );
    setGroups(arrangedGroups.groups);
    if (Object.keys(arrangedGroups.positions).length) {
      setPositions((current) => ({ ...current, ...arrangedGroups.positions }));
    }
    setSelectedIds((current) => current.filter((id) => !deletedIds.has(id)));
    setSelectedId((current) => (current && deletedIds.has(current) ? null : current));
    setFocusedInspectorCardId((current) =>
      current && deletedIds.has(current) ? null : current,
    );
    setSplitMarkers((current) => {
      const next = { ...current };
      for (const id of deletedIds) delete next[id];
      return next;
    });
    setHiddenSegments((current) => {
      const next = { ...current };
      for (const id of deletedIds) delete next[id];
      return next;
    });
  }

  function alignCards(targets: CanvasCard[], mode: "grid" | "row") {
    if (targets.length < 2) return;
    const ordered = [...targets].sort((a, b) => {
      const left = positions[a.id] ?? { x: 0, y: 0 };
      const right = positions[b.id] ?? { x: 0, y: 0 };
      return left.y === right.y ? left.x - right.x : left.y - right.y;
    });
    const baseX = Math.min(...ordered.map((card) => positions[card.id]?.x ?? 0));
    const baseY = Math.min(...ordered.map((card) => positions[card.id]?.y ?? 0));
    const gap = 48;
    setPositions((current) => {
      const next = { ...current };
      if (mode === "row") {
        ordered.forEach((card, index) => {
          next[card.id] = { x: baseX + index * (CANVAS_CARD_WIDTH + gap), y: baseY };
        });
        return next;
      }
      const columns = Math.max(2, Math.ceil(Math.sqrt(ordered.length)));
      let cursorY = baseY;
      for (let rowStart = 0; rowStart < ordered.length; rowStart += columns) {
        const row = ordered.slice(rowStart, rowStart + columns);
        const rowHeight = Math.max(
          ...row.map((card) => cardHeight(card, measuredAspectRatios[card.id])),
        );
        row.forEach((card, index) => {
          next[card.id] = {
            x: baseX + index * (CANVAS_CARD_WIDTH + gap),
            y: cursorY,
          };
        });
        cursorY += rowHeight + gap;
      }
      return next;
    });
  }

  function rememberAspectRatio(cardId: string, width: number, height: number) {
    const next = measuredAspectRatio(width, height);
    if (!next) return;
    setMeasuredAspectRatios((current) => {
      if (current[cardId] === next) return current;
      return { ...current, [cardId]: next };
    });
  }

  function openLocalUpload(kind: LocalTileKind) {
    setLocalUploadKind(kind);
    localUploadInputRef.current?.click();
  }

  function addLocalTiles(kind: LocalTileKind, files: File[]) {
    if (!files.length) return [] as string[];
    const created = files.map((file, index): CanvasCard => ({
      aspectRatio: null,
      id: `local-${kind}-${file.name}-${file.lastModified}-${Date.now()}-${index}`,
      kind,
      path: "#",
      src: URL.createObjectURL(file),
      status: "local",
      title: file.name,
    }));
    setLocalCards((current) => [...created, ...current]);
    selectOnly(created[0]?.id ?? null);
    return created.map((card) => card.id);
  }

  async function handleLocalFiles(kind: LocalTileKind, files: File[]) {
    if (!files.length) return;
    // Blob tiles give instant feedback; when the parent can persist uploads to
    // the workspace we swap them for the server-backed cards on success so the
    // asset is addressable by the composer/edit flows.
    const optimisticIds = addLocalTiles(kind, files);
    if (!onUploadFiles || kind === "audio") return;
    try {
      await onUploadFiles(files);
      setLocalCards((current) =>
        current.filter((card) => {
          if (!optimisticIds.includes(card.id)) return true;
          if (card.src?.startsWith("blob:")) URL.revokeObjectURL(card.src);
          return false;
        }),
      );
    } catch {
      // Keep the local tiles as a fallback preview if persistence failed.
    }
  }

  useEffect(() => {
    localCardsRef.current = localCards;
  }, [localCards]);

  useEffect(
    () => () => {
      if (focusAnimationRef.current !== null) {
        window.cancelAnimationFrame(focusAnimationRef.current);
      }
      for (const card of localCardsRef.current) {
        if (card.src?.startsWith("blob:")) URL.revokeObjectURL(card.src);
      }
    },
    [],
  );

  const animateToCard = useCallback((card: CanvasCard, options?: { neverZoomOut?: boolean }) => {
    const viewport = viewportRef.current;
    const position = positions[card.id];
    if (!viewport || !position) return;
    if (focusAnimationRef.current !== null) {
      window.cancelAnimationFrame(focusAnimationRef.current);
    }
    const rect = viewport.getBoundingClientRect();
    // Fit to the tile's real rendered box so portrait/tall media never crops,
    // regardless of whether the media has been measured yet. Fall back to the
    // aspect-ratio estimate only if the element isn't in the DOM.
    const cardEl = viewport.querySelector<HTMLElement>(`[data-card-id="${card.id}"]`);
    const tileEl = cardEl?.querySelector<HTMLElement>(".storyboard-tile-shell");
    const measuredWidth = tileEl
      ? tileEl.getBoundingClientRect().width / scale
      : cardWidth(card);
    const measuredHeight = cardEl
      ? cardEl.getBoundingClientRect().height / scale
      : cardHeight(card, measuredAspectRatios[card.id]);
    // Grouped tiles render inset from their logical position (the group
    // frame's padding), so derive world coordinates from the DOM when the
    // element exists — centering then matches what's actually on screen.
    const cardRect = cardEl?.getBoundingClientRect();
    const worldX = cardRect ? (cardRect.left - rect.left - pan.x) / scale : position.x;
    const worldY = cardRect ? (cardRect.top - rect.top - pan.y) / scale : position.y;
    // Center within the space the floating chrome actually leaves free —
    // measure the dock and drawer instead of guessing their sizes.
    const workspace = workspaceRef.current;
    const dockEl = workspace?.querySelector<HTMLElement>(".canvas-dock");
    // A hidden dock (desktop hides it entirely via CSS) reports a zero rect;
    // measuring it made the bottom inset the whole viewport and pinned the
    // focused tile to the top of the screen.
    const dockBox =
      dockEl && !dockEl.classList.contains("is-hidden")
        ? dockEl.getBoundingClientRect()
        : null;
    const bottomInset =
      dockBox && dockBox.height > 0
        ? Math.max(24, rect.bottom - dockBox.top + 12)
        : 24;
    // The drawer opens with selection and covers the right edge — center the
    // tile within the width it actually leaves free.
    const drawerEl = document.querySelector<HTMLElement>(
      ".canvas-inspector-region.is-open",
    );
    // The drawer SQUEEZES the viewport in the normal layout (the viewport
    // rect already excludes it) — subtract only actual overlap, clamped so a
    // mid-slide transform can't exaggerate it.
    const rightInset = drawerEl
      ? Math.max(
          0,
          Math.min(
            drawerEl.offsetWidth,
            rect.right - drawerEl.getBoundingClientRect().left,
          ),
        )
      : 0;
    const fitScale = fitScaleForRect(
      { height: rect.height - bottomInset, width: rect.width - rightInset },
      measuredWidth,
      measuredHeight,
    );
    // Click-focus never zooms out: from a distance it zooms IN to the tile,
    // and past fit it only centers at the current zoom.
    const targetScale = options?.neverZoomOut ? Math.max(scale, fitScale) : fitScale;
    const targetPan = {
      x: (rect.width - rightInset) / 2 - (worldX + measuredWidth / 2) * targetScale,
      y: (rect.height - bottomInset) / 2 - (worldY + measuredHeight / 2) * targetScale,
    };
    const startPan = pan;
    const startScale = scale;
    let startedAt: number | null = null;

    const step = (now: number) => {
      startedAt ??= now;
      const progress = Math.min(1, (now - startedAt) / CANVAS_FOCUS_DURATION_MS);
      const eased = easeOutCubic(progress);
      setScale(startScale + (targetScale - startScale) * eased);
      setPan({
        x: startPan.x + (targetPan.x - startPan.x) * eased,
        y: startPan.y + (targetPan.y - startPan.y) * eased,
      });
      if (progress < 1) {
        focusAnimationRef.current = window.requestAnimationFrame(step);
      } else {
        focusAnimationRef.current = null;
      }
    };
    focusAnimationRef.current = window.requestAnimationFrame(step);
  }, [measuredAspectRatios, pan, positions, scale]);

  const animateToCards = useCallback(
    (cards: CanvasCard[]) => {
      if (cards.length === 1) {
        animateToCard(cards[0]!);
        return;
      }
      const viewport = viewportRef.current;
      if (!viewport || !cards.length) return;
      if (focusAnimationRef.current !== null) {
        window.cancelAnimationFrame(focusAnimationRef.current);
      }
      const rect = viewport.getBoundingClientRect();
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const card of cards) {
        const position = positions[card.id];
        if (!position) continue;
        const cardEl = viewport.querySelector<HTMLElement>(`[data-card-id="${card.id}"]`);
        const tileEl = cardEl?.querySelector<HTMLElement>(".storyboard-tile-shell");
        const width = tileEl ? tileEl.getBoundingClientRect().width / scale : cardWidth(card);
        const height = cardEl
          ? cardEl.getBoundingClientRect().height / scale
          : cardHeight(card, measuredAspectRatios[card.id]);
        minX = Math.min(minX, position.x);
        minY = Math.min(minY, position.y);
        maxX = Math.max(maxX, position.x + width);
        maxY = Math.max(maxY, position.y + height);
      }
      if (!Number.isFinite(minX)) return;
      const margin = 70;
      const boundsWidth = maxX - minX + margin * 2;
      const boundsHeight = maxY - minY + margin * 2;
      const targetScale = fitScaleForRect(
        { height: rect.height, width: rect.width },
        boundsWidth,
        boundsHeight,
      );
      const targetPan = {
        x: rect.width / 2 - (minX - margin + boundsWidth / 2) * targetScale,
        y: rect.height / 2 - (minY - margin + boundsHeight / 2) * targetScale,
      };
      const startPan = pan;
      const startScale = scale;
      let startedAt: number | null = null;
      const step = (now: number) => {
        startedAt ??= now;
        const progress = Math.min(1, (now - startedAt) / CANVAS_FOCUS_DURATION_MS);
        const eased = easeOutCubic(progress);
        setScale(startScale + (targetScale - startScale) * eased);
        setPan({
          x: startPan.x + (targetPan.x - startPan.x) * eased,
          y: startPan.y + (targetPan.y - startPan.y) * eased,
        });
        if (progress < 1) {
          focusAnimationRef.current = window.requestAnimationFrame(step);
        } else {
          focusAnimationRef.current = null;
        }
      };
      focusAnimationRef.current = window.requestAnimationFrame(step);
    },
    [animateToCard, measuredAspectRatios, pan, positions, scale],
  );

  useEffect(() => {
    // Apply per-tile playback speed to whichever video elements are mounted.
    const videos = document.querySelectorAll<HTMLVideoElement>("video[data-canvas-card-id]");
    videos.forEach((video) => {
      const cardId = video.getAttribute("data-canvas-card-id");
      if (!cardId) return;
      const rate = playbackRates[cardId] ?? 1;
      if (video.playbackRate !== rate) video.playbackRate = rate;
    });
  }, [playbackRates, allCards]);

  const focusedComposeIdsRef = useRef(new Set<string>());
  /** Timestamp of the user's last deliberate navigation (arrows, drag, zoom):
   * automatic camera moves must never fight it. */
  const lastUserNavRef = useRef(0);
  const lastArrowStepRef = useRef(0);
  /** Held-key state for S+arrow speed control. */
  const speedKeyHeldRef = useRef(false);
  const [tileOpBusy, setTileOpBusy] = useState(false);
  useEffect(() => {
    // The camera glides to a freshly SUBMITTED composer placeholder (the
    // request's first, "_0") once its position exists — and only when the
    // user hasn't navigated in the last few seconds. Everything else is
    // marked handled WITHOUT moving the camera: extra artifact placeholders
    // and late position assignments must not yank the view mid-work.
    for (const card of allCards) {
      if (!card.id.startsWith("compose_") || focusedComposeIdsRef.current.has(card.id)) continue;
      const position = positions[card.id];
      if (!position) continue;
      focusedComposeIdsRef.current.add(card.id);
      const isPrimaryPlaceholder = card.id.endsWith("_0");
      const userIsNavigating = Date.now() - lastUserNavRef.current < 4000;
      if (isPrimaryPlaceholder && !userIsNavigating) {
        const focus = () => {
          const latestCard = allCards.find((entry) => entry.id === card.id) ?? card;
          if (positions[latestCard.id]) animateToCard(latestCard);
        };
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(focus);
        });
        window.setTimeout(focus, 180);
      }
    }
  }, [allCards, positions, animateToCard]);


  useEffect(() => {
    // Spatial arrow navigation: arrows move to the GEOMETRICALLY nearest tile
    // in that direction on the canvas (right goes right), never by list index.
    const ARROW_VECTORS: Record<string, [number, number]> = {
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
    };
    function onKeyDown(event: KeyboardEvent) {
      const vector = ARROW_VECTORS[event.key];
      if (!vector) return;
      if (speedKeyHeldRef.current) return; // S+arrow = speed control
      if (!selectedId || pendingSelectionId !== undefined) return;
      // One press = one step: swallow key auto-repeat bursts and any
      // double-dispatch (stale HMR listeners) within a step's settle time.
      const now = Date.now();
      if (event.repeat || now - lastArrowStepRef.current < 200) {
        event.preventDefault();
        return;
      }
      lastArrowStepRef.current = now;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable='true'], .app-dialog")
      ) {
        return;
      }
      const currentPosition = positions[selectedId];
      const currentCard = allCards.find((card) => card.id === selectedId);
      if (!currentPosition || !currentCard) return;
      const centerOf = (card: CanvasCard, position: Point) => ({
        x: position.x + (card.displayWidth ?? CANVAS_CARD_WIDTH) / 2,
        y: position.y + cardHeight(card, measuredAspectRatios[card.id]) / 2,
      });
      const origin = centerOf(currentCard, currentPosition);
      const [ux, uy] = vector;
      let best: { card: CanvasCard; score: number } | null = null;
      for (const card of allCards) {
        if (card.id === selectedId) continue;
        const position = positions[card.id];
        if (!position) continue;
        const center = centerOf(card, position);
        const dx = center.x - origin.x;
        const dy = center.y - origin.y;
        const along = dx * ux + dy * uy;
        if (along <= 8) continue; // must actually be in that direction
        const ortho = Math.abs(dx * uy) + Math.abs(dy * ux);
        // Directional CONE, not just half-plane: the candidate must be more
        // "in that direction" than sideways (45° cone, widened by a 96px
        // margin so slightly-staggered rows/columns still count). Without
        // this, "down" could select a nearby tile far to the LEFT that
        // merely sits a few pixels lower.
        if (along < ortho - 96) continue;
        // Off-axis drift is penalized so "right" prefers the same row over a
        // slightly-closer tile diagonally below; drift within ~a tile margin
        // is forgiven entirely so aligned-but-imperfect grids rank by
        // distance alone.
        const score = along + Math.max(0, ortho - 80) * 2.5;
        if (!best || score < best.score) best = { card, score };
      }
      if (!best) return;
      event.preventDefault();
      lastUserNavRef.current = Date.now();
      if (requestSelectOnly(best.card.id)) {
        animateToCard(best.card);
        window.requestAnimationFrame(() => {
          viewportRef.current
            ?.querySelector<HTMLElement>(`[data-card-id="${best.card.id}"]`)
            ?.focus({ preventScroll: true });
        });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measuredAspectRatios only refines centers
  }, [allCards, animateToCard, pendingSelectionId, positions, requestSelectOnly, selectedId]);

  async function runTileOp(
    card: CanvasCard,
    op: "duplicate" | "extract_frame",
    at?: "first" | "last",
  ) {
    if (tileOpBusy || card.path === "#") return;
    setTileOpBusy(true);
    const versions = card.versions ?? [];
    const versionIndex = versions.length
      ? resolveVersionIndex(`${card.kind}:${card.id}`, versions)
      : null;
    try {
      const response = await fetch(`/api/projects/${projectId}/canvas/tile-ops`, {
        body: JSON.stringify({ at, op, path: card.path, version: versionIndex }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && typeof payload.created_id === "string") {
        // Land the result beside its source.
        const sourcePosition = positions[card.id];
        if (sourcePosition) {
          setPositions((current) => ({
            ...current,
            [payload.created_id]: {
              x: sourcePosition.x + (card.displayWidth ?? CANVAS_CARD_WIDTH) + 90,
              y: sourcePosition.y + (op === "duplicate" ? 40 : 0),
            },
          }));
        }
        // The op response carries the fresh snapshot — applying it directly
        // beats a second round-trip.
        if (payload.snapshot && onApplySnapshot) onApplySnapshot(payload.snapshot);
        else await onRefreshProjectRef.current();
        setPendingFocusCardId(payload.created_id);
      }
    } finally {
      setTileOpBusy(false);
    }
  }

  useEffect(() => {
    // Tile shortcuts: F/L extract first/last frame of a video tile, D
    // duplicates any tile, S+Up/Down steps the clip's playback speed.
    function isTypingContext(target: EventTarget | null) {
      return (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable='true'], .app-dialog")
      );
    }
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingContext(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "s") speedKeyHeldRef.current = true;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const card = selectedId ? allCards.find((entry) => entry.id === selectedId) : null;
      if (!card) return;
      const isVideoTile =
        (card.kind === "clip" || card.kind === "video") && card.path !== "#" && Boolean(card.src);
      if ((key === "f" || key === "l") && isVideoTile && !event.repeat) {
        event.preventDefault();
        void runTileOp(card, "extract_frame", key === "f" ? "first" : "last");
        return;
      }
      if (key === "d" && card.path !== "#" && !event.repeat) {
        event.preventDefault();
        void runTileOp(card, "duplicate");
        return;
      }
      if (key === "m" && isVideoTile && !event.repeat) {
        event.preventDefault();
        setUnmutedCardIds((current) =>
          current.includes(card.id)
            ? current.filter((entry) => entry !== card.id)
            : [...current, card.id],
        );
        return;
      }
      if (
        (event.key === "ArrowUp" || event.key === "ArrowDown") &&
        speedKeyHeldRef.current &&
        isVideoTile
      ) {
        event.preventDefault();
        const direction = event.key === "ArrowUp" ? 1 : -1;
        setPlaybackRates((current) => {
          const rate = current[card.id] ?? 1;
          const next = Math.max(
            0.25,
            Math.min(4, Number((direction > 0 ? rate * 1.25 : rate / 1.25).toFixed(2))),
          );
          return { ...current, [card.id]: next };
        });
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "s") speedKeyHeldRef.current = false;
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runTileOp reads live state
  }, [allCards, selectedId, positions, projectId, tileOpBusy]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest(".app-dialog")
      ) {
        return;
      }
      if (focusedInspectorCardId) {
        const returnId =
          inspectorReturnFocusRef.current ?? focusedInspectorCardId;
        event.preventDefault();
        event.stopPropagation();
        setFocusedInspectorCardId(null);
        window.requestAnimationFrame(() => {
          viewportRef.current
            ?.querySelector<HTMLElement>(`[data-card-id="${returnId}"]`)
            ?.focus({ preventScroll: true });
        });
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      if (!selectedIds.length && !selectedGroupId) return;
      if (!requestSelectOnly(null)) return;
      event.preventDefault();
      onAgentContextClear?.();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    focusedInspectorCardId,
    onAgentContextClear,
    requestSelectOnly,
    selectedGroupId,
    selectedIds.length,
  ]);

  useEffect(() => {
    // Delete/Backspace on focused tiles asks for confirmation — but never while
    // the user is typing in a composer, chat box, or any dialog.
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (pendingDeleteCards || pendingSelectionId !== undefined || importDialogOpen) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest("input, textarea, select, [contenteditable='true'], .app-dialog"))
      ) {
        return;
      }
      const targets = allCards.filter(
        (card) => selectedIdSet.has(card.id) || card.id === selectedId,
      );
      if (!areCanvasCardsDeletable(targets)) return;
      event.preventDefault();
      requestDeleteConfirmation(targets);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [allCards, importDialogOpen, pendingDeleteCards, pendingSelectionId, selectedId, selectedIdSet]);

  function continuePendingSelection() {
    const nextId = pendingSelectionId ?? null;
    setPendingSelectionId(undefined);
    setTrimDraft(null);
    selectOnly(nextId);
    const nextCard = allCards.find((card) => card.id === nextId);
    if (nextCard) animateToCard(nextCard);
  }

  async function saveTrimThenContinue(mode: "new" | "version") {
    await saveTrim(mode);
    if (mode === "new") {
      setPendingSelectionId(undefined);
      return;
    }
    continuePendingSelection();
  }

  useEffect(() => {
    if (!pendingFocusCardId) return;
    const card = allCards.find((entry) => entry.id === pendingFocusCardId);
    if (!card || !positions[card.id]) return;
    const frame = window.requestAnimationFrame(() => {
      setPendingFocusCardId(null);
      selectOnly(card.id);
      animateToCard(card);
    });
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectOnly is stable-enough plain fn
  }, [allCards, animateToCard, pendingFocusCardId, positions]);

  useEffect(() => {
    if (!focusRequest) return;
    // Animate each focus request exactly ONCE (by nonce). The effect re-runs
    // whenever cards/positions recompute (snapshot refreshes during a run,
    // selection re-renders) — without the guard the same request restarts the
    // zoom animation every time, which reads as flickering zoom in/out.
    if (handledFocusNonceRef.current === focusRequest.nonce) return;
    const requestedIds = focusRequest.ids?.length ? focusRequest.ids : [focusRequest.id];
    const cards = requestedIds
      .map((requestedId) =>
        allCards.find(
          (item) =>
            item.id === requestedId &&
            (focusRequest.kind === "card" || item.kind === focusRequest.kind),
        ),
      )
      .filter((item): item is CanvasCard => Boolean(item && positions[item.id]));
    if (!cards.length || !positions[cards[0]!.id]) return;
    handledFocusNonceRef.current = focusRequest.nonce;
    const frame = window.requestAnimationFrame(() => {
      if (cards.length > 1) {
        selectMany(cards.map((item) => item.id));
        animateToCards(cards);
      } else {
        const card = cards[0]!;
        const versions = card.versions ?? [];
        if (focusRequest.artifact && versions.length) {
          const requestedIndex = focusRequest.artifact.versionIndex;
          const requestedVersionId = focusRequest.artifact.versionId;
          const matchingIndex = versions.findIndex((version, index) => {
            const candidate = canvasAgentContextArtifact(card, index);
            return (
              candidate.version?.index === requestedIndex &&
              candidate.version?.versionId === requestedVersionId &&
              candidate.version?.path === focusRequest.artifact?.sourcePath
            );
          });
          if (matchingIndex >= 0) {
            stepVersion(
              `${card.kind}:${card.id}`,
              matchingIndex,
              versions,
            );
          }
        }
        selectOnly(card.id);
        if (focusRequest.openInspector) focusInspectorCard(card.id);
        animateToCard(card);
      }
    });
    return () => window.cancelAnimationFrame(frame);
    // stepVersion only writes the requested persisted index; its closure does
    // not participate in deciding whether this focus request is exact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCards, animateToCard, animateToCards, focusRequest, positions]);

  function startMarqueeSelection(event: ReactPointerEvent<HTMLElement>) {
    if (focusAnimationRef.current !== null) {
      window.cancelAnimationFrame(focusAnimationRef.current);
      focusAnimationRef.current = null;
    }
    const start = worldPoint(event.clientX, event.clientY);
    const pointer = { x: event.clientX, y: event.clientY };
    let edgePanFrame: number | null = null;
    const stopEdgePan = () => {
      if (edgePanFrame !== null) {
        window.cancelAnimationFrame(edgePanFrame);
        edgePanFrame = null;
      }
    };
    const updateCurrentPoint = (clientX: number, clientY: number, currentPan = panRef.current) => {
      setMarquee((current) =>
        current ? { ...current, current: worldPointWithPan(clientX, clientY, currentPan) } : null,
      );
    };
    const tickEdgePan = () => {
      const delta = edgePanDelta(pointer.x, pointer.y);
      if (delta.x !== 0 || delta.y !== 0) {
        const nextPan = {
          x: panRef.current.x + delta.x,
          y: panRef.current.y + delta.y,
        };
        panRef.current = nextPan;
        setPan(nextPan);
        updateCurrentPoint(pointer.x, pointer.y, nextPan);
      }
      edgePanFrame = window.requestAnimationFrame(tickEdgePan);
    };
    setMarquee({ current: start, start });
    const onPointerMove = (moveEvent: PointerEvent) => {
      pointer.x = moveEvent.clientX;
      pointer.y = moveEvent.clientY;
      updateCurrentPoint(moveEvent.clientX, moveEvent.clientY);
    };
    const onPointerUp = (upEvent: PointerEvent) => {
      stopEdgePan();
      const end = worldPoint(upEvent.clientX, upEvent.clientY);
      const rect = orderedRect(start, end);
      const hits = cardSpatialIndex.query(rect).map((box) => box.id);
      selectMany([...selectedIds, ...hits]);
      setMarquee(null);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
    edgePanFrame = window.requestAnimationFrame(tickEdgePan);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function startSequenceCardReorder(
    card: CanvasCard,
    connection: CanvasConnection,
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (!requestSelectOnly(card.id)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSequenceReorder({ cardId: card.id, connectionId: connection.id });
    const start = { x: event.clientX, y: event.clientY };
    const originalPositions = Object.fromEntries(
      connection.cardIds.map((id) => [id, positions[id] ?? { x: 0, y: 0 }]),
    );
    const baseX = Math.min(...connection.cardIds.map((id) => originalPositions[id]?.x ?? 0));
    const baseY = Math.min(...connection.cardIds.map((id) => originalPositions[id]?.y ?? 0));
    const slotStride = CANVAS_CARD_WIDTH + CANVAS_CONNECTION_GAP;
    let order = connection.cardIds.filter((id) => cardById.has(id));
    let moved = false;
    let reorderFrame: number | null = null;
    let pendingMove: Point | null = null;

    const slotPosition = (index: number) => ({ x: baseX + index * slotStride, y: baseY });
    const reorderTo = (targetIndex: number) => {
      const withoutDragged = order.filter((id) => id !== card.id);
      const nextOrder = [
        ...withoutDragged.slice(0, targetIndex),
        card.id,
        ...withoutDragged.slice(targetIndex),
      ];
      if (nextOrder.join("|") === order.join("|")) return;
      order = nextOrder;
      setConnections((current) =>
        current.map((entry) =>
          entry.id === connection.id ? { ...entry, cardIds: nextOrder } : entry,
        ),
      );
    };

    const applyPointerMove = (clientX: number, clientY: number) => {
      const dx = (clientX - start.x) / scale;
      const dy = (clientY - start.y) / scale;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      const original = originalPositions[card.id] ?? { x: baseX, y: baseY };
      const draggedX = original.x + dx;
      const draggedY = original.y;
      const targetIndex = Math.max(
        0,
        Math.min(order.length - 1, Math.round((draggedX - baseX) / slotStride)),
      );
      reorderTo(targetIndex);
      setPositions((current) => {
        const next = { ...current };
        for (const id of order) {
          if (id === card.id) {
            next[id] = { x: draggedX, y: draggedY };
            continue;
          }
          next[id] = slotPosition(order.indexOf(id));
        }
        return next;
      });
    };
    const flushPointerMove = () => {
      reorderFrame = null;
      const next = pendingMove;
      pendingMove = null;
      if (next) applyPointerMove(next.x, next.y);
    };
    const onPointerMove = (moveEvent: PointerEvent) => {
      pendingMove = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (reorderFrame === null) reorderFrame = window.requestAnimationFrame(flushPointerMove);
    };

    const onPointerUp = () => {
      if (reorderFrame !== null) {
        window.cancelAnimationFrame(reorderFrame);
        reorderFrame = null;
      }
      if (pendingMove) flushPointerMove();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      setSequenceReorder(null);
      setPositions((current) => {
        const next = { ...current };
        order.forEach((id, index) => {
          next[id] = slotPosition(index);
        });
        return next;
      });
      if (!moved) {
        focusInspectorCard(card.id);
        animateToCard(card);
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function startCardDrag(card: CanvasCard, event: ReactPointerEvent<HTMLDivElement>) {
    lastUserNavRef.current = Date.now();
    if (event.button !== 0) {
      event.stopPropagation();
      return;
    }
    event.stopPropagation();
    if (event.shiftKey || event.metaKey || event.ctrlKey) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest(".storyboard-frame-title-text, .canvas-title-input")
    ) {
      // No drag/pointer-capture from the title — capture would retarget the
      // dblclick away from the span and break rename. Still select the tile.
      if (requestSelectOnly(card.id)) {
        focusInspectorCard(card.id);
      }
      return;
    }
    const draggingSelection = selectedIdSet.has(card.id) && selectedIds.length > 1;
    const sequenceConnection = draggingSelection ? null : connectionForCard(card.id);
    if (sequenceConnection && !sequenceConnection.collapsed) {
      startSequenceCardReorder(card, sequenceConnection, event);
      return;
    }
    const dragIds = draggingSelection ? selectedIds : [card.id];
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY };
    const originalPositions = Object.fromEntries(
      dragIds.map((id) => [id, positions[id] ?? { x: 0, y: 0 }]),
    );
    const groupSnapshots = groupSnapshotsForPositions(positions);
    const dragCards = dragIds
      .map((id) => cardById.get(id))
      .filter((entry): entry is CanvasCard => Boolean(entry));
    const stageableDragCards = dragCards.filter((entry) => canStage(entry));
    let moved = false;
    let dragStateSet = false;
    let nearDock = false;
    let latestDragPositions: Record<string, Point> = { ...originalPositions };
    let pendingMove: Point | null = null;
    let dragFrame: number | null = null;
    const dragFrameDurations: number[] = [];
    const applyPointerMove = (clientX: number, clientY: number) => {
      const frameStartedAt = performance.now();
      const dx = (clientX - start.x) / scale;
      const dy = (clientY - start.y) / scale;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      if (moved && !dragStateSet) {
        dragStateSet = true;
        setDragState({ groupSnapshots, ids: dragIds });
      }
      // Composer drop zone: hovering near the dock pulls a minified ghost of
      // the tile out of the canvas; dropping stages it as a reference.
      if (stageableDragCards.length) {
        const dockBox = composerVisible || activeDrawCard
          ? workspaceRef.current
              ?.querySelector(".canvas-dock-shell")
              ?.getBoundingClientRect()
          : null;
        const chatBox = document
          .querySelector(".chat-mounted-composer")
          ?.getBoundingClientRect();
        const inDock =
          (dockBox
            ? clientX >= dockBox.left - 48 &&
              clientX <= dockBox.right + 48 &&
              clientY >= dockBox.top - 72
            : false) ||
          (chatBox
            ? clientX >= chatBox.left - 24 &&
              clientX <= chatBox.right + 24 &&
              clientY >= chatBox.top - 48 &&
              clientY <= chatBox.bottom + 24
            : false);
        if (inDock !== nearDock) nearDock = inDock;
        setDockDropGhost(
          inDock
            ? {
                thumb: displaySrc(stageableDragCards[0]!),
                title:
                  stageableDragCards.length > 1
                    ? `${stageableDragCards.length} tiles`
                    : stageableDragCards[0]!.title,
                x: clientX,
                y: clientY,
              }
            : null,
        );
      }
      latestDragPositions = Object.fromEntries(
        dragIds.map((id) => {
          const original = originalPositions[id] ?? { x: 0, y: 0 };
          return [id, { x: original.x + dx, y: original.y + dy }];
        }),
      );
      const nextSourcePositions = { ...positions, ...latestDragPositions };
      const targetGroup = !nearDock ? groupForDrop(dragIds, nextSourcePositions) : null;
      const preview = targetGroup
        ? buildGroupDropPreview(targetGroup, dragIds, nextSourcePositions)
        : null;
      setGroupDropPreview(preview);
      setPositions((current) => {
        const next = { ...current };
        for (const id of dragIds) {
          next[id] = latestDragPositions[id] ?? originalPositions[id] ?? { x: 0, y: 0 };
        }
        return next;
      });
      dragFrameDurations.push(performance.now() - frameStartedAt);
    };
    const flushPointerMove = () => {
      dragFrame = null;
      const next = pendingMove;
      pendingMove = null;
      if (next) applyPointerMove(next.x, next.y);
    };
    const onPointerMove = (moveEvent: PointerEvent) => {
      pendingMove = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (dragFrame === null) dragFrame = window.requestAnimationFrame(flushPointerMove);
    };
    const onPointerUp = () => {
      if (dragFrame !== null) {
        window.cancelAnimationFrame(dragFrame);
        dragFrame = null;
      }
      if (pendingMove) flushPointerMove();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      setDragState(null);
      setGroupDropPreview(null);
      setDockDropGhost(null);
      if (dragFrameDurations.length && viewportRef.current) {
        const orderedDurations = [...dragFrameDurations].sort((left, right) => left - right);
        const p95Index = Math.min(
          orderedDurations.length - 1,
          Math.floor(orderedDurations.length * 0.95),
        );
        viewportRef.current.dataset.canvasDragP95Ms =
          orderedDurations[p95Index]!.toFixed(2);
      }
      if (nearDock && stageableDragCards.length) {
        // Dropped on the composer: stage as references, tiles glide home —
        // nothing on the canvas is consumed or mutated, and the currently
        // focused tile remains the composer target.
        setStagedCardIds((current) => [
          ...current,
          ...stageableDragCards
            .map((entry) => entry.id)
            .filter((entryId) => !current.includes(entryId)),
        ]);
        setPositions((current) => ({ ...current, ...originalPositions }));
        return;
      }
      const targetGroup = moved ? groupForDrop(dragIds, latestDragPositions) : null;
      if (targetGroup) {
        if (!draggingSelection) requestSelectOnly(card.id);
        assignCardsToGroup(targetGroup.id, dragIds, latestDragPositions);
        return;
      }
      if (moved) {
        latestDragPositions = resolveCollisionFreePlacement({
          boxes: cardBoxes,
          movingIds: dragIds,
          proposed: latestDragPositions,
        });
        setPositions((current) => ({ ...current, ...latestDragPositions }));
        removeCardsFromGroups(dragIds, latestDragPositions);
      }
      if (moved && !draggingSelection) requestSelectOnly(card.id);
      if (!moved) {
        // A plain click always focuses the tile — even re-clicking the
        // already-selected one. Deferred two frames so the drawer the
        // selection opens is mounted and its width counted; never zooms out.
        if (requestSelectOnly(card.id)) focusInspectorCard(card.id);
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(() =>
            animateToCard(card, { neverZoomOut: true }),
          ),
        );
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function startConnectionDrag(connection: CanvasConnection, event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest("button, input, textarea, select, [contenteditable='true']")
    ) {
      return;
    }
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY };
    const originalPositions = Object.fromEntries(
      connection.cardIds.map((id) => [id, positions[id] ?? { x: 0, y: 0 }]),
    );
    const groupSnapshots = groupSnapshotsForPositions(positions);
    let dragStateSet = false;
    let latestDragPositions: Record<string, Point> = { ...originalPositions };
    let connectionFrame: number | null = null;
    let pendingMove: Point | null = null;
    const applyPointerMove = (clientX: number, clientY: number) => {
      const dx = (clientX - start.x) / scale;
      const dy = (clientY - start.y) / scale;
      if (!dragStateSet && Math.abs(dx) + Math.abs(dy) > 2) {
        dragStateSet = true;
        setDragState({ groupSnapshots, ids: connection.cardIds });
      }
      setPositions((current) => {
        const next = { ...current };
        for (const id of connection.cardIds) {
          const original = originalPositions[id] ?? { x: 0, y: 0 };
          latestDragPositions[id] = { x: original.x + dx, y: original.y + dy };
          next[id] = latestDragPositions[id];
        }
        return next;
      });
    };
    const flushPointerMove = () => {
      connectionFrame = null;
      const next = pendingMove;
      pendingMove = null;
      if (next) applyPointerMove(next.x, next.y);
    };
    const onPointerMove = (moveEvent: PointerEvent) => {
      pendingMove = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (connectionFrame === null) connectionFrame = window.requestAnimationFrame(flushPointerMove);
    };
    const onPointerUp = () => {
      if (connectionFrame !== null) {
        window.cancelAnimationFrame(connectionFrame);
        connectionFrame = null;
      }
      if (pendingMove) flushPointerMove();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      setDragState(null);
      setGroupDropPreview(null);
      if (dragStateSet) {
        autoSizeGroupsForPositions(latestDragPositions);
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function startGroupDrag(group: CanvasGroup, event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest("button, input, textarea, select, [contenteditable='true']")
    ) {
      return;
    }
    event.stopPropagation();
    if (!requestSelectOnly(null)) return;
    selectGroup(group.id);
    setDraggingGroupId(group.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY };
    const memberIds = group.cardIds.filter((id) => allCards.some((card) => card.id === id));
    const originalPositions = Object.fromEntries(
      memberIds.map((id) => [id, positions[id] ?? { x: 0, y: 0 }]),
    );
    const originalGroup = autoSizeGroupToCards(group);
    let moved = false;
    let latestPositions: Record<string, Point> = { ...positions };
    let latestGroup = originalGroup;
    let pendingMove: Point | null = null;
    let groupFrame: number | null = null;
    const applyPointerMove = (clientX: number, clientY: number) => {
      const dx = (clientX - start.x) / scale;
      const dy = (clientY - start.y) / scale;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      latestGroup = {
        ...originalGroup,
        x: originalGroup.x + dx,
        y: originalGroup.y + dy,
      };
      latestPositions = { ...positions };
      for (const id of memberIds) {
        const original = originalPositions[id] ?? { x: 0, y: 0 };
        latestPositions[id] = { x: original.x + dx, y: original.y + dy };
      }
      if (memberIds.length) {
        setPositions(latestPositions);
      }
      setGroups((current) =>
        current.map((entry) =>
          entry.id === group.id
            ? { ...entry, x: latestGroup.x, y: latestGroup.y }
            : entry,
        ),
      );
    };
    const flushPointerMove = () => {
      groupFrame = null;
      const next = pendingMove;
      pendingMove = null;
      if (next) applyPointerMove(next.x, next.y);
    };
    const onPointerMove = (moveEvent: PointerEvent) => {
      pendingMove = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (groupFrame === null) groupFrame = window.requestAnimationFrame(flushPointerMove);
    };
    const onPointerUp = () => {
      if (groupFrame !== null) {
        window.cancelAnimationFrame(groupFrame);
        groupFrame = null;
      }
      if (pendingMove) flushPointerMove();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      setDraggingGroupId(null);
      if (moved) {
        setGroups((current) =>
          current.map((entry) =>
            entry.id === group.id
              ? autoSizeGroupToCards({ ...entry, x: latestGroup.x, y: latestGroup.y }, latestPositions)
              : autoSizeGroupToCards(entry, latestPositions),
          ),
        );
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if (event.target !== event.currentTarget) return;
    if (groupCreateArmed) {
      startGroupCreation(event);
      return;
    }
    if (focusAnimationRef.current !== null) {
      window.cancelAnimationFrame(focusAnimationRef.current);
      focusAnimationRef.current = null;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.shiftKey) {
      startMarqueeSelection(event);
      return;
    }
    const start = { x: event.clientX, y: event.clientY };
    const original = pan;
    let moved = false;
    let panFrame: number | null = null;
    let pendingPan = original;
    const flushPan = () => {
      panFrame = null;
      panRef.current = pendingPan;
      setPan(pendingPan);
    };
    const onPointerMove = (moveEvent: PointerEvent) => {
      if (Math.abs(moveEvent.clientX - start.x) + Math.abs(moveEvent.clientY - start.y) > 2) {
        moved = true;
      }
      pendingPan = {
        x: original.x + moveEvent.clientX - start.x,
        y: original.y + moveEvent.clientY - start.y,
      };
      if (panFrame === null) panFrame = window.requestAnimationFrame(flushPan);
    };
    const onPointerUp = () => {
      if (panFrame !== null) {
        window.cancelAnimationFrame(panFrame);
        flushPan();
      }
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (!moved && requestSelectOnly(null)) {
        setFocusedInspectorCardId(null);
        onAgentContextClear?.();
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function onWheel(event: React.WheelEvent<HTMLDivElement>) {
    // preventDefault happens in a native non-passive listener below — React
    // attaches wheel handlers passively, so calling it here is a no-op.
    if (focusAnimationRef.current !== null) {
      window.cancelAnimationFrame(focusAnimationRef.current);
      focusAnimationRef.current = null;
    }
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    lastUserNavRef.current = Date.now();
    const nextScale = Math.max(0.05, Math.min(1.8, scale * Math.exp(-event.deltaY * 0.001)));
    const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const world = {
      x: (cursor.x - pan.x) / scale,
      y: (cursor.y - pan.y) / scale,
    };
    setScale(nextScale);
    setPan({
      x: cursor.x - world.x * nextScale,
      y: cursor.y - world.y * nextScale,
    });
  }

  useEffect(() => {
    // React registers wheel listeners as passive, so its onWheel can't block
    // the browser's default scroll — on macOS that shows up as the page
    // rubber-banding while zooming the canvas. Attach a real non-passive
    // listener just to suppress the default.
    const viewport = viewportRef.current;
    if (!viewport) return;
    const preventScroll = (event: WheelEvent) => event.preventDefault();
    viewport.addEventListener("wheel", preventScroll, { passive: false });
    return () => viewport.removeEventListener("wheel", preventScroll);
  }, []);


  useEffect(() => {
    if (drawMode && selectedId !== drawMode.cardId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDrawMode(null);
    }
  }, [drawMode, selectedId]);

  useEffect(() => {
    if (trimModeCardId && trimModeCardId !== selectedId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTrimModeCardId(null);
    }
  }, [selectedId, trimModeCardId]);

  useEffect(() => {
    if (!drawMode) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setDrawMode(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawMode]);

  useEffect(() => {
    if (!activeImportId) return;
    let cancelled = false;
    let timer: number | null = null;
    async function loadRequirements() {
      const response = await fetch(
        `/api/projects/${projectId}/canvas/import-youtube/${activeImportId}/requirements`,
      );
      if (!response.ok || cancelled) return;
      const payload = await response.json() as CanvasYoutubeRequirementPayload;
      if (cancelled) return;
      setImportRequirements(payload);
      if (payload.record?.status) setImportState(youtubeImportStateFromRecord(payload.record));
      await onRefreshProjectRef.current();
      if (isTerminalYoutubeImportStatus(payload.record?.status) && timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    }
    void loadRequirements();
    timer = window.setInterval(() => void loadRequirements(), 2500);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [activeImportId, projectId]);

  useEffect(() => {
    updateOverlayRect();
    window.addEventListener("resize", updateOverlayRect);
    return () => window.removeEventListener("resize", updateOverlayRect);
  }, [measuredAspectRatios, pan, positions, scale, selectedActionCard?.id, updateOverlayRect]);

  useEffect(() => {
    let frame: number | null = null;
    if (!selectedVideoCard) {
      frame = window.requestAnimationFrame(() => setTrimDraft(null));
      return () => {
        if (frame !== null) window.cancelAnimationFrame(frame);
      };
    }
    const duration = mediaDurations[selectedVideoCard.id] ?? selectedVideoCard.duration ?? 0;
    if (!duration) return undefined;
    frame = window.requestAnimationFrame(() => {
      setTrimDraft((current) =>
        current?.cardId === selectedVideoCard.id
          ? current
          : {
              cardId: selectedVideoCard.id,
              duration,
              endSeconds: duration,
              startSeconds: 0,
            },
      );
    });
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [mediaDurations, selectedVideoCard]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.querySelectorAll<HTMLVideoElement>("video[data-canvas-card-id]").forEach((video) => {
      const cardId = video.dataset.canvasCardId;
      if (!cardId) return;
      video.playbackRate = playbackRates[cardId] ?? 1;
      video.muted = !unmutedCardIds.includes(cardId);
      video.loop = cardId === playingVideoId && !connectionPlaybackRef.current;
      if (cardId !== playingVideoId || drawMode?.cardId === cardId) {
        video.pause();
      }
    });
  }, [allCards, drawMode, playbackRates, playingVideoId, unmutedCardIds, versionSelection]);

  async function saveTrim(mode: "new" | "version") {
    if (!selectedVideoCard || !trimDraft || !trimChanged()) return;
    setSavingClipEdit(true);
    try {
      await onEditClip({
        card: selectedVideoCard,
        mode,
        trim: {
          endSeconds: trimDraft.endSeconds,
          startSeconds: trimDraft.startSeconds,
        },
      });
      setTrimDraft(null);
    } finally {
      setSavingClipEdit(false);
    }
  }

  async function fetchImportRequirements(importId: string) {
    const response = await fetch(`/api/projects/${projectId}/canvas/import-youtube/${importId}/requirements`);
    if (!response.ok) return;
    setImportRequirements(await response.json() as CanvasYoutubeRequirementPayload);
  }

  async function submitImport() {
    const url = importUrl.trim();
    if (!url) return;
    const productDescription = importProductDescription.trim();
    if (!productDescription) {
      setImportState({ label: "Add what the product does before planning.", state: "failed" });
      return;
    }
    const targetAudience = importTargetAudience.trim();
    const keyMessages = importKeyMessages.trim();
    const brandGuidelines = importBrandGuidelines.trim();
    const ctaUrl = importCtaUrl.trim();
    const forbiddenConcepts = importForbiddenConcepts.trim();
    const brief = [
      importBrief.trim() ? `CREATIVE DIRECTION:\n${importBrief.trim()}` : "",
      `PRODUCT / OFFER:\n${productDescription}`,
      targetAudience ? `TARGET AUDIENCE:\n${targetAudience}` : "",
      keyMessages ? `CORE MESSAGING / FEATURES:\n${keyMessages}` : "",
      brandGuidelines ? `APPROVED BRAND / VISUAL GUIDELINES:\n${brandGuidelines}` : "",
      ctaUrl ? `APPROVED FINAL CTA URL:\n${ctaUrl}` : "",
      forbiddenConcepts ? `FORBIDDEN CLAIMS / PHRASES / CONCEPTS:\n${forbiddenConcepts}` : "",
    ].filter(Boolean).join("\n\n");
    setImportRequirements(null);
    setActiveImportId(null);
    setImportState({ label: "Planning YouTube source…", state: "running" });
    try {
      const result = await onImportYoutube(url, brief);
      const importId = result?.importId;
      if (importId) {
        setActiveImportId(importId);
        await fetchImportRequirements(importId);
      }
      setImportState({ label: "Planner is running…", state: "running" });
      setImportUrl("");
      setImportBrief("");
      setImportProductDescription("");
      setImportTargetAudience("");
      setImportKeyMessages("");
      setImportBrandGuidelines("");
      setImportCtaUrl("");
      setImportForbiddenConcepts("");
    } catch (error) {
      setImportState({
        label: error instanceof Error ? error.message : "Import failed",
        state: "failed",
      });
    }
  }

  async function submitImportRequirements(form: HTMLFormElement) {
    if (!activeImportId) return;
    setImportState({ label: "Saving planner inputs…", state: "running" });
    const formData = new FormData(form);
    const response = await fetch(
      `/api/projects/${projectId}/canvas/import-youtube/${activeImportId}/requirements`,
      {
        method: "POST",
        body: formData,
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setImportState({
        label: typeof payload.error === "string" ? payload.error : "Could not save planner inputs.",
        state: "failed",
      });
      return;
    }
    await onRefreshProject();
    setImportRequirements(payload as CanvasYoutubeRequirementPayload);
    if (!(payload as CanvasYoutubeRequirementPayload).plan?.readyToGenerate) {
      setImportState({ label: "More planner inputs are needed", state: "needs_input" });
      return;
    }
    setImportState({ label: "Starting generation…", state: "running" });
    const generateResponse = await fetch(
      `/api/projects/${projectId}/canvas/import-youtube/${activeImportId}/generate`,
      { method: "POST" },
    );
    const generatePayload = await generateResponse.json().catch(() => ({}));
    if (!generateResponse.ok) {
      setImportState({
        label: typeof generatePayload.error === "string" ? generatePayload.error : "Could not start generation.",
        state: "failed",
      });
      return;
    }
    await onRefreshProject();
    setImportState({ label: "Generating clips…", state: "running" });
  }

  async function submitPrompt() {
    if (!selectedCard || !draftText.trim()) return;
    const text = draftText.trim();
    // The composer agent infers the outcome (edited image vs. animated clip)
    // from the prompt itself — no hardcoded "image in, image out" rule.
    if (onComposerRequest) {
      // Fire-and-forget: the placeholder blob is the progress indicator; the
      // box frees up immediately so more tasks can be fired concurrently.
      const focus = composerFocusCards(selectedCard);
      setDraft({ id: "", text: "" });
      void onComposerRequest(text, focus, { imageModel: null }).catch(
        () => {},
      );
      return;
    }
    setSubmitting(true);
    try {
      await onPromptRequest({ card: selectedCard, text });
    } finally {
      setSubmitting(false);
    }
  }

  async function submitWorkflow() {
    const text = draftText.trim();
    if (!text || submitting || isSending) return;
    setSubmitting(true);
    try {
      setDraft({ id: "", text: "" });
      await onCreateRequest(text);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitCreate() {
    const text = draftText.trim();
    if (!text) return;
    // The canvas composer agent handles one-off tasks with project context;
    // fall back to a plain chat turn when the parent has not wired it up.
    if (onComposerRequest) {
      const focus = composerFocusCards(null);
      setDraft({ id: "", text: "" });
      void onComposerRequest(text, focus, { imageModel: null }).catch(
        () => {},
      );
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      await onCreateRequest(text);
      setDraft({ id: "", text: "" });
    } finally {
      setSubmitting(false);
    }
  }

  const promptAttachments: StoryboardPromptDraft["attachments"] = [];
  const visibleRequirements = importRequirements?.requirements ?? [];
  const blockingQuestions = importRequirements?.plan?.blockingQuestions ?? [];
  const importNeedsInput = importRequirements?.record?.status === "needs_assets";
  const latestYoutubeImport = youtubeImports[0] ?? null;
  const derivedImportState = useMemo(() => {
    const latestState = latestYoutubeImport ? youtubeImportStateFromRecord(latestYoutubeImport) : null;
    if (latestState && latestState.state !== "idle") return latestState;
    return importState;
  }, [importState, latestYoutubeImport]);
  const displayedGroups = useMemo(
    () =>
      groups.map((group) => {
        if (groupDropPreview?.groupId === group.id) return groupDropPreview.group;
        return dragState?.groupSnapshots?.[group.id] ?? autoSizeGroupToCards(group);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allCards, dragState?.groupSnapshots, groupDropPreview, groups, measuredAspectRatios, positions],
  );
  const previewSlotIds = useMemo(
    () =>
      groupDropPreview
        ? dragState?.ids.filter((id) => groupDropPreview.positions[id]) ?? []
        : [],
    [dragState?.ids, groupDropPreview],
  );

  return (
    <div ref={workspaceRef} className="canvas-workspace">
      <div className="canvas-stage">
      <div className="canvas-control-panel" aria-label="Canvas controls">
        <button
          className="canvas-control-button"
          type="button"
          title="Add image tile"
          aria-label="Add image tile"
          onClick={() => openLocalUpload("image")}
        >
          <ImageIcon size={15} />
        </button>
        <button
          className="canvas-control-button"
          type="button"
          title="Add video tile"
          aria-label="Add video tile"
          onClick={() => openLocalUpload("video")}
        >
          <Video size={15} />
        </button>
        <button
          className="canvas-control-button"
          type="button"
          title="Add audio tile"
          aria-label="Add audio tile"
          onClick={() => openLocalUpload("audio")}
        >
          <Music2 size={15} />
        </button>
        <span className="canvas-control-separator" aria-hidden="true" />
        <button
          className="canvas-control-button"
          type="button"
          title="Import YouTube URL"
          aria-label="Import YouTube URL"
          onClick={() => setImportDialogOpen(true)}
        >
          <Youtube size={15} />
        </button>
        <input
          ref={localUploadInputRef}
          className="hidden"
          type="file"
          accept={
            localUploadKind === "image"
              ? "image/*"
              : localUploadKind === "video"
                ? "video/*"
                : "audio/*"
          }
          multiple
          onChange={(event) => {
            void handleLocalFiles(localUploadKind, Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = "";
          }}
        />
      </div>
      {derivedImportState.state !== "idle" ? (
        <div className="canvas-top-status">
          <div className={`canvas-import-state state-${derivedImportState.state}`}>
            {derivedImportState.state === "running" ? <Loader2 size={13} className="spin" /> : null}
            <strong>{derivedImportState.label}</strong>
          </div>
        </div>
      ) : null}
      <div className="canvas-top-right-controls">
        <button
          aria-pressed={arrowsPinned}
          className={`canvas-arrows-toggle ${arrowsPinned ? "is-on" : ""}`}
          onClick={() => setArrowsPinned((current) => !current)}
          title={arrowsPinned ? "Hide dependency arrows" : "Show dependency arrows"}
          type="button"
        >
          <Waypoints size={14} aria-hidden="true" />
          <span>Arrows</span>
        </button>
      </div>
      <div className="canvas-bottom-status">
        <div className="canvas-zoom-readout">{Math.round(scale * 100)}%</div>
      </div>
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent>
          <form
            className="canvas-import-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (importNeedsInput) {
                void submitImportRequirements(event.currentTarget);
              } else {
                void submitImport();
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>Import YouTube</DialogTitle>
              <DialogDescription>
                {importNeedsInput
                  ? "Add the planner inputs needed before generation starts."
                  : "Plan the source into reference clips and generated canvas tiles."}
              </DialogDescription>
            </DialogHeader>
            {importNeedsInput ? (
              <div className="canvas-import-requirements">
                {visibleRequirements.map((requirement) => {
                  const isText =
                    requirement.kind === "slogan" ||
                    requirement.kind === "metric" ||
                    requirement.kind === "on_screen_text" ||
                    requirement.kind === "brand_rule";
                  return (
                    <label key={requirement.assetId} className="canvas-import-requirement">
                      <span>
                        <strong>{requirement.label || requirement.assetId}</strong>
                        {requirement.required ? <em>Required</em> : <em>Optional</em>}
                      </span>
                      <small>
                        {requirement.description || requirement.reason || "Add this input for the planner."}
                      </small>
                      {requirement.neededForShots?.length ? (
                        <small>Used in {requirement.neededForShots.join(", ")}</small>
                      ) : null}
                      {isText ? (
                        <textarea
                          className="canvas-import-url-input"
                          name={`asset:${requirement.assetId}:value`}
                          rows={2}
                          placeholder="Enter the exact text..."
                        />
                      ) : (
                        <input
                          className="canvas-import-url-input"
                          name={`asset:${requirement.assetId}:file`}
                          type="file"
                          accept={requirement.kind === "video_ref" ? "video/*" : "image/*,video/*"}
                        />
                      )}
                    </label>
                  );
                })}
                {blockingQuestions.map((question, index) => (
                  <label key={`${question.question}-${index}`} className="canvas-import-requirement">
                    <span>
                      <strong>{question.question}</strong>
                      <em>Decision</em>
                    </span>
                    {question.reason ? <small>{question.reason}</small> : null}
                    <textarea
                      className="canvas-import-url-input"
                      name={`question:${index}`}
                      rows={3}
                      placeholder="Answer for the planner..."
                    />
                  </label>
                ))}
              </div>
            ) : (
              <>
                <input
                  className="canvas-import-url-input"
                  autoFocus
                  aria-label="YouTube URL"
                  value={importUrl}
                  placeholder="Paste YouTube URL..."
                  onChange={(event) => setImportUrl(event.target.value)}
                />
                <textarea
                  className="canvas-import-url-input"
                  aria-label="Target brief"
                  rows={3}
                  value={importBrief}
                  placeholder="Creative direction: preserve pacing, camera moves, and shot structure while turning this into a product ad."
                  onChange={(event) => setImportBrief(event.target.value)}
                />
                <textarea
                  className="canvas-import-url-input"
                  aria-label="Product description"
                  rows={3}
                  value={importProductDescription}
                  placeholder="Required: what does the product do? Example: Impractical.ai is an AI video editor that generates high-quality ads with consistent characters, voices, environments, and best-in-class models."
                  onChange={(event) => setImportProductDescription(event.target.value)}
                />
                <textarea
                  className="canvas-import-url-input"
                  aria-label="Target audience"
                  rows={2}
                  value={importTargetAudience}
                  placeholder="Target audience: who is this ad for?"
                  onChange={(event) => setImportTargetAudience(event.target.value)}
                />
                <textarea
                  className="canvas-import-url-input"
                  aria-label="Core messaging"
                  rows={3}
                  value={importKeyMessages}
                  placeholder="Core messages/features: 3-5 bullets or phrases the ad should communicate."
                  onChange={(event) => setImportKeyMessages(event.target.value)}
                />
                <textarea
                  className="canvas-import-url-input"
                  aria-label="Brand guidelines"
                  rows={2}
                  value={importBrandGuidelines}
                  placeholder="Approved brand/colors/style: exact colors, visual references, or style notes the planner may use."
                  onChange={(event) => setImportBrandGuidelines(event.target.value)}
                />
                <input
                  className="canvas-import-url-input"
                  aria-label="CTA URL"
                  type="text"
                  value={importCtaUrl}
                  placeholder="Final CTA URL, if the source ad has an end-card URL."
                  onChange={(event) => setImportCtaUrl(event.target.value)}
                />
                <textarea
                  className="canvas-import-url-input"
                  aria-label="Forbidden concepts"
                  rows={2}
                  value={importForbiddenConcepts}
                  placeholder="Forbidden claims/phrases/concepts: anything the planner should not invent or say."
                  onChange={(event) => setImportForbiddenConcepts(event.target.value)}
                />
              </>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <button className="dialog-btn" type="button">
                  Cancel
                </button>
              </DialogClose>
              <button
                className="dialog-btn dialog-btn-danger canvas-import-submit"
                type="submit"
                disabled={importState.state === "running" || (!importNeedsInput && (!importUrl.trim() || !importProductDescription.trim()))}
              >
                {importState.state === "running" ? <Loader2 size={15} className="spin" /> : null}
                {importNeedsInput ? "Continue to generation" : "Import"}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <FlowsModal
        categories={["Workflows", "Import"]}
        emptyLabel="No workflows available yet."
        flows={[
          ...workflowRecipes.map((workflow) => ({
            category: "Workflows",
            description: workflow.description,
            icon: "workflow" as const,
            id: `workflow:${workflow.id}`,
            run: () => {
              const text = `Use the "${workflow.title}" workflow — `;
              setDraft({ id: composeTarget, runMode: "workflow", text });
              onWorkflowPick?.(text);
            },
            selected: false,
            title: workflow.title,
          })),
          {
            category: "Import",
            description: "Plan a YouTube source into reference clips and canvas tiles.",
            icon: "youtube" as const,
            id: "import:youtube",
            run: () => window.setTimeout(() => setImportDialogOpen(true), 0),
            selected: false,
            title: "Import from YouTube",
          },
        ]}
        onOpenChange={setFlowsModalOpen}
        open={flowsModalOpen}
      />

      <Dialog open={browseModalOpen} onOpenChange={setBrowseModalOpen}>
        <DialogContent className="workflow-modal" showClose={false}>
          <DialogTitle className="sr-only">Browse references</DialogTitle>
          <div className="workflow-modal-search">
            <Search size={16} aria-hidden="true" />
            <input
              autoFocus
              className="workflow-modal-search-input"
              placeholder="Search references..."
              value={browseModalQuery}
              onChange={(event) => setBrowseModalQuery(event.target.value)}
            />
          </div>
          <div className="workflow-modal-filters">
            {BROWSE_FILTERS.map(([label]) => (
              <button
                key={label}
                type="button"
                className={`workflow-filter-pill ${browseModalFilter === label ? "is-active" : ""}`}
                onClick={() => setBrowseModalFilter(label)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="workflow-modal-grid">
            {(browseItems ?? [])
              .filter((item) => {
                const wanted = BROWSE_FILTERS.find(([label]) => label === browseModalFilter)?.[1];
                if (wanted && item.kind !== wanted) return false;
                return item.title.toLowerCase().includes(browseModalQuery.trim().toLowerCase());
              })
              .map((item) => {
                const pickItem = () => {
                  onBrowseImport?.({ id: item.id, title: item.title });
                  setBrowseModalOpen(false);
                };
                return (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    aria-label={item.title}
                    className="ref-card"
                    onClick={pickItem}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        pickItem();
                      }
                    }}
                  >
                    <div
                      className="ref-thumb"
                      style={item.src ? undefined : { background: workflowTitleGradient(item.title) }}
                    >
                      {item.src ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.src} alt="" loading="lazy" draggable={false} />
                      ) : (
                        <span className="ref-thumb-empty">{item.title.charAt(0)}</span>
                      )}
                      <div className="ref-card-gradient" aria-hidden="true" />
                      <div className="ref-card-blur" aria-hidden="true">
                        {[1, 2, 3, 4].map((layer) => (
                          <span key={layer} />
                        ))}
                      </div>
                      <div className="ref-card-content">
                        <div className="ref-card-copy">
                          <span className="ref-name">{item.title}</span>
                          <span className="ref-sub">{browseKindLabel(item.kind)}</span>
                        </div>
                        <div className="ref-card-actions">
                          <button
                            className="ref-card-view-button"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              pickItem();
                            }}
                          >
                            Import
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            {!(browseItems ?? []).length ? (
              <p className="workflow-modal-empty">No public references yet.</p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={viewportRef}
            aria-label="Canvas tiles"
            aria-multiselectable="true"
            className={`canvas-viewport ${groupCreateArmed || groupDraft ? "is-placing-group" : ""} ${dragState ? "is-dragging-card" : ""}`}
            role="listbox"
            style={
              {
                "--canvas-grid-x": `${pan.x}px`,
                "--canvas-grid-y": `${pan.y}px`,
                "--canvas-grid-size": `${48 * scale}px`,
              } as React.CSSProperties
            }
            onPointerDownCapture={(event) => {
              if (groupCreateArmed && event.button === 0) startGroupCreation(event);
            }}
            onPointerDown={startPan}
            onWheel={onWheel}
          >
        <div
          className="canvas-world"
          style={
            {
              "--canvas-pan-x": `${pan.x}px`,
              "--canvas-pan-y": `${pan.y}px`,
              "--canvas-scale": scale,
            } as React.CSSProperties
          }
        >
          <CanvasLineageArrows
            activeIds={activeLineageIds}
            edges={lineageEdges}
            hoveredId={hoveredCardId}
            pinned={arrowsPinned}
            positions={positions}
          />
          {displayedGroups.map((group) => {
            const groupMembers = allCards.filter((entry) =>
              group.cardIds.includes(entry.id),
            );
            const groupCanDelete = areCanvasCardsDeletable(groupMembers);
            return (
              <div
              key={group.id}
              className={`canvas-group ${selectedGroupId === group.id ? "selected" : ""} ${draggingGroupId === group.id ? "dragging" : ""} ${groupDropPreview?.groupId === group.id ? "is-drop-preview" : ""}`}
              style={
                {
                  "--group-color": group.color,
                  height: group.height,
                  left: group.x,
                  top: group.y,
                  width: group.width,
                } as CSSProperties & { "--group-color": string }
              }
              onPointerDown={(event) => startGroupDrag(group, event)}
            >
              <svg className="canvas-group-outline" aria-hidden="true">
                <rect
                  x={1 / scale}
                  y={1 / scale}
                  width={Math.max(1, group.width - 2 / scale)}
                  height={Math.max(1, group.height - 2 / scale)}
                  rx={20}
                  ry={20}
                  style={{
                    strokeWidth: 1 / scale,
                  }}
                />
              </svg>
              <div
                className="canvas-group-header"
                style={{
                  left: 12 / scale,
                  top: -26 / scale,
                  transform: `scale(${1 / scale})`,
                  // Width is in SCREEN pixels (zoom-cancelled): never wider
                  // than the group's own on-screen width, so the menu button
                  // stays inside the box at any zoom.
                  width: Math.max(96, Math.min(420, group.width * scale - 24)),
                }}
              >
                <span className="canvas-group-dot" aria-hidden="true" />
                {editingGroupId === group.id ? (
                  <input
                    autoFocus
                    className="canvas-group-title"
                    aria-label="Group title"
                    value={group.title}
                    onBlur={() => setEditingGroupId(null)}
                    onChange={(event) => {
                      const title = event.target.value;
                      setGroups((current) =>
                        current.map((entry) =>
                          entry.id === group.id ? { ...entry, title } : entry,
                        ),
                      );
                    }}
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") setEditingGroupId(null);
                    }}
                  />
                ) : (
                  <span
                    className="canvas-group-title canvas-group-title-text"
                    title="Double-click to rename group"
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      setEditingGroupId(group.id);
                    }}
                  >
                    {group.title}
                  </span>
                )}
                <Menu>
                  <MenuTrigger asChild>
                    <button
                      type="button"
                      className="canvas-group-menu-button"
                      aria-label="Group actions"
                      title="Group actions"
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <MoreHorizontal size={15} />
                    </button>
                  </MenuTrigger>
                  <MenuContent align="start" side="bottom" sideOffset={8}>
                    <MenuLabel>{group.title}</MenuLabel>
                    <MenuItem
                      onSelect={() => {
                        // Defer past the menu's close/focus-restore (same race
                        // that swallowed the delete action).
                        window.setTimeout(() => alignGroup(group.id, "grid"), 0);
                      }}
                    >
                      Align in grid
                    </MenuItem>
                    <MenuItem
                      onSelect={() => {
                        window.setTimeout(() => alignGroup(group.id, "row"), 0);
                      }}
                    >
                      Align in row
                    </MenuItem>
                    <MenuItem
                      onSelect={() => {
                        window.setTimeout(() => alignGroup(group.id, "column"), 0);
                      }}
                    >
                      Align in column
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem onSelect={() => degroup(group.id)}>
                      Degroup
                    </MenuItem>
                    {groupCanDelete ? (
                      <MenuItem
                        onSelect={() => {
                          // Defer past the menu's close/focus-restore, which
                          // otherwise races the dialog open and swallows it.
                          window.setTimeout(
                            () => requestDeleteConfirmation(groupMembers),
                            0,
                          );
                        }}
                      >
                        Delete {groupMembers.length} pieces…
                      </MenuItem>
                    ) : null}
                  </MenuContent>
                </Menu>
              </div>
              </div>
            );
          })}
          {groupDraft ? (
            <div
              className="canvas-group-draft"
              style={(() => {
                const rect = orderedRect(groupDraft.start, groupDraft.current);
                return {
                  height: rect.height,
                  left: rect.x,
                  top: rect.y,
                  width: rect.width,
                };
              })()}
            />
          ) : null}
          {groupDropPreview
            ? previewSlotIds.map((id) => {
                const card = allCards.find((entry) => entry.id === id);
                const position = groupDropPreview.positions[id];
                if (!card || !position) return null;
                return (
                  <div
                    key={`group-slot-${groupDropPreview.groupId}-${id}`}
                    className="canvas-group-slot-preview"
                    style={{
                      height: cardHeight(card, measuredAspectRatios[id]),
                      transform: `translate(${position.x}px, ${position.y}px)`,
                      width: CANVAS_CARD_WIDTH,
                    }}
                  />
                );
              })
            : null}
          {connections.map((connection) => {
            const bounds = connectionBounds(connection);
            if (!bounds) return null;
            const connectionVisible =
              playingConnectionId === connection.id ||
              spatialRectsIntersect(visibleWorldRect, {
                height: bounds.height,
                width: bounds.width,
                x: bounds.left,
                y: bounds.top,
              });
            if (!connectionVisible) {
              return (
                <div
                  aria-hidden="true"
                  className="canvas-connection canvas-connection-geometry-shell"
                  key={connection.id}
                  style={{
                    height: bounds.height,
                    left: bounds.left,
                    top: bounds.top,
                    width: bounds.width,
                  }}
                />
              );
            }
            const duration = connectionDuration(connection);
            const isPlaying = playingConnectionId === connection.id;
            const previewCardId = connectionPreviewCardIds[connection.id] ?? connection.cardIds[0];
            const previewCard = allCards.find((card) => card.id === previewCardId) ?? null;
            const previewCards = connectionCards(connection).filter(canConnect);
            const previewAspectCard = previewCard ?? previewCards[0] ?? null;
            const sequenceTime = Math.max(
              0,
              Math.min(duration || 0, connectionPlaybackTimes[connection.id] ?? 0),
            );
            const timelineFrames = connectionCards(connection).flatMap((card) => frameStrips[card.id] ?? []);
            return (
              <div
                key={connection.id}
                className={`canvas-connection ${isPlaying ? "playing" : ""} ${connection.collapsed ? "collapsed" : ""}`}
                style={{
                  "--connection-color": connectionColorFromName(connection.name || connection.id),
                  height: bounds.height,
                  left: bounds.left,
                  top: bounds.top,
                  width: bounds.width,
                } as CSSProperties & { "--connection-color": string }}
                onPointerDown={(event) => startConnectionDrag(connection, event)}
              >
                {connection.collapsed ? (
                  <TrimTimeline
                    className="canvas-connection-timeline"
                    currentSeconds={sequenceTime}
                    duration={duration}
                    endSeconds={duration}
                    frames={timelineFrames}
                    playheadLabel="Scrub sequence"
                    showTrimHandles={false}
                    startSeconds={0}
                    onPointerDown={(event) => event.stopPropagation()}
                    onPlayheadPointerDown={(event) => startConnectionPlayheadDrag(connection, event)}
                    onStartPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onEndPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  />
                ) : null}
                {connection.collapsed && previewCard ? (
                  <div
                    data-card-id={previewCard.id}
                    className="canvas-connection-preview"
                    style={{
                      left: CANVAS_CONNECTION_PADDING,
                      top: CANVAS_CONNECTION_PADDING,
                      width: CANVAS_CARD_WIDTH,
                    }}
                    onPointerDown={(event) => startConnectionDrag(connection, event)}
                  >
                    <div className="storyboard-tile-shell" style={{ width: CANVAS_CARD_WIDTH }}>
                      <div
                        data-card-media-id={previewCard.id}
                        className="storyboard-motion-card has-media focused"
                        style={{
                          aspectRatio: cssAspectRatio(
                            resolvePieceAspectRatio({
                              explicit: previewAspectCard?.aspectRatio,
                              intrinsic:
                                measuredAspectRatios[previewAspectCard?.id ?? previewCard.id],
                              source: previewAspectCard?.sourceAspectRatio,
                              tool: previewAspectCard?.toolAspectRatio,
                              workflowDefault: previewAspectCard?.workflowAspectRatio,
                            }),
                          ),
                        }}
                      >
                        <canvas
                          ref={(node) => {
                            connectionCanvasRefs.current[connection.id] = node;
                          }}
                          className="storyboard-motion-video canvas-connection-sequence-canvas"
                          aria-label={`${connection.name} preview`}
                        />
                        <div className="canvas-connection-video-bank" aria-hidden="true">
                          {previewCards.map((card) => {
                            const src = displaySrc(card);
                            if (!src) return null;
                            return (
                              <video
                                key={`${connection.id}:${card.id}:${src}`}
                                data-canvas-card-id={card.id}
                                className="canvas-connection-hidden-video"
                                src={src}
                                muted
                                playsInline
                                preload="metadata"
                                onLoadedData={(event) => {
                                  const canvas = connectionCanvasRefs.current[connection.id];
                                  if (card.id === previewCard.id && canvas) {
                                    drawVideoFrameToCoverCanvas(canvas, event.currentTarget);
                                  }
                                }}
                                onLoadedMetadata={(event) => {
                                  const video = event.currentTarget;
                                  video.playbackRate = playbackRates[card.id] ?? 1;
                                  rememberAspectRatio(card.id, video.videoWidth, video.videoHeight);
                                  if (Number.isFinite(video.duration) && video.duration > 0) {
                                    setMediaDurations((current) =>
                                      current[card.id] === video.duration
                                        ? current
                                        : { ...current, [card.id]: video.duration },
                                    );
                                  }
                                  if (isPlaying && card.id === previewCard.id) {
                                    video.muted = !unmutedCardIds.includes(card.id);
                                    void video.play().catch(() => {});
                                  }
                                }}
                                onPause={(event) => handleMediaPause(card.id, event.currentTarget)}
                                onPlay={(event) => handleMediaPlay(card.id, event.currentTarget)}
                                onTimeUpdate={(event) =>
                                  handleVideoTimeUpdate(card.id, event.currentTarget)
                                }
                              />
                            );
                          })}
                        </div>
                        <span className="storyboard-motion-duration">
                          {duration > 0 ? formatCanvasTime(duration) : "sequence"}
                        </span>
                        <div className="storyboard-motion-icon">
                          <Video size={17} />
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
                <input
                  className="canvas-connection-name"
                  value={connection.name}
                  aria-label="Sequence name"
                  onChange={(event) => renameConnection(connection.id, event.target.value)}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                />
              </div>
            );
          })}
          {marquee ? (
            <div
              className="canvas-marquee"
              style={(() => {
                const rect = orderedRect(marquee.start, marquee.current);
                return {
                  height: rect.height,
                  left: rect.x,
                  top: rect.y,
                  width: rect.width,
                };
              })()}
            />
          ) : null}
          {allCards.map((card) => {
            if (collapsedConnectionCardIds.has(card.id)) return null;
            const previewPosition =
              groupDropPreview && !dragState?.ids.includes(card.id)
                ? groupDropPreview.positions[card.id]
                : undefined;
            const originId = spawnOrigins?.[card.id] ?? spawnOrigins?.[card.path] ?? null;
            const originPosition = originId ? positions[originId] : undefined;
            const position = previewPosition ?? positions[card.id] ?? originPosition ?? { x: 0, y: 0 };
            const visualCardKey = originId ?? card.id;
            const selected = selectedIdSet.has(card.id);
            const primaryFocused =
              focusedInspectorCardId === card.id && selected;
            if (!eagerCardIds.has(card.id)) {
              return (
                <CanvasGeometryShell
                  key={`canvas-card:${visualCardKey}`}
                  card={card}
                  height={cardHeight(card, measuredAspectRatios[card.id])}
                  position={position}
                />
              );
            }
            const versions = card.versions ?? [];
            const versionKey = `${card.kind}:${card.id}`;
            const versionIndex = resolveVersionIndex(versionKey, versions);
            const src = displaySrc(card);
            const renderedAspectRatio = resolvePieceAspectRatio({
              explicit: card.aspectRatio,
              intrinsic: measuredAspectRatios[card.id],
              source: card.sourceAspectRatio,
              tool: card.toolAspectRatio,
              workflowDefault: card.workflowAspectRatio,
            });
            const actionCards = cardsForAction(card);
            const cardDuration = mediaDurations[card.id] ?? card.duration ?? 0;
            const cardCurrentTime = Math.max(
              0,
              Math.min(cardDuration || 0, mediaCurrentTimes[card.id] ?? 0),
            );
            const durationLabel =
              selected &&
              (card.kind === "clip" || card.kind === "video" || card.kind === "audio") &&
              cardDuration > 0
                ? `${formatCanvasTime(cardCurrentTime)} / ${formatCanvasTime(cardDuration)}`
                : card.duration
                  ? `${card.duration}s`
                  : card.kind === "audio"
                    ? "audio"
                    : "clip";
            const activeTrack = activeVideoTrack(card, staleTrackIds);
            const trackingBox = trackingBoxAtTime(activeTrack, cardCurrentTime);
            const trackingInProgress =
              activeTrack?.status === "queued" || activeTrack?.status === "running";
            const connectableActionCards = actionCards.filter(canConnect);
            const deletableActionCards = areCanvasCardsDeletable(actionCards);
            const existingConnection = connectionForCard(card.id);
            const isSequenceReorderMember =
              Boolean(sequenceReorder) && sequenceReorder?.connectionId === existingConnection?.id;
            const isSequenceReordering = sequenceReorder?.cardId === card.id;
            const durablePieceState = canvasPieceState(
              card.status,
              Boolean(card.generating || editingCardIds?.has(card.id)),
            );
            return (
              <ContextMenu
                key={`canvas-card:${visualCardKey}`}
                onOpenChange={(open) => {
                  if (open && !selectedIdSet.has(card.id)) requestSelectOnly(card.id);
                  if (!open) setTimelineContextTarget(null);
                }}
              >
                <ContextMenuTrigger asChild>
                  <div
                    data-card-id={card.id}
                    aria-current={primaryFocused ? "true" : undefined}
                    aria-label={`${card.title}, ${canvasPieceKindForCard(card)}${primaryFocused ? ", primary selection" : selected ? ", selected" : ""}`}
                    aria-selected={selected}
                    className={`canvas-card ${selected ? "selected" : ""} ${primaryFocused ? "is-primary-focused" : selected ? "is-secondary-selected" : ""} ${card.refCategory ? "is-reference-tile" : ""} ${card.generating ? "generating" : ""} ${dragState?.ids.includes(card.id) ? "is-dragging" : ""} ${dockDropGhost && dragState?.ids.includes(card.id) ? "is-dock-candidate" : ""} ${isSequenceReorderMember ? "sequence-reorder-member" : ""} ${isSequenceReordering ? "sequence-reordering" : ""}`}
                    role="option"
                    style={{
                      transform: `translate(${position.x}px, ${position.y}px)`,
                      width: card.displayWidth ?? CANVAS_CARD_WIDTH,
                    }}
                    tabIndex={selectedId === card.id ? 0 : -1}
                    onFocus={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (
                        preservesCanvasSelectionOnFocus(
                          pendingModifierFocusRef.current,
                          card.id,
                        )
                      ) {
                        return;
                      }
                      if (selected) setSelectedId(card.id);
                      else requestSelectOnly(card.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        if (selected) setSelectedId(card.id);
                        else if (!requestSelectOnly(card.id)) return;
                        focusInspectorCard(card.id);
                      }
                      if (
                        event.key === " " &&
                        (event.shiftKey || event.metaKey || event.ctrlKey)
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                        selectCardFromInteraction(card.id, {
                          additive: event.metaKey || event.ctrlKey,
                          range: event.shiftKey,
                        });
                        return;
                      }
                      if (
                        event.key === " " &&
                        (card.kind === "clip" ||
                          card.kind === "video" ||
                          card.kind === "audio")
                      ) {
                        event.preventDefault();
                        toggleTilePlayback(card.id);
                      }
                    }}
                    onPointerDownCapture={(event) => {
                      const target = event.target;
                      if (
                        target instanceof HTMLElement &&
                        target.closest(
                          "button, input, textarea, select, [contenteditable='true']",
                        )
                      ) {
                        return;
                      }
                      pendingModifierFocusRef.current =
                        captureCanvasModifierSelectionIntent({
                          ctrlKey: event.ctrlKey,
                          metaKey: event.metaKey,
                          shiftKey: event.shiftKey,
                          targetId: card.id,
                        });
                    }}
                    onPointerDown={(event) => {
                      if (!event.shiftKey && !event.metaKey && !event.ctrlKey) {
                        event.currentTarget.focus({ preventScroll: true });
                      }
                      startCardDrag(card, event);
                    }}
                    onClick={(event) => {
                      const capturedIntent =
                        pendingModifierFocusRef.current?.targetId === card.id
                          ? pendingModifierFocusRef.current
                          : captureCanvasModifierSelectionIntent({
                              ctrlKey: event.ctrlKey,
                              metaKey: event.metaKey,
                              shiftKey: event.shiftKey,
                              targetId: card.id,
                            });
                      if (!capturedIntent) return;
                      event.stopPropagation();
                      pendingModifierFocusRef.current = null;
                      selectCardFromInteraction(card.id, {
                        additive: capturedIntent.additive,
                        range: capturedIntent.range,
                      });
                      window.requestAnimationFrame(() => {
                        viewportRef.current
                          ?.querySelector<HTMLElement>(`[data-card-id="${card.id}"]`)
                          ?.focus({ preventScroll: true });
                      });
                    }}
                    onPointerEnter={() => setHoveredCardId(card.id)}
                    onPointerLeave={() =>
                      setHoveredCardId((current) => (current === card.id ? null : current))
                    }
                    onDoubleClick={() => {
                      if (card.path !== "#") onOpenFile(card.path);
                    }}
                  >
                    <div
                      className="storyboard-tile-shell"
                      style={{ width: card.displayWidth ?? CANVAS_CARD_WIDTH }}
                    >
                      {canStage(card) &&
                      (hoveredCardId === card.id ||
                        stagedCardIds.includes(card.id)) ? (
                        <button
                          aria-label={
                            stagedCardIds.includes(card.id)
                              ? `Remove ${card.title} as a reference`
                              : `Use ${card.title} as a reference`
                          }
                          aria-pressed={stagedCardIds.includes(card.id)}
                          className={`canvas-card-stage${stagedCardIds.includes(card.id) ? " is-staged" : ""}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setStagedCardIds((current) =>
                              current.includes(card.id)
                                ? current.filter((entry) => entry !== card.id)
                                : [...current, card.id],
                            );
                          }}
                          onPointerDownCapture={(event) => event.stopPropagation()}
                          title={
                            stagedCardIds.includes(card.id)
                              ? "Remove reference"
                              : "Use as reference"
                          }
                          type="button"
                        >
                          {stagedCardIds.includes(card.id) ? (
                            <Check aria-hidden size={15} />
                          ) : (
                            <Plus aria-hidden size={15} />
                          )}
                        </button>
                      ) : null}
                      {card.kind === "clip" || card.kind === "video" ? (
                        <div
                          data-card-media-id={card.id}
                          className={`storyboard-motion-card has-media ${selected ? "focused" : ""}`}
                          style={{ aspectRatio: cssAspectRatio(renderedAspectRatio) }}
                        >
                          {src ? (
                            <video
                              key={src}
                              data-canvas-card-id={card.id}
                              className="storyboard-motion-video"
                              src={src}
                              autoPlay={!playingConnectionId}
                              loop={!playingConnectionId}
                              muted
                              playsInline
                              preload="metadata"
                              onLoadedMetadata={(event) => {
                                const video = event.currentTarget;
                                const restored = playbackStateRef.current[card.id];
                                video.muted = true;
                                video.playbackRate = restored?.playbackRate ?? playbackRates[card.id] ?? 1;
                                rememberAspectRatio(card.id, video.videoWidth, video.videoHeight);
                                if (Number.isFinite(video.duration) && video.duration > 0) {
                                  setMediaDurations((current) =>
                                    current[card.id] === video.duration
                                      ? current
                                      : { ...current, [card.id]: video.duration },
                                  );
                                }
                                try {
                                  video.currentTime = Math.min(
                                    restored?.currentTime ?? mediaCurrentTimes[card.id] ?? 0,
                                    Math.max(0, video.duration || 0),
                                  );
                                } catch {
                                  // Keep the first frame if early restoration is not seekable.
                                }
                              }}
                              onPause={(event) => handleMediaPause(card.id, event.currentTarget)}
                              onPlay={(event) => handleMediaPlay(card.id, event.currentTarget)}
                              onTimeUpdate={(event) =>
                                handleVideoTimeUpdate(card.id, event.currentTarget)
                              }
                            />
                          ) : (
                            <div className="canvas-tile-empty-state storyboard-motion-generating">
                              {renderLoadingPiece(card)}
                            </div>
                          )}
                          {TILE_PLAYBACK_CONTROLS &&
                          src &&
                          drawMode?.cardId !== card.id &&
                          (selected || playingVideoId === card.id) ? (
                            <div
                              className={`tile-scrub ${scrubbingCardId === card.id ? "is-scrubbing" : ""}`}
                              onPointerDown={(event) => event.stopPropagation()}
                              onDoubleClick={(event) => event.stopPropagation()}
                              onClick={(event) => event.stopPropagation()}
                            >
                              <div
                                className="tile-scrub-rail"
                                onPointerDown={(event) => startTileScrub(card.id, event)}
                              >
                                <div className="tile-scrub-track">
                                  <div
                                    className="tile-scrub-fill"
                                    style={{
                                      width:
                                        cardDuration > 0
                                          ? `${(cardCurrentTime / cardDuration) * 100}%`
                                          : "0%",
                                    }}
                                  />
                                  <div
                                    className="tile-scrub-dot"
                                    style={{
                                      left:
                                        cardDuration > 0
                                          ? `${(cardCurrentTime / cardDuration) * 100}%`
                                          : "0%",
                                    }}
                                  />
                                </div>
                              </div>
                              <div className="tile-scrub-controls">
                                <button
                                  type="button"
                                  title={playingVideoId === card.id ? "Pause" : "Play"}
                                  aria-label={playingVideoId === card.id ? "Pause clip" : "Play clip"}
                                  onClick={() => toggleTilePlayback(card.id)}
                                >
                                  {playingVideoId === card.id ? (
                                    <Pause size={15} fill="currentColor" />
                                  ) : (
                                    <Play size={15} fill="currentColor" />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  title="Back 1s"
                                  aria-label="Back 1 second"
                                  onClick={() => stepTilePlayback(card.id, -1)}
                                >
                                  <Rewind size={14} fill="currentColor" />
                                </button>
                                <button
                                  type="button"
                                  title="Forward 1s"
                                  aria-label="Forward 1 second"
                                  onClick={() => stepTilePlayback(card.id, 1)}
                                >
                                  <FastForward size={14} fill="currentColor" />
                                </button>
                                <button
                                  type="button"
                                  title={unmutedCardIds.includes(card.id) ? "Mute" : "Unmute"}
                                  aria-label={
                                    unmutedCardIds.includes(card.id) ? "Mute clip" : "Unmute clip"
                                  }
                                  onClick={() => toggleTileMute(card.id)}
                                >
                                  {unmutedCardIds.includes(card.id) ? (
                                    <Volume2 size={15} />
                                  ) : (
                                    <VolumeX size={15} />
                                  )}
                                </button>
                                {cardDuration > 0 ? (
                                  <span className="tile-scrub-time">
                                    {formatCanvasTime(cardCurrentTime)} /{" "}
                                    {formatCanvasTime(cardDuration)}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          ) : null}
                          {trackingBox ? (
                            <span
                              className="canvas-tracking-box"
                              style={{
                                height: `${trackingBox.h * 100}%`,
                                left: `${trackingBox.x * 100}%`,
                                top: `${trackingBox.y * 100}%`,
                                width: `${trackingBox.w * 100}%`,
                              }}
                            />
                          ) : null}
                          {trackingInProgress ? (
                            <span className="canvas-tracking-status">Analyzing video...</span>
                          ) : activeTrack?.status === "failed" ? (
                            <span className="canvas-tracking-status is-failed">Tracking failed</span>
                          ) : null}
                          {selected ? renderGenRefs(card) : null}
                          {card.generating || trackingInProgress || editingCardIds?.has(card.id) ? (
                            <span className="board-shimmer" />
                          ) : null}
                          {drawMode?.cardId === card.id ? (
                            <TileDrawLayer
                              marks={drawMode.marks}
                              tool={drawMode.tool}
                              timestampSeconds={cardCurrentTime}
                              onAddMark={(mark) => handleDrawMark(card, mark)}
                            />
                          ) : null}
                          {renderDrawToolbar(card)}
                          <span className="storyboard-motion-duration">{durationLabel}</span>
                          <div className="storyboard-motion-icon">
                            <Video size={17} />
                          </div>
                        </div>
                      ) : card.kind === "audio" ? (
                        <div
                          data-card-media-id={card.id}
                          className={`storyboard-motion-card has-media canvas-audio-motion ${selected ? "focused" : ""}`}
                          style={{ aspectRatio: "16 / 9" }}
                        >
                          {src ? (
                            <video
                              key={src}
                              data-canvas-card-id={card.id}
                              data-audio-tile="true"
                              className="canvas-audio-media"
                              src={src}
                              muted={!unmutedCardIds.includes(card.id)}
                              playsInline
                              preload="metadata"
                              onLoadedMetadata={(event) => {
                                const media = event.currentTarget;
                                const restored = playbackStateRef.current[card.id];
                                media.pause();
                                media.muted = true;
                                media.playbackRate = restored?.playbackRate ?? playbackRates[card.id] ?? 1;
                                if (Number.isFinite(media.duration) && media.duration > 0) {
                                  setMediaDurations((current) =>
                                    current[card.id] === media.duration
                                      ? current
                                    : { ...current, [card.id]: media.duration },
                                  );
                                }
                                try {
                                  media.currentTime = Math.min(
                                    restored?.currentTime ?? mediaCurrentTimes[card.id] ?? 0,
                                    Math.max(0, media.duration || 0),
                                  );
                                } catch {
                                  // Keep the first frame if early restoration is not seekable.
                                }
                              }}
                              onPause={(event) => handleMediaPause(card.id, event.currentTarget)}
                              onPlay={(event) => handleMediaPlay(card.id, event.currentTarget)}
                              onTimeUpdate={(event) =>
                                handleVideoTimeUpdate(card.id, event.currentTarget)
                              }
                            />
                          ) : null}
                          {src ? (
                            <CanvasWaveform
                              progress={cardDuration > 0 ? cardCurrentTime / cardDuration : 0}
                              values={audioWaveforms[card.id]}
                            />
                          ) : (
                            renderLoadingPiece(card)
                          )}
                          {src && (selected || playingVideoId === card.id) ? (
                            <div
                              className={`tile-scrub ${scrubbingCardId === card.id ? "is-scrubbing" : ""}`}
                              onPointerDown={(event) => event.stopPropagation()}
                              onDoubleClick={(event) => event.stopPropagation()}
                              onClick={(event) => event.stopPropagation()}
                            >
                              <div
                                className="tile-scrub-rail"
                                onPointerDown={(event) => startTileScrub(card.id, event)}
                              >
                                <div className="tile-scrub-track">
                                  <div
                                    className="tile-scrub-fill"
                                    style={{
                                      width:
                                        cardDuration > 0
                                          ? `${(cardCurrentTime / cardDuration) * 100}%`
                                          : "0%",
                                    }}
                                  />
                                  <div
                                    className="tile-scrub-dot"
                                    style={{
                                      left:
                                        cardDuration > 0
                                          ? `${(cardCurrentTime / cardDuration) * 100}%`
                                          : "0%",
                                    }}
                                  />
                                </div>
                              </div>
                              <div className="tile-scrub-controls">
                                <button
                                  type="button"
                                  title={playingVideoId === card.id ? "Pause" : "Play"}
                                  aria-label={playingVideoId === card.id ? "Pause audio" : "Play audio"}
                                  onClick={() => toggleTilePlayback(card.id)}
                                >
                                  {playingVideoId === card.id ? (
                                    <Pause size={15} fill="currentColor" />
                                  ) : (
                                    <Play size={15} fill="currentColor" />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  title="Back 1s"
                                  aria-label="Back 1 second"
                                  onClick={() => stepTilePlayback(card.id, -1)}
                                >
                                  <Rewind size={14} fill="currentColor" />
                                </button>
                                <button
                                  type="button"
                                  title="Forward 1s"
                                  aria-label="Forward 1 second"
                                  onClick={() => stepTilePlayback(card.id, 1)}
                                >
                                  <FastForward size={14} fill="currentColor" />
                                </button>
                                <button
                                  type="button"
                                  title={unmutedCardIds.includes(card.id) ? "Mute" : "Unmute"}
                                  aria-label={
                                    unmutedCardIds.includes(card.id) ? "Mute audio" : "Unmute audio"
                                  }
                                  onClick={() => toggleTileMute(card.id)}
                                >
                                  {unmutedCardIds.includes(card.id) ? (
                                    <Volume2 size={15} />
                                  ) : (
                                    <VolumeX size={15} />
                                  )}
                                </button>
                                {cardDuration > 0 ? (
                                  <span className="tile-scrub-time">
                                    {formatCanvasTime(cardCurrentTime)} /{" "}
                                    {formatCanvasTime(cardDuration)}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          ) : null}
                          <span className="storyboard-motion-duration">{durationLabel}</span>
                          <div className="storyboard-motion-icon">
                            <Music2 size={17} />
                          </div>
                        </div>
                      ) : (
                        <div
                          className="storyboard-frame-media relative overflow-hidden"
                          style={{
                            aspectRatio: cssAspectRatio(renderedAspectRatio),
                            background: card.generating
                              ? "var(--surface-3)"
                              : "var(--surface-2)",
                          }}
                        >
                          {selected ? renderGenRefs(card) : null}
                          {src ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              data-canvas-card-id={card.id}
                              className={`board-pop h-full w-full object-cover ${card.sheetFallback ? "is-sheet-fallback" : ""}`}
                              src={src}
                              alt={card.title}
                              draggable={false}
                              style={
                                imageAdjust?.cardId === card.id
                                  ? { filter: cssFilterForAdjust(imageAdjust.params) }
                                  : undefined
                              }
                              onLoad={(event) => {
                                const image = event.currentTarget;
                                rememberAspectRatio(card.id, image.naturalWidth, image.naturalHeight);
                              }}
                            />
                          ) : (
                            <div
                              className="canvas-tile-empty-state flex h-full w-full items-center justify-center"
                              style={{ color: "var(--muted)" }}
                            >
                              {renderLoadingPiece(card)}
                            </div>
                          )}
                          {editingCardIds?.has(card.id) ? (
                            <span className="board-shimmer" />
                          ) : null}
                          {imageAdjust?.cardId === card.id && imageAdjust.params.vignette > 0 ? (
                            <div
                              className="canvas-vignette-preview"
                              aria-hidden="true"
                              style={{
                                background: `radial-gradient(ellipse at center, transparent 45%, rgba(0, 0, 0, ${((imageAdjust.params.vignette / 100) * 0.75).toFixed(3)}) 100%)`,
                              }}
                            />
                          ) : null}
                          {imageAdjust?.cardId === card.id && imageAdjust.mode === "crop" ? (
                            <TileDrawLayer
                              marks={
                                imageAdjust.crop
                                  ? [
                                      {
                                        height: imageAdjust.crop.height,
                                        timestampSeconds: 0,
                                        type: "rect",
                                        width: imageAdjust.crop.width,
                                        x: imageAdjust.crop.x,
                                        y: imageAdjust.crop.y,
                                      },
                                    ]
                                  : []
                              }
                              tool="rect"
                              timestampSeconds={0}
                              onAddMark={(mark) => {
                                if (mark.type !== "rect") return;
                                setImageAdjust((current) =>
                                  current?.cardId === card.id
                                    ? {
                                        ...current,
                                        crop: {
                                          height: mark.height,
                                          width: mark.width,
                                          x: mark.x,
                                          y: mark.y,
                                        },
                                      }
                                    : current,
                                );
                              }}
                            />
                          ) : null}
                          {drawMode?.cardId === card.id ? (
                            <TileDrawLayer
                              marks={drawMode.marks}
                              tool={drawMode.tool}
                              timestampSeconds={0}
                              onAddMark={(mark) => handleDrawMark(card, mark)}
                            />
                          ) : null}
                          {renderDrawToolbar(card)}
                        </div>
                      )}
                      {trimModeCardId === card.id &&
                      selectedVideoCard?.id === card.id &&
                      trimDraft?.cardId === card.id ? (
                        <TrimTimeline
                          className="canvas-trim-editor-card"
                          currentSeconds={mediaCurrentTimes[card.id] ?? trimDraft.startSeconds}
                          duration={trimDraft.duration}
                          endSeconds={trimDraft.endSeconds}
                          frames={frameStrips[card.id] ?? []}
                          hiddenSegmentIndexes={hiddenSegments[card.id] ?? []}
                          splitSeconds={splitMarkers[card.id] ?? []}
                          startSeconds={trimDraft.startSeconds}
                          onRailContextMenu={(_, seconds) =>
                            setTimelineContextTarget({ cardId: card.id, seconds, type: "rail" })
                          }
                          onSegmentContextMenu={(_, segment) =>
                            setTimelineContextTarget({
                              cardId: card.id,
                              endSeconds: segment.endSeconds,
                              index: segment.index,
                              seconds: segment.seconds,
                              startSeconds: segment.startSeconds,
                              type: "segment",
                            })
                          }
                          onPlayheadPointerDown={startPlayheadDrag}
                          onSplitContextMenu={(_, index, seconds) =>
                            setTimelineContextTarget({ cardId: card.id, index, seconds, type: "split" })
                          }
                          onSplitPointerDown={(index, event) =>
                            startSplitMarkerDrag(card.id, index, event)
                          }
                          onStartPointerDown={(event) => startTrimDrag("start", event)}
                          onEndPointerDown={(event) => startTrimDrag("end", event)}
                        />
                      ) : null}
                      <div className="storyboard-frame-title canvas-card-title">
                        <span
                          className={`canvas-card-kind ${card.refCategory ? "is-reference" : ""}`}
                          role="img"
                          aria-label={
                            card.refCategory
                              ? `${card.refCategory} reference`
                              : card.kind === "keyframe"
                                ? "image"
                                : card.kind
                          }
                          title={
                            card.refCategory
                              ? `Reference — ${card.refCategory}`
                              : card.kind === "keyframe"
                                ? "image"
                                : card.kind
                          }
                        >
                          {card.status === "imagining" ? (
                            "✦"
                          ) : card.refCategory === "characters" ? (
                            <UserRound size={14} />
                          ) : card.refCategory === "styles" ? (
                            <Palette size={14} />
                          ) : card.refCategory === "locations" ? (
                            <MapPin size={14} />
                          ) : card.refCategory ? (
                            <Package size={14} />
                          ) : card.kind === "clip" || card.kind === "video" ? (
                            <Video size={14} />
                          ) : card.kind === "audio" ? (
                            <AudioLines size={14} />
                          ) : (
                            <ImageIcon size={14} />
                          )}
                        </span>
                        <span className="storyboard-frame-title-text">{card.title}</span>
                      </div>
                    </div>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  {timelineContextTarget?.cardId === card.id ? (
                    <>
                      <ContextMenuLabel>
                        {timelineContextTarget.type === "rail"
                          ? `${formatCanvasTime(timelineContextTarget.seconds)}`
                          : timelineContextTarget.type === "split"
                            ? `Split at ${formatCanvasTime(timelineContextTarget.seconds)}`
                            : `${formatCanvasTime(timelineContextTarget.startSeconds)} - ${formatCanvasTime(timelineContextTarget.endSeconds)}`}
                      </ContextMenuLabel>
                      {timelineContextTarget.type === "rail" && trimDraft?.cardId === card.id ? (
                        <ContextMenuItem
                          onSelect={() =>
                            addSplitMarker(card.id, timelineContextTarget.seconds, trimDraft.duration)
                          }
                        >
                          Split here
                        </ContextMenuItem>
                      ) : null}
                      {timelineContextTarget.type === "split" ? (
                        <ContextMenuItem
                          onSelect={() => removeSplitMarker(card.id, timelineContextTarget.index)}
                        >
                          Remove split
                        </ContextMenuItem>
                      ) : null}
                      {timelineContextTarget.type === "segment" && trimDraft?.cardId === card.id
                        ? (() => {
                            const segmentHidden = (hiddenSegments[card.id] ?? []).includes(
                              timelineContextTarget.index,
                            );
                            return (
                              <>
                                <ContextMenuItem
                                  onSelect={() =>
                                    addSplitMarker(
                                      card.id,
                                      timelineContextTarget.seconds,
                                      trimDraft.duration,
                                    )
                                  }
                                >
                                  Split here
                                </ContextMenuItem>
                                <ContextMenuItem
                                  onSelect={() =>
                                    setSegmentHidden(
                                      card.id,
                                      timelineContextTarget.index,
                                      !segmentHidden,
                                    )
                                  }
                                >
                                  {segmentHidden ? "Restore section" : "Delete section"}
                                </ContextMenuItem>
                              </>
                            );
                          })()
                        : null}
                      <ContextMenuSeparator />
                    </>
                  ) : null}
                  <ContextMenuLabel>{card.title}</ContextMenuLabel>
                  <ContextMenuItem onSelect={() => animateToCard(card)}>Focus tile</ContextMenuItem>
                  {deletableActionCards ? (
                    <ContextMenuItem
                      onSelect={() => {
                        window.setTimeout(
                          () => requestDeleteConfirmation(actionCards),
                          0,
                        );
                      }}
                    >
                      {actionCards.length > 1
                        ? `Delete ${actionCards.length} selected pieces…`
                        : "Delete…"}
                    </ContextMenuItem>
                  ) : null}
                  {actionCards.length > 1 ? (
                    <>
                      <ContextMenuSeparator />
                      {connectableActionCards.length > 1 ? (
                        <ContextMenuItem onSelect={() => connectCards(connectableActionCards)}>
                          Connect selected
                        </ContextMenuItem>
                      ) : null}
                      <ContextMenuItem onSelect={() => alignCards(actionCards, "row")}>
                        Align selected in row
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => alignCards(actionCards, "grid")}>
                        Align selected in grid
                      </ContextMenuItem>
                    </>
                  ) : null}
                  {existingConnection ? (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => disconnectConnection(existingConnection.id)}>
                        Disconnect sequence
                      </ContextMenuItem>
                    </>
                  ) : null}
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
           {connections.map((connection) => {
             const bounds = connectionBounds(connection);
             if (!bounds) return null;
             if (
               playingConnectionId !== connection.id &&
               !spatialRectsIntersect(visibleWorldRect, {
                 height: bounds.height,
                 width: bounds.width,
                 x: bounds.left,
                 y: bounds.top,
               })
             ) {
               return null;
             }
             const isPlaying = playingConnectionId === connection.id;
            return (
              <div
                key={`connection-controls-${connection.id}`}
                className="canvas-connection-header"
                style={{
                  "--connection-color": connectionColorFromName(connection.name || connection.id),
                  left: bounds.left + bounds.width / 2,
                  top: bounds.top - 66,
                } as CSSProperties & { "--connection-color": string }}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  aria-label="Rewind sequence"
                  title="Rewind sequence"
                  onClick={() => stepConnectionPlayback(connection, -1)}
                >
                  <Rewind size={19} fill="currentColor" />
                </button>
                <button
                  type="button"
                  className="primary"
                  aria-label={isPlaying ? "Stop sequence" : "Play sequence"}
                  title={isPlaying ? "Stop sequence" : "Play sequence"}
                  onClick={() => toggleConnectionPlayback(connection)}
                >
                  {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
                </button>
                <button
                  type="button"
                  aria-label="Fast-forward sequence"
                  title="Fast-forward sequence"
                  onClick={() => stepConnectionPlayback(connection, 1)}
                >
                  <FastForward size={19} fill="currentColor" />
                </button>
                <button
                  type="button"
                  aria-label={connection.collapsed ? "Expand sequence" : "Collapse sequence"}
                  title={connection.collapsed ? "Expand sequence" : "Collapse sequence"}
                  onClick={() => setConnectionCollapsed(connection.id, !connection.collapsed)}
                >
                  {connection.collapsed ? <Maximize2 size={18} /> : <Minimize2 size={18} />}
                </button>
                <button
                  type="button"
                  aria-label="Disconnect sequence"
                  title="Disconnect sequence"
                  onClick={() => disconnectConnection(connection.id)}
                >
                  <X size={18} />
                </button>
              </div>
            );
          })}
        </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>Canvas</ContextMenuLabel>
          <ContextMenuItem onSelect={() => setGroupCreateArmed(true)}>
            Create group
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {dockDropGhost ? (
        <div
          className="canvas-carry-tile"
          style={{ left: dockDropGhost.x, top: dockDropGhost.y }}
          aria-hidden="true"
        >
          {dockDropGhost.thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={dockDropGhost.thumb} alt="" draggable={false} />
          ) : (
            <span className="canvas-carry-tile-fallback">
              <Video size={16} />
            </span>
          )}
        </div>
      ) : null}

      {renderCanvasDock()}
      </div>

      {inspectorVisible && selectedInspectorCards.length ? (
      <CanvasTileInspector
        onLivePlayback={(cardId, playbackState) => {
          // The drawer is the master player; its tile mirrors time and
          // play/pause so the two can never disagree.
          const tile = videoElementForCard(cardId);
          if (!tile) return;
          if (Math.abs(tile.currentTime - playbackState.currentTime) > 0.35) {
            try {
              tile.currentTime = playbackState.currentTime;
            } catch {
              /* not seekable yet */
            }
          }
          if (playbackState.playing && tile.paused) {
            void tile.play().catch(() => {});
          } else if (!playbackState.playing && !tile.paused) {
            tile.pause();
          }
        }}
        cards={selectedInspectorCards.map((card) => {
          const versions = card.versions ?? [];
          return {
            ...card,
            canAdjust: canAdjustImage(card, displaySrc(card)),
            canDraw: canDrawOver(card, displaySrc(card)),
            canDuplicate: card.path !== "#",
            canStage: canStage(card),
            canTrack: (card.kind === "clip" || card.kind === "video") && Boolean(displaySrc(card)),
            canTrim:
              (card.kind === "clip" || card.kind === "video") &&
              card.status !== "local" &&
              Boolean(displaySrc(card)),
            isStaged: stagedCardIds.includes(card.id),
            kind: canvasPieceKindForCard(card),
            muted: !unmutedCardIds.includes(card.id),
            playbackRate: playbackRates[card.id] ?? 1,
            previewSrc: displaySrc(card),
            selectedVersionIndex: versions.length
              ? resolveVersionIndex(`${card.kind}:${card.id}`, versions)
              : 0,
          };
        })}
        adjustment={
          inspectorCard && imageAdjust?.cardId === inspectorCard.id
            ? {
                changed: imageAdjustChanged(imageAdjust),
                mode: imageAdjust.mode,
                params: imageAdjust.params,
                saving: imageAdjust.saving,
              }
            : null
        }
        open={inspectorVisible}
        usedCards={inspectorUsedCards}
        adjustmentFilter={
          inspectorCard && imageAdjust?.cardId === inspectorCard.id
            ? cssFilterForAdjust(imageAdjust.params)
            : null
        }
        trim={
          inspectorCard && trimDraft?.cardId === inspectorCard.id
            ? { changed: trimChanged(), saving: savingClipEdit }
            : null
        }
        trimDraft={
          inspectorCard && trimDraft?.cardId === inspectorCard.id
            ? trimDraft
            : null
        }
        onTrimDraftChange={(draft) => {
          if (!inspectorCard) return;
          setTrimDraft({ cardId: inspectorCard.id, ...draft });
        }}
        onAction={(action) => {
          const targets = selectedInspectorCards;
          const card = targets.length === 1 ? targets[0]! : null;
          if (action === "stage") {
            const allStaged = targets.every((target) => stagedCardIds.includes(target.id));
            setStagedCardIds((current) => {
              const next = new Set(current);
              for (const target of targets) {
                if (allStaged) next.delete(target.id);
                else if (canStage(target)) next.add(target.id);
              }
              return [...next];
            });
            return;
          }
          if (action === "delete") {
            requestDeleteConfirmation(targets);
            return;
          }
          if (action === "duplicate") {
            void (async () => {
              for (const target of targets) await runTileOp(target, "duplicate");
            })();
            return;
          }
          if (!card) return;
          if (action === "crop" || action === "filters") {
            startImageAdjust(card, action);
            return;
          }
          if (action === "trim") {
            if (trimModeCardId === card.id) {
              setTrimModeCardId(null);
              return;
            }
            setTrimModeCardId(card.id);
            const src = displaySrc(card);
            if (src) void captureFrameStrip(card.id, src);
            return;
          }
          if (action === "mute") {
            toggleTileMute(card.id);
            return;
          }
          if (action === "track" || action === "draw" || action === "revise") {
            if (
              (action === "track" || action === "draw") &&
              canDrawOver(card, displaySrc(card))
            ) {
              startDrawing(card);
            }
            window.requestAnimationFrame(() => {
              workspaceRef.current
                ?.querySelector<HTMLTextAreaElement>(".canvas-dock textarea")
                ?.focus();
            });
          }
        }}
        onActivateVersion={(index) => {
          if (!inspectorCard?.versions?.length) return;
          stepVersion(
            `${inspectorCard.kind}:${inspectorCard.id}`,
            index,
            inspectorCard.versions,
          );
        }}
        onAdjustmentChange={(key, value) => {
          setImageAdjust((current) =>
            current && key in current.params
              ? { ...current, params: { ...current.params, [key]: value } }
              : current,
          );
        }}
        onAdjustmentDiscard={() => setImageAdjust(null)}
        onAdjustmentSave={() => {
          if (inspectorCard) void applyImageAdjust(inspectorCard);
        }}
        onPlaybackRateChange={setSelectedPlaybackRate}
        onRename={(title) => {
          if (inspectorCard) void commitRename(inspectorCard, title);
        }}
        onTrimDiscard={() => {
          if (inspectorCard && trimDraft) resetTrimDraft(inspectorCard, trimDraft.duration);
        }}
        onTrimSave={(mode) => void saveTrim(mode).then(() => setTrimModeCardId(null))}
        onOpenChange={(open) => {
          if (open) return;
          const returnId = inspectorReturnFocusRef.current;
          setFocusedInspectorCardId(null);
          window.requestAnimationFrame(() => {
            if (!returnId) return;
            viewportRef.current
              ?.querySelector<HTMLElement>(`[data-card-id="${returnId}"]`)
              ?.focus({ preventScroll: true });
          });
        }}
      />
      ) : null}

      <Dialog
        open={pendingSelectionId !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingSelectionId(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save trim changes?</DialogTitle>
            <DialogDescription>
              This clip has unsaved trim edits. Save them before leaving the tile?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <button className="dialog-btn" type="button" onClick={continuePendingSelection}>
                Discard
              </button>
            </DialogClose>
            <button
              className="dialog-btn dialog-btn-danger"
              type="button"
              disabled={savingClipEdit}
              onClick={() => void saveTrimThenContinue("version")}
            >
              Save
            </button>
            <button
              className="dialog-btn dialog-btn-danger"
              type="button"
              disabled={savingClipEdit}
              onClick={() => void saveTrimThenContinue("new")}
            >
              Save as new
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingDeleteCards !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteCards(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingDeleteCards && pendingDeleteCards.length > 1
                ? `Delete ${pendingDeleteCards.length} pieces?`
                : `Delete “${pendingDeleteCards?.[0]?.title ?? "this piece"}”?`}
            </DialogTitle>
            <DialogDescription>
              {deleteConfirmationDescription(pendingDeleteCards ?? [])}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <button className="dialog-btn" type="button">
                Cancel
              </button>
            </DialogClose>
            <button
              className="dialog-btn dialog-btn-danger"
              type="button"
              onClick={() => {
                const targets = pendingDeleteCards ?? [];
                setPendingDeleteCards(null);
                void deleteCards(targets);
              }}
            >
              {pendingDeleteCards && pendingDeleteCards.length > 1
                ? `Delete ${pendingDeleteCards.length} pieces`
                : "Delete"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
