"use client";

import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  TextNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
} from "lexical";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Search } from "lucide-react";
import {
  AudioLines,
  Clapperboard,
  Image as ImageIcon,
  MapPin,
  Package,
  Palette,
  UserRound,
  Workflow,
} from "lucide-react";
import { mentionColor } from "@/lib/mention-color";

/**
 * The composer's text input: a Lexical editor whose mentions are ATOMIC
 * token nodes rendered inline in the reference's identity color — real
 * editor state, no overlay-div tricks. Typing `@` opens the mention popover
 * (tiles + references); typing `/` opens commands. The popover spans the
 * composer's width (see .mention-popover).
 *
 * Serialization contract: `value`/`onChange` speak plain text where every
 * token collapses to `@<id>` — exactly what the agents already understand.
 */

export type MentionItem = {
  id: string;
  kind?: string;
  src?: string | null;
  title: string;
};

/** Representative icon per item type — shown instead of a kind word. */
function MentionKindIcon({ kind }: { kind?: string }) {
  const value = (kind ?? "").toLowerCase();
  if (value.includes("clip") || value.includes("video")) return <Clapperboard size={15} />;
  if (value.includes("audio")) return <AudioLines size={15} />;
  if (value.includes("character")) return <UserRound size={15} />;
  if (value.includes("style")) return <Palette size={15} />;
  if (value.includes("environment") || value.includes("location")) return <MapPin size={15} />;
  if (value.includes("prop") || value.includes("object")) return <Package size={15} />;
  return <ImageIcon size={15} />;
}

/** Section rank: references are canonical identities; the rest is content. */
function mentionRank(kind?: string): number {
  const value = (kind ?? "").toLowerCase();
  if (value.includes("reference")) return 0;
  if (value.includes("clip") || value.includes("video")) return 1;
  if (value.includes("audio")) return 2;
  return 3;
}

const MENTION_SECTION_LABELS = ["References", "Clips", "Audio", "Images & frames"];

const BROWSE_SECTIONS: Array<{ label: string; match: string }> = [
  { label: "Characters", match: "character" },
  { label: "Locations", match: "environment" },
  { label: "Objects", match: "prop" },
  { label: "Styles", match: "style" },
  { label: "Features", match: "feature" },
];

function browseRank(kind?: string): number {
  const value = (kind ?? "").toLowerCase();
  const index = BROWSE_SECTIONS.findIndex((section) => value.includes(section.match));
  return index === -1 ? BROWSE_SECTIONS.length : index;
}

function isImageKind(kind?: string) {
  const value = (kind ?? "").toLowerCase();
  return !value.includes("clip") && !value.includes("video") && !value.includes("audio");
}

export type SlashCommand = {
  /** Trailing chevron — the row opens a subview instead of running. */
  chevron?: boolean;
  description?: string;
  icon?: ReactNode;
  id: string;
  /** "browse" morphs the popover into the search view; default runs `run`. */
  kind?: "action" | "browse";
  run?: () => void;
  title: string;
};

export type BrowseItem = {
  id: string;
  kind?: string;
  src?: string | null;
  title: string;
};

// ---- Mention token node ----------------------------------------------------

type SerializedMentionNode = SerializedTextNode & { refId: string; title: string };

class MentionNode extends TextNode {
  __refId: string;
  __title: string;

  static getType(): string {
    return "mention";
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__refId, node.__title, node.__key);
  }

  constructor(refId: string, title: string, key?: NodeKey) {
    super(`@${title}`, key);
    this.__refId = refId;
    this.__title = title;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.className = "mention-token";
    dom.style.color = mentionColor(this.__refId);
    dom.setAttribute("data-ref-id", this.__refId);
    return dom;
  }

  static importJSON(serialized: SerializedMentionNode): MentionNode {
    return $createMentionNode(serialized.refId, serialized.title);
  }

  exportJSON(): SerializedMentionNode {
    return { ...super.exportJSON(), refId: this.__refId, title: this.__title, type: "mention" };
  }
}

function $createMentionNode(refId: string, title: string): MentionNode {
  const node = new MentionNode(refId, title);
  // Token mode: the caret treats the mention as one atomic unit. Set OUTSIDE
  // the constructor — setMode inside it recurses via clone() on any mutation.
  node.setMode("token");
  return node;
}

