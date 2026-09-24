"use client";

import {
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Check,
  Heart,
  Loader2,
  Map,
  Menu as MenuIcon,
  MousePointerClick,
  Package,
  Palette,
  Plus,
  Search,
  Share2,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type WheelEvent,
} from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import TextareaAutosize from "react-textarea-autosize";
import { toast } from "sonner";
import { useProjectDirectory } from "@/app/app-shell";
import { MediaThumb } from "@/app/media-thumb";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { refreshCredits } from "@/lib/credit-context";
import { stashStartIntent } from "@/lib/onboarding-intent";
import type { PublishedItemDetail, PublishedItemSummary } from "@/lib/published-items";
import { useAuthGate } from "@/lib/use-auth-gate";
import { userFacingError } from "@/lib/user-facing-error";
import { isLocalAppModeClient } from "@/lib/app-mode";

type VideoNavDirection = "next" | "previous";

const KIND_FILTERS = [
  { label: "All", value: "all" },
  { label: "Characters", value: "character" },
  { label: "Environments", value: "environment" },
  { label: "Styles", value: "style" },
  { label: "Videos", value: "video" },
];
export type ExploreCreateKind = "character" | "environment" | "prop" | "style";
const EXPLORE_CREATE_TYPES: Array<{
  description: string;
  label: string;
  value: ExploreCreateKind;
}> = [
  { description: "A reusable person, creature, or character identity.", label: "Character", value: "character" },
  { description: "A recurring place, set, room, or location.", label: "Environment", value: "environment" },
  { description: "A prop, vehicle, weapon, object, or artifact.", label: "Object", value: "prop" },
  { description: "A visual language, palette, rendering, or mood.", label: "Style", value: "style" },
];
const MEDIA_COLUMN_COUNT = 4;
const MEDIA_PRELOAD_MARGIN = "1600px 0px";
const EXPLORE_VIDEO_FETCH_LIMIT = 96;
const EXPLORE_VIDEO_SKELETON_COUNT = 32;
const EXPLORE_REFERENCE_SKELETON_COUNT = 4;
const EXPLORE_VIDEO_SKELETON_RATIOS = [
  9 / 16,
  16 / 9,
  1,
  9 / 16,
  4 / 5,
  16 / 9,
  9 / 16,
  1,
];
type ExploreLoadStatus = "error" | "loading" | "ready";
type ExploreCatalogPayload = {
  availability: "online" | "unavailable";
  error: string | null;
  items: PublishedItemSummary[];
  localItems: PublishedItemSummary[];
};

const EXPLORE_REFERENCE_CACHE_TTL_MS = 5_000;
const EXPLORE_VIDEO_CACHE_TTL_MS = 30_000;
const EXPLORE_REFERENCE_CACHE_BUST_KEY = "explore-reference-cache-bust";

let cachedExploreReferenceItems: PublishedItemSummary[] | null = null;
let cachedExploreVideoItems: PublishedItemSummary[] | null = null;
let cachedLocalReferenceItems: PublishedItemSummary[] = [];
let cachedLocalVideoItems: PublishedItemSummary[] = [];
let cachedReferenceAvailability: ExploreCatalogPayload["availability"] = "online";
let cachedVideoAvailability: ExploreCatalogPayload["availability"] = "online";
let cachedExploreReferenceItemsAt = 0;
let cachedExploreVideoItemsAt = 0;
let cachedExploreReferenceItemsBustToken = "";
let pendingExploreReferenceItems: Promise<ExploreCatalogPayload> | null = null;
let pendingExploreVideoItems: Promise<ExploreCatalogPayload> | null = null;

async function loadExploreCatalog(url: string, fallbackError: string): Promise<ExploreCatalogPayload> {
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || fallbackError);
  return {
    availability: data.availability === "unavailable" ? "unavailable" : "online",
    error: typeof data.error === "string" ? data.error : null,
    items: Array.isArray(data.items) ? data.items as PublishedItemSummary[] : [],
    localItems: Array.isArray(data.localItems) ? data.localItems as PublishedItemSummary[] : [],
  };
}

function exploreReferenceCacheBustToken() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(EXPLORE_REFERENCE_CACHE_BUST_KEY) ?? "";
}

function isFreshCache(cachedAt: number, ttlMs: number) {
  return cachedAt > 0 && Date.now() - cachedAt < ttlMs;
}

function getUsableCachedExploreReferenceItems() {
  if (!cachedExploreReferenceItems) return null;
  if (cachedExploreReferenceItemsBustToken !== exploreReferenceCacheBustToken()) return null;
  return isFreshCache(cachedExploreReferenceItemsAt, EXPLORE_REFERENCE_CACHE_TTL_MS)
    ? cachedExploreReferenceItems
    : null;
}

function getUsableCachedExploreVideoItems() {
  if (!cachedExploreVideoItems) return null;
  return isFreshCache(cachedExploreVideoItemsAt, EXPLORE_VIDEO_CACHE_TTL_MS)
    ? cachedExploreVideoItems
    : null;
}

function getExploreReferenceCatalog({ force = false }: { force?: boolean } = {}) {
  const cached = getUsableCachedExploreReferenceItems();
  if (!force && cached) {
    return Promise.resolve({
      availability: cachedReferenceAvailability,
      error: null,
      items: cached,
      localItems: cachedLocalReferenceItems,
    } satisfies ExploreCatalogPayload);
  }
  if (force) pendingExploreReferenceItems = null;
  pendingExploreReferenceItems ??= loadExploreCatalog(
    "/api/explore/references",
    "Failed to load Explore references.",
  ).then(
    (catalog) => {
      cachedExploreReferenceItems = catalog.items;
      cachedLocalReferenceItems = catalog.localItems;
      cachedReferenceAvailability = catalog.availability;
      cachedExploreReferenceItemsAt = Date.now();
      cachedExploreReferenceItemsBustToken = exploreReferenceCacheBustToken();
      pendingExploreReferenceItems = null;
      return catalog;
    },
    (error) => {
      pendingExploreReferenceItems = null;
      throw error;
    },
  );
  return pendingExploreReferenceItems;
}

export function getExploreReferenceItems(options: { force?: boolean } = {}) {
  return getExploreReferenceCatalog(options).then((catalog) => catalog.items);
}

function getExploreVideoCatalog({ force = false }: { force?: boolean } = {}) {
  const cached = getUsableCachedExploreVideoItems();
  if (!force && cached) {
    return Promise.resolve({
      availability: cachedVideoAvailability,
      error: null,
      items: cached,
      localItems: cachedLocalVideoItems,
    } satisfies ExploreCatalogPayload);
  }
  if (force) pendingExploreVideoItems = null;
  pendingExploreVideoItems ??= loadExploreCatalog(
    `/api/explore/videos?limit=${EXPLORE_VIDEO_FETCH_LIMIT}`,
    "Failed to load Explore videos.",
  ).then(
    (catalog) => {
      cachedExploreVideoItems = catalog.items;
      cachedLocalVideoItems = catalog.localItems;
      cachedVideoAvailability = catalog.availability;
      cachedExploreVideoItemsAt = Date.now();
      pendingExploreVideoItems = null;
      return catalog;
    },
    (error) => {
      pendingExploreVideoItems = null;
      throw error;
    },
  );
  return pendingExploreVideoItems;
}

export function getExploreVideoItems(options: { force?: boolean } = {}) {
  return getExploreVideoCatalog(options).then((catalog) => catalog.items);
}

function createTypeLabel(kind: ExploreCreateKind) {
  return EXPLORE_CREATE_TYPES.find((type) => type.value === kind)?.label ?? "Asset";
}

function CreateTypeIcon({ kind, size = 16 }: { kind: ExploreCreateKind; size?: number }) {
  if (kind === "character") return <UserRound size={size} />;
  if (kind === "environment") return <Map size={size} />;
  if (kind === "prop") return <Package size={size} />;
  return <Palette size={size} />;
}

type ExploreCreateAttachment = {
  file: File;
  id: string;
  label: string;
  src: string;
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read attachment."));
    reader.onload = () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    };
    reader.readAsDataURL(file);
  });
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en", { notation: value > 9999 ? "compact" : "standard" }).format(value);
}

export function normalizeExploreKind(kind: string) {
  if (kind === "characters") return "character";
  if (kind === "environment" || kind === "environments" || kind === "feature" || kind === "features") {
    return "environment";
  }
  if (kind === "prop" || kind === "props" || kind === "object" || kind === "objects") return "prop";
  if (kind === "styles") return "style";
  if (kind === "clip") return "video";
  return kind;
}

export function exploreReferenceThumbKind(kind: string) {
  const normalizedKind = normalizeExploreKind(kind);
  if (normalizedKind === "environment") return "environment";
  if (normalizedKind === "character") return "character";
  return "image";
}

function isExploreReferenceKind(kind: string) {
  const normalizedKind = normalizeExploreKind(kind);
  return (
    normalizedKind === "character" ||
    normalizedKind === "environment" ||
    normalizedKind === "prop" ||
    normalizedKind === "style"
  );
}

function itemMatchesSearch(item: PublishedItemSummary, search: string) {
  if (!search) return true;
  return [
    item.title,
    item.description ?? "",
    normalizeExploreKind(item.kind),
    item.publisher?.displayName ?? "",
    ...item.tags,
  ]
    .join(" ")
    .toLowerCase()
    .includes(search);
}

