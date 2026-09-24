"use client";

import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  LayoutGrid,
  List,
  Loader2,
  MoreVertical,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useRouter } from "next/navigation";
import { useProjectDirectory } from "@/app/app-shell";
import { toast } from "sonner";
import {
  ExploreCreateDialog,
  PublishedUseButton,
  type ExploreCreateKind,
} from "@/app/explore/explore-page-client";
import { MediaThumb } from "@/app/media-thumb";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import type { LibraryFolder } from "@/lib/library";
import type { PublishedItemDetail, PublishedItemMedia, PublishedItemSummary } from "@/lib/published-items";
import { userFacingError } from "@/lib/user-facing-error";
import { isLocalAppModeClient } from "@/lib/app-mode";
import styles from "./library-upload.module.css";

const DRAG_MIME = "application/x-library";

type DragPayload = { id: string; type: "folder" | "item" };
type PendingDraft = {
  id: string;
  kind: ExploreCreateKind;
  prompt: string;
  startedAt: number;
  title: string;
};
type RectSnapshot = { height: number; left: number; top: number; width: number };
type FlyingDrop = {
  from: RectSnapshot;
  id: string;
  item: PublishedItemSummary;
  targetFolderId: string | null;
  to: RectSnapshot;
};
type LibrarySelectionKey = `folder:${string}` | `item:${string}`;

const EMPTY_EXAMPLES: Record<ExploreCreateKind, PublishedItemSummary[]> = {
  character: [],
  environment: [],
  prop: [],
  style: [],
};

function normalizeLibraryKind(kind: string) {
  if (kind === "characters") return "character";
  if (kind === "environment" || kind === "environments" || kind === "feature" || kind === "features") {
    return "environment";
  }
  if (kind === "styles") return "style";
  if (kind === "prop" || kind === "props" || kind === "object" || kind === "objects") return "object";
  return kind;
}

function libraryThumbKind(kind: string) {
  const normalized = normalizeLibraryKind(kind);
  if (normalized === "environment") return "environment";
  if (normalized === "character") return "character";
  return "image";
}

function kindLabel(kind: string) {
  const normalized = normalizeLibraryKind(kind);
  if (normalized === "character") return "Character";
  if (normalized === "object") return "Object";
  if (normalized === "environment") return "Environment";
  if (normalized === "style") return "Style";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function createKindForLibraryItem(item: PublishedItemSummary): ExploreCreateKind {
  const normalized = normalizeLibraryKind(item.kind);
  if (normalized === "environment") return "environment";
  if (normalized === "style") return "style";
  if (normalized === "object") return "prop";
  return "character";
}

function folderTintStyle(title: string): React.CSSProperties {
  let hash = 0;
  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 31 + title.charCodeAt(index)) >>> 0;
  }
  const hue = hash % 360;
  return { "--library-folder-color": `hsl(${hue} 46% 48%)` } as React.CSSProperties;
}

function isGeneratedDraftItem(item: PublishedItemSummary) {
  if (item.libraryStatus === "saved") return false;
  return (
    item.libraryStatus === "draft" ||
    item.libraryStatus === "generating" ||
    (item.visibility === "draft" && item.tags.includes("library-draft"))
  );
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return "";
  }
}

async function libraryRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Request failed.") as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return data;
}

const IMAGE_KINDS = ["character", "object", "environment", "style", "image"];

const FILE_VISUALS: { color: string; exts: string[]; icon: typeof FileText }[] = [
  { color: "#e5484d", exts: ["pdf"], icon: FileText },
  { color: "#3b82f6", exts: ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "bmp", "avif"], icon: FileImage },
  { color: "#8b5cff", exts: ["mp4", "mov", "webm", "mkv", "avi", "m4v"], icon: FileVideo },
  { color: "#ec4899", exts: ["mp3", "wav", "aac", "flac", "ogg", "m4a"], icon: FileAudio },
  { color: "#10b981", exts: ["js", "ts", "jsx", "tsx", "py", "rb", "go", "rs", "java", "c", "cpp", "json", "html", "css", "sh"], icon: FileCode },
  { color: "#f59e0b", exts: ["zip", "rar", "7z", "tar", "gz"], icon: FileArchive },
  { color: "#16a34a", exts: ["xls", "xlsx", "csv"], icon: FileSpreadsheet },
  { color: "#2563eb", exts: ["doc", "docx", "txt", "md", "rtf"], icon: FileText },
];

function fileVisual(item: PublishedItemSummary): { Icon: typeof FileText; color: string } {
  const ext = item.title.includes(".") ? (item.title.split(".").pop() ?? "").toLowerCase() : "";
  for (const visual of FILE_VISUALS) {
    if (visual.exts.includes(ext)) return { Icon: visual.icon, color: visual.color };
  }
  const normalized = normalizeLibraryKind(item.kind);
  if (normalized === "video") return { Icon: FileVideo, color: "#8b5cff" };
  if (normalized === "audio") return { Icon: FileAudio, color: "#ec4899" };
  if (["character", "environment", "image", "object", "style"].includes(normalized)) {
    return { Icon: FileImage, color: "#3b82f6" };
  }
  return { Icon: File, color: "#8a90a0" };
}

function ListThumb({ item }: { item: PublishedItemSummary }) {
  const normalized = normalizeLibraryKind(item.kind);
  const showImage = IMAGE_KINDS.includes(normalized) || item.posterMediaKind === "image";
  if (showImage) {
    return (
      <MediaThumb
        className="library-list-thumb"
        gradientIndex={item.id.length}
        kind={libraryThumbKind(item.kind)}
        src={item.posterUrl}
        title={item.title}
      />
    );
  }
  const { Icon, color } = fileVisual(item);
  return (
    <span className="library-list-icon library-list-file-icon">
      <Icon size={22} style={{ color }} />
    </span>
  );
}

type CardAction = { destructive?: boolean; label?: string; onSelect?: () => void; separator?: boolean };

function CardMenu({ actions }: { actions: CardAction[] }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          aria-label="Actions"
          className="library-card-more"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          <MoreVertical size={16} />
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        {actions.map((action, index) =>
          action.separator ? (
            <MenuSeparator key={index} />
          ) : (
            <MenuItem
              key={index}
              onSelect={(event) => {
                event.stopPropagation();
                action.onSelect?.();
              }}
              variant={action.destructive ? "destructive" : "default"}
            >
              {action.label}
            </MenuItem>
          ),
        )}
      </MenuContent>
    </Menu>
  );
}

function FileArt({ item }: { item: PublishedItemSummary }) {
  const normalized = normalizeLibraryKind(item.kind);
  const showImage = IMAGE_KINDS.includes(normalized) || item.posterMediaKind === "image";
  if (showImage) {
    return (
      <MediaThumb
        className="library-card-image"
        gradientIndex={item.id.length}
        kind={libraryThumbKind(item.kind)}
        src={item.posterUrl}
        title={item.title}
      />
    );
  }
  const { Icon, color } = fileVisual(item);
  return (
    <span className="library-card-bigicon" style={{ color }}>
      <Icon size={42} />
    </span>
  );
}

function FileMini({ item }: { item: PublishedItemSummary }) {
  const { Icon, color } = fileVisual(item);
  return <Icon className="library-card-mini" size={15} style={{ color }} />;
}

type ActiveDrag = { item: PublishedItemSummary; type: "item" };

const DragItem = forwardRef<HTMLDivElement, { children: React.ReactNode; className?: string; data: ActiveDrag; id: string } & React.HTMLAttributes<HTMLDivElement>>(
  function DragItem({ children, className = "", data, id, ...rest }, forwardedRef) {
    const { attributes, isDragging, listeners, setNodeRef } = useDraggable({ data, id });
    const setRef = (node: HTMLDivElement | null) => {
      setNodeRef(node);
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    };
    return (
      <div className={`${className}${isDragging ? " is-dragging" : ""}`} ref={setRef} {...attributes} {...listeners} {...rest}>
        {children}
      </div>
    );
  },
);

const DropZone = forwardRef<HTMLDivElement, { children: React.ReactNode; className?: string; data: { folderId: string | null }; id: string } & React.HTMLAttributes<HTMLDivElement>>(
  function DropZone({ children, className = "", data, id, ...rest }, forwardedRef) {
    const { isOver, setNodeRef } = useDroppable({ data, id });
    const setRef = (node: HTMLDivElement | null) => {
      setNodeRef(node);
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    };
    return (
      <div className={`${className}${isOver ? " is-drop" : ""}`} ref={setRef} {...rest}>
        {children}
      </div>
    );
  },
);

