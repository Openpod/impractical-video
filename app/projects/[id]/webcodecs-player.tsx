"use client";

import { Loader2, Pause, Play, SkipBack } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DataStream, Endianness, createFile } from "mp4box";
import { placeholderDuration, type SequenceClip } from "./sequence-player";
import { ClipStrip } from "./clip-strip";

/**
 * WebCodecs sequence player — the technique real web video editors use.
 *
 * Instead of <video> elements (whose seek latency and play() spin-up cause
 * scrub stutter and boundary freezes), each clip is fetched once, demuxed to
 * encoded samples (mp4box), and decoded with a hardware VideoDecoder. We own
 * the frame queue and the clock:
 *  - playback presents decoded VideoFrames against an AudioContext clock,
 *    feeding the decoder a few frames ahead;
 *  - scrubbing decodes from the nearest keyframe to the exact target frame
 *    (coalesced: one decode burst in flight, newest drag target wins);
 *  - the next clip's decoder is pre-fed before a boundary, so cuts are
 *    seamless;
 *  - audio tracks (when present) are decoded to AudioBuffers and scheduled
 *    sample-accurately on the shared AudioContext.
 *
 * Any engine failure (unsupported codec, demux error) calls onFallback so the
 * parent can swap in the element-based player.
 */

type EncodedSample = {
  data: Uint8Array;
  /** Presentation time, seconds. */
  ts: number;
  dur: number;
  key: boolean;
};

type DemuxedClip = {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description: Uint8Array | null;
  samples: EncodedSample[];
  duration: number;
  audio: AudioBuffer | null;
};

function proxied(url: string) {
  if (url.startsWith("/")) return url;
  return `/api/media-proxy?url=${encodeURIComponent(url)}`;
}

/* mp4box's public types are minified re-exports; keep our touch points loose. */

function extractDescription(file: any, trackId: number): Uint8Array | null {
  const trak = file.getTrackById(trackId);
  for (const entry of trak?.mdia?.minf?.stbl?.stsd?.entries ?? []) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer as ArrayBuffer, 8); // strip box header
    }
  }
  return null;
}

async function demuxClip(
  url: string,
  audioContext: AudioContext | null,
): Promise<DemuxedClip> {
  const response = await fetch(proxied(url));
  if (!response.ok) throw new Error(`Fetch failed (${response.status}).`);
  const bytes = await response.arrayBuffer();

  const demuxed = await new Promise<Omit<DemuxedClip, "audio">>(
    (resolve, reject) => {
      const file = createFile();
      let info: any = null;
      const samples: EncodedSample[] = [];
      file.onError = (error: unknown) =>
        reject(new Error(`Demux failed: ${String(error)}`));
      file.onReady = (readyInfo: any) => {
        info = readyInfo;
        const video = readyInfo.videoTracks?.[0];
        if (!video) {
          reject(new Error("No video track."));
          return;
        }
        file.setExtractionOptions(video.id, null, { nbSamples: Infinity });
        file.start();
      };
      file.onSamples = (_id: number, _user: unknown, batch: any[]) => {
        for (const sample of batch) {
          samples.push({
            data: new Uint8Array(sample.data),
            ts: sample.cts / sample.timescale,
            dur: sample.duration / sample.timescale,
            key: Boolean(sample.is_sync),
          });
        }
        const video = info?.videoTracks?.[0];
        if (video && samples.length >= video.nb_samples) {
          // Samples stay in DECODE order (as delivered): with B-frames,
          // presentation order differs, and a decoder fed out of decode
          // order produces reference-less macroblock garbage.
          resolve({
            codec: video.codec,
            codedWidth: video.video?.width ?? video.track_width,
            codedHeight: video.video?.height ?? video.track_height,
            description: extractDescription(file, video.id),
            samples,
            duration:
              video.duration && video.timescale
                ? video.duration / video.timescale
                : samples.reduce((max, sample) => Math.max(max, sample.ts + sample.dur), 0),
          });
        }
      };
      const buffer = bytes.slice(0) as ArrayBuffer & { fileStart: number };
      buffer.fileStart = 0;
      file.appendBuffer(buffer);
      file.flush();
    },
  );

  let audio: AudioBuffer | null = null;
  if (audioContext) {
    // decodeAudioData extracts the first audio track from the container;
    // silent clips (no audio track) simply reject.
    audio = await audioContext.decodeAudioData(bytes.slice(0)).catch(() => null);
  }
  return { ...demuxed, audio };
}