// ---- Serialization ---------------------------------------------------------

function $serializeToText(): string {
  const lines: string[] = [];
  for (const paragraph of $getRoot().getChildren()) {
    let line = "";
    if ("getChildren" in paragraph && typeof (paragraph as { getChildren?: () => LexicalNode[] }).getChildren === "function") {
      for (const child of (paragraph as unknown as { getChildren: () => LexicalNode[] }).getChildren()) {
        if (child instanceof MentionNode) line += `@${child.__refId}`;
        else if (child.getType() === "linebreak") {
          lines.push(line);
          line = "";
        } else line += child.getTextContent();
      }
    } else {
      line = paragraph.getTextContent();
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function $rebuildFromText(text: string, mentions: MentionItem[]) {
  const byId = new Map(mentions.map((item) => [item.id, item]));
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  const lines = text.split("\n");
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) paragraph.append($createLineBreakNode());
    const pattern = /@([A-Za-z0-9_-]+)/g;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      const item = byId.get(match[1]!);
      if (!item) continue;
      if (match.index > cursor) paragraph.append($createTextNode(line.slice(cursor, match.index)));
      paragraph.append($createMentionNode(item.id, item.title));
      cursor = match.index + match[0].length;
    }
    if (cursor < line.length) paragraph.append($createTextNode(line.slice(cursor)));
  });
  root.append(paragraph);
}

// ---- Trigger detection -----------------------------------------------------

type TriggerState =
  | { query: string; type: "mention" | "slash" }
  | null;

function $detectTrigger(): TriggerState {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const anchor = selection.anchor;
  const node = anchor.getNode();
  if (!$isTextNode(node) || node instanceof MentionNode) return null;
  const upToCaret = node.getTextContent().slice(0, anchor.offset);
  const mention = /(^|\s)@([A-Za-z0-9 _-]{0,40})$/.exec(upToCaret);
  if (mention) return { query: mention[2]!, type: "mention" };
  const slash = /(^|\s)\/([A-Za-z0-9 _-]{0,40})$/.exec(upToCaret);
  if (slash) return { query: slash[2]!, type: "slash" };
  return null;
}

/** Replace the live "@query" / "/query" the user typed with the picked node. */
function $consumeTrigger(triggerLength: number, replaceWith: LexicalNode[]) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
  const anchor = selection.anchor;
  const node = anchor.getNode();
  if (!$isTextNode(node)) return;
  const offset = anchor.offset;
  node.spliceText(offset - triggerLength, triggerLength, "", true);
  const target = $getSelection();
  if ($isRangeSelection(target)) {
    target.insertNodes(replaceWith);
  }
}

function TypeaheadPreview({ preview }: { preview: { kind?: string; src: string } | null }) {
  if (!preview) return null;
  const isVideo =
    (preview.kind ?? "").toLowerCase().includes("clip") ||
    (preview.kind ?? "").toLowerCase().includes("video") ||
    /\.(mp4|webm|mov)(\?|$)/i.test(preview.src);
  return (
    <div className="composer-typeahead-preview" aria-hidden="true">
      {isVideo ? (
        <video src={preview.src} muted loop autoPlay playsInline preload="metadata" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview.src} alt="" draggable={false} />
      )}
    </div>
  );
}

// ---- Plugins ---------------------------------------------------------------