function DragOverlayCard({ active }: { active: { item: PublishedItemSummary; width: number | null } }) {
  const { item, width } = active;
  return (
    <div className="library-card library-drag-overlay" style={width ? { width } : undefined}>
      <div className="library-card-art">
        <FileArt item={item} />
      </div>
      <div className="library-card-foot">
        <FileMini item={item} />
        <div className="library-card-text">
          <span className="library-card-title">{item.title}</span>
          <span className="library-card-sub">{kindLabel(item.kind)}</span>
        </div>
      </div>
    </div>
  );
}

function FlyingDropCard({ drop }: { drop: FlyingDrop }) {
  const scale = Math.max(0.18, Math.min(0.34, drop.to.width / Math.max(drop.from.width, 1)));
  return (
    <div
      aria-hidden="true"
      className="library-flying-drop"
      style={
        {
          "--drop-from-x": `${drop.from.left}px`,
          "--drop-from-y": `${drop.from.top}px`,
          "--drop-height": `${drop.from.height}px`,
          "--drop-scale": scale,
          "--drop-to-x": `${drop.to.left}px`,
          "--drop-to-y": `${drop.to.top}px`,
          "--drop-width": `${drop.from.width}px`,
        } as React.CSSProperties
      }
    >
      <DragOverlayCard active={{ item: drop.item, width: drop.from.width }} />
    </div>
  );
}

function isVideoMedia(media: PublishedItemMedia | null | undefined) {
  if (!media) return false;
  return media.kind === "video" || Boolean(media.mimeType?.startsWith("video/"));
}

function isImageMedia(media: PublishedItemMedia | null | undefined) {
  if (!media) return false;
  return media.kind === "image" || Boolean(media.mimeType?.startsWith("image/"));
}

function isAudioMedia(media: PublishedItemMedia | null | undefined) {
  if (!media) return false;
  return media.kind === "audio" || Boolean(media.mimeType?.startsWith("audio/"));
}

function isPdfMedia(media: PublishedItemMedia | null | undefined) {
  if (!media) return false;
  return media.mimeType === "application/pdf" || Boolean(media.url?.toLowerCase().split("?")[0]?.endsWith(".pdf"));
}

function firstImageMediaForRole(detail: PublishedItemDetail | null, roles: string[]) {
  return detail?.media.find((media) => (
    roles.includes(media.role) &&
    media.kind === "image" &&
    Boolean(media.url)
  )) ?? null;
}

function uploadedFileName(item: PublishedItemSummary, detail: PublishedItemDetail | null, media: PublishedItemMedia | null) {
  const originalName = detail?.metadata?.original_filename;
  if (typeof originalName === "string" && originalName.trim()) return originalName.trim();
  if (item.title.trim()) return item.title.trim();
  if (!media?.url) return "File";
  try {
    const pathname = new URL(media.url).pathname;
    const last = pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : "File";
  } catch {
    return "File";
  }
}

function ItemDetailDialog({
  item,
  onEdit,
  onClose,
}: {
  item: PublishedItemSummary;
  onEdit: (item: PublishedItemSummary) => void;
  onClose: () => void;
}) {
  const [detailState, setDetailState] = useState<{
    detail: PublishedItemDetail | null;
    error: string | null;
    itemId: string;
    status: "error" | "loading" | "ready";
  }>({ detail: null, error: null, itemId: item.id, status: "loading" });
  const [mediaMode, setMediaMode] = useState<"display" | "portfolio">("display");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    setDetailState({ detail: null, error: null, itemId: item.id, status: "loading" });
    setMediaMode("display");

    void (async () => {
      try {
        const response = await fetch(`/api/published-items/${encodeURIComponent(item.id)}`, {
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Failed to load item details.");
        if (!controller.signal.aborted) {
          setDetailState({
            detail: data as PublishedItemDetail,
            error: null,
            itemId: item.id,
            status: "ready",
          });
        }
      } catch (caught) {
        if (controller.signal.aborted) return;
        setDetailState({
          detail: null,
          error: caught instanceof Error ? caught.message : "Failed to load item details.",
          itemId: item.id,
          status: "error",
        });
      }
    })();

    return () => controller.abort();
  }, [item.id]);

  const detail = detailState.itemId === item.id ? detailState.detail : null;
  const media = detail?.media?.filter((entry) => entry.url) ?? [];
  const displayMedia = firstImageMediaForRole(detail, ["display", "thumbnail", "preview"]) ??
    (item.posterUrl
      ? {
          durationS: null,
          height: item.posterHeight,
          id: `${item.id}:poster-summary`,
          kind: item.posterMediaKind ?? "image",
          mimeType: null,
          nodeId: null,
          role: "display",
          url: item.posterUrl,
          width: item.posterWidth,
        } satisfies PublishedItemMedia
      : null) ??
    media.find((entry) => entry.kind === "image" && !entry.url?.includes("portfolio")) ??
    media[0] ??
    null;
  const portfolioMedia = firstImageMediaForRole(detail, ["poster", "asset"]) ??
    media.find((entry) => entry.kind === "image" && entry.url?.includes("portfolio")) ??
    null;
  const selectedMedia = mediaMode === "portfolio"
    ? portfolioMedia ?? displayMedia
    : displayMedia ?? portfolioMedia;
  const swapMedia = mediaMode === "portfolio" ? displayMedia : portfolioMedia;
  const showMediaSwap = Boolean(displayMedia?.url && portfolioMedia?.url && displayMedia.url !== portfolioMedia.url);
  const files = detail?.files ?? [];
  const description = detail?.description || item.description;
  const canEdit = normalizeLibraryKind(item.kind) === "character";

  return (
    <div
      aria-modal="true"
      className="explore-reference-dialog library-detail-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
    >
      <div className="explore-reference-dialog-panel library-detail-panel">
        <button
          aria-label={`Close ${item.title}`}
          className="explore-reference-dialog-close"
          onClick={onClose}
          type="button"
        >
          <X size={17} />
        </button>
        <div className="explore-reference-dialog-media">
          <div className="explore-reference-dialog-media-frame">
            {selectedMedia?.url ? (
              isVideoMedia(selectedMedia) ? (
                <video controls playsInline src={selectedMedia.url} />
              ) : isAudioMedia(selectedMedia) ? (
                <div className="library-detail-file-preview">
                  <FileAudio size={54} />
                  <strong>{uploadedFileName(item, detail, selectedMedia)}</strong>
                  <span>{selectedMedia.mimeType ?? "Audio file"}</span>
                  <audio controls src={selectedMedia.url} />
                  <a href={selectedMedia.url} rel="noreferrer" target="_blank">
                    <ExternalLink size={15} />
                    Open file
                  </a>
                </div>
              ) : isPdfMedia(selectedMedia) ? (
                <iframe
                  className="library-detail-pdf-preview"
                  src={selectedMedia.url}
                  title={`${uploadedFileName(item, detail, selectedMedia)} preview`}
                />
              ) : isImageMedia(selectedMedia) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img alt={item.title} src={selectedMedia.url} />
              ) : (
                <div className="library-detail-file-preview">
                  <FileText size={54} />
                  <strong>{uploadedFileName(item, detail, selectedMedia)}</strong>
                  <span>{selectedMedia.mimeType ?? "Document file"}</span>
                  <a href={selectedMedia.url} rel="noreferrer" target="_blank">
                    <ExternalLink size={15} />
                    Open file
                  </a>
                </div>
              )
            ) : (
              <MediaThumb
                className="explore-reference-dialog-fallback"
                gradientIndex={item.id.length}
                kind={libraryThumbKind(item.kind)}
                src={item.posterUrl}
                title={item.title}
              />
            )}
            {showMediaSwap ? (
              <button
                aria-label={mediaMode === "portfolio" ? "Show profile image" : "Show 3 by 3 portfolio"}
                className="library-detail-media-swap"
                onClick={() => setMediaMode((mode) => (mode === "portfolio" ? "display" : "portfolio"))}
                type="button"
              >
                {swapMedia?.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img alt="" src={swapMedia.url} />
                ) : null}
              </button>
            ) : null}
          </div>
        </div>

        <aside className="explore-reference-dialog-copy library-detail-copy">
          <div className="library-detail-scroll">
            <div className="published-detail-kicker">{kindLabel(item.kind)}</div>
            <h2>{item.title}</h2>
            <p className="explore-reference-dialog-description">
              {description || `A short ${kindLabel(item.kind).toLowerCase()} description will appear here soon.`}
            </p>

            {(() => {
              const voicePreview = detailState.detail?.media.find(
                (media) => media.role === "voice_preview" && media.url,
              );
              return voicePreview ? (
                <div className="published-voice-preview">
                  <span>Voice</span>
                  <audio controls preload="none" src={voicePreview.url ?? undefined} />
                </div>
              ) : null;
            })()}

            {detailState.status === "loading" ? (
              <div className="explore-reference-dialog-loading">
                <Loader2 className="spin" size={15} />
                Loading details
              </div>
            ) : null}

            {detailState.status === "error" ? (
              <div className="explore-reference-dialog-error">{detailState.error ?? "Unable to load details."}</div>
            ) : null}

            {files.length ? (
              <section className="explore-reference-dialog-files library-detail-files">
                <h3>Files</h3>
                {files.map((file) => (
                  <details className="library-detail-file" key={file.path}>
                    <summary>{file.path}</summary>
                    <pre>{file.content}</pre>
                  </details>
                ))}
              </section>
            ) : null}
          </div>

          <div className="explore-reference-dialog-actions library-detail-actions">
            {canEdit ? (
              <button className="library-detail-edit-button" onClick={() => onEdit(item)} type="button">
                Edit
              </button>
            ) : null}
            <PublishedUseButton itemId={item.id} label="Use" showIcon={false} />
          </div>
        </aside>
      </div>
    </div>
  );
}

