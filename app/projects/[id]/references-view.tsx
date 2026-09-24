"use client";

import {
  ArrowLeft,
  ArrowUp,
  Box,
  FileText,
  Loader2,
  MapPin,
  Palette,
  Plus,
  Search,
  Share2,
  UserRound,
  Volume2,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import TextareaAutosize from "react-textarea-autosize";
import type { ProjectSnapshot } from "@/lib/workspace";

/**
 * Image-forward "References" surface: the project's reference portfolios as a
 * portfolio grid, not a file tree. Everything is derived from snapshot.files
 * (reference.md / portfolio.md / keyframes), the same client-side parsing the
 * storyboard already uses — no backend changes.
 */

type RefCategory = "characters" | "environments" | "props" | "styles" | "audio";

const CATEGORY_LABEL: Record<RefCategory, string> = {
  characters: "Characters",
  environments: "Locations",
  props: "Objects",
  styles: "Style",
  audio: "Audio",
};

const CATEGORY_ICON: Record<RefCategory, LucideIcon> = {
  characters: UserRound,
  environments: MapPin,
  props: Box,
  styles: Palette,
  audio: Volume2,
};

// Category order for the filter row.
const CATEGORY_ORDER: RefCategory[] = ["characters", "environments", "props", "styles", "audio"];

type ReferenceCard = {
  id: string;
  name: string;
  category: RefCategory;
  generating: boolean;
  status: string;
  description: string;
  thumbUrl: string | null;
  usage: number;
  usedIn: string[];
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => void;
};

const ID_PREFIXES = new Set(["env", "char", "character", "prop", "style", "loc", "obj", "fx", "sfx", "aud", "audio"]);

function humanizeId(id: string): string {
  const parts = id.split("_").filter(Boolean);
  if (parts.length > 1 && ID_PREFIXES.has(parts[0].toLowerCase())) parts.shift();
  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .trim();
}

function parseFrontmatter(content: string | undefined): Record<string, unknown> | null {
  if (!content || !content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  try {
    return JSON.parse(content.slice(content.indexOf("\n") + 1, end)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function bodyAfterFrontmatter(content: string | undefined): string {
  if (!content) return "";
  if (!content.startsWith("---")) return content.trim();
  const end = content.indexOf("\n---", 3);
  if (end === -1) return "";
  return content.slice(end + 4).trim();
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function proxied(url: string): string {
  return url.startsWith("/") ? url : `/api/media-proxy?url=${encodeURIComponent(url)}`;
}

function ReferenceIcon({ category, size }: { category: RefCategory; size: number }) {
  const Icon = CATEGORY_ICON[category];
  const filled = category === "environments";
  return (
    <Icon
      size={size}
      fill={filled ? "currentColor" : "none"}
      strokeWidth={filled ? 0 : 2}
    />
  );
}

function transitionName(id: string): string {
  return `ref-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function transitionStyle(id: string): CSSProperties {
  return { viewTransitionName: transitionName(id) } as CSSProperties;
}

function portfolioCellStyle(index: number): CSSProperties {
  const clamped = Math.max(0, Math.min(8, index));
  const col = clamped % 3;
  const row = Math.floor(clamped / 3);
  return {
    "--portfolio-cell-x": `${-((col + 0.5) / 3) * 100}%`,
    "--portfolio-cell-y": `${-((row + 0.5) / 3) * 100}%`,
  } as CSSProperties;
}

function PortfolioCellImage({
  alt,
  index,
  loading,
  src,
}: {
  alt: string;
  index: number;
  loading?: "lazy";
  src: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="ref-portfolio-cell-image"
      src={src}
      alt={alt}
      loading={loading}
      draggable={false}
      style={portfolioCellStyle(index)}
    />
  );
}

function ReferencesEmptyState() {
  return (
    <div className="preview-empty preview-empty-references">
      <div className="preview-empty-diagram" aria-hidden="true">
        <div className="empty-ref-grid">
          {Array.from({ length: 9 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
      </div>
      <p>Your reference portfolios will show up here.</p>
    </div>
  );
}

export function ReferencesView({
  focusRequest,
  generatingReferenceIds = new Set<string>(),
  isSending = false,
  onRequestChange,
  projectId,
  snapshot,
}: {
  focusRequest?: { id: string; nonce: number } | null;
  generatingReferenceIds?: Set<string>;
  isSending?: boolean;
  onRequestChange?: (message: string) => void;
  snapshot: ProjectSnapshot;
  projectId?: string;
}) {
  const cards = useMemo<ReferenceCard[]>(() => {
    const files = snapshot.files;
    // portfolio urls keyed by reference id
    const portfolioByRef = new Map<string, { status: string; urls: string[] }>();
    for (const file of files) {
      if (!file.path.endsWith("/portfolio.md")) continue;
      const meta = parseFrontmatter(file.content);
      const refId = meta?.reference_id;
      if (typeof refId === "string") {
        portfolioByRef.set(refId, {
          status: typeof meta?.status === "string" ? meta.status : "planned",
          urls: asStringArray(meta?.urls),
        });
      }
    }

    // usage: count keyframes whose depicts/identity_anchors mention the ref id
    const usageById = new Map<string, string[]>();
    for (const file of files) {
      if (!file.path.startsWith("keyframes/") || !file.path.endsWith(".md")) continue;
      const meta = parseFrontmatter(file.content);
      if (!meta) continue;
      const kfId = typeof meta.id === "string" ? meta.id : file.path;
      const refs = new Set([...asStringArray(meta.depicts), ...asStringArray(meta.identity_anchors)]);
      for (const ref of refs) {
        const key = ref.replace(/_portfolio$/, "");
        if (!usageById.has(key)) usageById.set(key, []);
        const usedIn = usageById.get(key)!;
        if (!usedIn.includes(kfId)) usedIn.push(kfId);
      }
    }

    const out: ReferenceCard[] = [];
    for (const file of files) {
      if (!file.path.endsWith("/reference.md")) continue;
      const meta = parseFrontmatter(file.content);
      if (!meta || typeof meta.id !== "string") continue;
      const id = meta.id;
      const category = (typeof meta.category === "string" ? meta.category : "props") as RefCategory;
      const portfolio = portfolioByRef.get(id) ?? portfolioByRef.get(`${id}_portfolio`) ?? null;
      const urls = portfolio?.urls ?? [];
      const generating =
        generatingReferenceIds.has(id) ||
        Boolean(
          portfolio &&
            urls.length === 0 &&
            ["generating", "pending"].includes(portfolio.status),
        );
      const usedIn = usageById.get(id) ?? [];
      out.push({
        id,
        name: humanizeId(id),
        category: CATEGORY_ORDER.includes(category) ? category : "props",
        generating,
        status: typeof meta.status === "string" ? meta.status : "active",
        description: bodyAfterFrontmatter(file.content),
        thumbUrl: urls[0] ? proxied(urls[0]) : null,
        usage: usedIn.length,
        usedIn,
      });
    }
    out.sort((a, b) => b.usage - a.usage || a.name.localeCompare(b.name));
    return out;
  }, [generatingReferenceIds, snapshot.files]);

  const present = useMemo(() => {
    const set = new Set(cards.map((card) => card.category));
    return CATEGORY_ORDER.filter((category) => set.has(category));
  }, [cards]);

  const [filter, setFilter] = useState<RefCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailCellIndex, setDetailCellIndex] = useState(4);
  const [request, setRequest] = useState("");
  const [localAttachments, setLocalAttachments] = useState<
    { id: string; label: string; src: string | null; fileKind: "image" | "file"; fileType: string }[]
  >([]);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishedItemId, setPublishedItemId] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const visible = (filter === "all" ? cards : cards.filter((card) => card.category === filter))
    .filter((card) => {
      if (!normalizedQuery) return true;
      return [card.id, card.name, card.description, card.status]
        .some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  const selected = cards.find((card) => card.id === selectedId) ?? null;

  useEffect(() => {
    if (!selected?.thumbUrl) return;
    const interval = window.setInterval(() => {
      setDetailCellIndex((current) => (current + 1) % 9);
    }, 1800);
    return () => window.clearInterval(interval);
  }, [selected?.id, selected?.thumbUrl]);

  function updateSelection(nextId: string | null) {
    const transitionDocument =
      typeof document === "undefined" ? null : (document as ViewTransitionDocument);
    if (transitionDocument?.startViewTransition) {
      transitionDocument.startViewTransition(() => setSelectedId(nextId));
      return;
    }
    setSelectedId(nextId);
  }

  const handledFocusNonceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!focusRequest) return;
    // Handle each request once (by nonce) — cards refresh mid-run and this
    // effect must not re-clear the filter/selection for a stale request.
    if (handledFocusNonceRef.current === focusRequest.nonce) return;
    if (!cards.some((card) => card.id === focusRequest.id)) return;
    handledFocusNonceRef.current = focusRequest.nonce;
    const frame = window.requestAnimationFrame(() => {
      setFilter("all");
      setQuery("");
      updateSelection(focusRequest.id);
    });
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce, focusRequest?.id, cards]);

  function removeLocalAttachment(id: string) {
    setLocalAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.src) URL.revokeObjectURL(removed.src);
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  if (!cards.length) {
    return <ReferencesEmptyState />;
  }

  if (selected) {
    const publishKind =
      selected.category === "characters"
        ? "character"
        : selected.category === "environments"
          ? "environment"
          : null;

    async function publishSelected() {
      if (!selected || !projectId || !publishKind || publishingId) return;
      setPublishingId(selected.id);
      setPublishError(null);
      setPublishedItemId(null);
      try {
        const response = await fetch("/api/published-items/publish", {
          body: JSON.stringify({
            description: selected.description,
            kind: publishKind,
            sourceNodeId: selected.id,
            sourceProjectId: projectId,
            tags: [CATEGORY_LABEL[selected.category]],
            title: selected.name,
            visibility: "public",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Publish failed.");
        const itemId = typeof data.itemId === "string" ? data.itemId : null;
        setPublishedItemId(itemId);
        if (itemId) window.localStorage.setItem("explore-reference-cache-bust", itemId);
      } catch (caught) {
        setPublishError(caught instanceof Error ? caught.message : "Publish failed.");
      } finally {
        setPublishingId(null);
      }
    }

    function submitRequest(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      const trimmed = request.trim();
      if (!trimmed || !onRequestChange || !selected) return;
      onRequestChange(
        [
          `For reference ${selected.id} (${selected.name}), update the reference source and portfolio to reflect this requested change: ${trimmed}`,
          `Read references/${selected.category}/${selected.id}/reference.md and references/${selected.category}/${selected.id}/portfolio.md first.`,
          "Patch reference.md so the written identity/details match the change, then regenerate the portfolio. Preserve the existing identity unless the requested change explicitly says otherwise.",
        ].join("\n"),
      );
      setRequest("");
      setLocalAttachments([]);
    }
    return (
      <div className="refs-view refs-view-detail">
        <div className="refs-toolbar">
          <button className="refs-back" onClick={() => updateSelection(null)}>
            <ArrowLeft size={16} />
            References
          </button>
        </div>
        <div className="ref-detail-page">
          <div className="ref-detail-hero" style={transitionStyle(selected.id)}>
            {selected.thumbUrl ? (
              <PortfolioCellImage
                key={`${selected.id}-${detailCellIndex}`}
                src={selected.thumbUrl}
                alt={`${selected.name} portfolio square ${detailCellIndex + 1}`}
                index={detailCellIndex}
              />
            ) : (
              <span className="ref-thumb-empty">{selected.name.charAt(0)}</span>
            )}
            <span className={`ref-type-badge ${selected.category}`}>
              <ReferenceIcon category={selected.category} size={19} />
            </span>
            {selected.thumbUrl ? (
              <div className="ref-carousel-dots" aria-label="Portfolio squares">
                {Array.from({ length: 9 }, (_, index) => (
                  <button
                    key={index}
                    className={`ref-carousel-dot ${index === detailCellIndex ? "active" : ""}`}
                    type="button"
                    aria-label={`Show portfolio square ${index + 1}`}
                    onClick={() => setDetailCellIndex(index)}
                  />
                ))}
              </div>
            ) : null}
          </div>
          <div className="ref-detail-content">
            <div className="ref-detail-kicker">
              {selected.status} · {selected.usage === 0 ? "unused" : `used in ${selected.usage} shot${selected.usage === 1 ? "" : "s"}`}
            </div>
            <h3 className="ref-detail-title">{selected.name}</h3>
            {selected.description ? <p className="ref-detail-desc">{selected.description}</p> : null}
            {selected.usedIn.length ? (
              <div className="ref-detail-used">
                <div className="ref-detail-label">Used in</div>
                <div className="ref-used-list">
                  {selected.usedIn.map((id) => (
                    <span key={id} className="ref-used-chip">
                      {id}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {publishKind ? (
              <div className="ref-publish-actions">
                <button
                  className="ref-publish-button"
                  disabled={!projectId || publishingId === selected.id}
                  onClick={() => void publishSelected()}
                  type="button"
                >
                  {publishingId === selected.id ? (
                    <Loader2 className="spin" size={15} />
                  ) : (
                    <Share2 size={15} />
                  )}
                  Publish to Explore
                </button>
                {publishedItemId ? (
                  <a className="ref-publish-link" href={`/explore/${publishedItemId}`}>
                    View published item
                  </a>
                ) : null}
                {publishError ? <span className="ref-publish-error">{publishError}</span> : null}
              </div>
            ) : null}
          </div>
        </div>
        <form className="ref-change-box" onSubmit={submitRequest}>
          {localAttachments.length ? (
            <div className="ref-change-attachments">
              {localAttachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className={`ref-change-attachment ${attachment.src ? "image" : "file"}`}
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
                        <span className="composer-file-type">{attachment.fileType}</span>
                      </span>
                    </>
                  )}
                  <button
                    className="composer-attachment-remove"
                    type="button"
                    title={`Remove ${attachment.label}`}
                    onClick={() => removeLocalAttachment(attachment.id)}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <TextareaAutosize
            className="ref-change-textarea"
            minRows={1}
            maxRows={7}
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            placeholder={`Request a change to ${selected.name}...`}
          />
          <div className="ref-change-controls">
            <button
              className="ref-change-add"
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
            <button
              className="ref-change-submit"
              type="submit"
              disabled={isSending || !request.trim() || !onRequestChange}
              title="Submit request"
              aria-label="Submit request"
            >
              {isSending ? <Loader2 size={17} className="spin" /> : <ArrowUp size={18} />}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="refs-view">
      <div className="refs-toolbar no-scrollbar">
        <button
          className={`ref-filter ${filter === "all" ? "active" : ""}`}
          onClick={() => setFilter("all")}
        >
          All <span className="ref-filter-count">{cards.length}</span>
        </button>
        {present.map((category) => {
          const count = cards.filter((card) => card.category === category).length;
          return (
            <button
              key={category}
              className={`ref-filter ${filter === category ? "active" : ""}`}
              onClick={() => setFilter(category)}
            >
              {CATEGORY_LABEL[category]} <span className="ref-filter-count">{count}</span>
            </button>
          );
        })}
        <label className="ref-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search references"
          />
        </label>
      </div>

      {visible.length ? (
        <div className="refs-grid">
          {visible.map((card) => {
            return (
              <div
                key={card.id}
                role="button"
                tabIndex={0}
                aria-label={`View reference: ${card.name}`}
                className={`image-tile ref-tile ${card.generating ? "generating" : ""}`}
                onClick={() => {
                  if (!card.generating) updateSelection(card.id);
                }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (card.generating) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    updateSelection(card.id);
                  }
                }}
              >
                <div className="image-tile-thumb ref-tile-thumb" style={transitionStyle(card.id)}>
                  {card.generating ? (
                    <div className="ref-thumb-generating">
                      <span />
                      <span />
                      <span />
                    </div>
                  ) : card.thumbUrl ? (
                    <PortfolioCellImage
                      src={card.thumbUrl}
                      alt={card.name}
                      index={4}
                      loading="lazy"
                    />
                  ) : (
                    <span className="ref-thumb-empty">{card.name.charAt(0)}</span>
                  )}
                  <span className={`ref-tile-badge ${card.category}`} aria-hidden="true">
                    <ReferenceIcon category={card.category} size={13} />
                  </span>
                </div>
                <span className="image-tile-title">{card.name}</span>
                <span className="ref-tile-sub">
                  {card.generating ? "Generating…" : CATEGORY_LABEL[card.category]}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="refs-empty muted">No references match that search.</div>
      )}
    </div>
  );
}
