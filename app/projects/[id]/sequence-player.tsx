"use client";

import { Loader2, Pause, Play, SkipBack } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ClipStrip } from "./clip-strip";

export type SequenceClip = {
  id: string;
  title: string;
  src?: string;
  /** Playback duration (seconds), matching generated clip duration when known. */
  playbackDuration?: number | null;
  /** Timed gap shown while the clip's media is still generating. */
  placeholder?: boolean;
  placeholderLabel?: string;
  /** Skip the first decoded presentation frame; used for continuous shared-keyframe cuts. */
  skipFirstFrame?: boolean;
};

export const DEFAULT_CLIP_DURATION = 4;

export function placeholderDuration(clip: SequenceClip) {
  return clip.playbackDuration && clip.playbackDuration > 0
    ? clip.playbackDuration
    : DEFAULT_CLIP_DURATION;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** Start the next clip this many seconds before the active one ends, so it is
 * already decoding frames when the boundary arrives (kills the flip freeze). */
const PREROLL_SECONDS = 0.12;

function drawPlaceholder(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const cw = canvas.width;
  const ch = canvas.height;
  context.fillStyle = "#101010";
  context.fillRect(0, 0, cw, ch);
  context.strokeStyle = "rgba(255,255,255,0.08)";
  context.lineWidth = 2;
  context.strokeRect(1, 1, cw - 2, ch - 2);
}

function letterboxColor() {
  if (typeof document === "undefined") return "#000000";
  return document.documentElement.getAttribute("data-theme") === "light" ? "#ffffff" : "#000000";
}

function drawVideoFrame(canvas: HTMLCanvasElement, video: HTMLVideoElement) {
  const context = canvas.getContext("2d");
  if (!context || video.readyState < 2) return false;
  const cw = canvas.width;
  const ch = canvas.height;
  const vw = video.videoWidth || cw;
  const vh = video.videoHeight || ch;
  const scale = Math.min(cw / vw, ch / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  context.fillStyle = letterboxColor();
  context.fillRect(0, 0, cw, ch);
  context.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  return true;
}

/**
 * Plays an ordered list of clips as ONE video, editor-style: every clip is a
 * hidden preloaded <video>, the active clip's frames are painted onto a
 * canvas via requestAnimationFrame, and a single scrubber spans the summed
 * duration with tick marks at clip boundaries.
 *
 * Two editor behaviors worth their complexity:
 * - Coalesced seeking: while scrubbing, a new currentTime is only issued once
 *   the previous seek completes; intermediate targets are dropped. Flooding a
 *   video element with seeks is what makes naive scrubbers stutter.
 * - Boundary pre-roll: the next clip starts (muted) just before the active
 *   one ends, then painting flips on `ended` — by which point the next video
 *   is already producing frames, so the cut is wall-clock continuous.
 */
export function SequencePlayer({ clips }: { clips: SequenceClip[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  const activeIndexRef = useRef(0);
  const playingRef = useRef(false);
  const rafRef = useRef<number>(0);
  /** Latest requested seek; applied only when the target video isn't mid-seek.
   * `issued` guards against re-seeking forever when the browser snaps the
   * landed time to a frame boundary instead of the exact request. */
  const pendingSeekRef = useRef<{ index: number; time: number; issued: boolean } | null>(
    null,
  );
  const placeholderClockRef = useRef<{ global: number; clock: number } | null>(null);
  const currentTimeRef = useRef(0);
  const scrubbingRef = useRef(false);
  const resumeAfterScrubRef = useRef(false);

  const [durations, setDurations] = useState<(number | null)[]>(() =>
    clips.map((clip) => (clip.placeholder ? placeholderDuration(clip) : null)),
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  const ready = durations.every((duration) => duration !== null);
  const offsets = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const duration of durations) {
      out.push(acc);
      acc += duration ?? 0;
    }
    return out;
  }, [durations]);
  const total = useMemo(
    () => durations.reduce<number>((acc, duration) => acc + (duration ?? 0), 0),
    [durations],
  );

  useEffect(() => {
    const paint = () => {
      const index = activeIndexRef.current;
      const clip = clips[index];
      const video = videoRefs.current[index];

      // Apply at most one outstanding seek per completed seek (coalescing).
      const pending = pendingSeekRef.current;
      if (pending && !clips[pending.index]?.placeholder) {
        const target = videoRefs.current[pending.index];
        if (target && !target.seeking) {
          if (!pending.issued) {
            pending.issued = true;
            target.currentTime = pending.time;
          } else {
            // Seek completed (possibly frame-snapped); accept the result.
            pendingSeekRef.current = null;
          }
        }
      }

      const canvas = canvasRef.current;
      if (canvas && clip?.placeholder) {
        drawPlaceholder(canvas);
      } else if (canvas && video && video.readyState >= 2) {
        drawVideoFrame(canvas, video);
      }

      if (clip?.placeholder) {
        if (!scrubbingRef.current) {
          const anchor =
            placeholderClockRef.current ?? {
              global: currentTimeRef.current,
              clock: performance.now() / 1000,
            };
          placeholderClockRef.current = anchor;
          const global = playingRef.current
            ? anchor.global + (performance.now() / 1000 - anchor.clock)
            : currentTimeRef.current;
          const clipEnd = (offsets[index] ?? 0) + (durations[index] ?? 0);
          const clampedGlobal = Math.min(global, clipEnd);
          setCurrentTime(clampedGlobal);

          if (playingRef.current && clampedGlobal >= clipEnd - 0.01) {
            const nextVideo = videoRefs.current[index + 1];
            if (index + 1 < clips.length) {
              activeIndexRef.current = index + 1;
              setActiveIndex(index + 1);
              setCurrentTime(clipEnd);
              placeholderClockRef.current = {
                global: clipEnd,
                clock: performance.now() / 1000,
              };
              if (nextVideo) {
                nextVideo.muted = false;
                nextVideo.currentTime = 0;
                void nextVideo.play().catch(() => {});
              }
            } else {
              playingRef.current = false;
              setPlaying(false);
            }
          }
        }
      } else if (video) {
        placeholderClockRef.current = null;
        // While the user drags, the slider value is the source of truth.
        if (!scrubbingRef.current && !pendingSeekRef.current) {
          setCurrentTime(
            (offsets[index] ?? 0) + (video.currentTime || 0),
          );
        }

        if (playingRef.current) {
          const nextVideo = videoRefs.current[index + 1];
          const eff = effectiveDuration(index, video.duration);
          const remaining = eff - video.currentTime;

          // Pre-roll: warm the next clip just before the boundary.
          if (
            nextVideo &&
            remaining > 0 &&
            remaining <= PREROLL_SECONDS &&
            nextVideo.paused
          ) {
            nextVideo.muted = true;
            nextVideo.currentTime = 0;
            void nextVideo.play().catch(() => {});
          }

          // Advance at the configured clip end, not the raw media end.
          if (video.ended || video.currentTime >= eff - 0.01) {
            if (index + 1 < clips.length) {
              video.muted = true;
              activeIndexRef.current = index + 1;
              setActiveIndex(index + 1);
              const nextOffset = offsets[index + 1] ?? offsets[index] ?? 0;
              setCurrentTime(nextOffset);
              if (nextVideo) {
                nextVideo.muted = false;
                if (nextVideo.paused) {
                  nextVideo.currentTime = 0;
                  void nextVideo.play().catch(() => {});
                }
              } else {
                placeholderClockRef.current = {
                  global: nextOffset,
                  clock: performance.now() / 1000,
                };
              }
            } else {
              playingRef.current = false;
              setPlaying(false);
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(paint);
    };
    rafRef.current = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(rafRef.current);
    // effectiveDuration reads stable refs/props; rebinding per offsets is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offsets]);

  // Effective duration: configured clip length, capped to real media length.
  function effectiveDuration(index: number, mediaDuration: number) {
    if (clips[index]?.placeholder) return placeholderDuration(clips[index]!);
    const playbackDuration = clips[index]?.playbackDuration;
    const media = Number.isFinite(mediaDuration) ? mediaDuration : 0;
    return playbackDuration && playbackDuration > 0 ? Math.min(playbackDuration, media) : media;
  }

  // Size the canvas backing store from the first clip's real dimensions.
  function handleMetadata(index: number, video: HTMLVideoElement) {
    const effective = effectiveDuration(index, video.duration);
    setDurations((current) => {
      if (current[index] === effective) return current;
      const next = [...current];
      next[index] = effective;
      return next;
    });
    const canvas = canvasRef.current;
    if (index === 0 && canvas && video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    if (index === activeIndexRef.current && canvas) {
      drawVideoFrame(canvas, video);
    }
  }

  function handleLoadedData(index: number, video: HTMLVideoElement) {
    const canvas = canvasRef.current;
    if (!canvas || index !== activeIndexRef.current) return;
    if (video.videoWidth && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    drawVideoFrame(canvas, video);
  }

  function pauseAll() {
    for (const video of videoRefs.current) {
      if (video && !video.paused) video.pause();
      // Imperative media-element control, not React state.
      if (video) video.muted = true;
    }
  }

  function seekTo(globalSeconds: number) {
    const clamped = Math.max(0, Math.min(globalSeconds, Math.max(total - 0.05, 0)));
    let index = 0;
    for (let i = 0; i < offsets.length; i += 1) {
      if (clamped >= offsets[i]) index = i;
    }
    const localTime = clamped - offsets[index];
    const clip = clips[index];

    if (index !== activeIndexRef.current) {
      const wasPlaying = playingRef.current && !scrubbingRef.current;
      pauseAll();
      activeIndexRef.current = index;
      setActiveIndex(index);
      pendingSeekRef.current = clip?.placeholder
        ? null
        : { index, time: localTime, issued: false };
      placeholderClockRef.current = clip?.placeholder
        ? { global: clamped, clock: performance.now() / 1000 }
        : null;
      const video = videoRefs.current[index];
      if (video && wasPlaying) {
        video.muted = false;
        void video.play().catch(() => {});
      }
    } else {
      // Same clip: just retarget the coalesced seek — no pause/mute churn.
      pendingSeekRef.current = clip?.placeholder
        ? null
        : { index, time: localTime, issued: false };
      if (clip?.placeholder) {
        placeholderClockRef.current = { global: clamped, clock: performance.now() / 1000 };
      }
    }
    setCurrentTime(clamped);
  }

  function beginScrub() {
    scrubbingRef.current = true;
    resumeAfterScrubRef.current = playingRef.current;
    if (playingRef.current) {
      playingRef.current = false;
      setPlaying(false);
      videoRefs.current[activeIndexRef.current]?.pause();
    }
  }

  function endScrub() {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    if (resumeAfterScrubRef.current) {
      resumeAfterScrubRef.current = false;
      playingRef.current = true;
      setPlaying(true);
      const video = videoRefs.current[activeIndexRef.current];
      if (video) {
        video.muted = false;
        void video.play().catch(() => {});
      } else {
        placeholderClockRef.current = {
          global: currentTime,
          clock: performance.now() / 1000,
        };
      }
    }
  }

  function togglePlay() {
    const clip = clips[activeIndexRef.current];
    const video = videoRefs.current[activeIndexRef.current];
    if (playingRef.current) {
      playingRef.current = false;
      setPlaying(false);
      video?.pause();
      return;
    }
    // Restart from the top when play is hit at the very end.
    if (currentTime >= total - 0.1 && total > 0) {
      seekTo(0);
    }
    playingRef.current = true;
    setPlaying(true);
    const target = videoRefs.current[activeIndexRef.current];
    if (clip?.placeholder) {
      placeholderClockRef.current = {
        global: currentTime,
        clock: performance.now() / 1000,
      };
      return;
    }
    if (target) {
      target.muted = false;
      void target.play().catch(() => {
        playingRef.current = false;
        setPlaying(false);
      });
    }
  }

  const activeClip = clips[activeIndex];

  return (
    <div className="player-surface flex min-h-0 flex-1 flex-col gap-2">
      {/* "grid" is avoided throughout: globals.css redefines .grid as 2 columns. */}
      <div
        className="video-stage-frame relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
      >
        <div className="video-stage relative overflow-hidden">
          <canvas ref={canvasRef} className="player-canvas" width={1280} height={720} />
          {ready && activeClip?.placeholder ? (
            <div className="generating-clip-overlay">
              <Loader2 size={16} className="generating-clip-spinner" />
              <span>{activeClip.placeholderLabel ?? "Generating"}</span>
            </div>
          ) : null}
          {!ready ? (
            <span className="absolute text-sm text-white/70">Loading {clips.length} clips…</span>
          ) : null}
          {/* Hidden buffered sources; the canvas is the single visible surface. */}
          {clips.map((clip, index) =>
            clip.placeholder || !clip.src ? null : (
              <video
                key={`${clip.id}-${index}`}
                ref={(element) => {
                  videoRefs.current[index] = element;
                }}
                src={clip.src}
                preload="auto"
                playsInline
                muted
                className="hidden"
                onLoadedMetadata={(event) => handleMetadata(index, event.currentTarget)}
                onLoadedData={(event) => handleLoadedData(index, event.currentTarget)}
              />
            ),
          )}
          <div className="video-controls">
            <button
              className="video-control-button"
              onClick={() => seekTo(0)}
              title="Back to start"
            >
              <SkipBack size={19} />
            </button>
            <button
              className="video-control-button"
              onClick={togglePlay}
              disabled={!ready}
              title={playing ? "Pause" : "Play"}
            >
              {playing ? <Pause size={21} /> : <Play size={21} />}
            </button>
            <div className="video-scrubber-wrap">
              <input
                type="range"
                className="video-scrubber"
                min={0}
                max={Math.max(total, 0.01)}
                step={0.01}
                value={Math.min(currentTime, total)}
                disabled={!ready}
                onPointerDown={beginScrub}
                onPointerUp={endScrub}
                onPointerCancel={endScrub}
                onBlur={endScrub}
                onChange={(event) => seekTo(Number(event.target.value))}
              />
              <div className="video-boundary-ticks">
                {offsets.slice(1).map((offset, index) =>
                  total > 0 ? (
                    <span
                      key={index}
                      className="video-boundary-tick"
                      style={{ left: `${(offset / total) * 100}%` }}
                    />
                  ) : null,
                )}
              </div>
            </div>
            <span className="video-time">
              {formatTime(currentTime)} / {formatTime(total)}
            </span>
          </div>
        </div>
      </div>

      <ClipStrip
        clips={clips}
        activeIndex={activeIndex}
        onSelect={(index) => seekTo(offsets[index] ?? 0)}
      />
    </div>
  );
}
