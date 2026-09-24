"use client";

import { ArrowUp, Loader2, Square } from "lucide-react";
import type { ReactNode } from "react";
import {
  MentionEditor,
  type BrowseItem,
  type MentionItem,
  type SlashCommand,
} from "@/components/mention-editor";

/**
 * THE composer — one component for every mount (chat panel, canvas dock).
 * Renders the white card (textarea + controls row + submit) with the grey
 * tray rising from behind it whenever `tray` has content. All chrome is
 * self-contained (`fcomposer-*` classes) so a mount can never change how it
 * looks; mounts differ only in what they pass in.
 */
export function FloatingComposer({
  aborting = false,
  browseItems,
  controls,
  mentions,
  onBrowsePick,
  onAbort,
  onChange,
  onFiles,
  onSubmit,
  placeholder,
  sending = false,
  slashItems,
  submitDisabled = false,
  submitTitle = "Send",
  textareaDisabled = false,
  tray,
  value,
}: {
  aborting?: boolean;
  /** Left side of the controls row (add button, Flows, contextual chips…). */
  controls?: ReactNode;
  /** Entities offered by the @ popover (tiles, references). */
  mentions?: MentionItem[];
  /** When provided, an active run shows a stop button in the submit slot. */
  onAbort?: (() => void) | null;
  onChange: (value: string) => void;
  /** Files pasted into the editor (screenshots etc.). */
  onFiles?: (files: File[]) => void;
  onSubmit: () => void;
  placeholder: string;
  sending?: boolean;
  /** Commands offered by the / popover. */
  slashItems?: SlashCommand[];
  /** Public items for the /browse search view. */
  browseItems?: BrowseItem[];
  onBrowsePick?: (item: BrowseItem) => void;
  submitDisabled?: boolean;
  submitTitle?: string;
  textareaDisabled?: boolean;
  /** Attachment tiles; the tray renders (and animates out) only when present. */
  tray?: ReactNode[] | null;
  value: string;
}) {
  const trayItems = (tray ?? []).filter(Boolean);
  const hasTray = trayItems.length > 0;
  const showStop = Boolean(onAbort) && (sending || aborting);

  return (
    <div className={`fcomposer ${hasTray ? "has-tray" : ""}`}>
      <div className="fcomposer-tray" aria-hidden={!hasTray}>
        <div className="fcomposer-tray-inner">
          <div className="tray-tiles">{trayItems}</div>
        </div>
      </div>
      <form
        className="fcomposer-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (!submitDisabled) onSubmit();
        }}
      >
        <div className="fcomposer-input-row">
          <MentionEditor
            value={value}
            placeholder={placeholder}
            disabled={textareaDisabled}
            browseItems={browseItems}
            mentions={mentions}
            onBrowsePick={onBrowsePick}
            slashItems={slashItems}
            onChange={onChange}
            onFiles={onFiles}
            onSubmit={() => {
              if (!submitDisabled) onSubmit();
            }}
          />
        </div>
        <div className="fcomposer-controls">
          {controls}
          {showStop ? (
            <button
              className="fcomposer-submit fcomposer-stop"
              type="button"
              title={aborting ? "Stopping" : "Stop"}
              aria-label="Stop run"
              disabled={aborting}
              onClick={() => onAbort?.()}
            >
              {aborting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Square size={14} fill="currentColor" />
              )}
            </button>
          ) : (
            <button
              className="fcomposer-submit"
              type="submit"
              disabled={submitDisabled}
              title={submitTitle}
              aria-label={submitTitle}
            >
              {sending ? <Loader2 size={17} className="animate-spin" /> : <ArrowUp size={18} />}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
