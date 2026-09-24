"use client";

import { Film, Map, UserRound } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

export type MediaThumbKind = "character" | "environment" | "image" | "project" | "video";

const THUMB_GRADIENTS = [
  ["#ed1d24", "#fb7b7f", "#191919"],
  ["#111111", "#ed1d24", "#f3f3f3"],
  ["#ed1d24", "#ffb3b6", "#4b0c10"],
  ["#2b2b2b", "#ec454b", "#ffffff"],
  ["#9f1419", "#ff5b61", "#171717"],
  ["#f4f4f4", "#ed1d24", "#2a2a2a"],
];

const loadedMediaUrls = new Set<string>();

function gradientFor(index: number) {
  const normalized = Math.abs(Math.trunc(index || 0)) % THUMB_GRADIENTS.length;
  return THUMB_GRADIENTS[normalized] ?? THUMB_GRADIENTS[0];
}

function FallbackIcon({ kind }: { kind: MediaThumbKind }) {
  if (kind === "character") return <UserRound size={28} strokeWidth={1.8} />;
  if (kind === "environment") return <Map size={28} strokeWidth={1.8} />;
  return <Film size={28} strokeWidth={1.8} />;
}

export function MediaThumb({
  className = "",
  gradientIndex = 0,
  kind,
  loading = "lazy",
  onImageSize,
  src,
  title,
}: {
  className?: string;
  gradientIndex?: number;
  kind: MediaThumbKind;
  loading?: "eager" | "lazy";
  onImageSize?: (size: { height: number; width: number }) => void;
  src?: string | null;
  title: string;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [mediaState, setMediaState] = useState<{ hasError: boolean; hasLoaded: boolean; src?: string | null }>(() => ({
    hasError: false,
    hasLoaded: Boolean(src && loadedMediaUrls.has(src)),
    src: src ?? null,
  }));
  const [thumbA, thumbB, thumbC] = gradientFor(gradientIndex);
  const style = {
    "--thumb-a": thumbA,
    "--thumb-b": thumbB,
    "--thumb-c": thumbC,
  } as CSSProperties;
  const hasCurrentState = mediaState.src === src;
  const hasError = hasCurrentState && mediaState.hasError;
  const hasLoaded = Boolean(src && loadedMediaUrls.has(src)) || (hasCurrentState && mediaState.hasLoaded);
  const mediaKind = src && !hasError && kind === "video" ? "video" : src && !hasError ? "image" : "fallback";

  useEffect(() => {
    if (!src || kind === "video") return;
    const image = imageRef.current;
    if (!image?.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    loadedMediaUrls.add(src);
    setMediaState({ hasError: false, hasLoaded: true, src });
    onImageSize?.({
      height: image.naturalHeight,
      width: image.naturalWidth,
    });
  }, [kind, onImageSize, src]);

  return (
    <span
      aria-label={title}
      className={`media-thumb media-thumb-kind-${mediaKind} ${hasLoaded ? "is-loaded" : "is-loading"} ${hasError ? "is-error" : ""} ${className}`.trim()}
      role="img"
      style={style}
    >
      {src && !hasError && kind === "video" ? (
        <video
          ref={videoRef}
          className="media-thumb-media"
          muted
          onError={() => setMediaState({ hasError: true, hasLoaded: false, src })}
          onLoadedData={() => {
            loadedMediaUrls.add(src);
            setMediaState({ hasError: false, hasLoaded: true, src });
          }}
          playsInline
          preload="metadata"
          src={src}
          onLoadedMetadata={() => {
            const element = videoRef.current;
            if (!element) return;
            if (element.videoWidth > 0 && element.videoHeight > 0) {
              onImageSize?.({
                height: element.videoHeight,
                width: element.videoWidth,
              });
            }
            if (Number.isFinite(element.duration)) {
              element.currentTime = Math.min(Math.max(element.duration * 0.5, 0.35), 4);
            }
          }}
        />
      ) : null}
      {src && !hasError && kind !== "video" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imageRef}
          alt=""
          className="media-thumb-media"
          loading={loading}
          onError={() => setMediaState({ hasError: true, hasLoaded: false, src })}
          onLoad={(event) => {
            loadedMediaUrls.add(src);
            setMediaState({ hasError: false, hasLoaded: true, src });
            const image = event.currentTarget;
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
              onImageSize?.({
                height: image.naturalHeight,
                width: image.naturalWidth,
              });
            }
          }}
          src={src}
        />
      ) : null}
      {(!src || hasError) ? (
        <span className="media-thumb-fallback" aria-hidden="true">
          <FallbackIcon kind={kind} />
        </span>
      ) : null}
    </span>
  );
}
