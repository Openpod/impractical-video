"use client";

import { ArrowRight, Check, ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ExploreCartContext,
  ExploreReferenceDialog,
  ExploreVideoLightbox,
  exploreReferenceThumbKind,
  featuredVideosForReference,
  getExploreReferenceItems,
  getExploreVideoItems,
  MediaColumnGrid,
  normalizeExploreKind,
  useExploreCart,
} from "@/app/explore/explore-page-client";
import { MediaThumb } from "@/app/media-thumb";
import type { PublishedItemSummary } from "@/lib/published-items";

/**
 * Signed-out home content. References render in the home's own section markup
 * (`.image-tile-grid` → `.image-tile`); clips reuse Explore's edge-to-edge
 * masonry. Clicking a tile opens Explore's detail view; the corner + adds it
 * to the shared picks (surfaced as attachments in the hero composer above).
 */

const REFERENCE_SECTIONS: Array<{ kind: string; title: string }> = [
  { kind: "environment", title: "Try some environments" },
  { kind: "style", title: "Try some styles" },
];

function ReferenceCard({
  item,
  onOpen,
}: {
  item: PublishedItemSummary;
  onOpen: (item: PublishedItemSummary) => void;
}) {
  const cart = useExploreCart();
  const added = cart?.has(item.id) ?? false;
  return (
    <div className="image-tile home-cart-tile">
      <div
        role="button"
        tabIndex={0}
        className="home-cart-tile-media"
        aria-label={`View ${item.title}`}
        onClick={() => onOpen(item)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen(item);
          }
        }}
      >
        <MediaThumb
          className="image-tile-thumb"
          gradientIndex={item.id.length}
          kind={exploreReferenceThumbKind(item.kind)}
          src={item.posterUrl}
          title={item.title}
        />
        <button
          type="button"
          className={`explore-cart-add ${added ? "is-added" : ""}`}
          aria-label={added ? `Remove ${item.title} from your picks` : `Add ${item.title} to your picks`}
          onClick={(event) => {
            event.stopPropagation();
            cart?.toggle(item);
          }}
        >
          {added ? <Check size={15} /> : <Plus size={15} />}
        </button>
      </div>
      <span className="image-tile-title">{item.title}</span>
    </div>
  );
}

const CAROUSEL_GAP = 18;
const CAROUSEL_MIN_CARD = 150;

/**
 * Two-row carousel flanked by left/right arrows (outside the cards). Card width
 * is computed so a whole number of cards fills the row exactly — never a half
 * card — and paging advances by exactly one screenful. Still wheel-scrollable.
 */
function ReferenceCarousel({
  items,
  onOpen,
}: {
  items: PublishedItemSummary[];
  onOpen: (item: PublishedItemSummary) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  const sync = () => {
    const el = ref.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 4);
    setAtEnd(el.scrollLeft >= el.scrollWidth - el.clientWidth - 4);
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const w = el.clientWidth;
      if (!w) return;
      const cols = Math.max(2, Math.floor((w + CAROUSEL_GAP) / (CAROUSEL_MIN_CARD + CAROUSEL_GAP)));
      el.style.setProperty("--card-w", `${(w - (cols - 1) * CAROUSEL_GAP) / cols}px`);
      sync();
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [items.length]);

  const page = (direction: number) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: direction * (el.clientWidth + CAROUSEL_GAP), behavior: "smooth" });
  };

  return (
    <div className="home-carousel-wrap">
      <button aria-label="Scroll left" className="home-carousel-arrow is-prev" disabled={atStart} onClick={() => page(-1)} type="button">
        <ChevronLeft size={18} />
      </button>
      <div className="home-carousel" onScroll={sync} ref={ref}>
        {items.map((item) => (
          <ReferenceCard item={item} key={item.id} onOpen={onOpen} />
        ))}
      </div>
      <button aria-label="Scroll right" className="home-carousel-arrow is-next" disabled={atEnd} onClick={() => page(1)} type="button">
        <ChevronRight size={18} />
      </button>
    </div>
  );
}