function EditorBehaviorPlugin({
  browseItems = [],
  mentions,
  onBrowsePick,
  onChange,
  onFiles,
  onSubmit,
  slashItems,
  value,
}: {
  browseItems?: BrowseItem[];
  mentions: MentionItem[];
  onBrowsePick?: (item: BrowseItem) => void;
  onChange: (value: string) => void;
  onFiles?: (files: File[]) => void;
  onSubmit: () => void;
  slashItems: SlashCommand[];
  value: string;
}) {
  const [editor] = useLexicalComposerContext();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [trigger, setTrigger] = useState<TriggerState>(null);
  const triggerRef = useRef<TriggerState>(null);
  const [browseMode, setBrowseMode] = useState(false);
  const browseModeRef = useRef(false);
  useEffect(() => {
    browseModeRef.current = browseMode;
  }, [browseMode]);
  const [browseQuery, setBrowseQuery] = useState("");
  const [browseActive, setBrowseActive] = useState(0);
  /** Dwell preview: hovering a row for a beat shows the media beside the popover. */
  const [preview, setPreview] = useState<{ kind?: string; src: string } | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const armPreview = (src: string | null | undefined, kind?: string) => {
    if (previewTimerRef.current) window.clearTimeout(previewTimerRef.current);
    setPreview(null);
    if (!src) return;
    previewTimerRef.current = window.setTimeout(() => setPreview({ kind, src }), 350);
  };
  const disarmPreview = () => {
    if (previewTimerRef.current) window.clearTimeout(previewTimerRef.current);
    setPreview(null);
  };
  useEffect(() => disarmPreview, []);
  const [rawActiveIndex, setActiveIndex] = useState(0);
  const lastEmittedRef = useRef<string>("");
  const stateRef = useRef({ activeIndex: 0, options: [] as Array<() => void>, open: false });

  // External value changes (prefill, clear-on-send) rebuild the document.
  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    editor.update(() => $rebuildFromText(value, mentions));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor]);

  // Emit serialized text + track the live trigger on every edit.
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read(() => {
          const text = $serializeToText();
          if (text !== lastEmittedRef.current) {
            lastEmittedRef.current = text;
            onChange(text);
            if (browseModeRef.current) setBrowseMode(false);
          }
          const nextTrigger = $detectTrigger();
          // A freshly opened popover always starts on the first item.
          if (nextTrigger && (!triggerRef.current || triggerRef.current.type !== nextTrigger.type)) {
            setActiveIndex(0);
          }
          triggerRef.current = nextTrigger;
          setTrigger(nextTrigger);
        });
      }),
    [editor, onChange],
  );



  const mentionResults = useMemo(() => {
    if (trigger?.type !== "mention") return [];
    const query = trigger.query.trim().toLowerCase();
    return mentions
      .filter(
        (item) =>
          !query ||
          item.title.toLowerCase().includes(query) ||
          item.id.toLowerCase().includes(query),
      )
      .sort((a, b) => mentionRank(a.kind) - mentionRank(b.kind));
  }, [mentions, trigger]);

  const slashResults = useMemo(() => {
    if (trigger?.type !== "slash") return [];
    const query = trigger.query.trim().toLowerCase();
    return slashItems
      .filter(
        (item) =>
          !query ||
          item.title.toLowerCase().includes(query) ||
          (item.description ?? "").toLowerCase().includes(query),
      );
  }, [slashItems, trigger]);

  const browseResults = useMemo(() => {
    if (!browseMode) return [];
    const query = browseQuery.trim().toLowerCase();
    return browseItems
      .filter((item) => !query || item.title.toLowerCase().includes(query))
      .sort((a, b) => browseRank(a.kind) - browseRank(b.kind));
  }, [browseItems, browseMode, browseQuery]);

  const open = Boolean(trigger) && (mentionResults.length > 0 || slashResults.length > 0);
  const optionCount = trigger?.type === "mention" ? mentionResults.length : slashResults.length;
  // Clamp instead of effect-resetting — result-list changes can only shrink it.
  const activeIndex = optionCount ? Math.min(rawActiveIndex, optionCount - 1) : 0;

  function pickMention(item: MentionItem) {
    const triggerLength = (trigger?.query.length ?? 0) + 1;
    editor.update(() => {
      $consumeTrigger(triggerLength, [
        $createMentionNode(item.id, item.title),
        $createTextNode(" "),
      ]);
    });
    editor.focus();
  }

  function pickSlash(item: SlashCommand) {
    const triggerLength = (trigger?.query.length ?? 0) + 1;
    // Commands never enter the composer — swallow the typed /query.
    editor.update(() => {
      $consumeTrigger(triggerLength, []);
    });
    if (item.kind === "browse") {
      setBrowseMode(true);
      setBrowseQuery("");
      setBrowseActive(0);
      return;
    }
    editor.focus();
    item.run?.();
  }

  // Keep an imperative snapshot for the key handlers.
  useEffect(() => {
    stateRef.current = {
      activeIndex,
      open,
      options:
        trigger?.type === "mention"
          ? mentionResults.map((item) => () => pickMention(item))
          : slashResults.map((item) => () => pickSlash(item)),
    };
  });

  useEffect(() => {
    // Pasted FILES (screenshots etc.) go to the attachment flow, not the text.
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (!(event instanceof ClipboardEvent) || !onFiles) return false;
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!files.length) return false;
        event.preventDefault();
        onFiles(files);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onFiles]);

  // Keyboard handling lives on the wrapper in CAPTURE phase — it runs before
  // Lexical's own root listeners, deterministically, no command priorities.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const snapshot = stateRef.current;
      if (browseModeRef.current) return; // browse input owns the keyboard
      if (event.key === "Enter") {
        if (event.isComposing) return;
        if (snapshot.open && snapshot.options[snapshot.activeIndex]) {
          event.preventDefault();
          event.stopPropagation();
          snapshot.options[snapshot.activeIndex]!();
          return;
        }
        if (!event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          onSubmit();
        }
        return;
      }
      if (!snapshot.open) return;
      const scrollToRow = (index: number) => {
        requestAnimationFrame(() => {
          const row = panelRef.current?.querySelector(`[data-typeahead-index="${index}"]`);
          if (!row) return;
          // If a section header sits directly above, bring IT into view so the
          // group label is visible (esp. wrapping back to the top).
          const previous = row.previousElementSibling;
          const target =
            previous && previous.classList.contains("composer-typeahead-section")
              ? previous
              : row;
          target.scrollIntoView({ block: "nearest" });
        });
      };
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((current) => {
          const next = (current + 1) % snapshot.options.length;
          scrollToRow(next);
          return next;
        });
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((current) => {
          const next = (current - 1 + snapshot.options.length) % snapshot.options.length;
          scrollToRow(next);
          return next;
        });
      } else if (event.key === "Tab") {
        if (snapshot.options[snapshot.activeIndex]) {
          event.preventDefault();
          event.stopPropagation();
          snapshot.options[snapshot.activeIndex]!();
        }
      } else if (event.key === "Escape") {
        event.stopPropagation();
        setTrigger(null);
      }
    };
    const root = editor.getRootElement();
    if (!root) return;
    root.addEventListener("keydown", handler, true);
    return () => root.removeEventListener("keydown", handler, true);
  }, [editor, onSubmit]);

  if (browseMode) {
    return (
      <div className="composer-typeahead app-menu" role="listbox" ref={panelRef}>
        <div className="composer-typeahead-search">
          <input
            ref={(element) => element?.focus()}
            placeholder="Search"
            value={browseQuery}
            onChange={(event) => {
              setBrowseQuery(event.target.value);
              setBrowseActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setBrowseMode(false);
                editor.focus();
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setBrowseActive((current) => (current + 1) % Math.max(1, browseResults.length));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setBrowseActive(
                  (current) =>
                    (current - 1 + Math.max(1, browseResults.length)) %
                    Math.max(1, browseResults.length),
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                const picked = browseResults[browseActive];
                if (picked) {
                  setBrowseMode(false);
                  onBrowsePick?.(picked);
                  editor.focus();
                }
              }
            }}
          />
        </div>
        {browseResults.map((item, index) => {
          const rank = browseRank(item.kind);
          const sectionLabel =
            index === 0 || browseRank(browseResults[index - 1]!.kind) !== rank
              ? BROWSE_SECTIONS[rank]?.label ?? "More"
              : null;
          return (
            <Fragment key={item.id}>
              {sectionLabel ? (
                <div className="composer-typeahead-section">{sectionLabel}</div>
              ) : null}
              <button
                type="button"
                role="option"
                aria-selected={index === browseActive}
                className={`composer-typeahead-row ${index === browseActive ? "is-active" : ""}`}
                onMouseEnter={() => {
                  setBrowseActive(index);
                  armPreview(item.src, item.kind);
                }}
                onMouseLeave={disarmPreview}
                onMouseDown={(event) => {
                  event.preventDefault();
                  disarmPreview();
                  setBrowseMode(false);
                  onBrowsePick?.(item);
                  editor.focus();
                }}
              >
                {item.src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="composer-typeahead-thumb" src={item.src} alt="" draggable={false} />
                ) : (
                  <span className="composer-typeahead-icon">
                    <MentionKindIcon kind={item.kind} />
                  </span>
                )}
                <span className="composer-typeahead-text">
                  <span className="composer-typeahead-title">{item.title}</span>
                </span>
              </button>
            </Fragment>
          );
        })}
        {!browseResults.length ? (
          <div className="composer-typeahead-empty">No public references match.</div>
        ) : null}
        <TypeaheadPreview preview={preview} />
      </div>
    );
  }

  if (!open) return null;
  return (
    <div className="composer-typeahead app-menu" role="listbox" ref={panelRef}>
      {trigger?.type === "mention"
        ? mentionResults.map((item, index) => {
            const sectionLabel =
              index === 0 || mentionRank(mentionResults[index - 1]!.kind) !== mentionRank(item.kind)
                ? MENTION_SECTION_LABELS[mentionRank(item.kind)]
                : null;
            return (
            <Fragment key={item.id}>
            {sectionLabel ? (
              <div className="composer-typeahead-section">{sectionLabel}</div>
            ) : null}
            <button
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`composer-typeahead-row ${index === activeIndex ? "is-active" : ""}`}
              data-typeahead-index={index}
              onMouseEnter={() => {
                setActiveIndex(index);
                armPreview(item.src, item.kind);
              }}
              onMouseLeave={disarmPreview}
              onMouseDown={(event) => {
                event.preventDefault();
                disarmPreview();
                pickMention(item);
              }}
            >
              {item.src && isImageKind(item.kind) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="composer-typeahead-thumb" src={item.src} alt="" draggable={false} />
              ) : item.src && !(item.kind ?? "").toLowerCase().includes("audio") ? (
                <video
                  className="composer-typeahead-thumb"
                  src={item.src}
                  muted
                  loop
                  autoPlay
                  playsInline
                  preload="metadata"
                />
              ) : (
                <span className="composer-typeahead-icon">
                  <MentionKindIcon kind={item.kind} />
                </span>
              )}
              <span className="composer-typeahead-text">
                <span className="composer-typeahead-title">{item.title}</span>
              </span>
            </button>
            </Fragment>
            );
          })
        : slashResults.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`composer-typeahead-row ${index === activeIndex ? "is-active" : ""}`}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                pickSlash(item);
              }}
            >
              <span className="composer-typeahead-icon">{item.icon ?? <Workflow size={15} />}</span>
              <span className="composer-typeahead-text">
                <span className="composer-typeahead-title">{item.title}</span>
                {item.description ? (
                  <span className="composer-typeahead-desc">{item.description}</span>
                ) : null}
              </span>
              {item.chevron ? (
                <span className="composer-typeahead-chevron">
                  <ChevronRight size={14} />
                </span>
              ) : null}
            </button>
          ))}
      <TypeaheadPreview preview={preview} />
    </div>
  );
}

