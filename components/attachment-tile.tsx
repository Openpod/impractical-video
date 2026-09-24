"use client";

import { AudioLines, File as FileIcon, FileText, Table2, X } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * The shared attachment tile — one visual vocabulary for everything a
 * composer holds (local files, staged canvas references). 64px tall; media
 * tiles take their true aspect (width clamped 48–112px, center-cropped),
 * everything else is a paper tile with a centered icon + extension badge.
 * The name tooltip and the remove ✕ are hover-revealed.
 */

function parseRatio(aspectRatio?: string | null): number {
  if (!aspectRatio) return 1;
  const parts = aspectRatio.split(/[:/]/).map((part) => Number(part.trim()));
  if (parts.length !== 2 || !(parts[0]! > 0) || !(parts[1]! > 0)) return 1;
  return parts[0]! / parts[1]!;
}

const MEDIA_KINDS = new Set(["image", "video", "clip", "keyframe", "final", "planned"]);
const TILE_HEIGHT = 72;

/** Type → hue: every format family gets one recognizable color. */
function paperClass(kind: string, ext: string): string {
  if (kind === "audio" || ["MP3", "WAV", "M4A", "OGG", "FLAC"].includes(ext)) return "p-audio";
  if (ext === "PDF") return "p-pdf";
  if (["CSV", "TSV", "JSON", "XLSX", "XLS"].includes(ext) || kind === "data") return "p-data";
  if (["DOC", "DOCX", "TXT", "MD", "RTF"].includes(ext)) return "p-doc";
  return "p-file";
}

export function AttachmentTile({
  aspectRatio,
  extension,
  kind,
  name,
  onRemove,
  src,
}: {
  aspectRatio?: string | null;
  /** Explicit extension badge; defaults to the name's file extension. */
  extension?: string | null;
  kind: string;
  name: string;
  onRemove?: (() => void) | null;
  src?: string | null;
}) {
  const showMedia = Boolean(src) && MEDIA_KINDS.has(kind);
  const width = showMedia
    ? Math.max(54, Math.min(128, Math.round(TILE_HEIGHT * parseRatio(aspectRatio))))
    : TILE_HEIGHT;
  const rawExt = extension ?? (name.includes(".") ? name.split(".").pop() ?? "" : "");
  const ext = rawExt.slice(0, 4).toUpperCase();
  const paper = showMedia ? "" : paperClass(kind, ext);
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={`tray-tile ${paper}`} style={{ width }}>
            {showMedia ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="tray-tile-art" src={src!} alt="" draggable={false} />
            ) : (
              <span className={`tray-tile-paper ${paper}`}>
                {kind === "audio" ? (
                  <AudioLines size={18} />
                ) : kind === "data" ? (
                  <Table2 size={18} />
                ) : ext ? (
                  <FileText size={18} />
                ) : (
                  <FileIcon size={18} />
                )}
                {ext ? <span className="tray-tile-ext">{ext}</span> : null}
              </span>
            )}
            {onRemove ? (
              <button
                type="button"
                className="tray-tile-x"
                aria-label={`Remove ${name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove();
                }}
              >
                <X size={9} />
              </button>
            ) : null}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={7}>
          {name}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