export function SignedOutHome({
  picks,
  onTogglePick,
}: {
  picks: PublishedItemSummary[];
  onTogglePick: (item: PublishedItemSummary) => void;
}) {
  const [references, setReferences] = useState<PublishedItemSummary[]>([]);
  const [clips, setClips] = useState<PublishedItemSummary[]>([]);
  const [query, setQuery] = useState("");
  const [expandedReference, setExpandedReference] = useState<PublishedItemSummary | null>(null);
  const [expandedVideo, setExpandedVideo] = useState<PublishedItemSummary | null>(null);
  const [videoDirection, setVideoDirection] = useState<"next" | "previous">("next");

  useEffect(() => {
    let cancelled = false;
    void getExploreReferenceItems()
      .then((loaded) => !cancelled && setReferences(loaded))
      .catch(() => {});
    void getExploreVideoItems()
      .then((loaded) => !cancelled && setClips(loaded))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const referencesByKind = useMemo(() => {
    const map = new Map<string, PublishedItemSummary[]>();
    for (const item of references) {
      const kind = normalizeExploreKind(item.kind);
      const list = map.get(kind);
      if (list) list.push(item);
      else map.set(kind, [item]);
    }
    return map;
  }, [references]);

  // The composer above owns the picks; the grid just reflects/toggles them.
  const cartValue = useMemo(
    () => ({
      has: (id: string) => picks.some((entry) => entry.id === id),
      toggle: onTogglePick,
    }),
    [picks, onTogglePick],
  );

  const q = query.trim().toLowerCase();
  const matches = (item: PublishedItemSummary) => !q || item.title.toLowerCase().includes(q);
  const characters = referencesByKind.get("character") ?? [];
  const filteredClips = clips.filter(matches);
  const videoIndex = expandedVideo ? clips.findIndex((clip) => clip.id === expandedVideo.id) : -1;
  const nextVideo = videoIndex >= 0 && videoIndex < clips.length - 1 ? clips[videoIndex + 1] : null;
  const previousVideo = videoIndex > 0 ? clips[videoIndex - 1] : null;

  return (
    <ExploreCartContext.Provider value={cartValue}>
      <div className="home-content home-browse">
        {characters.length ? (
          <section className="home-image-section">
            <div className="section-title-row">
              <h2>Try some characters</h2>
              <div className="home-section-actions">
                <label className="projects-search home-browse-search">
                  <Search size={16} />
                  <input
                    aria-label="Search references and clips"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search"
                    type="search"
                    value={query}
                  />
                </label>
                <Link className="section-link explore-section-link" href="/explore">
                  See all
                  <ArrowRight size={14} />
                </Link>
              </div>
            </div>
            <ReferenceCarousel items={characters.filter(matches)} onOpen={setExpandedReference} />
          </section>
        ) : null}
        {REFERENCE_SECTIONS.map((section) => {
          const base = referencesByKind.get(section.kind) ?? [];
          if (!base.length) return null; // keep the section on search — filter only the grid
          return (
            <section className="home-image-section" key={section.kind}>
              <div className="section-title-row">
                <h2>{section.title}</h2>
                <Link className="section-link explore-section-link" href="/explore">
                  See all
                  <ArrowRight size={14} />
                </Link>
              </div>
              <ReferenceCarousel items={base.filter(matches)} onOpen={setExpandedReference} />
            </section>
          );
        })}
      </div>

      {/* Full-width band (direct child of .home-page) so the masonry reaches
          edge-to-edge. Placed last, below all the carousels, since it's tall. */}
      {clips.length ? (
        <section className="home-clips-band">
          <div className="home-clips-band-head">
            <div className="section-title-row">
              <h2>Try some clips</h2>
              <Link className="section-link explore-section-link" href="/explore">
                See all
                <ArrowRight size={14} />
              </Link>
            </div>
          </div>
          <div className="explore-media-shell">
            <MediaColumnGrid items={filteredClips} onOpen={setExpandedVideo} suspendAutoplay={Boolean(expandedVideo)} />
          </div>
        </section>
      ) : null}

      {expandedReference ? (
        <ExploreReferenceDialog
          featuredVideos={featuredVideosForReference(expandedReference, clips)}
          item={expandedReference}
          key={expandedReference.id}
          onClose={() => setExpandedReference(null)}
          onOpenVideo={(video) => {
            setExpandedReference(null);
            setExpandedVideo(video);
          }}
        />
      ) : null}

      {expandedVideo ? (
        <ExploreVideoLightbox
          direction={videoDirection}
          hasNext={Boolean(nextVideo)}
          hasPrevious={Boolean(previousVideo)}
          isExiting={false}
          item={expandedVideo}
          nextItem={nextVideo}
          onClose={() => setExpandedVideo(null)}
          onNext={() => {
            if (nextVideo) {
              setVideoDirection("next");
              setExpandedVideo(nextVideo);
            }
          }}
          onPrevious={() => {
            if (previousVideo) {
              setVideoDirection("previous");
              setExpandedVideo(previousVideo);
            }
          }}
          previousItem={previousVideo}
        />
      ) : null}
    </ExploreCartContext.Provider>
  );
}