function ExploreKindFilterDropdown({
  onValueChange,
  tabIndex,
  value,
}: {
  onValueChange: (value: string) => void;
  tabIndex?: number;
  value: string;
}) {
  const label = KIND_FILTERS.find((filter) => filter.value === value)?.label ?? "All";

  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="projects-filter explore-compact-filter" tabIndex={tabIndex} type="button">
          <span>{label}</span>
          <ChevronDown size={18} />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="projects-filter-menu">
        <MenuRadioGroup onValueChange={onValueChange} value={value}>
          {KIND_FILTERS.map((filter) => (
            <MenuRadioItem key={filter.value} value={filter.value}>
              {filter.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

function ExploreCreateMenu({
  disabled,
  onSelect,
}: {
  disabled?: boolean;
  onSelect: (kind: ExploreCreateKind) => void;
}) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="projects-create explore-create-trigger" disabled={disabled} type="button">
          <Plus size={15} />
          <span>Create</span>
          <ChevronDown size={16} />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="explore-create-menu">
        {EXPLORE_CREATE_TYPES.map((type) => (
          <MenuItem key={type.value} onSelect={() => onSelect(type.value)}>
            <CreateTypeIcon kind={type.value} />
            <span>{type.label}</span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function ExploreCompactToolbar({
  activeKind,
  isVisible,
  query,
  setActiveKind,
  setQuery,
}: {
  activeKind: string;
  isVisible: boolean;
  query: string;
  setActiveKind: (value: string) => void;
  setQuery: (value: string) => void;
}) {
  return (
    <div
      aria-hidden={!isVisible}
      className={`projects-toolbar explore-compact-toolbar ${isVisible ? "is-visible" : ""}`}
    >
      <label className="projects-search explore-compact-search">
        <Search size={15} />
        <input
          aria-label="Search published items"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          tabIndex={isVisible ? 0 : -1}
          type="search"
          value={query}
        />
      </label>
      <div className="projects-filters">
        <ExploreKindFilterDropdown
          onValueChange={setActiveKind}
          tabIndex={isVisible ? 0 : -1}
          value={activeKind}
        />
      </div>
    </div>
  );
}

export function PublishedLikeButton({
  initialIsLiked,
  initialLikeCount,
  itemId,
}: {
  initialIsLiked: boolean;
  initialLikeCount: number;
  itemId: string;
}) {
  const [isLiked, setIsLiked] = useState(initialIsLiked);
  const [likeCount, setLikeCount] = useState(initialLikeCount);
  const [pending, setPending] = useState(false);

  async function toggleLike() {
    if (pending) return;
    setPending(true);
    try {
      const response = await fetch(`/api/published-items/${itemId}/like`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Like failed.");
      setIsLiked(Boolean(data.isLiked));
      setLikeCount(Number(data.likeCount ?? likeCount));
    } catch (caught) {
      toast.error(userFacingError(caught, "Like failed."));
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="published-like-wrap">
      <button
        aria-pressed={isLiked}
        className={`published-like-button ${isLiked ? "is-liked" : ""}`}
        disabled={pending}
        onClick={toggleLike}
        type="button"
      >
        <Heart size={15} fill={isLiked ? "currentColor" : "none"} />
        <span>{formatCount(likeCount)}</span>
      </button>
    </span>
  );
}

export function PublishedUseButton({
  itemId,
  label = "Use in project",
  showIcon = true,
}: {
  itemId: string;
  label?: string;
  showIcon?: boolean;
}) {
  const directory = useProjectDirectory();
  const { isLoaded: authLoaded, isSignedIn, requireAuth } = useAuthGate();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const projects = directory?.projects ?? [];

  async function importIntoProject(projectId: string) {
    setPending(true);
    try {
      const response = await fetch(`/api/published-items/${itemId}/use`, {
        body: JSON.stringify({ projectId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Import failed.");
      toast.success("Added to project.");
      router.push(`/projects/${projectId}`);
    } catch (caught) {
      toast.error(userFacingError(caught, "Import failed."));
    } finally {
      setPending(false);
    }
  }

  async function createProjectAndImport() {
    if (!directory || pending) return;
    setPending(true);
    try {
      const project = await directory.createProject("Untitled video");
      const response = await fetch(`/api/published-items/${itemId}/use`, {
        body: JSON.stringify({ projectId: project.id }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Import failed.");
      toast.success("Added to new project.");
      router.push(`/projects/${project.id}`);
    } catch (caught) {
      toast.error(userFacingError(caught, "Import failed."));
    } finally {
      setPending(false);
    }
  }

  // Signed-out: the button is a straight sign-up prompt, no project menu.
  if (authLoaded && !isSignedIn) {
    return (
      <div className="published-use-wrap">
        <button className="published-use-button" type="button" onClick={() => requireAuth()}>
          {showIcon ? <ArrowRight size={15} /> : null}
          {label}
        </button>
      </div>
    );
  }

  return (
    <div className="published-use-wrap">
      <Menu>
        <MenuTrigger asChild>
          <button className="published-use-button" disabled={!directory || pending} type="button">
            {pending ? <Loader2 className="spin" size={15} /> : showIcon ? <ArrowRight size={15} /> : null}
            {label}
          </button>
        </MenuTrigger>
        <MenuContent align="start" className="published-use-menu" sideOffset={8}>
          <MenuLabel>Choose project</MenuLabel>
          {projects.length ? (
            projects.slice(0, 8).map((project) => (
              <MenuItem
                key={project.id}
                onSelect={(event) => {
                  event.preventDefault();
                  void importIntoProject(project.id);
                }}
              >
                {project.name}
              </MenuItem>
            ))
          ) : (
            <MenuItem disabled>No projects yet</MenuItem>
          )}
          <MenuSeparator />
          <MenuItem
            onSelect={(event) => {
              event.preventDefault();
              void createProjectAndImport();
            }}
          >
            Create project and use
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

type ExploreCartValue = {
  has: (id: string) => boolean;
  toggle: (item: PublishedItemSummary) => void;
};

export const ExploreCartContext = createContext<ExploreCartValue | null>(null);
export const useExploreCart = () => useContext(ExploreCartContext);

/** Corner cart toggle overlaid on a media tile (kept OUTSIDE the tile's
 * <button> so we never nest interactive elements). Renders only where a cart
 * context is present. */
function ExploreMediaCartButton({ item }: { item: PublishedItemSummary }) {
  const cart = useExploreCart();
  if (!cart) return null;
  const inCart = cart.has(item.id);
  return (
    <button
      type="button"
      className={`explore-cart-add ${inCart ? "is-added" : ""}`}
      aria-label={inCart ? "Remove from project cart" : "Add to project cart"}
      onClick={(event) => {
        event.stopPropagation();
        cart.toggle(item);
      }}
    >
      {inCart ? <Check size={15} /> : <Plus size={15} />}
    </button>
  );
}

function PublishedReferenceTile({
  item,
  onOpen,
}: {
  item: PublishedItemSummary;
  onOpen: (item: PublishedItemSummary) => void;
}) {
  const cart = useExploreCart();
  const inCart = cart?.has(item.id) ?? false;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`View ${item.title}`}
      className="image-tile explore-reference-tile"
      onClick={() => onOpen(item)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(item);
        }
      }}
    >
      {cart ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={`explore-cart-add ${inCart ? "is-added" : ""}`}
              aria-label={inCart ? "Remove from project cart" : "Add to project cart"}
              onClick={(event) => {
                event.stopPropagation();
                cart.toggle(item);
              }}
            >
              {inCart ? <Check size={15} /> : <Plus size={15} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={6}>
            {inCart ? "Remove from cart" : "Add to project cart"}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <MediaThumb
        className="image-tile-thumb"
        gradientIndex={item.id.length}
        kind={exploreReferenceThumbKind(item.kind)}
        src={item.posterUrl}
        title={item.title}
      />
      <span className="image-tile-title">{item.title}</span>
      <span className="explore-reference-stats" aria-label={`${formatCount(item.likeCount)} likes, ${formatCount(item.useCount)} uses`}>
        <span>
          <Heart size={13} />
          {formatCount(item.likeCount)}
        </span>
        <span>
          <MousePointerClick size={13} />
          {formatCount(item.useCount)}
        </span>
      </span>
    </div>
  );
}

function ExploreSectionHeader({
  onSeeAll,
  title,
}: {
  onSeeAll?: () => void;
  title: string;
}) {
  return (
    <div className="section-title-row">
      <h2>{title}</h2>
      {onSeeAll ? (
        <button className="section-link explore-section-link" onClick={onSeeAll} type="button">
          See all
          <ArrowRight size={14} />
        </button>
      ) : null}
    </div>
  );
}

function ExploreReferenceSection({
  isLoading,
  items,
  onOpen,
  onSeeAll,
  title,
}: {
  isLoading: boolean;
  items: PublishedItemSummary[];
  onOpen: (item: PublishedItemSummary) => void;
  onSeeAll?: () => void;
  title: string;
}) {
  if (!items.length && !isLoading) return null;

  return (
    <section className="home-image-section explore-reference-section">
      <ExploreSectionHeader onSeeAll={onSeeAll} title={title} />
      <div className="image-tile-grid explore-reference-grid">
        {items.length ? (
          items.map((item) => (
            <PublishedReferenceTile item={item} key={item.id} onOpen={onOpen} />
          ))
        ) : (
          <ExploreReferenceSkeletonTiles />
        )}
      </div>
    </section>
  );
}

function sortTrendingItems(items: PublishedItemSummary[]) {
  return [...items].sort((left, right) => (
    (right.likeCount + right.useCount + right.viewCount) - (left.likeCount + left.useCount + left.viewCount)
  ));
}

function sortNewItems(items: PublishedItemSummary[]) {
  return [...items].sort((left, right) => (
    new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  ));
}

function ExploreReferenceCategorySections({
  isLoading,
  items,
  onOpen,
}: {
  isLoading: boolean;
  items: PublishedItemSummary[];
  onOpen: (item: PublishedItemSummary) => void;
}) {
  if (!items.length && !isLoading) return null;

  return (
    <>
      <ExploreReferenceSection
        isLoading={isLoading}
        items={sortTrendingItems(items)}
        onOpen={onOpen}
        title="Trending"
      />
      <ExploreReferenceSection
        isLoading={isLoading}
        items={sortNewItems(items)}
        onOpen={onOpen}
        title="New"
      />
      <ExploreReferenceSection isLoading={isLoading} items={items} onOpen={onOpen} title="All" />
    </>
  );
}

function ExploreVideoSection({
  items,
  isLoading,
  onOpen,
  onSeeAll,
  showHeader,
  suspendAutoplay,
  title = "Trending videos",
}: {
  items: PublishedItemSummary[];
  isLoading: boolean;
  onOpen: (item: PublishedItemSummary) => void;
  onSeeAll?: () => void;
  showHeader: boolean;
  suspendAutoplay: boolean;
  title?: string;
}) {
  if (!items.length && !isLoading) return null;

  return (
    <section className="home-image-section explore-video-section">
      {showHeader ? <ExploreSectionHeader onSeeAll={onSeeAll} title={title} /> : null}
      <div className="explore-media-shell">
        {items.length ? (
          <MediaColumnGrid
            items={items}
            onOpen={onOpen}
            suspendAutoplay={suspendAutoplay}
          />
        ) : (
          <ExploreVideoSkeletonGrid />
        )}
      </div>
    </section>
  );
}

function PublishedMediaTile({
  item,
  onOpen,
  suspendAutoplay,
  style,
}: {
  item: PublishedItemSummary;
  onOpen: (item: PublishedItemSummary) => void;
  suspendAutoplay: boolean;
  style?: CSSProperties;
}) {
  const [intrinsicSize, setIntrinsicSize] = useState<{ height: number; width: number } | null>(null);
  const [isInViewport, setIsInViewport] = useState(false);
  const [isNearViewport, setIsNearViewport] = useState(false);
  const [hasEnteredPreloadWindow, setHasEnteredPreloadWindow] = useState(false);
  const [readyPreviewUrl, setReadyPreviewUrl] = useState<string | null>(null);
  const tileRef = useRef<HTMLButtonElement | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const isPreviewReady = Boolean(item.previewVideoUrl && readyPreviewUrl === item.previewVideoUrl);
  const tileStyle = intrinsicSize
    ? {
        ...style,
        aspectRatio: `${intrinsicSize.width} / ${intrinsicSize.height}`,
      }
    : style;
  useEffect(() => {
    const element = tileRef.current;
    if (!element || !item.previewVideoUrl) return;
    const observer = new IntersectionObserver(
      (entries) => setIsInViewport(entries.some((entry) => entry.isIntersecting)),
      { threshold: 0.42 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [item.previewVideoUrl]);

  useEffect(() => {
    const element = tileRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const isNear = entries.some((entry) => entry.isIntersecting);
        setIsNearViewport(isNear);
        if (isNear) setHasEnteredPreloadWindow(true);
      },
      { rootMargin: MEDIA_PRELOAD_MARGIN, threshold: 0 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = previewRef.current;
    if (!video) return;
    video.muted = true;
    video.defaultMuted = true;
    if (isInViewport && !suspendAutoplay) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, [isInViewport, isNearViewport, item.previewVideoUrl, suspendAutoplay]);

  return (
    <button
      aria-label={item.title}
      className={`explore-media-tile is-${item.posterOrientation}${isInViewport && !suspendAutoplay ? " is-playing" : ""}${isNearViewport ? " is-near-viewport" : ""}${isPreviewReady ? " is-preview-ready" : ""}${intrinsicSize ? " is-loaded" : ""}`}
      onClick={() => onOpen(item)}
      ref={tileRef}
      style={tileStyle}
      type="button"
    >
      {hasEnteredPreloadWindow ? (
        <MediaThumb
          className="explore-media-thumb"
          gradientIndex={item.id.length}
          kind={item.posterMediaKind === "video" ? "video" : "image"}
          loading="eager"
          onImageSize={setIntrinsicSize}
          src={item.posterUrl}
          title={item.title}
        />
      ) : null}
      {isNearViewport && item.previewVideoUrl ? (
        <video
          ref={previewRef}
          className="explore-media-preview"
          loop
          muted
          onCanPlay={() => setReadyPreviewUrl(item.previewVideoUrl)}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              setIntrinsicSize({
                height: video.videoHeight,
                width: video.videoWidth,
              });
            }
          }}
          playsInline
          preload="none"
          src={item.previewVideoUrl}
        />
      ) : null}
    </button>
  );
}

export function ExploreVideoLightbox({
  direction,
  hasNext,
  hasPrevious,
  isExiting,
  item,
  nextItem,
  onClose,
  onNext,
  onPrevious,
  previousItem,
}: {
  direction: VideoNavDirection;
  hasNext: boolean;
  hasPrevious: boolean;
  isExiting: boolean;
  item: PublishedItemSummary;
  nextItem: PublishedItemSummary | null;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
  previousItem: PublishedItemSummary | null;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wheelLockRef = useRef(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowDown" && hasNext) onNext();
      if (event.key === "ArrowUp" && hasPrevious) onPrevious();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasNext, hasPrevious, onClose, onNext, onPrevious]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    video.defaultMuted = false;
    video.volume = 1;
    void video.play().catch(() => {
      video.muted = true;
      video.defaultMuted = true;
      void video.play().catch(() => undefined);
    });
  }, [item.id]);

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (Math.abs(event.deltaY) < 18 || wheelLockRef.current) return;
    if ((event.deltaY > 0 && !hasNext) || (event.deltaY < 0 && !hasPrevious)) return;
    event.preventDefault();
    wheelLockRef.current = true;
    if (event.deltaY > 0) {
      onNext();
    } else {
      onPrevious();
    }
    window.setTimeout(() => {
      wheelLockRef.current = false;
    }, 520);
  }

  return (
    <div
      aria-modal="true"
      className="explore-video-expanded"
      onMouseDown={(event) => {
        const target = event.target;
        if (
          !(target instanceof Element) ||
          !target.closest(".explore-video-expanded-media, .explore-video-expanded-copy, .explore-video-expanded-nav")
        ) {
          onClose();
        }
      }}
      role="dialog"
    >
      <button
        aria-label="Previous video"
        className="explore-video-expanded-nav is-previous"
        disabled={!hasPrevious || isExiting}
        onClick={onPrevious}
        type="button"
      >
        <ChevronUp size={20} />
      </button>
      <button
        aria-label="Next video"
        className="explore-video-expanded-nav is-next"
        disabled={!hasNext || isExiting}
        onClick={onNext}
        type="button"
      >
        <ChevronDown size={20} />
      </button>
      <VideoPrefetch src={previousItem?.previewVideoUrl ?? null} />
      <VideoPrefetch src={nextItem?.previewVideoUrl ?? null} />
      <div className="explore-video-expanded-panel">
        <div className="explore-video-expanded-stage">
          <div
            className={`explore-video-expanded-media is-${item.posterOrientation} is-${direction}${isExiting ? " is-exiting" : ""}`}
            key={item.id}
            onWheel={handleWheel}
            style={modalMediaStyle(item)}
          >
            {item.previewVideoUrl ? (
              <video
                ref={videoRef}
                autoPlay
                controls
                loop
                playsInline
                src={item.previewVideoUrl}
              />
            ) : (
              <MediaThumb
                className="explore-video-expanded-fallback"
                gradientIndex={item.id.length}
                kind="video"
                src={item.posterUrl}
                title={item.title}
              />
            )}
          </div>
        </div>
        <aside className="explore-video-expanded-copy">
          <button aria-label="Close video" className="explore-video-expanded-close" onClick={onClose} type="button">
            <X size={17} />
          </button>
          <ExploreVideoPrompt
            itemId={item.id}
            key={item.id}
            text={item.description || "No prompt is attached to this video."}
          />
          <div className="published-detail-publisher">
            <span>{item.publisher?.displayName ?? "AI video library"}</span>
          </div>
          <ExploreVideoActions item={item} key={item.id} />
        </aside>
      </div>
    </div>
  );
}

function ExploreVideoPrompt({ itemId, text }: { itemId: string; text: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const promptRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const element = promptRef.current;
    if (!element) return;
    let frame = 0;

    const checkOverflow = () => {
      setCanExpand((current) => current || element.scrollHeight > element.clientHeight + 1);
    };
    const scheduleCheck = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(checkOverflow);
    };
    const resizeObserver = new ResizeObserver(scheduleCheck);

    scheduleCheck();
    resizeObserver.observe(element);
    window.addEventListener("resize", scheduleCheck);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleCheck);
    };
  }, [text]);

  function togglePrompt() {
    if (isExpanded) {
      promptRef.current?.scrollTo({ top: 0 });
    }
    setIsExpanded((expanded) => !expanded);
  }

  return (
    <>
      <div className="explore-video-prompt-header">
        <div className="published-detail-kicker">Video prompt</div>
      </div>
      <div
        className={`explore-video-prompt-box ${isExpanded ? "is-expanded" : ""}`}
      >
        <span
          className="explore-video-prompt-text"
          id={`prompt-${itemId}`}
          ref={promptRef}
        >
          {text}
        </span>
        {canExpand ? (
          <button
            aria-controls={`prompt-${itemId}`}
            aria-expanded={isExpanded}
            className="explore-video-prompt-toggle"
            onClick={togglePrompt}
            type="button"
          >
            {isExpanded ? "Show less" : "Show more"}
            <ChevronDown size={14} />
          </button>
        ) : null}
      </div>
    </>
  );
}

function ExploreVideoActions({ item }: { item: PublishedItemSummary }) {
  const [isLiked, setIsLiked] = useState(item.isLiked);
  const [likeCount, setLikeCount] = useState(item.likeCount);
  const [shareState, setShareState] = useState<"idle" | "copied">("idle");
  const [useStateLabel, setUseStateLabel] = useState<"idle" | "copied">("idle");
  const isAiVideo = item.id.startsWith("ai-video-");

  async function toggleLike() {
    if (isAiVideo) {
      setIsLiked((liked) => {
        setLikeCount((count) => Math.max(0, count + (liked ? -1 : 1)));
        return !liked;
      });
      return;
    }

    const response = await fetch(`/api/published-items/${item.id}/like`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return;
    setIsLiked(Boolean(data.isLiked));
    setLikeCount(Number(data.likeCount ?? likeCount));
  }

  async function copyUsePrompt() {
    const text = item.description || item.title;
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    setUseStateLabel("copied");
    window.setTimeout(() => setUseStateLabel("idle"), 1400);
  }

  async function shareVideo() {
    const url = `${window.location.origin}/explore/${item.id}`;
    const shareData = {
      text: item.description ?? undefined,
      title: item.title,
      url,
    };
    if (navigator.share) {
      await navigator.share(shareData).catch(() => undefined);
    } else {
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      setShareState("copied");
      window.setTimeout(() => setShareState("idle"), 1400);
    }
  }

  return (
    <div className="explore-video-actions">
      <button className="explore-video-use-action" onClick={() => void copyUsePrompt()} type="button">
        {useStateLabel === "copied" ? "Copied" : "Use"}
      </button>
      <button
        aria-pressed={isLiked}
        className={`explore-video-icon-action ${isLiked ? "is-liked" : ""}`}
        onClick={() => void toggleLike()}
        type="button"
      >
        <Heart size={17} fill={isLiked ? "currentColor" : "none"} />
        <span>{formatCount(likeCount)}</span>
      </button>
      <button className="explore-video-icon-action" onClick={() => void shareVideo()} type="button">
        <Share2 size={17} />
        <span>{shareState === "copied" ? "Copied" : "Share"}</span>
      </button>
    </div>
  );
}

function isTemporaryReference(item: PublishedItemSummary) {
  return item.id.startsWith("temp-");
}

function referenceKindLabel(kind: string) {
  const normalizedKind = normalizeExploreKind(kind);
  if (normalizedKind === "character") return "Character";
  if (normalizedKind === "environment") return "Environment";
  if (normalizedKind === "prop") return "Object";
  if (normalizedKind === "style") return "Style";
  if (normalizedKind === "video") return "Video";
  return normalizedKind;
}

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sourceEntryVideoId(sourceEntryId: string) {
  return sourceEntryId.startsWith("ai-video-") ? sourceEntryId : `ai-video-${sourceEntryId}`;
}

export function featuredVideosForReference(
  reference: PublishedItemSummary,
  mediaItems: PublishedItemSummary[],
) {
  if (reference.sourceEntryId) {
    const videoId = sourceEntryVideoId(reference.sourceEntryId);
    const exactSource = mediaItems.find((video) => (
      video.id === videoId ||
      video.sourceEntryId === reference.sourceEntryId ||
      sourceEntryVideoId(video.sourceEntryId ?? "") === videoId
    ));
    return exactSource ? [exactSource] : [];
  }

  const title = normalizeSearchText(reference.title);
  const terms = new Set(
    [
      title.includes(" ") && title.length >= 8 ? title : "",
      ...reference.tags.map(normalizeSearchText).filter((term) => term.includes(" ") && term.length >= 8),
    ].filter(Boolean),
  );

  if (!terms.size) return [];

  return mediaItems.filter((video) => {
    const haystack = normalizeSearchText([
      video.title,
      video.description ?? "",
      ...video.tags,
    ].join(" "));
    return [...terms].some((term) => haystack.includes(term));
  }).slice(0, 6);
}

function isVideoMedia(media: PublishedItemDetail["media"][number]) {
  return media.kind === "video" || media.mimeType?.startsWith("video/");
}

type ReferenceDetailState = {
  detail: PublishedItemDetail | null;
  error: string | null;
  itemId: string;
  status: "error" | "idle" | "loading" | "ready";
};

export function ExploreReferenceDialog({
  featuredVideos,
  item,
  onClose,
  onOpenVideo,
}: {
  featuredVideos: PublishedItemSummary[];
  item: PublishedItemSummary;
  onClose: () => void;
  onOpenVideo: (item: PublishedItemSummary) => void;
}) {
  const isTemporary = isTemporaryReference(item);
  const isLocalItem = item.id.startsWith("local:");
  const [mediaMode, setMediaMode] = useState<"display" | "portfolio">("display");
  const [detailState, setDetailState] = useState<ReferenceDetailState>(() => ({
    detail: null,
    error: null,
    itemId: item.id,
    status: isTemporary ? "idle" : "loading",
  }));
  const currentDetail = detailState.itemId === item.id ? detailState.detail : null;
  const status = isTemporary
    ? "idle"
    : detailState.itemId === item.id
      ? detailState.status
      : "loading";
  const error = detailState.itemId === item.id ? detailState.error : null;
  const detailMedia = (currentDetail?.media ?? []).filter((mediaItem) => mediaItem.url);
  const posterSummary = item.posterUrl
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
      }
    : null;
  // First image is the profile (display) hero; the 3x3 contact sheet is the
  // alternate, shown in the top-right swap square (same pattern as Library).
  const displayMedia =
    detailMedia.find((m) => ["display", "thumbnail", "preview"].includes(m.role) && m.kind === "image") ??
    posterSummary ??
    detailMedia.find((m) => m.kind === "image" && !m.url?.includes("portfolio")) ??
    detailMedia[0] ??
    null;
  const portfolioMedia =
    detailMedia.find((m) => ["poster", "asset"].includes(m.role) && m.kind === "image") ??
    detailMedia.find((m) => m.kind === "image" && m.url?.includes("portfolio")) ??
    null;
  const selectedMedia = mediaMode === "portfolio" ? portfolioMedia ?? displayMedia : displayMedia ?? portfolioMedia;
  const swapMedia = mediaMode === "portfolio" ? displayMedia : portfolioMedia;
  const showMediaSwap = Boolean(displayMedia?.url && portfolioMedia?.url && displayMedia.url !== portfolioMedia.url);
  const description = currentDetail?.description ?? item.description;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (isTemporary) return;
    const controller = new AbortController();

    void (async () => {
      setDetailState({
        detail: null,
        error: null,
        itemId: item.id,
        status: "loading",
      });
      try {
        const response = await fetch(`/api/published-items/${encodeURIComponent(item.id)}`, {
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || "Failed to load item details.");
        }
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
  }, [isTemporary, item.id]);

  return (
    <div
      aria-modal="true"
      className="explore-reference-dialog"
      onMouseDown={(event) => {
        const target = event.target;
        if (!(target instanceof Element) || !target.closest(".explore-reference-dialog-panel")) {
          onClose();
        }
      }}
      role="dialog"
    >
      <div className="explore-reference-dialog-panel">
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
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img alt={item.title} src={selectedMedia.url} />
              )
            ) : (
              <MediaThumb
                className="explore-reference-dialog-fallback"
                gradientIndex={item.id.length}
                kind={exploreReferenceThumbKind(item.kind)}
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

        <aside className="explore-reference-dialog-copy">
          <div className="published-detail-kicker">{referenceKindLabel(item.kind)}</div>
          <h2>{item.title}</h2>
          {isLocalItem ? (
            <div className="explore-reference-dialog-stats">On this device</div>
          ) : (
            <div className="explore-reference-dialog-stats" aria-label={`${formatCount(item.likeCount)} likes, ${formatCount(item.useCount)} uses`}>
              <span>
                <Heart size={14} />
                {formatCount(item.likeCount)}
              </span>
              <span>
                <MousePointerClick size={14} />
                {formatCount(item.useCount)}
              </span>
            </div>
          )}

          {!isTemporary && !isLocalItem ? (
            <div className="explore-reference-dialog-actions">
              <PublishedUseButton itemId={item.id} />
              <PublishedLikeButton
                initialIsLiked={item.isLiked}
                initialLikeCount={item.likeCount}
                itemId={item.id}
              />
            </div>
          ) : null}

          {status === "error" ? (
            <div className="explore-reference-dialog-error">{error ?? "Unable to load details."}</div>
          ) : null}

          <p className="explore-reference-dialog-description">
            {description || `A short ${referenceKindLabel(item.kind).toLowerCase()} description will appear here soon.`}
          </p>

          {(() => {
            const voicePreview = currentDetail?.media.find(
              (media) => media.role === "voice_preview" && media.url,
            );
            return voicePreview ? (
              <div className="published-voice-preview">
                <span>Voice</span>
                <audio controls preload="none" src={voicePreview.url ?? undefined} />
              </div>
            ) : null;
          })()}

          <section className="explore-reference-featured">
            <h3>Featured in</h3>
            {featuredVideos.length ? (
              <div className="explore-reference-featured-grid">
                {featuredVideos.map((video) => (
                  <button
                    className="explore-reference-featured-card"
                    key={video.id}
                    onClick={() => {
                      onClose();
                      onOpenVideo(video);
                    }}
                    type="button"
                  >
                    <MediaThumb
                      className="explore-reference-featured-thumb"
                      gradientIndex={video.id.length}
                      kind={video.posterMediaKind === "video" ? "video" : "image"}
                      src={video.posterUrl}
                      title={video.title}
                    />
                    <span>{video.title}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p>No tagged videos found yet.</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function VideoPrefetch({ src }: { src: string | null }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    video.muted = true;
    video.defaultMuted = true;
    video.load();
  }, [src]);

  if (!src) return null;

  return (
    <video
      aria-hidden="true"
      className="explore-video-prefetch"
      muted
      playsInline
      preload="auto"
      ref={videoRef}
      src={src}
      tabIndex={-1}
    />
  );
}

function mediaAspectRatio(item: PublishedItemSummary) {
  if (item.posterWidth && item.posterHeight) {
    return item.posterWidth / item.posterHeight;
  }
  if (item.posterOrientation === "landscape") return 16 / 9;
  if (item.posterOrientation === "portrait") return 9 / 16;
  return 1;
}

function modalMediaStyle(item: PublishedItemSummary): CSSProperties {
  const ratio = mediaAspectRatio(item);
  return {
    aspectRatio: `${ratio}`,
  };
}

function mediaAspectStyle(item: PublishedItemSummary): CSSProperties {
  if (item.posterWidth && item.posterHeight) {
    return { aspectRatio: `${item.posterWidth} / ${item.posterHeight}` };
  }
  if (item.posterOrientation === "landscape") return { aspectRatio: "16 / 9" };
  if (item.posterOrientation === "portrait") return { aspectRatio: "9 / 16" };
  return { aspectRatio: "1 / 1" };
}

function buildMediaColumns(items: PublishedItemSummary[]) {
  const columns = Array.from({ length: MEDIA_COLUMN_COUNT }, () => ({
    height: 0,
    items: [] as PublishedItemSummary[],
  }));

  for (const item of items) {
    const target = columns.reduce((shortest, column, index) => (
      column.height < columns[shortest].height ? index : shortest
    ), 0);
    columns[target].items.push(item);
    columns[target].height += 1 / mediaAspectRatio(item);
  }

  return columns.map((column) => column.items);
}

function buildSkeletonColumns() {
  const columns = Array.from({ length: MEDIA_COLUMN_COUNT }, () => ({
    height: 0,
    items: [] as Array<{ id: number; ratio: number }>,
  }));

  for (let index = 0; index < EXPLORE_VIDEO_SKELETON_COUNT; index += 1) {
    const ratio = EXPLORE_VIDEO_SKELETON_RATIOS[index % EXPLORE_VIDEO_SKELETON_RATIOS.length] ?? 1;
    const target = columns.reduce((shortest, column, columnIndex) => (
      column.height < columns[shortest].height ? columnIndex : shortest
    ), 0);
    columns[target].items.push({ id: index, ratio });
    columns[target].height += 1 / ratio;
  }

  return columns.map((column) => column.items);
}

function ExploreVideoSkeletonGrid() {
  const columns = useMemo(() => buildSkeletonColumns(), []);
  return (
    <div className="explore-media-grid" aria-hidden="true">
      {columns.map((column, columnIndex) => (
        <div className="explore-media-column" key={columnIndex}>
          {column.map((item) => (
            <span
              className="explore-media-skeleton-tile"
              key={item.id}
              style={{ aspectRatio: `${item.ratio}` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function ExploreReferenceSkeletonTiles() {
  return (
    <>
      {Array.from({ length: EXPLORE_REFERENCE_SKELETON_COUNT }, (_, index) => (
        <span className="explore-reference-skeleton-tile" key={index} aria-hidden="true" />
      ))}
    </>
  );
}

function detailFromSummary(item: PublishedItemSummary | null) {
  if (!item || !("media" in item)) return null;
  const maybeDetail = item as PublishedItemDetail;
  return Array.isArray(maybeDetail.media) ? maybeDetail : null;
}

function firstImageUrlForRole(detail: PublishedItemDetail | null, roles: string[]) {
  return detail?.media.find((media) => (
    roles.includes(media.role) &&
    media.kind === "image" &&
    Boolean(media.url)
  ))?.url ?? null;
}

function createPreviewUrls(item: PublishedItemSummary, detail: PublishedItemDetail | null) {
  const displayUrl = firstImageUrlForRole(detail, ["display", "thumbnail", "preview"]) ?? item.posterUrl;
  const portfolioUrl = firstImageUrlForRole(detail, ["poster", "asset"]) ??
    detail?.media.find((media) => media.kind === "image" && media.url?.includes("portfolio"))?.url ??
    null;
  return { displayUrl, portfolioUrl };
}

function isLibraryDraftItem(item: PublishedItemSummary | null | undefined) {
  if (item?.libraryStatus === "saved") return false;
  return Boolean(
    item &&
      (
        item.libraryStatus === "draft" ||
        item.libraryStatus === "generating" ||
        (item.visibility === "draft" && item.tags.includes("library-draft"))
      ),
  );
}

function usePreloadedImage(src: string | null) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!src) {
      setLoadedSrc(null);
      return;
    }

    let canceled = false;
    setLoadedSrc(null);
    const image = new window.Image();
    image.decoding = "async";
    image.onload = () => {
      if (!canceled) setLoadedSrc(src);
    };
    image.onerror = () => {
      if (!canceled) setLoadedSrc(src);
    };
    image.src = src;
    if (image.complete) {
      setLoadedSrc(src);
    } else {
      void image.decode?.().then(
        () => {
          if (!canceled) setLoadedSrc(src);
        },
        () => undefined,
      );
    }

    return () => {
      canceled = true;
    };
  }, [src]);

  return loadedSrc === src;
}

export function ExploreCreateDialog({
  examples,
  initialItem,
  initialKind,
  libraryDraft,
  onClose,
  onCreated,
  onCreateSettled,
  onCreateStart,
  onSaveDraft,
}: {
  examples: Record<ExploreCreateKind, PublishedItemSummary[]>;
  initialItem?: PublishedItemSummary | null;
  initialKind: ExploreCreateKind;
  libraryDraft?: boolean;
  onClose: () => void;
  onCreated: (item: PublishedItemSummary) => void;
  onCreateSettled?: (localId: string) => void;
  onCreateStart?: (input: { kind: ExploreCreateKind; prompt: string; title: string }) => string | void;
  onSaveDraft?: (item: PublishedItemSummary) => Promise<void> | void;
}) {
  const [kind, setKind] = useState<ExploreCreateKind>(initialKind);
  const [prompt, setPrompt] = useState("");
  const [versions, setVersions] = useState<PublishedItemSummary[]>([]);
  const [activeVersionIndex, setActiveVersionIndex] = useState(0);
  const [rootVersion, setRootVersion] = useState<PublishedItemSummary | null>(initialItem ?? null);
  const [rootVersionDetail, setRootVersionDetail] = useState<PublishedItemDetail | null>(null);
  const [rootVersionDetailStatus, setRootVersionDetailStatus] = useState<"idle" | "loading" | "ready">(
    initialItem ? "loading" : "idle",
  );
  const [selectedExample, setSelectedExample] = useState<PublishedItemSummary | null>(initialItem ?? null);
  const [selectedExampleDetail, setSelectedExampleDetail] = useState<PublishedItemDetail | null>(null);
  const [selectedExampleDetailStatus, setSelectedExampleDetailStatus] = useState<"idle" | "loading" | "ready">(
    initialItem ? "loading" : "idle",
  );
  const [previewMode, setPreviewMode] = useState<"display" | "portfolio">("display");
  const [status, setStatus] = useState<"idle" | "creating">("idle");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving">("idle");
  const [attachments, setAttachments] = useState<ExploreCreateAttachment[]>([]);
  const [railMetrics, setRailMetrics] = useState<{ height: number; top: number } | null>(null);
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
  const [generationNow, setGenerationNow] = useState<number | null>(null);
  const attachmentsRef = useRef<ExploreCreateAttachment[]>([]);
  const createMainRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const activeVersion = versions[activeVersionIndex] ?? null;
  const previewItem = selectedExample ?? activeVersion;
  const previewDetail = selectedExample ? selectedExampleDetail : detailFromSummary(activeVersion);
  const versionItems = rootVersion ? [rootVersion, ...versions] : versions;
  const previewUrls = previewItem ? createPreviewUrls(previewItem, previewDetail) : null;
  const previewUrl = previewMode === "portfolio"
    ? previewUrls?.portfolioUrl ?? previewUrls?.displayUrl ?? null
    : previewUrls?.displayUrl ?? previewUrls?.portfolioUrl ?? null;
  const nextSwapUrl = previewMode === "portfolio" ? previewUrls?.displayUrl : previewUrls?.portfolioUrl;
  const swapUrl = nextSwapUrl && nextSwapUrl !== previewUrl ? nextSwapUrl : null;
  const isPreviewLoaded = usePreloadedImage(previewUrl);
  const isSwapLoaded = usePreloadedImage(swapUrl);
  const shouldShowSwap = Boolean(previewItem && (swapUrl || selectedExampleDetailStatus === "loading"));
  const isGenerating = status === "creating";
  const isEditingExisting = Boolean(activeVersion ?? selectedExample ?? rootVersion);
  const generationElapsedSeconds = generationStartedAt
    ? Math.max(0, ((generationNow ?? generationStartedAt) - generationStartedAt) / 1000)
    : 0;
  const activeSaveItem = !selectedExample && activeVersion
    ? activeVersion
    : isLibraryDraftItem(selectedExample)
      ? selectedExample
      : isLibraryDraftItem(rootVersion)
        ? rootVersion
        : null;
  const shouldShowLibraryEditActions = Boolean(
    libraryDraft &&
      kind === "character" &&
      (versions.length > 0 || isLibraryDraftItem(selectedExample) || isLibraryDraftItem(rootVersion)),
  );
  const railStyle = railMetrics
    ? {
        "--explore-create-rail-height": `${railMetrics.height}px`,
        "--explore-create-rail-top": `${railMetrics.top}px`,
      } as CSSProperties
    : undefined;
  const label = createTypeLabel(kind).toLowerCase();
  const generationTaskLabel = `${isEditingExisting ? "Editing" : "Creating"} ${label}`;
  const visibleExamples = examples[kind].slice(0, 6);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.src);
    };
  }, []);

  useEffect(() => {
    if (!isGenerating || !generationStartedAt) return;
    const interval = window.setInterval(() => setGenerationNow(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, [generationStartedAt, isGenerating]);

  useEffect(() => {
    if (!shouldShowLibraryEditActions) return;
    const main = createMainRef.current;
    const preview = previewRef.current;
    if (!main || !preview) return;

    let frame = 0;
    const updateRailMetrics = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const mainRect = main.getBoundingClientRect();
        const previewRect = preview.getBoundingClientRect();
        setRailMetrics((current) => {
          const next = {
            height: Math.round(previewRect.height),
            top: Math.round(previewRect.top - mainRect.top),
          };
          return current && current.height === next.height && current.top === next.top ? current : next;
        });
      });
    };

    updateRailMetrics();
    const observer = new ResizeObserver(updateRailMetrics);
    observer.observe(main);
    observer.observe(preview);
    window.addEventListener("resize", updateRailMetrics);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", updateRailMetrics);
    };
  }, [previewUrl, shouldShowLibraryEditActions, versionItems.length]);

  useEffect(() => {
    if (!initialItem) return;
    let canceled = false;
    setSelectedExample(initialItem);
    setSelectedExampleDetail(null);
    setSelectedExampleDetailStatus("loading");
    setRootVersion(initialItem);
    setRootVersionDetail(null);
    setRootVersionDetailStatus("loading");
    setVersions([]);
    setActiveVersionIndex(0);
    setPreviewMode("display");
    setPrompt("");
    void (async () => {
      try {
        const response = await fetch(`/api/published-items/${encodeURIComponent(initialItem.id)}`);
        const data = await response.json().catch(() => ({}));
        if (!canceled && response.ok && data?.id === initialItem.id) {
          const detail = data as PublishedItemDetail;
          setSelectedExampleDetail(detail);
          setSelectedExampleDetailStatus("ready");
          setRootVersionDetail(detail);
          setRootVersionDetailStatus("ready");
        } else if (!canceled) {
          setSelectedExampleDetailStatus("idle");
          setRootVersionDetailStatus("idle");
        }
      } catch {
        if (!canceled) {
          setSelectedExampleDetailStatus("idle");
          setRootVersionDetailStatus("idle");
        }
      }
    })();
    return () => {
      canceled = true;
    };
  }, [initialItem]);

  async function selectExample(item: PublishedItemSummary) {
    setSelectedExample(item);
    setSelectedExampleDetail(null);
    setSelectedExampleDetailStatus("loading");
    setRootVersion(item);
    setRootVersionDetail(null);
    setRootVersionDetailStatus("loading");
    setVersions([]);
    setActiveVersionIndex(0);
    setPreviewMode("display");
    setPrompt("");
    try {
      const response = await fetch(`/api/published-items/${encodeURIComponent(item.id)}`);
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.id === item.id) {
        const detail = data as PublishedItemDetail;
        setSelectedExampleDetail(detail);
        setSelectedExampleDetailStatus("ready");
        setRootVersionDetail(detail);
        setRootVersionDetailStatus("ready");
      } else {
        setSelectedExampleDetailStatus("idle");
        setRootVersionDetailStatus("idle");
      }
    } catch {
      // Keep the summary thumbnail if detail loading fails.
      setSelectedExampleDetailStatus("idle");
      setRootVersionDetailStatus("idle");
    }
  }

  async function submitCreate() {
    const trimmed = prompt.trim();
    if (!trimmed || status === "creating") return;
    const localDraftId = onCreateStart?.({
      kind,
      prompt: trimmed,
      title: `${isEditingExisting ? "Editing" : "Creating"} ${createTypeLabel(kind)}`,
    });
    setStatus("creating");
    const startedAt = Date.now();
    setGenerationStartedAt(startedAt);
    setGenerationNow(startedAt);
    try {
      const referenceImageUrls = await Promise.all(attachments.map((attachment) => readFileAsDataUrl(attachment.file)));
      const response = await fetch("/api/explore/create-asset", {
        body: JSON.stringify({
          kind,
          previousItemId: activeVersion?.id ?? selectedExample?.id ?? rootVersion?.id ?? null,
          prompt: trimmed,
          referenceImageUrls,
          saveMode: libraryDraft ? "library-draft" : "public",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.item) throw new Error(data.error || "Create failed.");
      const item = data.item as PublishedItemSummary;
      const nextVersionIndex = versions.length;
      setVersions((current) => [...current, item]);
      setActiveVersionIndex(nextVersionIndex);
      setSelectedExample(null);
      setSelectedExampleDetail(null);
      setSelectedExampleDetailStatus("idle");
      setPreviewMode("display");
      if (typeof data.warning === "string") toast.warning(userFacingError(data.warning, data.warning));
      toast.success(`${createTypeLabel(kind)} ${isEditingExisting ? "edited" : "created"}.`);
      onCreated(item);
      refreshCredits();
    } catch (caught) {
      toast.error(userFacingError(caught, "Create failed."));
    } finally {
      setStatus("idle");
      setGenerationStartedAt(null);
      setGenerationNow(null);
      if (localDraftId) onCreateSettled?.(localDraftId);
    }
  }

  async function submitSave() {
    if (!activeSaveItem || saveStatus === "saving") return;
    setSaveStatus("saving");
    try {
      await onSaveDraft?.(activeSaveItem);
      toast.success("Saved to library.");
      onClose();
    } catch (caught) {
      toast.error(userFacingError(caught, "Save failed."));
    } finally {
      setSaveStatus("idle");
    }
  }

  function addAttachments(files: File[]) {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length !== files.length) {
      toast.error("Only image references can be attached here.");
    }
    if (!images.length) return;
    setAttachments((current) => {
      const remainingSlots = Math.max(0, 6 - current.length);
      const nextImages = images.slice(0, remainingSlots);
      if (nextImages.length < images.length) toast.error("You can attach up to 6 reference images.");
      return [
        ...current,
        ...nextImages.map((file, index) => ({
          file,
          id: `${file.name}-${file.lastModified}-${file.size}-${Date.now()}-${index}`,
          label: file.name,
          src: URL.createObjectURL(file),
        })),
      ];
    });
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed) URL.revokeObjectURL(removed.src);
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  return (
    <div
      aria-modal="true"
      className="explore-create-dialog"
      onMouseDown={(event) => {
        const target = event.target;
        if (!(target instanceof Element) || !target.closest(".explore-create-panel")) onClose();
      }}
      role="dialog"
    >
      <div className="explore-create-panel">
        <button aria-label="Close create asset" className="explore-create-close" onClick={onClose} type="button">
          <X size={17} />
        </button>

        <div className="explore-create-main" ref={createMainRef}>
          <div className="explore-create-workspace">
            <div className="projects-view-toggle explore-create-tabs" role="tablist" aria-label="Asset type">
              {EXPLORE_CREATE_TYPES.map((type) => (
                <button
                  aria-selected={kind === type.value}
                  className="projects-view-seg explore-create-tab"
                  key={type.value}
                  onClick={() => {
                    setKind(type.value);
                    setRootVersion(null);
                    setRootVersionDetail(null);
                    setRootVersionDetailStatus("idle");
                    setVersions([]);
                    setActiveVersionIndex(0);
                    setSelectedExample(null);
                    setSelectedExampleDetail(null);
                    setSelectedExampleDetailStatus("idle");
                    setPreviewMode("display");
                  }}
                  role="tab"
                  type="button"
                >
                  <CreateTypeIcon kind={type.value} />
                  <span>{type.label}</span>
                </button>
              ))}
            </div>
            <div
              className={`explore-create-preview ${previewUrl ? "has-image" : ""}${previewUrl && !isPreviewLoaded ? " is-loading-image" : ""}${isGenerating ? " is-generating" : ""}`}
              ref={previewRef}
            >
              {previewUrl && previewItem ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  alt={previewItem.title}
                  className={`explore-create-preview-image ${isPreviewLoaded ? "is-loaded" : ""}`}
                  key={previewUrl}
                  src={previewUrl}
                />
              ) : (
                <div className="explore-create-empty-preview">
                  <CreateTypeIcon kind={kind} size={28} />
                  <span>Your {label} will appear here</span>
                </div>
              )}
              {shouldShowSwap ? (
                <button
                  aria-label={previewMode === "portfolio" ? "Show profile image" : "Show 3 by 3 portfolio"}
                  className={`explore-create-portfolio-swap ${swapUrl && isSwapLoaded ? "is-loaded" : "is-loading"}`}
                  disabled={!swapUrl}
                  key={`${previewMode}:${swapUrl ?? "loading"}`}
                  onClick={() => setPreviewMode((mode) => (mode === "portfolio" ? "display" : "portfolio"))}
                  type="button"
                >
                  {swapUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img alt="" key={swapUrl} src={swapUrl} />
                  ) : null}
                </button>
              ) : null}
              {isGenerating ? (
                <div className="explore-create-generating">
                  {previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      alt=""
                      aria-hidden="true"
                      className="explore-create-generating-clear-img"
                      src={previewUrl}
                    />
                  ) : null}
                  <div className="explore-create-generating-dots" aria-hidden="true" />
                  <div className="explore-create-generating-window" aria-hidden="true" />
                  <div className="explore-create-generating-timer">
                    <span>{generationElapsedSeconds.toFixed(1)}</span>
                    <small>{generationTaskLabel}</small>
                  </div>
                </div>
              ) : null}
            </div>

            {versionItems.length ? (
              <div className="explore-create-versions" aria-label="Generated versions">
                {versionItems.map((version, index) => {
                  const isRoot = Boolean(rootVersion && index === 0);
                  const generatedIndex = rootVersion ? index - 1 : index;
                  const isActive = isRoot
                    ? selectedExample?.id === rootVersion?.id
                    : !selectedExample && generatedIndex === activeVersionIndex;
                  return (
                    <button
                      aria-pressed={isActive}
                      className={isActive ? "is-active" : ""}
                      key={version.id}
                      onClick={() => {
                        if (isRoot && rootVersion) {
                          setSelectedExample(rootVersion);
                          setSelectedExampleDetail(rootVersionDetail);
                          setSelectedExampleDetailStatus(rootVersionDetailStatus);
                        } else {
                          setActiveVersionIndex(generatedIndex);
                          setSelectedExample(null);
                          setSelectedExampleDetail(null);
                          setSelectedExampleDetailStatus("idle");
                        }
                        setPreviewMode("display");
                      }}
                      type="button"
                    >
                      {index + 1}
                    </button>
                  );
                })}
              </div>
            ) : null}

            <form
              className="chat-composer explore-create-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void submitCreate();
              }}
            >
              {attachments.length ? (
                <div className="chat-composer-attachments explore-create-attachments">
                  {attachments.map((attachment) => (
                    <div className="chat-composer-attachment image" key={attachment.id} title={attachment.label}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img alt="" draggable={false} src={attachment.src} />
                      <button
                        aria-label={`Remove ${attachment.label}`}
                        className="composer-attachment-remove"
                        onClick={() => removeAttachment(attachment.id)}
                        title={`Remove ${attachment.label}`}
                        type="button"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <TextareaAutosize
                className="chat-composer-textarea"
                maxRows={6}
                minRows={1}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={`Describe the ${label}...`}
                value={prompt}
              />
              <div className="chat-composer-controls">
                <button
                  aria-label="Add reference images"
                  className="chat-composer-add"
                  onClick={() => fileInputRef.current?.click()}
                  title="Add reference images"
                  type="button"
                >
                  <Plus size={18} />
                </button>
                <input
                  accept="image/*"
                  aria-label="Reference image upload"
                  className="hidden"
                  multiple
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    addAttachments(files);
                    event.currentTarget.value = "";
                  }}
                  ref={fileInputRef}
                  type="file"
                />
                <span aria-label="Costs 25 credits" className="explore-create-credit-badge" title="Costs 25 credits">
                  <Sparkles size={13} />
                  <span>25</span>
                </span>
                <button
                  aria-label={`Create ${label}`}
                  className="chat-composer-submit"
                  disabled={status === "creating" || !prompt.trim()}
                  type="submit"
                >
                  {status === "creating" ? <Loader2 className="spin" size={17} /> : <ArrowUp size={18} />}
                </button>
              </div>
            </form>
          </div>

          <aside className={`explore-create-examples${shouldShowLibraryEditActions ? " is-editing" : ""}`} style={railStyle}>
            <div>
              <strong>Try with</strong>
            </div>
            <div className="explore-create-example-list">
              {visibleExamples.length ? visibleExamples.map((item) => (
                <button
                  aria-pressed={selectedExample?.id === item.id}
                  key={item.id}
                  onClick={() => void selectExample(item)}
                  type="button"
                >
                  <MediaThumb
                    gradientIndex={item.id.length}
                    kind={exploreReferenceThumbKind(item.kind)}
                    src={item.posterUrl}
                    title={item.title}
                  />
                  <span>{item.title}</span>
                </button>
              )) : (
                <p>No examples yet.</p>
              )}
            </div>
            {shouldShowLibraryEditActions ? (
              <div className="explore-create-edit-actions">
                <button
                  className="explore-create-save-button"
                  disabled={!activeSaveItem || saveStatus === "saving"}
                  onClick={() => void submitSave()}
                  type="button"
                >
                  {saveStatus === "saving" ? <Loader2 className="spin" size={15} /> : null}
                  <span>Save</span>
                </button>
                <button
                  className="explore-create-discard-button"
                  disabled={saveStatus === "saving"}
                  onClick={onClose}
                  type="button"
                >
                  Discard
                </button>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}

export function MediaColumnGrid({
  items,
  onOpen,
  suspendAutoplay,
}: {
  items: PublishedItemSummary[];
  onOpen: (item: PublishedItemSummary) => void;
  suspendAutoplay: boolean;
}) {
  const columns = useMemo(() => buildMediaColumns(items), [items]);

  return (
    <div className="explore-media-grid">
      {columns.map((column, index) => (
        <div className="explore-media-column" key={index}>
          {column.map((item) => (
            <div className="explore-media-cell" key={item.id}>
              <PublishedMediaTile
                item={item}
                onOpen={onOpen}
                style={mediaAspectStyle(item)}
                suspendAutoplay={suspendAutoplay}
              />
              <ExploreMediaCartButton item={item} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function useStartProjectFromCart(items: PublishedItemSummary[], onDone: () => void) {
  const directory = useProjectDirectory();
  const { requireAuth } = useAuthGate();
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const start = async () => {
    if (!requireAuth()) {
      // Signed-out: keep the cart so it carries through sign-up (StartContinuation).
      stashStartIntent({ pickIds: items.map((entry) => entry.id), prompt: "" });
      return;
    }
    if (!directory || starting || !items.length) return;
    setStarting(true);
    const toastId = toast.loading(`Starting a project with ${items.length} references...`);
    try {
      const project = await directory.createProject("Untitled video");
      let imported = 0;
      for (const item of items) {
        const response = await fetch(`/api/published-items/${item.id}/use`, {
          body: JSON.stringify({ projectId: project.id }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        if (response.ok) imported += 1;
      }
      toast.success(`Imported ${imported} of ${items.length} into a new project.`, { id: toastId });
      onDone();
      router.push(`/projects/${project.id}`);
    } catch (caught) {
      toast.error(userFacingError(caught, "Could not start project."), { id: toastId });
    } finally {
      setStarting(false);
    }
  };
  return { canStart: Boolean(directory), start, starting };
}

/** Floating red pill (fixed bottom-center) holding the project cart:
 * [N items] opens the cart dialog, [->] starts a project with the picks. */
export function ExploreCartBar({
  items,
  onOpen,
  onStart,
}: {
  items: PublishedItemSummary[];
  onOpen: () => void;
  onStart: () => void;
}) {
  const { canStart, start, starting } = useStartProjectFromCart(items, onStart);
  // On each add, flash "Added to cart" then spring-collapse to the count.
  const [justAdded, setJustAdded] = useState(false);
  const prevCountRef = useRef(0);
  useEffect(() => {
    if (items.length > prevCountRef.current) {
      setJustAdded(true);
      const timer = window.setTimeout(() => setJustAdded(false), 1100);
      prevCountRef.current = items.length;
      return () => window.clearTimeout(timer);
    }
    prevCountRef.current = items.length;
  }, [items.length]);
  if (!items.length) return null;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="explore-cart-bar" role="group" aria-label="Project cart">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={`explore-cart-count ${justAdded ? "is-added-flash" : ""}`}
              onClick={onOpen}
            >
              {justAdded ? (
                <span className="explore-cart-added">Added to cart</span>
              ) : (
                <span className="explore-cart-collapsed">
                  <MenuIcon size={16} aria-hidden="true" />
                  {items.length} {items.length === 1 ? "item" : "items"}
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={8}>
            View selected references
          </TooltipContent>
        </Tooltip>
        <span className="explore-cart-divider" aria-hidden="true" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="explore-cart-go"
              disabled={!canStart || starting}
              onClick={() => void start()}
              aria-label="Start a project with these references"
            >
              {starting ? <Loader2 size={17} className="spin" /> : <ArrowRight size={17} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={8}>
            Start a project with these
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

/** The cart's references, scaled up from the pill. */
export function ExploreCartDialog({
  items,
  open,
  onOpenChange,
  onRemove,
}: {
  items: PublishedItemSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const { canStart, start, starting } = useStartProjectFromCart(items, () =>
    onOpenChange(false),
  );
  const [render, setRender] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) {
      const frame = window.requestAnimationFrame(() => {
        setRender(true);
        setClosing(false);
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (!render) return;
    // Play the reverse animation, then unmount.
    const frame = window.requestAnimationFrame(() => setClosing(true));
    const timer = window.setTimeout(() => {
      setRender(false);
      setClosing(false);
    }, 260);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [open, render]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);
  if (!render) return null;
  return (
    <div
      className={`explore-cart-sheet-layer ${closing ? "is-closing" : ""}`}
      onClick={() => onOpenChange(false)}
    >
      <div
        className={`explore-cart-sheet ${closing ? "is-closing" : ""}`}
        role="dialog"
        aria-label="Project cart"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="explore-cart-sheet-head">
          <span className="explore-cart-sheet-title">
            Project cart <span className="explore-cart-sheet-count">({items.length})</span>
          </span>
          <button
            type="button"
            className="explore-cart-sheet-start"
            disabled={!canStart || starting || !items.length}
            onClick={() => void start()}
          >
            {starting ? <Loader2 size={14} className="spin" /> : <ArrowRight size={14} />}
            Start project
          </button>
        </div>
        <div className="explore-cart-grid">
          {items.map((item) => (
            <div key={item.id} className="explore-cart-cell">
              <MediaThumb
                className="explore-cart-thumb"
                gradientIndex={item.id.length}
                kind={exploreReferenceThumbKind(item.kind)}
                src={item.posterUrl}
                title={item.title}
              />
              <span className="explore-cart-cell-title">{item.title}</span>
              <button
                type="button"
                className="explore-cart-remove"
                aria-label={`Remove ${item.title}`}
                onClick={() => {
                  onRemove(item.id);
                  if (items.length <= 1) onOpenChange(false);
                }}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ExplorePageClient({ items }: { items: PublishedItemSummary[] }) {
  const localMode = isLocalAppModeClient();
  const [activeKind, setActiveKind] = useState("all");
  const [query, setQuery] = useState("");
  const [loadedReferenceItems, setLoadedReferenceItems] = useState<PublishedItemSummary[]>(
    () => getUsableCachedExploreReferenceItems() ?? [],
  );
  const [videoItems, setVideoItems] = useState<PublishedItemSummary[]>(
    () => getUsableCachedExploreVideoItems() ?? [],
  );
  const [localReferenceItems, setLocalReferenceItems] = useState<PublishedItemSummary[]>(
    () => cachedLocalReferenceItems,
  );
  const [localVideoItems, setLocalVideoItems] = useState<PublishedItemSummary[]>(
    () => cachedLocalVideoItems,
  );
  const [catalogAvailability, setCatalogAvailability] = useState<"online" | "unavailable">(
    () => cachedReferenceAvailability === "unavailable" && cachedVideoAvailability === "unavailable"
      ? "unavailable"
      : "online",
  );
  const [referenceStatus, setReferenceStatus] = useState<ExploreLoadStatus>(
    () => getUsableCachedExploreReferenceItems() === null ? "loading" : "ready",
  );
  const [videoStatus, setVideoStatus] = useState<ExploreLoadStatus>(
    () => getUsableCachedExploreVideoItems() === null ? "loading" : "ready",
  );
  const [expandedVideo, setExpandedVideo] = useState<PublishedItemSummary | null>(null);
  const [expandedReference, setExpandedReference] = useState<PublishedItemSummary | null>(null);
  const [expandedDirection, setExpandedDirection] = useState<VideoNavDirection>("next");
  const [isExpandedVideoExiting, setIsExpandedVideoExiting] = useState(false);
  const [isCompactToolbarVisible, setIsCompactToolbarVisible] = useState(false);
  const [createModalKind, setCreateModalKind] = useState<ExploreCreateKind | null>(null);
  const [cartItems, setCartItems] = useState<PublishedItemSummary[]>([]);
  const [cartDialogOpen, setCartDialogOpen] = useState(false);
  // Adding to the cart is open to everyone — the gate lives on "Start a
  // project" (useStartProjectFromCart), where we catch signed-out users.
  const cartValue = useMemo<ExploreCartValue>(
    () => ({
      has: (id: string) => cartItems.some((entry) => entry.id === id),
      toggle: (item: PublishedItemSummary) =>
        setCartItems((current) =>
          current.some((entry) => entry.id === item.id)
            ? current.filter((entry) => entry.id !== item.id)
            : [...current, item],
        ),
    }),
    [cartItems],
  );
  const expandedVideoTimerRef = useRef<number | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  const uniqueItems = useMemo(() => {
    const seen = new Set<string>();
    return [...items, ...loadedReferenceItems, ...videoItems].filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [items, loadedReferenceItems, videoItems]);
  const search = query.trim().toLowerCase();
  const filteredLocalItems = useMemo(
    () => [...localReferenceItems, ...localVideoItems].filter((item) => {
      const normalizedKind = normalizeExploreKind(item.kind);
      if (activeKind !== "all" && normalizedKind !== activeKind) return false;
      return itemMatchesSearch(item, search);
    }),
    [activeKind, localReferenceItems, localVideoItems, search],
  );
  const filteredLocalReferences = filteredLocalItems.filter((item) => isExploreReferenceKind(item.kind));
  const filteredLocalVideos = filteredLocalItems.filter(
    (item) => normalizeExploreKind(item.kind) === "video",
  );
  const filteredItems = useMemo(() => {
    return uniqueItems.filter((item) => {
      const normalizedKind = normalizeExploreKind(item.kind);
      if (activeKind !== "all" && normalizedKind !== activeKind) return false;
      return itemMatchesSearch(item, search);
    });
  }, [activeKind, search, uniqueItems]);
  const allMediaItems = uniqueItems.filter((item) => normalizeExploreKind(item.kind) === "video");
  const filteredReferenceItems = filteredItems.filter((item) => isExploreReferenceKind(item.kind));
  const publishedCharacterItems = filteredReferenceItems.filter(
    (item) => normalizeExploreKind(item.kind) === "character",
  );
  const publishedEnvironmentItems = filteredReferenceItems.filter(
    (item) => normalizeExploreKind(item.kind) === "environment",
  );
  const publishedPropItems = filteredReferenceItems.filter(
    (item) => normalizeExploreKind(item.kind) === "prop",
  );
  const publishedStyleItems = filteredReferenceItems.filter(
    (item) => normalizeExploreKind(item.kind) === "style",
  );
  const mediaItems = filteredItems.filter((item) => normalizeExploreKind(item.kind) === "video");
  const isReferenceLoading = referenceStatus === "loading";
  const isVideoLoading = videoStatus === "loading";
  const characterItems = publishedCharacterItems;
  const environmentItems = publishedEnvironmentItems;
  const propItems = publishedPropItems;
  const styleItems = publishedStyleItems;
  const expandedReferenceFeaturedVideos = expandedReference
    ? featuredVideosForReference(expandedReference, allMediaItems)
    : [];
  const expandedVideoIndex = expandedVideo
    ? mediaItems.findIndex((item) => item.id === expandedVideo.id)
    : -1;
  const hasPreviousExpandedVideo = expandedVideoIndex > 0;
  const hasNextExpandedVideo = expandedVideoIndex >= 0 && expandedVideoIndex < mediaItems.length - 1;
  const previousExpandedVideo = hasPreviousExpandedVideo ? mediaItems[expandedVideoIndex - 1] ?? null : null;
  const nextExpandedVideo = hasNextExpandedVideo ? mediaItems[expandedVideoIndex + 1] ?? null : null;
  const otherItems = filteredItems.filter(
    (item) => !filteredReferenceItems.includes(item) && !mediaItems.includes(item),
  );
  const hasExploreResults = activeKind === "all"
    ? Boolean(characterItems.length || environmentItems.length || propItems.length || styleItems.length || mediaItems.length || filteredLocalItems.length || isReferenceLoading || isVideoLoading || otherItems.length)
    : activeKind === "character"
      ? Boolean(characterItems.length || filteredLocalReferences.length || isReferenceLoading)
      : activeKind === "environment"
        ? Boolean(environmentItems.length || filteredLocalReferences.length || isReferenceLoading)
      : activeKind === "prop"
          ? Boolean(propItems.length || filteredLocalReferences.length || isReferenceLoading)
          : activeKind === "style"
            ? Boolean(styleItems.length || filteredLocalReferences.length || isReferenceLoading)
            : activeKind === "video"
              ? Boolean(mediaItems.length || filteredLocalVideos.length || isVideoLoading)
              : Boolean(filteredItems.length);

  function openMediaItem(item: PublishedItemSummary) {
    if (expandedVideoTimerRef.current) {
      window.clearTimeout(expandedVideoTimerRef.current);
      expandedVideoTimerRef.current = null;
    }
    setIsExpandedVideoExiting(false);
    setExpandedDirection("next");
    setExpandedVideo(item);
  }

  function openReferenceItem(item: PublishedItemSummary) {
    setExpandedReference(item);
  }

  function handleCreatedReference(item: PublishedItemSummary) {
    setLoadedReferenceItems((current) => {
      const nextItems = [item, ...current.filter((currentItem) => currentItem.id !== item.id)];
      cachedExploreReferenceItems = nextItems;
      cachedExploreReferenceItemsAt = Date.now();
      cachedExploreReferenceItemsBustToken = exploreReferenceCacheBustToken();
      return nextItems;
    });
    setReferenceStatus("ready");
  }

  function openExpandedVideoAt(index: number, direction: VideoNavDirection) {
    if (isExpandedVideoExiting) return;
    const item = mediaItems[index];
    if (!item) return;
    setExpandedDirection(direction);
    setIsExpandedVideoExiting(true);
    if (expandedVideoTimerRef.current) {
      window.clearTimeout(expandedVideoTimerRef.current);
    }
    expandedVideoTimerRef.current = window.setTimeout(() => {
      setExpandedVideo(item);
      setIsExpandedVideoExiting(false);
      expandedVideoTimerRef.current = null;
    }, 300);
  }

  useEffect(() => () => {
    if (expandedVideoTimerRef.current) {
      window.clearTimeout(expandedVideoTimerRef.current);
    }
  }, []);

  useEffect(() => {
    let canceled = false;
    void (async () => {
      const cached = getUsableCachedExploreReferenceItems();
      if (!cached) setReferenceStatus("loading");
      try {
        const catalog = await getExploreReferenceCatalog({ force: !cached });
        if (canceled) return;
        setLoadedReferenceItems(catalog.items);
        setLocalReferenceItems(catalog.localItems);
        setCatalogAvailability((current) => (
          catalog.availability === "unavailable" && cachedVideoAvailability === "unavailable"
            ? "unavailable"
            : current
        ));
        setReferenceStatus("ready");
      } catch {
        if (canceled) return;
        setLoadedReferenceItems([]);
        setReferenceStatus("error");
      }
    })();
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    let canceled = false;
    void (async () => {
      const cached = getUsableCachedExploreVideoItems();
      if (!cached) setVideoStatus("loading");
      try {
        const catalog = await getExploreVideoCatalog({ force: !cached });
        if (canceled) return;
        setVideoItems(catalog.items);
        setLocalVideoItems(catalog.localItems);
        setCatalogAvailability(
          catalog.availability === "unavailable" && cachedReferenceAvailability === "unavailable"
            ? "unavailable"
            : "online",
        );
        setVideoStatus("ready");
      } catch {
        if (canceled) return;
        setVideoItems([]);
        setVideoStatus("error");
      }
    })();
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setIsCompactToolbarVisible(!entries.some((entry) => entry.isIntersecting));
      },
      { rootMargin: "-72px 0px 0px 0px", threshold: 0 },
    );
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, []);

  return (
    <ExploreCartContext.Provider value={cartValue}>

    <section className="projects-section projects-browser explore-browser">
      <header className="projects-header">
        <h1 className="projects-header-title">Explore</h1>
        <ExploreCompactToolbar
          activeKind={activeKind}
          isVisible={isCompactToolbarVisible}
          query={query}
          setActiveKind={setActiveKind}
          setQuery={setQuery}
        />
      </header>

      <div className="projects-toolbar" ref={toolbarRef}>
        <label className="projects-search">
          <Search size={16} />
          <input
            aria-label="Search published items"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search published items"
            type="search"
            value={query}
          />
        </label>

        <div className="projects-filters">
          <div className="projects-view-toggle explore-kind-toggle" role="group" aria-label="Published item type">
            {KIND_FILTERS.map((filter) => (
              <button
                aria-label={filter.label}
                aria-pressed={activeKind === filter.value}
                className="projects-view-seg explore-kind-seg"
                key={filter.value}
                onClick={() => setActiveKind(filter.value)}
                type="button"
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {localMode && catalogAvailability === "unavailable" ? (
        <div className="explore-empty" role="status">
          <Sparkles size={22} />
          <strong>Canonical catalog unavailable</strong>
          <span>You can keep working with assets on this device. Reconnect to browse the public catalog.</span>
        </div>
      ) : null}

      {hasExploreResults ? (
        <div className={`explore-results ${activeKind === "all" ? "is-all" : "is-filtered"}`}>
          {activeKind === "all" ? (
            <>
              <ExploreReferenceSection
                isLoading={isReferenceLoading}
                items={characterItems}
                onOpen={openReferenceItem}
                onSeeAll={() => setActiveKind("character")}
                title="Trending characters"
              />
              <ExploreReferenceSection
                isLoading={isReferenceLoading}
                items={environmentItems}
                onOpen={openReferenceItem}
                onSeeAll={() => setActiveKind("environment")}
                title="Trending environments"
              />
              <ExploreReferenceSection
                isLoading={isReferenceLoading}
                items={styleItems}
                onOpen={openReferenceItem}
                onSeeAll={() => setActiveKind("style")}
                title="Trending styles"
              />
              <ExploreVideoSection
                items={mediaItems}
                isLoading={isVideoLoading}
                onOpen={openMediaItem}
                onSeeAll={() => setActiveKind("video")}
                showHeader
                suspendAutoplay={Boolean(expandedVideo || expandedReference)}
              />
            </>
          ) : null}

          {activeKind === "character" ? (
            <ExploreReferenceCategorySections
              isLoading={isReferenceLoading}
              items={characterItems}
              onOpen={openReferenceItem}
            />
          ) : null}

          {activeKind === "environment" ? (
            <ExploreReferenceCategorySections
              isLoading={isReferenceLoading}
              items={environmentItems}
              onOpen={openReferenceItem}
            />
          ) : null}

          {activeKind === "prop" ? (
            <ExploreReferenceCategorySections
              isLoading={isReferenceLoading}
              items={propItems}
              onOpen={openReferenceItem}
            />
          ) : null}

          {activeKind === "style" ? (
            <ExploreReferenceCategorySections
              isLoading={isReferenceLoading}
              items={styleItems}
              onOpen={openReferenceItem}
            />
          ) : null}

          {activeKind === "video" ? (
            <ExploreVideoSection
              items={mediaItems}
              isLoading={isVideoLoading}
              onOpen={openMediaItem}
              showHeader={false}
              suspendAutoplay={Boolean(expandedVideo || expandedReference)}
            />
          ) : null}

          {otherItems.length ? (
            <div className="image-tile-grid explore-reference-grid">
              {otherItems.map((item) => (
                <PublishedReferenceTile item={item} key={item.id} onOpen={openReferenceItem} />
              ))}
            </div>
          ) : null}

          {localMode && filteredLocalReferences.length ? (
            <ExploreReferenceSection
              isLoading={false}
              items={filteredLocalReferences}
              onOpen={openReferenceItem}
              title="On this device"
            />
          ) : null}
          {localMode && filteredLocalVideos.length ? (
            <ExploreVideoSection
              isLoading={false}
              items={filteredLocalVideos}
              onOpen={openMediaItem}
              showHeader
              suspendAutoplay={Boolean(expandedVideo || expandedReference)}
              title="On this device · videos"
            />
          ) : null}
        </div>
      ) : (
        <div className="explore-empty">
          <Sparkles size={22} />
          <strong>
            {referenceStatus === "error" && videoStatus === "error"
              ? "Explore unavailable"
              : localMode
                ? "No local project assets yet"
                : "No published items yet"}
          </strong>
          <span>
            {referenceStatus === "error" && videoStatus === "error"
              ? "The catalog could not be reached. Check this deployment's catalog configuration or connection."
              : localMode
                ? "Create references or clips in a project and they will appear here automatically."
                : "Published characters, environments, styles, and videos will appear here first."}
          </span>
        </div>
      )}
      {expandedVideo ? (
        <ExploreVideoLightbox
          direction={expandedDirection}
          hasNext={hasNextExpandedVideo}
          hasPrevious={hasPreviousExpandedVideo}
          isExiting={isExpandedVideoExiting}
          item={expandedVideo}
          nextItem={nextExpandedVideo}
          onClose={() => {
            if (expandedVideoTimerRef.current) {
              window.clearTimeout(expandedVideoTimerRef.current);
              expandedVideoTimerRef.current = null;
            }
            setIsExpandedVideoExiting(false);
            setExpandedVideo(null);
          }}
          onNext={() => openExpandedVideoAt(expandedVideoIndex + 1, "next")}
          onPrevious={() => openExpandedVideoAt(expandedVideoIndex - 1, "previous")}
          previousItem={previousExpandedVideo}
        />
      ) : null}
      {expandedReference ? (
        <ExploreReferenceDialog
          featuredVideos={expandedReferenceFeaturedVideos}
          item={expandedReference}
          key={expandedReference.id}
          onClose={() => setExpandedReference(null)}
          onOpenVideo={openMediaItem}
        />
      ) : null}
      {createModalKind ? (
        <ExploreCreateDialog
          examples={{
            character: characterItems,
            environment: environmentItems,
            prop: propItems,
            style: styleItems,
          }}
          initialKind={createModalKind}
          onClose={() => setCreateModalKind(null)}
          onCreated={handleCreatedReference}
        />
      ) : null}
      <ExploreCartBar
        items={cartItems}
        onOpen={() => setCartDialogOpen(true)}
        onStart={() => setCartDialogOpen(false)}
      />
      <ExploreCartDialog
        items={cartItems}
        open={cartDialogOpen}
        onOpenChange={setCartDialogOpen}
        onRemove={(id) => setCartItems((current) => current.filter((entry) => entry.id !== id))}
      />
    </section>
    </ExploreCartContext.Provider>
  );
}