export function LibraryPageClient() {
  const localMode = isLocalAppModeClient();
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [items, setItems] = useState<PublishedItemSummary[]>([]);
  const [placements, setPlacements] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"auth-required" | "error" | "loading" | "ready">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expandedItem, setExpandedItem] = useState<PublishedItemSummary | null>(null);
  const [createKind, setCreateKind] = useState<ExploreCreateKind | null>(null);
  const [editingItem, setEditingItem] = useState<PublishedItemSummary | null>(null);
  const [examples, setExamples] = useState<Record<ExploreCreateKind, PublishedItemSummary[]>>(EMPTY_EXAMPLES);
  const [pendingDrafts, setPendingDrafts] = useState<PendingDraft[]>([]);
  const [pendingDraftNow, setPendingDraftNow] = useState(Date.now());
  const [absorbingFolderId, setAbsorbingFolderId] = useState<string | null>(null);
  const [flyingDrop, setFlyingDrop] = useState<FlyingDrop | null>(null);
  const [isFileDragging, setIsFileDragging] = useState(false);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [activeDrag, setActiveDrag] = useState<{ item: PublishedItemSummary; width: number | null } | null>(null);
  const draggedRecentlyRef = useRef(false);
  const suppressOpenUntilRef = useRef(0);
  const dropAnimationTimerRef = useRef<number | null>(null);
  const folderAbsorbTimerRef = useRef<number | null>(null);
  const folderLayoutRef = useRef<Map<string, RectSnapshot>>(new Map());
  const folderNodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const router = useRouter();
  const directory = useProjectDirectory();
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ completed: 0, total: 0, filename: "" });
  const uploadInFlight = useRef(false);
  const newFolderRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedEntries, setSelectedEntries] = useState<Set<LibrarySelectionKey>>(new Set());
  const [isCompactToolbarVisible, setIsCompactToolbarVisible] = useState(false);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const saved = window.localStorage.getItem("library-view");
    if (saved === "grid" || saved === "list") setViewMode(saved);
  }, []);
  useEffect(() => {
    window.localStorage.setItem("library-view", viewMode);
  }, [viewMode]);
  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const observer = new IntersectionObserver(
      (entries) => setIsCompactToolbarVisible(!entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "-72px 0px 0px 0px", threshold: 0 },
    );
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, []);

  const loadTree = useCallback(async () => {
    try {
      const data = await libraryRequest("/api/library/tree");
      setFolders(Array.isArray(data.folders) ? (data.folders as LibraryFolder[]) : []);
      const cloudItems = Array.isArray(data.items) ? (data.items as PublishedItemSummary[]) : [];
      const localItems = Array.isArray(data.localItems)
        ? (data.localItems as PublishedItemSummary[])
        : [];
      setItems(localMode ? localItems : cloudItems);
      const placementMap: Record<string, string> = {};
      for (const placement of (data.placements ?? []) as Array<{ folderId: string; itemId: string }>) {
        placementMap[placement.itemId] = placement.folderId;
      }
      setPlacements(placementMap);
      setLoadError(null);
      setStatus("ready");
    } catch (caught) {
      const error = caught as Error & { status?: number };
      setLoadError(error.message);
      setStatus(error.status === 401 ? "auth-required" : "error");
    }
  }, [localMode]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  useEffect(() => {
    const syncFolderFromUrl = () => {
      const folderId = new URLSearchParams(window.location.search).get("folder");
      setCurrentFolderId(folderId || null);
    };
    syncFolderFromUrl();
    window.addEventListener("popstate", syncFolderFromUrl);
    return () => window.removeEventListener("popstate", syncFolderFromUrl);
  }, []);

  useEffect(
    () => () => {
      if (dropAnimationTimerRef.current) window.clearTimeout(dropAnimationTimerRef.current);
      if (folderAbsorbTimerRef.current) window.clearTimeout(folderAbsorbTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!pendingDrafts.length) return;
    const interval = window.setInterval(() => setPendingDraftNow(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, [pendingDrafts.length]);

  function navigateToFolder(folderId: string | null, mode: "push" | "replace" = "push") {
    setCurrentFolderId(folderId);
    const url = new URL(window.location.href);
    if (folderId) url.searchParams.set("folder", folderId);
    else url.searchParams.delete("folder");
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    if (mode === "replace") window.history.replaceState(window.history.state, "", nextUrl);
    else window.history.pushState(window.history.state, "", nextUrl);
  }

  function suppressCardOpen(durationMs = 320) {
    suppressOpenUntilRef.current = Date.now() + durationMs;
  }

  function canOpenCard() {
    return !draggedRecentlyRef.current && Date.now() >= suppressOpenUntilRef.current;
  }

  useEffect(() => {
    if (isCreatingFolder) newFolderRef.current?.focus();
  }, [isCreatingFolder]);

  useEffect(() => {
    let canceled = false;
    void (async () => {
      try {
        const response = await fetch("/api/explore/references", { cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || canceled) return;
        const grouped: Record<ExploreCreateKind, PublishedItemSummary[]> = {
          character: [],
          environment: [],
          prop: [],
          style: [],
        };
        for (const item of (data.items ?? []) as PublishedItemSummary[]) {
          const normalized = normalizeLibraryKind(item.kind);
          if (normalized === "character") grouped.character.push(item);
          else if (normalized === "environment") grouped.environment.push(item);
          else if (normalized === "style") grouped.style.push(item);
          else if (normalized === "object") grouped.prop.push(item);
        }
        setExamples(grouped);
      } catch {
        // keep EMPTY_EXAMPLES on failure
      }
    })();
    return () => {
      canceled = true;
    };
  }, []);

  const folderById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);

  const search = query.trim().toLowerCase();
  const childFolders = useMemo(
    () =>
      folders.filter((folder) =>
        search
          ? folder.name.toLowerCase().includes(search)
          : (folder.parentFolderId ?? null) === currentFolderId,
      ),
    [folders, currentFolderId, search],
  );

  useLayoutEffect(() => {
    const previousLayouts = folderLayoutRef.current;
    const nextLayouts = new Map<string, RectSnapshot>();

    for (const folder of childFolders) {
      const node = folderNodeRefs.current.get(folder.id);
      if (!node) continue;
      const next = rectSnapshot(node.getBoundingClientRect());
      if (!next) continue;
      nextLayouts.set(folder.id, next);

      const previous = previousLayouts.get(folder.id);
      if (!previous) {
        node.animate(
          [
            { opacity: 0, transform: "translateY(8px) scale(0.975)" },
            { opacity: 1, transform: "translateY(0) scale(1)" },
          ],
          { duration: 220, easing: "cubic-bezier(0.2, 0.84, 0.26, 1)", fill: "both" },
        );
        continue;
      }

      const deltaX = previous.left - next.left;
      const deltaY = previous.top - next.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;
      node.animate(
        [
          { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
          { transform: "translate3d(0, 0, 0)" },
        ],
        { duration: 280, easing: "cubic-bezier(0.18, 0.82, 0.24, 1)", fill: "both" },
      );
    }

    folderLayoutRef.current = nextLayouts;
  }, [childFolders, viewMode]);

  const itemsHere = useMemo(
    () =>
      items
        .filter((item) => !isGeneratedDraftItem(item))
        .filter((item) =>
          search
            ? [item.title, item.description ?? "", normalizeLibraryKind(item.kind)]
                .join(" ")
                .toLowerCase()
                .includes(search)
            : (placements[item.id] ?? null) === currentFolderId,
        ),
    [items, placements, currentFolderId, search],
  );
  const visibleSelectionKeys = useMemo(
    () => [
      ...childFolders.map((folder) => `folder:${folder.id}` as LibrarySelectionKey),
      ...itemsHere.map((item) => `item:${item.id}` as LibrarySelectionKey),
    ],
    [childFolders, itemsHere],
  );
  const allVisibleSelected =
    visibleSelectionKeys.length > 0 && visibleSelectionKeys.every((key) => selectedEntries.has(key));
  const draftItems = useMemo(
    () =>
      items
        .filter(isGeneratedDraftItem)
        .filter(
          (item) =>
            !search ||
            [item.title, item.description ?? "", normalizeLibraryKind(item.kind)]
              .join(" ")
              .toLowerCase()
              .includes(search),
        ),
    [items, search],
  );

  const breadcrumb = useMemo(() => {
    const chain: LibraryFolder[] = [];
    let cursor = currentFolderId;
    while (cursor) {
      const folder = folderById.get(cursor);
      if (!folder) break;
      chain.unshift(folder);
      cursor = folder.parentFolderId;
    }
    return chain;
  }, [currentFolderId, folderById]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setError(null);
      try {
        await action();
        await loadTree();
      } catch (caught) {
        const message = userFacingError(caught, "Something went wrong.");
        setError(message);
        toast.error(message);
      }
    },
    [loadTree],
  );

  function submitNewFolder() {
    const name = newFolderName.trim();
    setIsCreatingFolder(false);
    setNewFolderName("");
    if (!name) return;
    const optimisticId = `optimistic-folder-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const optimisticFolder: LibraryFolder = {
      createdAt: new Date().toISOString(),
      id: optimisticId,
      name,
      parentFolderId: currentFolderId,
      position: Date.now(),
    };
    setError(null);
    setFolders((current) => [...current, optimisticFolder]);
    void (async () => {
      try {
        const data = await libraryRequest("/api/library/folders", {
          body: JSON.stringify({ name, parentFolderId: currentFolderId }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        const folder = data.folder as LibraryFolder | undefined;
        if (!folder) throw new Error("Folder was created but no folder data was returned.");
        setFolders((current) => current.map((currentFolder) => (currentFolder.id === optimisticId ? folder : currentFolder)));
        toast.success("Folder created.");
      } catch (caught) {
        setFolders((current) => current.filter((folder) => folder.id !== optimisticId));
        const message = userFacingError(caught, "Failed to create folder.");
        setError(message);
        toast.error(message);
      }
    })();
  }

  function submitRename(folderId: string) {
    const name = renameValue.trim();
    setRenamingId(null);
    setRenameValue("");
    if (!name) return;
    void run(() =>
      libraryRequest(`/api/library/folders/${folderId}`, {
        body: JSON.stringify({ name }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
    );
  }

  function submitItemRename(itemId: string) {
    const title = renameValue.trim();
    setRenamingId(null);
    setRenameValue("");
    if (!title) return;
    void run(() =>
      libraryRequest(`/api/library/items/${itemId}`, {
        body: JSON.stringify({ title }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
    );
  }

  function deleteFolder(folderId: string) {
    const previousFolders = folders;
    const previousPlacements = placements;
    const previousSelectedEntries = selectedEntries;
    const deletedFolderIds = new Set<string>([folderId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of folders) {
        if (folder.parentFolderId && deletedFolderIds.has(folder.parentFolderId) && !deletedFolderIds.has(folder.id)) {
          deletedFolderIds.add(folder.id);
          changed = true;
        }
      }
    }

    setError(null);
    setFolders((current) => current.filter((folder) => !deletedFolderIds.has(folder.id)));
    setPlacements((current) => {
      const next = { ...current };
      for (const [itemId, placementFolderId] of Object.entries(next)) {
        if (deletedFolderIds.has(placementFolderId)) delete next[itemId];
      }
      return next;
    });
    setSelectedEntries((current) => {
      const next = new Set(current);
      for (const deletedFolderId of deletedFolderIds) next.delete(`folder:${deletedFolderId}`);
      return next;
    });

    void (async () => {
      try {
        await libraryRequest(`/api/library/folders/${folderId}`, { method: "DELETE" });
        toast.success("Folder deleted.");
      } catch (caught) {
        setFolders(previousFolders);
        setPlacements(previousPlacements);
        setSelectedEntries(previousSelectedEntries);
        const message = userFacingError(caught, "Failed to delete folder.");
        setError(message);
        toast.error(message);
      }
    })();
  }

  function moveItem(itemId: string, folderId: string | null) {
    const previousFolderId = placements[itemId] ?? null;
    setError(null);
    setPlacements((current) => {
      const next = { ...current };
      if (folderId) next[itemId] = folderId;
      else delete next[itemId];
      return next;
    });
    void (async () => {
      try {
        await libraryRequest(`/api/library/items/${itemId}/placement`, {
          body: JSON.stringify({ folderId }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        toast.success(folderId ? "Moved to folder." : "Moved to Library.");
      } catch (caught) {
        setPlacements((current) => {
          const next = { ...current };
          if (previousFolderId) next[itemId] = previousFolderId;
          else delete next[itemId];
          return next;
        });
        const message = userFacingError(caught, "Failed to move item.");
        setError(message);
        toast.error(message);
      }
    })();
  }

  function deleteItem(itemId: string) {
    const previousItems = items;
    const previousPlacements = placements;
    const previousSelectedEntries = selectedEntries;

    setError(null);
    setItems((current) => current.filter((item) => item.id !== itemId));
    setPlacements((current) => {
      const next = { ...current };
      delete next[itemId];
      return next;
    });
    setSelectedEntries((current) => {
      const next = new Set(current);
      next.delete(`item:${itemId}`);
      return next;
    });

    void (async () => {
      try {
        await libraryRequest(`/api/library/items/${itemId}`, { method: "DELETE" });
        toast.success("Item deleted.");
      } catch (caught) {
        setItems(previousItems);
        setPlacements(previousPlacements);
        setSelectedEntries(previousSelectedEntries);
        const message = userFacingError(caught, "Failed to delete item.");
        setError(message);
        toast.error(message);
      }
    })();
  }

  function toggleSelectedEntry(key: LibrarySelectionKey) {
    setSelectedEntries((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    setSelectedEntries((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const key of visibleSelectionKeys) next.delete(key);
      } else {
        for (const key of visibleSelectionKeys) next.add(key);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelectionMode(false);
    setSelectedEntries(new Set());
  }

  const selectedItemIds = Array.from(selectedEntries)
    .filter((key) => key.startsWith("item:"))
    .map((key) => key.slice("item:".length));

  async function startProjectFromSelection() {
    if (!selectedItemIds.length || !directory) return;
    setError(null);
    try {
      const project = await directory.createProject("Untitled video");
      for (const itemId of selectedItemIds) {
        await libraryRequest(`/api/published-items/${encodeURIComponent(itemId)}/use`, {
          body: JSON.stringify({ projectId: project.id }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
      }
      router.push(`/projects/${project.id}`);
    } catch (caught) {
      const message = userFacingError(caught, "Failed to start project.");
      setError(message);
      toast.error(message);
    }
  }

  function deleteSelectedEntries() {
    const targets = Array.from(selectedEntries);
    if (!targets.length) return;
    suppressCardOpen();
    const previousFolders = folders;
    const previousItems = items;
    const previousPlacements = placements;
    const previousSelectedEntries = selectedEntries;
    const deletedFolderIds = new Set(
      targets
        .filter((key) => key.startsWith("folder:"))
        .map((key) => key.slice("folder:".length)),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of folders) {
        if (folder.parentFolderId && deletedFolderIds.has(folder.parentFolderId) && !deletedFolderIds.has(folder.id)) {
          deletedFolderIds.add(folder.id);
          changed = true;
        }
      }
    }
    const deletedItemIds = new Set(
      targets
        .filter((key) => key.startsWith("item:"))
        .map((key) => key.slice("item:".length)),
    );

    setError(null);
    setFolders((current) => current.filter((folder) => !deletedFolderIds.has(folder.id)));
    setItems((current) => current.filter((item) => !deletedItemIds.has(item.id)));
    setPlacements((current) => {
      const next = { ...current };
      for (const itemId of deletedItemIds) delete next[itemId];
      for (const [itemId, placementFolderId] of Object.entries(next)) {
        if (deletedFolderIds.has(placementFolderId)) delete next[itemId];
      }
      return next;
    });
    setSelectedEntries(new Set());
    setSelectionMode(false);

    void (async () => {
      try {
        await Promise.all(
          targets.map((key) => {
            const [kind, id] = key.split(":") as ["folder" | "item", string];
            return libraryRequest(
              kind === "folder" ? `/api/library/folders/${id}` : `/api/library/items/${id}`,
              { method: "DELETE" },
            );
          }),
        );
        toast.success(targets.length === 1 ? "Deleted." : "Items deleted.");
      } catch (caught) {
        setFolders(previousFolders);
        setItems(previousItems);
        setPlacements(previousPlacements);
        setSelectedEntries(previousSelectedEntries);
        setSelectionMode(true);
        const message = userFacingError(caught, "Failed to delete selected items.");
        setError(message);
        toast.error(message);
      }
    })();
  }

  async function saveDraftItem(itemId: string) {
    const data = await run(() =>
      libraryRequest(`/api/library/items/${itemId}`, {
        body: JSON.stringify({ folderId: currentFolderId, libraryStatus: "saved" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
    );
    const savedItem = (data as unknown as { item?: PublishedItemSummary } | null)?.item;
    if (savedItem?.id) {
      setItems((current) => [savedItem, ...current.filter((item) => item.id !== savedItem.id)]);
      setPlacements((current) => {
        const next = { ...current };
        if (currentFolderId) next[savedItem.id] = currentFolderId;
        else delete next[savedItem.id];
        return next;
      });
    } else {
      setItems((current) =>
        current.map((item) => item.id === itemId ? { ...item, libraryStatus: "saved", visibility: "unlisted" } : item),
      );
    }
    await loadTree();
  }

  function moveFolder(folderId: string, parentFolderId: string | null) {
    if (folderId === parentFolderId) return;
    void run(() =>
      libraryRequest(`/api/library/folders/${folderId}`, {
        body: JSON.stringify({ parentFolderId }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
    );
  }

  function rectSnapshot(rect: RectSnapshot | null | undefined): RectSnapshot | null {
    if (!rect) return null;
    return { height: rect.height, left: rect.left, top: rect.top, width: rect.width };
  }

  function folderDropTargetRect(folderId: string | null, fallback: RectSnapshot | null): RectSnapshot | null {
    if (!folderId) return fallback;
    const escapedFolderId = folderId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const target = document.querySelector(
      `[data-library-folder-id="${escapedFolderId}"] .library-card-art, [data-library-folder-id="${escapedFolderId}"] .library-list-folder-icon`,
    );
    if (!(target instanceof HTMLElement)) return fallback;
    return rectSnapshot(target.getBoundingClientRect());
  }

  function playDropAnimation(
    item: PublishedItemSummary,
    from: RectSnapshot | null,
    to: RectSnapshot | null,
    folderId: string | null,
  ) {
    if (!from || !to || !folderId) return;
    if (dropAnimationTimerRef.current) window.clearTimeout(dropAnimationTimerRef.current);
    if (folderAbsorbTimerRef.current) window.clearTimeout(folderAbsorbTimerRef.current);
    const targetSize = Math.min(to.width, to.height) * 0.38;
    setFlyingDrop({
      from,
      id: `${item.id}-${Date.now()}`,
      item,
      targetFolderId: folderId,
      to: {
        height: targetSize,
        left: to.left + to.width / 2 - targetSize / 2,
        top: to.top + to.height / 2 - targetSize / 2,
        width: targetSize,
      },
    });
    setAbsorbingFolderId(folderId);
    dropAnimationTimerRef.current = window.setTimeout(() => setFlyingDrop(null), 540);
    folderAbsorbTimerRef.current = window.setTimeout(() => {
      setAbsorbingFolderId((current) => (current === folderId ? null : current));
    }, 680);
  }

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as ActiveDrag | undefined;
    if (data?.type === "item") {
      const width = event.active.rect.current.initial?.width ?? null;
      setActiveDrag({ item: data.item, width });
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDrag(null);
    draggedRecentlyRef.current = true;
    window.setTimeout(() => {
      draggedRecentlyRef.current = false;
    }, 140);
    const active = event.active.data.current as ActiveDrag | undefined;
    const over = event.over?.data.current as { folderId: string | null } | undefined;
    if (!active || active.type !== "item" || !event.over || !over) return;
    const translated = rectSnapshot(event.active.rect.current.translated);
    const initial = rectSnapshot(event.active.rect.current.initial);
    const from = translated ?? (initial ? { ...initial, left: initial.left + event.delta.x, top: initial.top + event.delta.y } : null);
    playDropAnimation(active.item, from, folderDropTargetRect(over.folderId, rectSnapshot(event.over.rect)), over.folderId);
    moveItem(active.item.id, over.folderId);
  }

  function handleDragCancel() {
    setActiveDrag(null);
  }

  function startNewItem() {
    setEditingItem(null);
    setCreateKind("character");
  }

  function startEditItem(item: PublishedItemSummary) {
    setEditingItem(item);
    setCreateKind(createKindForLibraryItem(item));
    setExpandedItem(null);
  }

  function openLibraryItem(item: PublishedItemSummary) {
    if (isGeneratedDraftItem(item)) {
      startEditItem(item);
      return;
    }
    setExpandedItem(item);
  }

  function triggerUpload() {
    fileInputRef.current?.click();
  }

  const uploadFiles = useCallback(
    async (fileList: File[] | FileList) => {
      const files = Array.from(fileList);
      if (!files.length) return;
      if (uploadInFlight.current) {
        toast.info("Wait for the current upload to finish, then add more files.");
        return;
      }
      uploadInFlight.current = true;
      setIsUploading(true);
      setError(null);
      const notice = toast.loading(files.length === 1 ? "Uploading file…" : `Uploading ${files.length} files…`);
      let uploaded = 0;
      const failures: string[] = [];
      try {
        for (const [index, file] of files.entries()) {
          setUploadProgress({ completed: index, total: files.length, filename: file.name });
          try {
            if (file.size > 100 * 1024 * 1024) throw new Error("File must be 100 MB or smaller.");
            const formData = new FormData();
            formData.append("file", file);
            if (currentFolderId) formData.append("folderId", currentFolderId);
            await libraryRequest("/api/library/upload", { body: formData, method: "POST" });
            uploaded += 1;
          } catch (caught) {
            failures.push(`${file.name}: ${userFacingError(caught, "Upload failed. Try again.")}`);
          }
          setUploadProgress({ completed: index + 1, total: files.length, filename: file.name });
        }
        await loadTree();
        if (failures.length) {
          setError(failures.join(" "));
          toast.error(`${uploaded} uploaded. ${failures.length} ${failures.length === 1 ? "file needs" : "files need"} another try.`, { id: notice });
        } else {
          toast.success(uploaded === 1 ? "File uploaded." : `${uploaded} files uploaded.`, { id: notice });
        }
      } finally {
        uploadInFlight.current = false;
        setIsUploading(false);
      }
    },
    [currentFolderId, loadTree],
  );

  function handleFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = "";
    if (files.length) void uploadFiles(files);
  }

  function isFileDrag(event: React.DragEvent) {
    return Array.from(event.dataTransfer.types ?? []).includes("Files");
  }

  function onCanvasDragOver(event: React.DragEvent) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setIsFileDragging(true);
  }

  function onCanvasDragLeave(event: React.DragEvent) {
    if (event.currentTarget === event.target) setIsFileDragging(false);
  }

  function onCanvasDrop(event: React.DragEvent) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setIsFileDragging(false);
    if (event.dataTransfer.files?.length) void uploadFiles(event.dataTransfer.files);
  }

  const folderActions = (folder: LibraryFolder): CardAction[] => [
    { label: "Open", onSelect: () => navigateToFolder(folder.id) },
    {
      label: "Rename",
      onSelect: () => {
        suppressCardOpen();
        setRenamingId(folder.id);
        setRenameValue(folder.name);
      },
    },
    ...(folder.parentFolderId
      ? [
          {
            label: "Move to Library root",
            onSelect: () => {
              suppressCardOpen();
              moveFolder(folder.id, null);
            },
          },
        ]
      : []),
    { separator: true },
    {
      destructive: true,
      label: "Delete folder",
      onSelect: () => {
        suppressCardOpen();
        deleteFolder(folder.id);
      },
    },
  ];

  const canManageItem = (item: PublishedItemSummary) => !localMode || item.id.startsWith("local:library:");

  const itemActions = (item: PublishedItemSummary): CardAction[] => !canManageItem(item) ? [
    { label: "Open", onSelect: () => openLibraryItem(item) },
  ] : [
    { label: "Open", onSelect: () => openLibraryItem(item) },
    {
      label: "Rename",
      onSelect: () => {
        suppressCardOpen();
        setRenamingId(`item:${item.id}`);
        setRenameValue(item.title);
      },
    },
    ...(currentFolderId
      ? [
          {
            label: "Move to Library root",
            onSelect: () => {
              suppressCardOpen();
              moveItem(item.id, null);
            },
          },
        ]
      : []),
    { separator: true },
    {
      destructive: true,
      label: "Delete",
      onSelect: () => {
        suppressCardOpen();
        deleteItem(item.id);
      },
    },
  ];

  const hasDrafts = Boolean(pendingDrafts.length || draftItems.length);
  const isEmpty = status === "ready" && !childFolders.length && !itemsHere.length && !isCreatingFolder && !hasDrafts;

  return (
    <section className="projects-section projects-browser explore-browser library-browser">
      <input
        aria-label="Upload library files"
        accept="*/*"
        hidden
        multiple
        onChange={handleFiles}
        ref={fileInputRef}
        type="file"
      />
      <header className="projects-header">
        <nav aria-label="Folder path" className="projects-header-title library-title-breadcrumb">
          <button
            className={`library-title-root ${currentFolderId ? "" : "is-current"}`}
            onClick={() => navigateToFolder(null)}
            type="button"
          >
            Library
          </button>
          {breadcrumb.map((folder) => (
            <span className="library-title-crumb-wrap" key={folder.id}>
              <ChevronRight aria-hidden="true" size={15} />
              <button
                className={`library-title-crumb ${folder.id === currentFolderId ? "is-current" : ""}`}
                onClick={() => navigateToFolder(folder.id)}
                type="button"
              >
                {folder.name}
              </button>
            </span>
          ))}
        </nav>
        <div className={`projects-toolbar explore-compact-toolbar ${isCompactToolbarVisible ? "is-visible" : ""}`}>
          <label className="projects-search explore-compact-search">
            <Search size={15} />
            <input
              aria-label="Search your assets"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              tabIndex={isCompactToolbarVisible ? 0 : -1}
              type="search"
              value={query}
            />
          </label>
          <button
            aria-label="Select library items"
            aria-pressed={selectionMode}
            className={`projects-icon-btn${selectionMode ? " is-active" : ""}`}
            onClick={() => {
              setSelectionMode((value) => !value);
              setSelectedEntries(new Set());
            }}
            tabIndex={isCompactToolbarVisible ? 0 : -1}
            type="button"
          >
            <Check size={16} />
          </button>
          <div className="projects-view-toggle library-view-toggle" role="group" aria-label="View mode">
            <button
              aria-label="Grid view"
              aria-pressed={viewMode === "grid"}
              className="projects-view-seg"
              onClick={() => setViewMode("grid")}
              tabIndex={isCompactToolbarVisible ? 0 : -1}
              type="button"
            >
              <LayoutGrid size={16} />
            </button>
            <button
              aria-label="List view"
              aria-pressed={viewMode === "list"}
              className="projects-view-seg"
              onClick={() => setViewMode("list")}
              tabIndex={isCompactToolbarVisible ? 0 : -1}
              type="button"
            >
              <List size={16} />
            </button>
          </div>
        </div>
        {localMode ? (
          <button className="projects-create explore-create-trigger library-create-trigger" disabled={isUploading} onClick={triggerUpload} type="button">
            {isUploading ? <Loader2 size={16} className={styles.spinner} /> : <Upload size={16} />}
            {isUploading ? "Uploading…" : "Upload files"}
          </button>
        ) : <Menu>
          <MenuTrigger asChild>
            <button className="projects-create explore-create-trigger library-create-trigger" type="button">
              <Plus size={15} />
              <span>Create</span>
              <ChevronDown size={16} />
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="explore-create-menu">
            <MenuItem onSelect={() => setIsCreatingFolder(true)}>
              <FolderPlus size={16} />
              <span>New folder</span>
            </MenuItem>
            <MenuItem onSelect={startNewItem}>
              <Sparkles size={16} />
              <span>New item</span>
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={triggerUpload}>
              <Upload size={16} />
              <span>Upload a file</span>
            </MenuItem>
          </MenuContent>
        </Menu>}
      </header>

      <div className="projects-toolbar" ref={toolbarRef}>
        <label className="projects-search">
          <Search size={16} />
          <input
            aria-label="Search your assets"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search your assets"
            type="search"
            value={query}
          />
        </label>
        <div className="projects-filters">
          <button
            aria-label="Select library items"
            aria-pressed={selectionMode}
            className={`projects-icon-btn${selectionMode ? " is-active" : ""}`}
            onClick={() => {
              setSelectionMode((value) => !value);
              setSelectedEntries(new Set());
            }}
            type="button"
          >
            <Check size={16} />
          </button>
          <div className="projects-view-toggle library-view-toggle" role="group" aria-label="View mode">
            <button
              aria-label="Grid view"
              aria-pressed={viewMode === "grid"}
              className="projects-view-seg"
              onClick={() => setViewMode("grid")}
              type="button"
            >
              <LayoutGrid size={16} />
            </button>
            <button
              aria-label="List view"
              aria-pressed={viewMode === "list"}
              className="projects-view-seg"
              onClick={() => setViewMode("list")}
              type="button"
            >
              <List size={16} />
            </button>
          </div>
        </div>
      </div>

      {selectionMode ? (
        <div className="projects-select-bar">
          <span>{selectedEntries.size} selected</span>
          <button
            className="projects-select-action library-start-project"
            disabled={selectedItemIds.length === 0}
            onClick={() => void startProjectFromSelection()}
            type="button"
          >
            <Plus size={15} />
            Start project
          </button>
          <button
            className="projects-select-action"
            disabled={visibleSelectionKeys.length === 0}
            onClick={toggleSelectAllVisible}
            type="button"
          >
            <Check size={15} />
            {allVisibleSelected ? "Clear visible" : "Select all"}
          </button>
          <button
            className="projects-select-action"
            disabled={selectedEntries.size === 0 || selectedItemIds.some(id => localMode && !id.startsWith("local:library:"))}
            title={localMode && selectedItemIds.some(id => !id.startsWith("local:library:")) ? "Manage project assets inside their project." : undefined}
            onClick={deleteSelectedEntries}
            type="button"
          >
            <Trash2 size={15} />
            Delete
          </button>
          <button className="projects-select-action" onClick={clearSelection} type="button">
            <X size={15} />
            Cancel
          </button>
        </div>
      ) : null}

      <div className={styles.uploadHint}>Images, videos, audio, and any other file. Drop them here or {localMode ? "choose Upload files" : "use Create → Upload a file"}. Up to 100 MB per file.{localMode ? " Stored on this device." : ""}</div>
      {isUploading ? (
        <div className={styles.progress} role="status" aria-live="polite">
          <span>Uploading {Math.min(uploadProgress.completed + 1, uploadProgress.total)} of {uploadProgress.total} · {uploadProgress.filename}</span>
          <progress aria-label="File upload progress" max={uploadProgress.total || 1} value={uploadProgress.completed} />
        </div>
      ) : null}
      {error ? <div className={styles.error} role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)} type="button"><X size={15} /></button></div> : null}

      <DndContext
        onDragCancel={handleDragCancel}
        onDragEnd={handleDragEnd}
        onDragStart={handleDragStart}
        sensors={sensors}
      >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            aria-label="Library assets"
            role="region"
            className={`library-canvas ${isFileDragging ? "is-file-dragging" : ""}`}
            onDragLeave={onCanvasDragLeave}
            onDragOver={onCanvasDragOver}
            onDrop={onCanvasDrop}
          >
            {isFileDragging ? (
              <div className="library-drop-overlay">
                <Upload size={26} />
                <span>Drop files to upload</span>
              </div>
            ) : null}

            {hasDrafts ? (
              <section className="library-board-section library-drafts-section">
                <div className="library-board-label">Drafts</div>
                <div className="library-card-grid">
                  {pendingDrafts.map((draft) => (
                    <div className="library-card library-draft-card is-pending" key={draft.id}>
                      <div className="library-card-art library-draft-art">
                        <div className="library-draft-dots" aria-hidden="true" />
                        <div className="library-draft-soft-window" aria-hidden="true" />
                        <div className="library-draft-timer">
                          <span>{Math.max(0, (pendingDraftNow - draft.startedAt) / 1000).toFixed(1)}</span>
                          <small>{draft.title}</small>
                        </div>
                      </div>
                      <div className="library-card-foot">
                        <Sparkles className="library-card-mini" size={15} />
                        <div className="library-card-text">
                          <span className="library-card-title">{draft.title}</span>
                          <span className="library-card-sub">Generating {kindLabel(draft.kind)}</span>
                        </div>
                      </div>
                    </div>
                  ))}

                  {draftItems.map((item) => (
                    <div
                      className="library-card library-draft-card"
                      key={item.id}
                      onClick={() => {
                        if (canOpenCard()) openLibraryItem(item);
                      }}
                    >
                      <div className="library-card-art">
                        <FileArt item={item} />
                      </div>
                      <div className="library-card-foot">
                        <FileMini item={item} />
                        <div className="library-card-text">
                          {renamingId === `item:${item.id}` ? (
                            <input
                              autoFocus
                              className="library-inline-input"
                              onBlur={() => submitItemRename(item.id)}
                              onChange={(event) => setRenameValue(event.target.value)}
                              onClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") submitItemRename(item.id);
                                if (event.key === "Escape") {
                                  setRenamingId(null);
                                  setRenameValue("");
                                }
                              }}
                              value={renameValue}
                            />
                          ) : (
                            <>
                              <span className="library-card-title">{item.title}</span>
                              <span className="library-card-sub">Unsaved {kindLabel(item.kind)}</span>
                            </>
                          )}
                        </div>
                        <button
                          className="library-draft-save"
                          onClick={(event) => {
                            event.stopPropagation();
                            void saveDraftItem(item.id);
                          }}
                          type="button"
                        >
                          Save
                        </button>
                        <CardMenu actions={itemActions(item)} />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {viewMode === "grid" ? (
            <div className="library-board">
              {childFolders.length > 0 || isCreatingFolder ? (
                <section className="library-board-section">
                  <div className="library-board-label">Folders</div>
                  <div className="library-card-grid">
                    {isCreatingFolder ? (
                      <div className="library-card is-editing">
                        <div className="library-card-art library-folder-art">
                          <Folder className="library-folder-glyph" fill="currentColor" size={54} />
                        </div>
                        <div className="library-card-foot">
                          <Folder className="library-folder-mini" fill="currentColor" size={15} />
                          <div className="library-card-text">
                            <input
                              className="library-inline-input"
                              onBlur={submitNewFolder}
                              onChange={(event) => setNewFolderName(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") submitNewFolder();
                                if (event.key === "Escape") {
                                  setIsCreatingFolder(false);
                                  setNewFolderName("");
                                }
                              }}
                              placeholder="Folder name"
                              ref={newFolderRef}
                              value={newFolderName}
                            />
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {childFolders.map((folder) => {
                      const isRenaming = renamingId === folder.id;
                      const selectionKey = `folder:${folder.id}` as LibrarySelectionKey;
                      const isSelected = selectedEntries.has(selectionKey);
                      return (
                        <DropZone
                          className={`library-card${absorbingFolderId === folder.id ? " is-absorbing" : ""}${isSelected ? " is-selected" : ""}`}
                          data={{ folderId: folder.id }}
                          data-library-folder-id={folder.id}
                          id={`drop-${folder.id}`}
                          key={folder.id}
                          onClick={() => {
                            if (selectionMode) {
                              toggleSelectedEntry(selectionKey);
                              return;
                            }
                            if (canOpenCard()) navigateToFolder(folder.id);
                          }}
                          ref={(node) => {
                            if (node) folderNodeRefs.current.set(folder.id, node);
                            else folderNodeRefs.current.delete(folder.id);
                          }}
                          style={folderTintStyle(folder.name)}
                        >
                          <div className="library-card-art library-folder-art">
                            <Folder className="library-folder-glyph" fill="currentColor" size={54} />
                            {selectionMode ? (
                              <span className={`lv-card-check library-selection-check${isSelected ? " is-on" : ""}`} aria-hidden="true">
                                {isSelected ? <Check size={15} strokeWidth={3} /> : null}
                              </span>
                            ) : null}
                          </div>
                          <div className="library-card-foot">
                            <Folder className="library-folder-mini" fill="currentColor" size={15} />
                            <div className="library-card-text">
                              {isRenaming ? (
                                <input
                                  autoFocus
                                  className="library-inline-input"
                                  onBlur={() => submitRename(folder.id)}
                                  onChange={(event) => setRenameValue(event.target.value)}
                                  onClick={(event) => event.stopPropagation()}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") submitRename(folder.id);
                                    if (event.key === "Escape") {
                                      setRenamingId(null);
                                      setRenameValue("");
                                    }
                                  }}
                                  value={renameValue}
                                />
                              ) : (
                                <span className="library-card-title">{folder.name}</span>
                              )}
                              <span className="library-card-sub">Folder</span>
                            </div>
                            {selectionMode ? null : <CardMenu actions={folderActions(folder)} />}
                          </div>
                        </DropZone>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {itemsHere.length > 0 ? (
                <section className="library-board-section">
                  <div className="library-board-label">{localMode ? "On this device" : "Files"}</div>
                  <div className="library-card-grid">
                    {itemsHere.map((item) => {
                      const selectionKey = `item:${item.id}` as LibrarySelectionKey;
                      const isSelected = selectedEntries.has(selectionKey);
                      return (
                        <DragItem
                          className={`library-card${isSelected ? " is-selected" : ""}`}
                          data={{ item, type: "item" }}
                          id={item.id}
                          key={item.id}
                          onClick={() => {
                            if (selectionMode) {
                              toggleSelectedEntry(selectionKey);
                              return;
                            }
                            if (canOpenCard()) openLibraryItem(item);
                          }}
                        >
                          <div className="library-card-art">
                            <FileArt item={item} />
                            {selectionMode ? (
                              <span className={`lv-card-check library-selection-check${isSelected ? " is-on" : ""}`} aria-hidden="true">
                                {isSelected ? <Check size={15} strokeWidth={3} /> : null}
                              </span>
                            ) : null}
                          </div>
                          <div className="library-card-foot">
                        <FileMini item={item} />
                        <div className="library-card-text">
                              {renamingId === `item:${item.id}` ? (
                                <input
                                  autoFocus
                                  className="library-inline-input"
                                  onBlur={() => submitItemRename(item.id)}
                                  onChange={(event) => setRenameValue(event.target.value)}
                                  onClick={(event) => event.stopPropagation()}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") submitItemRename(item.id);
                                    if (event.key === "Escape") {
                                      setRenamingId(null);
                                      setRenameValue("");
                                    }
                                  }}
                                  value={renameValue}
                                />
                              ) : (
                                <>
                                  <span className="library-card-title">{item.title}</span>
                                  <span className="library-card-sub">{kindLabel(item.kind)}</span>
                                </>
                              )}
                            </div>
                            {selectionMode ? null : <CardMenu actions={itemActions(item)} />}
                          </div>
                        </DragItem>
                      );
                    })}
                  </div>
                </section>
              ) : null}
            </div>
            ) : (
              <div className="library-list">
                <div className="library-list-head">
                  <span className="library-col-name">Name</span>
                  <span className="library-col-kind">Kind</span>
                  <span className="library-col-date">Created</span>
                </div>
                {isCreatingFolder ? (
                  <div className="library-list-row is-editing">
                    <span className="library-col-name">
                      <span className="library-list-icon library-list-folder-icon">
                        <Folder fill="currentColor" size={22} />
                      </span>
                      <input
                        className="library-inline-input"
                        onBlur={submitNewFolder}
                        onChange={(event) => setNewFolderName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") submitNewFolder();
                          if (event.key === "Escape") {
                            setIsCreatingFolder(false);
                            setNewFolderName("");
                          }
                        }}
                        placeholder="Folder name"
                        ref={newFolderRef}
                        value={newFolderName}
                      />
                    </span>
                    <span className="library-col-kind">Folder</span>
                    <span className="library-col-date">—</span>
                  </div>
                ) : null}
                {childFolders.map((folder) => {
                  const isRenaming = renamingId === folder.id;
                  const selectionKey = `folder:${folder.id}` as LibrarySelectionKey;
                  const isSelected = selectedEntries.has(selectionKey);
                  return (
                    <ContextMenu key={folder.id}>
                      <ContextMenuTrigger asChild>
                        <DropZone
                          className={`library-list-row${absorbingFolderId === folder.id ? " is-absorbing" : ""}${isSelected ? " is-selected" : ""}`}
                          data={{ folderId: folder.id }}
                          data-library-folder-id={folder.id}
                          id={`drop-row-${folder.id}`}
                          onClick={() => {
                            if (selectionMode) {
                              toggleSelectedEntry(selectionKey);
                              return;
                            }
                            if (canOpenCard()) navigateToFolder(folder.id);
                          }}
                          ref={(node) => {
                            if (node) folderNodeRefs.current.set(folder.id, node);
                            else folderNodeRefs.current.delete(folder.id);
                          }}
                          style={folderTintStyle(folder.name)}
                        >
                          <span className="library-col-name">
                            {selectionMode ? (
                              <span className={`lv-card-check library-selection-check library-list-selection-check${isSelected ? " is-on" : ""}`} aria-hidden="true">
                                {isSelected ? <Check size={15} strokeWidth={3} /> : null}
                              </span>
                            ) : null}
                            <span className="library-list-icon library-list-folder-icon">
                              <Folder fill="currentColor" size={22} />
                            </span>
                            {isRenaming ? (
                              <input
                                autoFocus
                                className="library-inline-input"
                                onBlur={() => submitRename(folder.id)}
                                onChange={(event) => setRenameValue(event.target.value)}
                                onClick={(event) => event.stopPropagation()}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") submitRename(folder.id);
                                  if (event.key === "Escape") {
                                    setRenamingId(null);
                                    setRenameValue("");
                                  }
                                }}
                                value={renameValue}
                              />
                            ) : (
                              <span className="library-list-label">{folder.name}</span>
                            )}
                          </span>
                          <span className="library-col-kind">Folder</span>
                          <span className="library-col-date">{formatDate(folder.createdAt)}</span>
                        </DropZone>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onSelect={() => navigateToFolder(folder.id)}>Open</ContextMenuItem>
                        <ContextMenuItem
                          onSelect={() => {
                            suppressCardOpen();
                            setRenamingId(folder.id);
                            setRenameValue(folder.name);
                          }}
                        >
                          Rename
                        </ContextMenuItem>
                        {folder.parentFolderId ? (
                          <ContextMenuItem
                            onSelect={() => {
                              suppressCardOpen();
                              moveFolder(folder.id, null);
                            }}
                          >
                            Move to Library root
                          </ContextMenuItem>
                        ) : null}
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          variant="destructive"
                          onSelect={() => {
                            suppressCardOpen();
                            deleteFolder(folder.id);
                          }}
                        >
                          Delete folder
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
                {itemsHere.map((item) => {
                  const selectionKey = `item:${item.id}` as LibrarySelectionKey;
                  const isSelected = selectedEntries.has(selectionKey);
                  const isRenaming = renamingId === `item:${item.id}`;
                  return (
                    <ContextMenu key={item.id}>
                      <ContextMenuTrigger asChild>
                        <DragItem
                          className={`library-list-row${isSelected ? " is-selected" : ""}`}
                          data={{ item, type: "item" }}
                          id={item.id}
                          onClick={() => {
                            if (selectionMode) {
                              toggleSelectedEntry(selectionKey);
                              return;
                            }
                            if (canOpenCard()) openLibraryItem(item);
                          }}
                        >
                          <span className="library-col-name">
                            {selectionMode ? (
                              <span className={`lv-card-check library-selection-check library-list-selection-check${isSelected ? " is-on" : ""}`} aria-hidden="true">
                                {isSelected ? <Check size={15} strokeWidth={3} /> : null}
                              </span>
                            ) : null}
                            <ListThumb item={item} />
                            {isRenaming ? (
                              <input
                                autoFocus
                                className="library-inline-input"
                                onBlur={() => submitItemRename(item.id)}
                                onChange={(event) => setRenameValue(event.target.value)}
                                onClick={(event) => event.stopPropagation()}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") submitItemRename(item.id);
                                  if (event.key === "Escape") {
                                    setRenamingId(null);
                                    setRenameValue("");
                                  }
                                }}
                                value={renameValue}
                              />
                            ) : (
                              <span className="library-list-label">{item.title}</span>
                            )}
                          </span>
                          <span className="library-col-kind">{kindLabel(item.kind)}</span>
                          <span className="library-col-date">{formatDate(item.createdAt)}</span>
                        </DragItem>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        {itemActions(item).map((action, index) => action.separator ? <ContextMenuSeparator key={index} /> : <ContextMenuItem key={index} variant={action.destructive ? "destructive" : "default"} onSelect={action.onSelect}>{action.label}</ContextMenuItem>)}
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
              </div>
            )}

            {isEmpty ? (
              <div className="library-empty">
                <Sparkles size={22} />
                <strong>
                  {currentFolderId
                    ? "This folder is empty"
                    : localMode
                      ? "Your library is empty"
                      : "Your library is empty"}
                </strong>
                <span>
                  {localMode
                    ? "Upload your first asset to keep it ready for any project."
                    : <>Use <em>Create</em> (or right-click here) to add a folder or a new asset. Drag items onto
                      folders to organize them.</>}
                </span>
              </div>
            ) : null}
            {status === "loading" ? <div className="library-empty">Loading your library…</div> : null}
            {status === "auth-required" ? (
              <div className="library-empty" role="status">
                <Sparkles size={22} />
                <strong>Sign in to view your private library</strong>
                <span>Your private cloud assets remain protected until you sign in.</span>
              </div>
            ) : null}
            {status === "error" ? (
              <div className="library-empty" role="status">
                <Sparkles size={22} />
                <strong>Library unavailable</strong>
                <span>{loadError ?? "The library could not be loaded. Check your connection and try again."}</span>
              </div>
            ) : null}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {!localMode ? <>
          <ContextMenuItem onSelect={() => setIsCreatingFolder(true)}>
            <FolderPlus size={16} />
            <span>New folder</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={startNewItem}>
            <Sparkles size={16} />
            <span>New item</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          </> : null}
          <ContextMenuItem disabled={isUploading} onSelect={triggerUpload}>
            <Upload size={16} />
            <span>Upload a file</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <DragOverlay dropAnimation={null}>
        {activeDrag ? <DragOverlayCard active={activeDrag} /> : null}
      </DragOverlay>
      {flyingDrop ? <FlyingDropCard drop={flyingDrop} key={flyingDrop.id} /> : null}
      </DndContext>

      {expandedItem ? (
        <ItemDetailDialog
          item={expandedItem}
          key={expandedItem.id}
          onClose={() => setExpandedItem(null)}
          onEdit={startEditItem}
        />
      ) : null}

      {createKind ? (
        <ExploreCreateDialog
          examples={examples}
          initialItem={editingItem}
          initialKind={createKind}
          libraryDraft
          onClose={() => {
            setCreateKind(null);
            setEditingItem(null);
          }}
          onCreateSettled={(localId) => {
            setPendingDrafts((current) => current.filter((draft) => draft.id !== localId));
          }}
          onCreateStart={(draft) => {
            const id = `pending-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            setPendingDrafts((current) => [{ ...draft, id, startedAt: Date.now() }, ...current]);
            return id;
          }}
          onCreated={(item) => {
            setItems((current) => [item, ...current.filter((currentItem) => currentItem.id !== item.id)]);
            void loadTree();
          }}
          onSaveDraft={async (item) => {
            await saveDraftItem(item.id);
          }}
        />
      ) : null}
    </section>
  );
}
