import { ArrowLeft, FileText, Layers3, UserRound } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublishedLikeButton, PublishedUseButton } from "@/app/explore/explore-page-client";
import { isLocalAppMode } from "@/lib/app-mode";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { getLocalCatalogItem } from "@/lib/local-catalog";
import { getPublishedItem } from "@/lib/published-items";
import { getPublicCatalogItem } from "@/lib/public-catalog";

export const dynamic = "force-dynamic";

function kindLabel(kind: string) {
  const displayKind = kind === "clip" ? "video" : kind;
  return displayKind
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en", { notation: value > 9999 ? "compact" : "standard" }).format(value);
}

function decodeRouteId(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default async function PublishedItemDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: encodedId } = await params;
  const id = decodeRouteId(encodedId);
  const localMode = isLocalAppMode();
  const user = localMode ? null : await ensureCurrentAppUser();
  const item = localMode
    ? id.startsWith("local:")
      ? await getLocalCatalogItem(id)
      : await getPublicCatalogItem(id).catch(() => null)
    : await getPublishedItem(id, user?.userId);
  if (!item) notFound();

  const heroMedia =
    item.media.find((media) => media.role === "display") ??
    item.media.find((media) => media.role === "poster") ??
    item.media[0] ??
    null;
  const isAiVideoEntry = item.id.startsWith("ai-video-");

  return (
    <div className="published-detail-page">
      <Link className="published-back-link" href="/explore">
        <ArrowLeft size={15} />
        Explore
      </Link>

      <section className="published-detail-hero">
        <div className="published-detail-media">
          {heroMedia?.url ? (
            heroMedia.kind === "video" ? (
              <video controls muted playsInline src={heroMedia.url} />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img alt="" src={heroMedia.url} />
            )
          ) : (
            <span>
              <Layers3 size={28} />
            </span>
          )}
        </div>

        <div className="published-detail-copy">
          <div className="published-detail-kicker">{isAiVideoEntry ? "Video prompt" : kindLabel(item.kind)}</div>
          {isAiVideoEntry ? null : <h1>{item.title}</h1>}
          {item.description ? <p>{item.description}</p> : null}
          <div className="published-detail-stats">
            {localMode ? (
              <span>Local project asset</span>
            ) : isAiVideoEntry ? (
              <span>AI video library</span>
            ) : (
              <>
                <PublishedLikeButton
                  initialIsLiked={item.isLiked}
                  initialLikeCount={item.likeCount}
                  itemId={item.id}
                />
                <span>Used {formatCount(item.useCount)} times</span>
              </>
            )}
          </div>
          <div className="published-detail-publisher">
            <UserRound size={15} />
            <span>
              {localMode && typeof item.metadata?.projectName === "string"
                ? item.metadata.projectName
                : item.publisher?.displayName ?? "Unknown publisher"}
            </span>
          </div>
          {!isAiVideoEntry && item.tags.length ? (
            <div className="published-tags">
              {item.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
          ) : null}
          {localMode || isAiVideoEntry ? null : <PublishedUseButton itemId={item.id} />}
        </div>
      </section>

      <section className="published-detail-section">
        <div className="section-title-row">
          <h2>Snapshot files</h2>
          <span>{item.files.length} files</span>
        </div>
        {item.files.length ? (
          <div className="published-file-list">
            {item.files.map((file) => (
              <div className="published-file-row" key={file.path}>
                <FileText size={15} />
                <span>{file.path}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="explore-empty">
            <FileText size={20} />
            <strong>No files in this snapshot</strong>
            <span>The publish service has not attached source files yet.</span>
          </div>
        )}
      </section>

      {item.media.length > 1 ? (
        <section className="published-detail-section">
          <div className="section-title-row">
            <h2>Media</h2>
            <span>{item.media.length} assets</span>
          </div>
          <div className="published-media-strip">
            {item.media.map((media) => (
              <div className="published-media-tile" key={media.id}>
                {media.url && media.kind === "video" ? (
                  <video muted playsInline src={media.url} />
                ) : media.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img alt="" src={media.url} />
                ) : (
                  <Layers3 size={18} />
                )}
                <span>{media.role}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
