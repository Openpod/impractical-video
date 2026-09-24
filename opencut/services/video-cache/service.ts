import {
	Input,
	ALL_FORMATS,
	BlobSource,
	CanvasSink,
	type WrappedCanvas,
} from "mediabunny";

interface VideoSinkData {
	input: Input;
	sink: CanvasSink;
	iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null;
	currentFrame: WrappedCanvas | null;
	queue: WrappedCanvas[];
	lastTime: number;
	prefetching: boolean;
	prefetchPromise: Promise<void> | null;
}

/** Decoded frames buffered ahead of the playhead. One-frame lookahead made
 * playback cadence hostage to every slow decode; a small queue absorbs decode
 * spikes so displayed frames stay evenly spaced. */
const PREFETCH_DEPTH = 4;

export class VideoCache {
	private sinks = new Map<string, VideoSinkData>();
	private initPromises = new Map<string, Promise<void>>();
	private frameChain = new Map<string, Promise<unknown>>();
	private seekGenerations = new Map<string, number>();
	private warming = new Set<string>();

	async getFrameAt({
		mediaId,
		file,
		time,
	}: {
		mediaId: string;
		file: File;
		time: number;
	}): Promise<WrappedCanvas | null> {
		await this.ensureSink({ mediaId, file });

		const sinkData = this.sinks.get(mediaId);
		if (!sinkData) return null;

		const generation = (this.seekGenerations.get(mediaId) ?? 0) + 1;
		this.seekGenerations.set(mediaId, generation);

		const previous = this.frameChain.get(mediaId) ?? Promise.resolve();
		const current = previous.then(() => {
			if (this.seekGenerations.get(mediaId) !== generation) {
				return sinkData.currentFrame ?? null;
			}
			return this.resolveFrame({ sinkData, time });
		});
		this.frameChain.set(
			mediaId,
			current.catch(() => {}),
		);
		return current;
	}

	/** Fire-and-forget decoder warm-up for a clip about to start: parses the
	 * container, initializes the decoder, seeks, and buffers the first frames
	 * so the first real getFrameAt returns instantly. No-op when the sink is
	 * already live. */
	async warmFrameAt({
		mediaId,
		file,
		time,
	}: {
		mediaId: string;
		file: File;
		time: number;
	}): Promise<void> {
		if (this.warming.has(mediaId)) return;
		const sinkData = this.sinks.get(mediaId);
		if (sinkData && (sinkData.currentFrame || sinkData.iterator)) return;
		this.warming.add(mediaId);
		try {
			await this.getFrameAt({ mediaId, file, time });
		} catch {
			// Warm-up is best-effort; the real request surfaces errors.
		} finally {
			this.warming.delete(mediaId);
		}
	}

