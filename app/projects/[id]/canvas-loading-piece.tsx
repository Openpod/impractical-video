"use client";

import {
  AudioLines,
  CircleAlert,
  CircleCheck,
  Clock3,
  Image as ImageIcon,
  Loader2,
  Package,
  Video,
  X,
} from "lucide-react";
import { memo, type CSSProperties } from "react";

export type CanvasPieceKind =
  | "audio"
  | "image"
  | "object"
  | "reference"
  | "unknown"
  | "video";

export type CanvasPieceState =
  | "awaiting-input"
  | "cancelled"
  | "failed"
  | "generating"
  | "unknown"
  | "preparing"
  | "processing"
  | "queued"
  | "ready";

const ACTIVE_STATES = new Set<CanvasPieceState>([
  "queued",
  "preparing",
  "generating",
  "processing",
]);

function validAspectRatio(value: string | null | undefined) {
  if (!value) return null;
  const parts = value.split(/[:/]/).map((part) => Number(part.trim()));
  if (
    parts.length !== 2 ||
    !Number.isFinite(parts[0]) ||
    !Number.isFinite(parts[1]) ||
    parts[0]! <= 0 ||
    parts[1]! <= 0
  ) {
    return null;
  }
  return `${parts[0]} / ${parts[1]}`;
}

export function resolvePieceAspectRatio({
  explicit,
  intrinsic,
  source,
  tool,
  workflowDefault,
}: {
  explicit?: string | null;
  intrinsic?: string | null;
  source?: string | null;
  tool?: string | null;
  workflowDefault?: string | null;
}) {
  return (
    validAspectRatio(explicit) ??
    validAspectRatio(tool) ??
    // `source` is the legacy name for a ratio chosen from conditioning
    // inputs. Treat it as tool-derived geometry, never as intrinsic media.
    validAspectRatio(source) ??
    validAspectRatio(workflowDefault) ??
    validAspectRatio(intrinsic) ??
    "1 / 1"
  );
}

export function canvasPieceState(status: string, generating = false): CanvasPieceState {
  const normalized = status.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "awaiting-input" || normalized === "needs-assets") return "awaiting-input";
  if (normalized === "cancelled" || normalized === "canceled" || normalized === "aborted") {
    return "cancelled";
  }
  if (normalized === "failed" || normalized === "error" || normalized === "rejected") {
    return "failed";
  }
  if (normalized === "queued" || normalized === "pending" || normalized === "planned") {
    return "queued";
  }
  if (normalized === "preparing" || normalized === "planning" || normalized === "imagining") {
    return "preparing";
  }
  if (normalized === "processing" || normalized === "finalizing") return "processing";
  if (generating || normalized === "generating" || normalized === "running") return "generating";
  if (
    normalized === "ready" ||
    normalized === "complete" ||
    normalized === "completed" ||
    normalized === "done" ||
    normalized === "generated" ||
    normalized === "reference" ||
    normalized === "success" ||
    normalized === "succeeded" ||
    normalized === "uploaded"
  ) {
    return "ready";
  }
  return "unknown";
}

export function canvasPieceKind(value: unknown): CanvasPieceKind {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "audio" || normalized === "music" || normalized === "speech") return "audio";
  if (normalized === "video" || normalized === "clip" || normalized === "motion") return "video";
  if (normalized === "image" || normalized === "keyframe" || normalized === "frame") return "image";
  if (
    normalized === "object" ||
    normalized === "objects" ||
    normalized === "prop" ||
    normalized === "props"
  ) {
    return "object";
  }
  if (
    normalized === "reference" ||
    normalized === "character" ||
    normalized === "characters" ||
    normalized === "environment" ||
    normalized === "environments" ||
    normalized === "location" ||
    normalized === "locations" ||
    normalized === "style" ||
    normalized === "styles"
  ) {
    return "reference";
  }
  return "unknown";
}