const FEED_AHEAD = 10;

/** Letterbox bars follow the theme: white in light mode, black in dark mode. */
function letterboxColor() {
  if (typeof document === "undefined") return "#000000";
  return document.documentElement.getAttribute("data-theme") === "light" ? "#ffffff" : "#000000";
}

/** Letterbox-draw any image source (VideoFrame or ImageBitmap) onto the canvas. */
function drawContain(
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
) {
  const cw = canvas.width;
  const ch = canvas.height;
  const vw = sourceW || cw;
  const vh = sourceH || ch;
  const scale = Math.min(cw / vw, ch / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  context.fillStyle = letterboxColor();
  context.fillRect(0, 0, cw, ch);
  context.drawImage(source, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
}

function drawPlaceholder(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
  context.fillStyle = "#101010";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "rgba(255,255,255,0.08)";
  context.lineWidth = 2;
  context.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
}

function firstPresentationFrameDuration(clip: DemuxedClip) {
  const first = clip.samples.reduce<EncodedSample | null>(
    (best, sample) => (!best || sample.ts < best.ts ? sample : best),
    null,
  );
  return first && first.dur > 0 ? first.dur : 0;
}

/**
 * Decode just a clip's first frame once, as an ImageBitmap "poster". Seeking to
 * a cold clip (e.g. scrolling the clip strip) can then paint the right clip
 * instantly while its real decoder spins up, instead of leaving a stale frame.
 */
async function decodePoster(clip: DemuxedClip): Promise<ImageBitmap | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (bitmap: ImageBitmap | null) => {
      if (settled) return;
      settled = true;
      resolve(bitmap);
    };
    let decoder: VideoDecoder | null = null;
    try {
      decoder = new VideoDecoder({
        output: (frame) => {
          void createImageBitmap(frame)
            .then((bitmap) => {
              frame.close();
              try {
                decoder?.close();
              } catch {
                // already closed
              }
              finish(bitmap);
            })
            .catch(() => {
              frame.close();
              finish(null);
            });
        },
        error: () => finish(null),
      });
      decoder.configure({
        codec: clip.codec,
        codedWidth: clip.codedWidth,
        codedHeight: clip.codedHeight,
        ...(clip.description ? { description: clip.description as BufferSource } : {}),
      });
      const first = clip.samples[0];
      if (!first) return finish(null);
      decoder.decode(
        new EncodedVideoChunk({
          type: "key",
          timestamp: Math.round(first.ts * 1e6),
          duration: Math.round(first.dur * 1e6),
          data: first.data as BufferSource,
        }),
      );
      void decoder.flush().catch(() => finish(null));
    } catch {
      finish(null);
    }
    // Safety net so a stuck decoder never holds the promise open.
    setTimeout(() => finish(null), 3000);
  });
}

/** One clip's decoder, frame queue, and GOP-aware feeding. */
class ClipEngine {
  private decoder: VideoDecoder | null = null;
  private queue: VideoFrame[] = [];
  private feedIndex = 0;
  private flushed = false;
  /** Index of the keyframe the current decode run started from. */
  private gopKeyIndex = -1;

  constructor(
    private clip: DemuxedClip,
    private onError: (error: Error) => void,
  ) {}

  private config(): VideoDecoderConfig {
    return {
      codec: this.clip.codec,
      codedWidth: this.clip.codedWidth,
      codedHeight: this.clip.codedHeight,
      ...(this.clip.description
        ? { description: this.clip.description as BufferSource }
        : {}),
    };
  }