	private async resolveFrame({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		while (
			sinkData.queue.length &&
			sinkData.queue[0].timestamp <= time
		) {
			sinkData.currentFrame = sinkData.queue.shift() ?? null;
			if (sinkData.currentFrame) sinkData.lastTime = sinkData.currentFrame.timestamp;
		}

		if (
			sinkData.currentFrame &&
			this.isFrameValid({ frame: sinkData.currentFrame, time })
		) {
			this.startPrefetch({ sinkData });
			return sinkData.currentFrame;
		}

		if (
			sinkData.iterator &&
			sinkData.currentFrame &&
			time >= sinkData.lastTime &&
			time < sinkData.lastTime + 2.0
		) {
			const frame = await this.iterateToTime({ sinkData, targetTime: time });
			if (frame) {
				this.startPrefetch({ sinkData });
				return frame;
			}
		}

		const frame = await this.seekToTime({ sinkData, time });
		if (frame) this.startPrefetch({ sinkData });
		return frame;
	}

	private isFrameValid({
		frame,
		time,
	}: {
		frame: WrappedCanvas;
		time: number;
	}): boolean {
		return time >= frame.timestamp && time < frame.timestamp + frame.duration;
	}
	private async iterateToTime({
		sinkData,
		targetTime,
	}: {
		sinkData: VideoSinkData;
		targetTime: number;
	}): Promise<WrappedCanvas | null> {
		if (!sinkData.iterator) return null;

		try {
			while (true) {
				// Wait for any pending prefetch to finish before touching iterator
				if (sinkData.prefetching && sinkData.prefetchPromise) {
					await sinkData.prefetchPromise;
				}

				// Consume buffered frames first; fall back to the iterator.
				if (
					sinkData.queue.length &&
					sinkData.queue[0].timestamp <= targetTime + 0.05 // Tolerance
				) {
					sinkData.currentFrame = sinkData.queue.shift() ?? null;
				} else {
					const { value: frame, done } = await sinkData.iterator.next();

					if (done || !frame) break;

					sinkData.currentFrame = frame;
				}

				const frame = sinkData.currentFrame;
				if (!frame) break;

				sinkData.lastTime = frame.timestamp;

				if (this.isFrameValid({ frame, time: targetTime })) {
					return frame;
				}

				if (frame.timestamp > targetTime + 1.0) break;
			}
		} catch (error) {
			console.warn("Iterator failed, will restart:", error);
			sinkData.iterator = null;
		}

		return null;
	}
	private async seekToTime({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		try {
			if (sinkData.prefetching && sinkData.prefetchPromise) {
				await sinkData.prefetchPromise;
			}

			if (sinkData.iterator) {
				await sinkData.iterator.return();
				sinkData.iterator = null;
			}

			sinkData.queue = [];
			sinkData.iterator = sinkData.sink.canvases(time);
			sinkData.lastTime = time;

			// Fetch current frame
			const { value: frame } = await sinkData.iterator.next();

			if (frame) {
				sinkData.currentFrame = frame;
				this.startPrefetch({ sinkData });
				return frame;
			}
		} catch (error) {
			console.warn("Failed to seek video:", error);
		}

		return null;
	}

	private startPrefetch({ sinkData }: { sinkData: VideoSinkData }): void {
		if (
			sinkData.prefetching ||
			!sinkData.iterator ||
			sinkData.queue.length >= PREFETCH_DEPTH
		) {
			return;
		}

		sinkData.prefetching = true;
		sinkData.prefetchPromise = this.pumpQueue({ sinkData });
	}

	private async pumpQueue({
		sinkData,
	}: {
		sinkData: VideoSinkData;
	}): Promise<void> {
		try {
			while (sinkData.iterator && sinkData.queue.length < PREFETCH_DEPTH) {
				const { value: frame, done } = await sinkData.iterator.next();
				if (done || !frame) break;
				sinkData.queue.push(frame);
			}
		} catch (error) {
			console.warn("Prefetch failed:", error);
			sinkData.iterator = null;
		} finally {
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
		}
	}
	private async ensureSink({
		mediaId,
		file,
	}: {
		mediaId: string;
		file: File;
	}): Promise<void> {
		if (this.sinks.has(mediaId)) return;

		if (this.initPromises.has(mediaId)) {
			await this.initPromises.get(mediaId);
			return;
		}

		const initPromise = this.initializeSink({ mediaId, file });
		this.initPromises.set(mediaId, initPromise);

		try {
			await initPromise;
		} finally {
			this.initPromises.delete(mediaId);
		}
	}
	private async initializeSink({
		mediaId,
		file,
	}: {
		mediaId: string;
		file: File;
	}): Promise<void> {
		const input = new Input({
			source: new BlobSource(file),
			formats: ALL_FORMATS,
		});

		try {
			const videoTrack = await input.getPrimaryVideoTrack();
			if (!videoTrack) {
				throw new Error("No video track found");
			}

			const canDecode = await videoTrack.canDecode();
			if (!canDecode) {
				throw new Error("Video codec not supported for decoding");
			}

			const sink = new CanvasSink(videoTrack, {
				// Must exceed PREFETCH_DEPTH + the frame handed to the compositor,
				// or the pool recycles canvases still queued for display.
				poolSize: PREFETCH_DEPTH + 3,
				fit: "contain",
			});

			this.sinks.set(mediaId, {
				input,
				sink,
				iterator: null,
				currentFrame: null,
				queue: [],
				lastTime: -1,
				prefetching: false,
				prefetchPromise: null,
			});
		} catch (error) {
			input.dispose();
			console.error(`Failed to initialize video sink for ${mediaId}:`, error);
			throw error;
		}
	}

	clearVideo({ mediaId }: { mediaId: string }): void {
		const sinkData = this.sinks.get(mediaId);
		if (sinkData) {
			if (sinkData.iterator) {
				void sinkData.iterator.return();
			}

			sinkData.input.dispose();
			this.sinks.delete(mediaId);
		}

		this.initPromises.delete(mediaId);
		this.frameChain.delete(mediaId);
		this.seekGenerations.delete(mediaId);
	}

	clearAll(): void {
		for (const [mediaId] of this.sinks) {
			this.clearVideo({ mediaId });
		}
	}

	getStats() {
		return {
			totalSinks: this.sinks.size,
			activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator)
				.length,
			cachedFrames: Array.from(this.sinks.values()).filter(
				(s) => s.currentFrame,
			).length,
		};
	}
}

export const videoCache = new VideoCache();