export function durableCanvasPieceStatus(value: unknown, hasMedia: boolean) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : hasMedia
      ? "uploaded"
      : "unknown";
}

const STATE_LABELS: Record<CanvasPieceState, string> = {
  "awaiting-input": "Needs input",
  cancelled: "Cancelled",
  failed: "Failed",
  generating: "Generating",
  unknown: "Status unavailable",
  preparing: "Preparing",
  processing: "Processing",
  queued: "Queued",
  ready: "Ready",
};

export function canvasPieceStateLabel(state: CanvasPieceState) {
  return STATE_LABELS[state];
}

function PieceIcon({ kind, state }: { kind: CanvasPieceKind; state: CanvasPieceState }) {
  // Queued is waiting, not working: a clock, never a spinner.
  if (state === "queued") return <Clock3 aria-hidden size={20} />;
  if (ACTIVE_STATES.has(state)) return <Loader2 aria-hidden size={20} />;
  if (state === "failed" || state === "awaiting-input") return <CircleAlert aria-hidden size={20} />;
  if (state === "cancelled") return <X aria-hidden size={20} />;
  if (state === "ready") return <CircleCheck aria-hidden size={20} />;
  if (kind === "audio") return <AudioLines aria-hidden size={20} />;
  if (kind === "video") return <Video aria-hidden size={20} />;
  if (kind === "image") return <ImageIcon aria-hidden size={20} />;
  if (kind === "object" || kind === "reference") return <Package aria-hidden size={20} />;
  return <Clock3 aria-hidden size={20} />;
}

export const CanvasLoadingPiece = memo(function CanvasLoadingPiece({
  aspectRatio,
  intrinsicAspectRatio,
  kind,
  label,
  progress,
  remediation,
  sourceAspectRatio,
  state,
  toolAspectRatio,
  workflowAspectRatio,
}: {
  aspectRatio?: string | null;
  intrinsicAspectRatio?: string | null;
  kind: CanvasPieceKind;
  label?: string | null;
  progress?: number | null;
  remediation?: string | null;
  sourceAspectRatio?: string | null;
  state: CanvasPieceState;
  toolAspectRatio?: string | null;
  workflowAspectRatio?: string | null;
}) {
  const resolvedAspect = resolvePieceAspectRatio({
    explicit: aspectRatio,
    intrinsic: intrinsicAspectRatio,
    source: sourceAspectRatio,
    tool: toolAspectRatio,
    workflowDefault: workflowAspectRatio,
  });
  const numericProgress =
    typeof progress === "number" && Number.isFinite(progress)
      ? Math.max(0, Math.min(1, progress))
      : null;
  const active = ACTIVE_STATES.has(state);
  // Queued tiles show no bar: a bar promises activity that hasn't started.
  const working = active && state !== "queued";
  const statusLabel = canvasPieceStateLabel(state);
  const primary = label?.trim() || statusLabel;
  // One label, never repeated: the detail line exists only when it adds
  // something (an error/remediation, or the state under a custom title).
  const detail =
    remediation?.trim() || (primary === statusLabel ? null : statusLabel);

  return (
    <div
      className={`canvas-loading-piece is-${state}`}
      data-loading-state={state}
      style={{ "--piece-aspect": resolvedAspect } as CSSProperties}
    >
      {working ? <span aria-hidden className="canvas-piece-wave" /> : null}
      <span className="canvas-loading-piece-icon">
        <PieceIcon kind={kind} state={state} />
      </span>
      <span className="canvas-loading-piece-copy">
        <strong>{primary}</strong>
        {detail ? <span>{detail}</span> : null}
      </span>
      {working && numericProgress !== null ? (
        <span
          aria-label={`${statusLabel} ${Math.round(numericProgress * 100)}%`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={Math.round(numericProgress * 100)}
          className="canvas-loading-piece-progress"
          role="progressbar"
        >
          <span style={{ width: `${numericProgress * 100}%` }} />
        </span>
      ) : null}
    </div>
  );
});