// ---- Public component ------------------------------------------------------

export function MentionEditor({
  browseItems = [],
  disabled = false,
  mentions = [],
  onBrowsePick,
  onChange,
  onFiles,
  onSubmit,
  placeholder,
  slashItems = [],
  value,
}: {
  browseItems?: BrowseItem[];
  disabled?: boolean;
  mentions?: MentionItem[];
  onBrowsePick?: (item: BrowseItem) => void;
  onChange: (value: string) => void;
  onFiles?: (files: File[]) => void;
  onSubmit: () => void;
  placeholder: string;
  slashItems?: SlashCommand[];
  value: string;
}) {
  const initialConfig = useMemo(
    () => ({
      editable: !disabled,
      namespace: "composer",
      nodes: [MentionNode],
      onError: (error: Error) => console.warn("[mention-editor]", error),
      theme: {},
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="mention-editor">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className="mention-editor-input"
              aria-placeholder={placeholder}
              placeholder={<div className="mention-editor-placeholder">{placeholder}</div>}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <EditorBehaviorPlugin
          browseItems={browseItems}
          mentions={mentions}
          onBrowsePick={onBrowsePick}
          onChange={onChange}
          onFiles={onFiles}
          onSubmit={onSubmit}
          slashItems={slashItems}
          value={value}
        />
      </div>
    </LexicalComposer>
  );
}