  private ensureDecoder() {
    if (this.decoder && this.decoder.state !== "closed") return;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.queue.push(frame);
        this.queue.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      },
      error: (error) => this.onError(error as Error),
    });
    this.decoder.configure(this.config());
  }

  private keyIndexAtOrBefore(timeS: number): number {
    // Samples are in decode order, so cts is not monotonic — scan everything
    // and keep the last keyframe whose presentation time is at/before target.
    let key = 0;
    let keyTs = -Infinity;
    for (let i = 0; i < this.clip.samples.length; i += 1) {
      const sample = this.clip.samples[i];
      if (sample.key && sample.ts <= timeS && sample.ts > keyTs) {
        key = i;
        keyTs = sample.ts;
      }
    }
    return key;
  }

  private clearQueue() {
    for (const frame of this.queue) frame.close();
    this.queue = [];
  }

  /** Restart decoding from the GOP containing timeS. */
  resetTo(timeS: number) {
    this.ensureDecoder();
    if (this.decoder!.state === "configured") this.decoder!.reset();
    this.decoder!.configure(this.config());
    this.clearQueue();
    this.feedIndex = this.keyIndexAtOrBefore(timeS);
    this.gopKeyIndex = this.feedIndex;
    this.flushed = false;
  }

  /**
   * True when `timeS` is decodable by continuing the current run (same or a
   * later GOP, target not behind what we already presented past).
   */
  canContinueTo(timeS: number) {
    if (this.gopKeyIndex < 0) return false;
    const earliest = this.queue[0]?.timestamp;
    const queueStart = earliest !== undefined ? earliest / 1e6 : null;
    const gopStart = this.clip.samples[this.gopKeyIndex]?.ts ?? 0;
    return timeS >= (queueStart ?? gopStart);
  }

  feed() {
    if (!this.decoder || this.decoder.state !== "configured") return;
    while (
      this.feedIndex < this.clip.samples.length &&
      this.queue.length + this.decoder.decodeQueueSize < FEED_AHEAD
    ) {
      const sample = this.clip.samples[this.feedIndex];
      this.decoder.decode(
        new EncodedVideoChunk({
          type: sample.key ? "key" : "delta",
          timestamp: Math.round(sample.ts * 1e6),
          duration: Math.round(sample.dur * 1e6),
          data: sample.data as BufferSource,
        }),
      );
      this.feedIndex += 1;
    }
    if (this.feedIndex >= this.clip.samples.length && !this.flushed) {
      this.flushed = true;
      void this.decoder.flush().catch(() => {});
    }
  }

  /**
   * Draw the frame for `timeS` if decoded. Frames older than the target are
   * closed; the presented frame is kept for repaints. Returns whether a
   * frame at/before timeS was drawn.
   */
  present(
    timeS: number,
    context: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    requireReached = false,
  ) {
    const targetUs = timeS * 1e6;
    while (
      this.queue.length > 1 &&
      (this.queue[1].timestamp ?? 0) <= targetUs
    ) {
      this.queue.shift()!.close();
    }
    const frame = this.queue[0];
    if (!frame || (frame.timestamp ?? 0) > targetUs + (frame.duration ?? 0)) {
      return false;
    }
    // While seeking, don't paint an intermediate frame from a fresh decode run
    // (e.g. the GOP keyframe after a backward seek) — that causes a first-frame
    // flash. Wait until decode has actually reached the target: a queued frame
    // past it exists, or the stream is fully decoded.
    if (requireReached) {
      const reached =
        this.flushed || this.queue.some((f) => (f.timestamp ?? 0) > targetUs);
      if (!reached) return false;
    }
    drawContain(frame, frame.displayWidth, frame.displayHeight, context, canvas);
    return true;
  }

  get duration() {
    return this.clip.duration;
  }

  get audio() {
    return this.clip.audio;
  }

  dispose() {
    this.clearQueue();
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
  }
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

const BOUNDARY_PREFEED_S = 0.5;

export function WebCodecsSequencePlayer({
  clips,
  onFallback,
}: {
  clips: SequenceClip[];
  onFallback: (reason: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const enginesRef = useRef<(ClipEngine | null)[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const rafRef = useRef(0);

  const playingRef = useRef(false);
  /** Media-time anchor: mediaTime = anchorMedia + (clockNow - anchorClock). */
  const anchorRef = useRef({ media: 0, clock: 0 });
  const mediaTimeRef = useRef(0);
  const scrubRef = useRef<{
    target: number | null;
    lastTarget: number | null;
    direction: "forward" | "backward" | null;
    resume: boolean;
    active: boolean;
  }>({
    target: null,
    lastTarget: null,
    direction: null,
    resume: false,
    active: false,
  });
  const fallbackRef = useRef(false);
  /** First-frame thumbnail per clip, for instant cold-seek paints. */
  const postersRef = useRef<(ImageBitmap | null)[]>([]);

  const [loadedCount, setLoadedCount] = useState(0);
  const [ready, setReady] = useState(false);
  const [durations, setDurations] = useState<number[]>([]);
  const [trimStarts, setTrimStarts] = useState<number[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const offsets = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const duration of durations) {
      out.push(acc);
      acc += duration;
    }
    return out;
  }, [durations]);
  const total = useMemo(
    () => durations.reduce((acc, duration) => acc + duration, 0),
    [durations],
  );

  const fail = (reason: string) => {
    if (fallbackRef.current) return;
    fallbackRef.current = true;
    onFallback(reason);
  };

  function clockNow() {
    const ctx = audioCtxRef.current;
    return ctx && ctx.state === "running"
      ? ctx.currentTime
      : performance.now() / 1000;
  }

  function clipAt(globalS: number): { index: number; local: number } {
    let index = 0;
    for (let i = 0; i < offsets.length; i += 1) {
      if (globalS >= offsets[i]) index = i;
    }
    return { index, local: globalS - offsets[index] };
  }

  function stopAudio() {
    for (const source of audioSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    audioSourcesRef.current = [];
  }

  function scheduleAudio(fromGlobalS: number) {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    stopAudio();
    const startCtx = ctx.currentTime;
    enginesRef.current.forEach((engine, index) => {
      const buffer = engine?.audio;
      if (!buffer) return;
      const clipStart = offsets[index] ?? 0;
      // Cap audio to the configured clip length so it doesn't bleed over.
      const clipDuration = durations[index] ?? buffer.duration;
      const trimStart = trimStarts[index] ?? 0;
      const localStart = fromGlobalS - clipStart;
      if (localStart >= clipDuration) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      if (localStart >= 0) {
        source.start(startCtx, trimStart + localStart, clipDuration - localStart);
      } else {
        source.start(startCtx + -localStart, trimStart, clipDuration);
      }
      audioSourcesRef.current.push(source);
    });
  }

  // Demux everything up front (clips are short); engines are created lazily.
  useEffect(() => {
    let cancelled = false;
    const audioCtx =
      typeof AudioContext !== "undefined" ? new AudioContext() : null;
    audioCtxRef.current = audioCtx;

    void (async () => {
      try {
        const demuxed = await Promise.all(
          clips.map(async (clip) => {
            if (clip.placeholder || !clip.src) {
              if (!cancelled) setLoadedCount((count) => count + 1);
              return null;
            }
            const result = await demuxClip(clip.src, audioCtx);
            if (!cancelled) setLoadedCount((count) => count + 1);
            return result;
          }),
        );
        if (cancelled) return;
        enginesRef.current = demuxed.map(
          (clip) => (clip ? new ClipEngine(clip, (error) => fail(error.message)) : null),
        );
        const firstMedia = demuxed.find((clip): clip is DemuxedClip => Boolean(clip));
        const canvas = canvasRef.current;
        if (firstMedia && canvas) {
          canvas.width = firstMedia.codedWidth;
          canvas.height = firstMedia.codedHeight;
        }
        const nextTrimStarts = demuxed.map((clip, i) =>
          clip && clips[i]?.skipFirstFrame ? firstPresentationFrameDuration(clip) : 0,
        );
        setTrimStarts(nextTrimStarts);
        // Use the configured clip duration (capped to real length), then remove
        // the exact first decoded presentation frame for continuous shared-keyframe clips.
        setDurations(
          demuxed.map((clip, i) => {
            if (!clip) return placeholderDuration(clips[i]!);
            const playbackDuration = clips[i]?.playbackDuration;
            const effective = playbackDuration && playbackDuration > 0
              ? Math.min(playbackDuration, clip.duration)
              : clip.duration;
            return Math.max(0.05, effective - nextTrimStarts[i]);
          }),
        );
        setReady(true);
        // Decode the first frame so the canvas isn't black.
        enginesRef.current.find(Boolean)?.resetTo(0);
        // Decode every clip's poster in the background; cold seeks (clip-strip
        // scrolling) paint these instantly while the real decoder catches up.
        void Promise.all(demuxed.map((clip) => (clip ? decodePoster(clip) : null))).then(
          (posters) => {
            if (cancelled) {
              for (const poster of posters) poster?.close();
              return;
            }
            postersRef.current = posters;
            const firstPoster = posters.find(Boolean);
            const canvas = canvasRef.current;
            const context = canvas?.getContext("2d");
            if (firstPoster && canvas && context && mediaTimeRef.current < 0.05) {
              drawContain(firstPoster, firstPoster.width, firstPoster.height, context, canvas);
            }
          },
        );
      } catch (error) {
        fail(error instanceof Error ? error.message : "Demux failed.");
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      stopAudio();
      for (const engine of enginesRef.current) engine?.dispose();
      enginesRef.current = [];
      for (const poster of postersRef.current) poster?.close();
      postersRef.current = [];
      void audioCtx?.close().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips]);

  // Render/present loop.
  useEffect(() => {
    if (!ready) return;
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;

      // Coalesced scrub handling: retarget cheaply; reset only when needed.
      const scrub = scrubRef.current;
      if (scrub.target !== null) {
        const { index, local } = clipAt(scrub.target);
        if (clips[index]?.placeholder) {
          drawPlaceholder(canvas, context);
          mediaTimeRef.current = scrub.target;
          scrub.target = null;
          setActiveIndex((current) => (current === index ? current : index));
          if (!scrubRef.current.active) setCurrentTime(scrub.target ?? mediaTimeRef.current);
          return;
        }
        const engine = enginesRef.current[index];
        if (engine) {
          if (!engine.canContinueTo(local)) engine.resetTo(local);
          engine.feed();
          // ALWAYS wait for the exact target frame while scrubbing. After a
          // reset the decoder emits the GOP keyframe and every frame between it
          // and the target on the way there; painting any of those (the partial
          // catch-up frames) is the backward "first-frame" flicker. A per-frame
          // "did we just reset" gate can't help, because decode catch-up spans
          // many frames where canContinueTo() flips back to true. Forward
          // continuation already has frames past the target queued, so reached
          // is satisfied immediately and this still paints instantly.
          if (engine.present(local, context, canvas, true)) {
            mediaTimeRef.current = scrub.target;
            scrub.target = null;
          } else if (local < 0.05 && !scrub.active) {
            // Cold clip-start jump (clip-strip scroll): paint the poster now so
            // the canvas snaps to the right clip instead of freezing. While
            // actively dragging, keep holding the last good frame until the
            // exact target is decoded; otherwise the poster is another
            // first-frame flash path.
            const poster = postersRef.current[index];
            if (poster) drawContain(poster, poster.width, poster.height, context, canvas);
          }
        }
        return;
      }

      if (playingRef.current) {
        mediaTimeRef.current =
          anchorRef.current.media + (clockNow() - anchorRef.current.clock);
      }
      const media = Math.min(mediaTimeRef.current, Math.max(total - 1e-3, 0));
      const { index, local } = clipAt(media);
      const trimStart = trimStarts[index] ?? 0;
      const mediaLocal = playingRef.current ? local + trimStart : local;
      const engine = enginesRef.current[index];

      setActiveIndex((current) => (current === index ? current : index));
      if (!scrubRef.current.active) setCurrentTime(media);

      if (clips[index]?.placeholder || !engine) {
        drawPlaceholder(canvas, context);
        if (playingRef.current && media >= total - 1e-3) {
          playingRef.current = false;
          setPlaying(false);
          stopAudio();
        }
        return;
      }

      if (!engine.canContinueTo(mediaLocal)) engine.resetTo(mediaLocal);
      engine.feed();
      engine.present(mediaLocal, context, canvas, playingRef.current && trimStart > 0 && local < 0.05);

      if (playingRef.current) {
        // Pre-feed the next clip's decoder before the boundary.
        const remaining = (durations[index] ?? 0) - local;
        const next = clips[index + 1]?.placeholder ? null : enginesRef.current[index + 1];
        if (next && remaining <= BOUNDARY_PREFEED_S) {
          const nextStart = trimStarts[index + 1] ?? 0;
          if (!next.canContinueTo(nextStart)) next.resetTo(nextStart);
          next.feed();
        }
        if (media >= total - 1e-3) {
          playingRef.current = false;
          setPlaying(false);
          stopAudio();
        }
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, offsets, durations, total]);

  function play() {
    if (!ready) return;
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
    if (mediaTimeRef.current >= total - 0.05 && total > 0) {
      mediaTimeRef.current = 0;
      const engine = enginesRef.current[0];
      engine?.resetTo(0);
    }
    anchorRef.current = { media: mediaTimeRef.current, clock: clockNow() };
    playingRef.current = true;
    setPlaying(true);
    scheduleAudio(mediaTimeRef.current);
  }

  function pause() {
    playingRef.current = false;
    setPlaying(false);
    stopAudio();
  }

  function seek(globalS: number) {
    const clamped = Math.max(0, Math.min(globalS, Math.max(total - 1e-3, 0)));
    const scrub = scrubRef.current;
    const previous = scrub.lastTarget ?? mediaTimeRef.current;
    if (clamped < previous - 1e-4) scrub.direction = "backward";
    else if (clamped > previous + 1e-4) scrub.direction = "forward";
    scrub.target = clamped;
    scrub.lastTarget = clamped;
    setCurrentTime(clamped);
    if (playingRef.current) {
      anchorRef.current = { media: clamped, clock: clockNow() };
      scheduleAudio(clamped);
    }
  }

  function beginScrub() {
    scrubRef.current.active = true;
    scrubRef.current.lastTarget = currentTime;
    scrubRef.current.direction = null;
    scrubRef.current.resume = playingRef.current;
    if (playingRef.current) pause();
  }

  function endScrub() {
    if (!scrubRef.current.active) return;
    scrubRef.current.active = false;
    scrubRef.current.target = currentTime;
    scrubRef.current.lastTarget = currentTime;
    scrubRef.current.direction = null;
    if (scrubRef.current.resume) {
      scrubRef.current.resume = false;
      mediaTimeRef.current = currentTime;
      play();
    }
  }

  const firstSize = durations.length > 0;
  const activeClip = clips[activeIndex];

  return (
    <div className="player-surface flex min-h-0 flex-1 flex-col gap-2">
      <div
        className="video-stage-frame relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
      >
        <div className="video-stage relative overflow-hidden">
          <canvas
            ref={canvasRef}
            className="player-canvas"
            width={1280}
            height={720}
          />
          {!ready ? (
            <span className="absolute text-sm text-white/70">
              Preparing clips… {loadedCount}/{clips.length}
            </span>
          ) : null}
          {ready && activeClip?.placeholder ? (
            <div className="generating-clip-overlay">
              <Loader2 size={16} className="generating-clip-spinner" />
              <span>{activeClip.placeholderLabel ?? "Generating"}</span>
            </div>
          ) : null}
          <div className="video-controls">
            <button
              className="video-control-button"
              onClick={() => seek(0)}
              title="Back to start"
            >
              <SkipBack size={19} />
            </button>
            <button
              className="video-control-button"
              onClick={() => (playing ? pause() : play())}
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
                step={0.001}
                value={Math.min(currentTime, total)}
                disabled={!ready}
                onPointerDown={beginScrub}
                onPointerUp={endScrub}
                onPointerCancel={endScrub}
                onBlur={endScrub}
                onChange={(event) => seek(Number(event.target.value))}
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

      {firstSize ? (
        <ClipStrip
          clips={clips}
          activeIndex={activeIndex}
          onSelect={(index) => seek(offsets[index] ?? 0)}
        />
      ) : null}
    </div>
  );
}
