"use client";

import { useState, useEffect } from "react";
import { useEditor } from "@opencut/editor/use-editor";
import { formatTimecode } from "opencut-wasm";
import { invokeAction } from "@opencut/actions";
import { EditableTimecode } from "@opencut/components/editable-timecode";
import { Button } from "@opencut/components/ui/button";
import {
	FullScreenIcon,
	PauseIcon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Separator } from "@opencut/components/ui/separator";
import {
	Select,
	SelectTrigger,
	SelectContent,
	SelectItem,
	SelectSeparator,
} from "@opencut/components/ui/select";
import { PREVIEW_ZOOM_PRESETS } from "@opencut/preview/zoom";
import { usePreviewViewport } from "./preview-viewport";
import { GridPopover } from "./guide-popover";
import { usePreviewStore } from "@opencut/preview/preview-store";
import { TICKS_PER_SECOND, type MediaTime } from "@opencut/wasm";

export function PreviewToolbar({
	onToggleFullscreen,
}: {
	onToggleFullscreen: () => void;
}) {
	return (
		<div className="flex flex-col gap-2 px-5 pt-4 pb-3">
			<PlaybackScrubber />
			<div className="grid grid-cols-[1fr_auto_1fr] items-center">
				<TimecodeDisplay />
				<PlayPauseButton />
				<div className="justify-self-end flex items-center gap-2.5">
					<ZoomSelect />
					<Separator orientation="vertical" className="h-4" />
					{/* v0.4.0 */}
					{/* <GridPopover>
					<Button
						variant={activeGuideDefinition ? "secondary" : "text"}
						size="icon"
					>
						{activeGuideDefinition ? (
							activeGuideDefinition.renderTriggerIcon()
						) : (
							<HugeiconsIcon icon={GridTableIcon} />
						)}
					</Button>
				</GridPopover> */}
					<Button variant="text" onClick={onToggleFullscreen}>
						<HugeiconsIcon icon={FullScreenIcon} />
					</Button>
				</div>
			</div>
		</div>
	);
}

function PlaybackScrubber() {
	const editor = useEditor();
	const totalDuration = useEditor((e) => e.timeline.getTotalDuration());
	const fps = useEditor((e) => e.project.getActive().settings.fps);
	const [currentTime, setCurrentTime] = useState<MediaTime>(() =>
		editor.playback.getCurrentTime(),
	);

	useEffect(() => {
		const syncTime = (time: MediaTime) => setCurrentTime(time);
		const unsubscribeUpdate = editor.playback.onUpdate(syncTime);
		const unsubscribeSeek = editor.playback.onSeek(syncTime);
		return () => {
			unsubscribeUpdate();
			unsubscribeSeek();
		};
	}, [editor.playback]);

	const duration = Math.max(totalDuration, 0);
	const clampedTime = Math.min(Math.max(currentTime, 0), duration);
	const progress = duration > 0 ? (clampedTime / duration) * 100 : 0;
	const frameStep = Math.max(
		1,
		Math.round((TICKS_PER_SECOND * fps.denominator) / fps.numerator),
	);
	const isDisabled = duration <= 0;

	const seekToValue = (value: string) => {
		const time = Math.min(Math.max(Number(value), 0), duration) as MediaTime;
		setCurrentTime(time);
		editor.playback.seek({ time });
	};

	const setScrubbing = (isScrubbing: boolean) => {
		editor.playback.setScrubbing({ isScrubbing });
	};

	return (
		<div className="group relative flex h-3 items-center">
			<div className="bg-muted/60 h-0.5 w-full overflow-hidden rounded-full">
				<div
					className="h-full rounded-full bg-[#ed1d24]"
					style={{ width: `${progress}%` }}
				/>
			</div>
			<div
				className="pointer-events-none absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#ed1d24] opacity-0 shadow-[0_0_0_2px_var(--background)] transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
				style={{ left: `${progress}%` }}
			/>
			<input
				type="range"
				min={0}
				max={Math.max(duration, 1)}
				step={frameStep}
				value={clampedTime}
				disabled={isDisabled}
				aria-label="Scrub timeline"
				className="absolute inset-0 h-3 w-full cursor-pointer opacity-0 disabled:cursor-default"
				onChange={(event) => seekToValue(event.currentTarget.value)}
				onPointerDown={() => setScrubbing(true)}
				onPointerUp={() => setScrubbing(false)}
				onPointerCancel={() => setScrubbing(false)}
				onBlur={() => setScrubbing(false)}
			/>
		</div>
	);
}

function TimecodeDisplay() {
	const editor = useEditor();
	const totalDuration = useEditor((e) => e.timeline.getTotalDuration());
	const fps = useEditor((e) => e.project.getActive().settings.fps);
	const [currentTime, setCurrentTime] = useState<MediaTime>(() =>
		editor.playback.getCurrentTime(),
	);

	useEffect(() => {
		const unsubscribeUpdate = editor.playback.onUpdate(setCurrentTime);
		const unsubscribeSeek = editor.playback.onSeek(setCurrentTime);
		return () => {
			unsubscribeUpdate();
			unsubscribeSeek();
		};
	}, [editor.playback]);

	return (
		<div className="flex items-center">
			<EditableTimecode
				time={currentTime}
				duration={totalDuration}
				format="HH:MM:SS:FF"
				fps={fps}
				onTimeChange={({ time }) => editor.playback.seek({ time })}
				className="text-center"
			/>
			<span className="text-muted-foreground px-2 font-mono text-xs">/</span>
			<span className="text-muted-foreground font-mono text-xs">
				{formatTimecode({
					time: totalDuration,
					format: "HH:MM:SS:FF",
					rate: fps,
				})}
			</span>
		</div>
	);
}

function ZoomSelect() {
	const { isAtFit, zoomPercent, fitToScreen, setViewportPercent } =
		usePreviewViewport();

	const displayLabel = isAtFit ? "Fit" : `${zoomPercent}%`;

	const onValueChange = (value: string) => {
		if (value === "fit") {
			fitToScreen();
		} else {
			setViewportPercent({ percent: Number(value) });
		}
	};

	return (
		<Select
			value={isAtFit ? "fit" : String(zoomPercent)}
			onValueChange={onValueChange}
		>
			<SelectTrigger className="tabular-nums">{displayLabel}</SelectTrigger>
			<SelectContent>
				<SelectItem value="fit">Fit</SelectItem>
				<SelectSeparator />
				{PREVIEW_ZOOM_PRESETS.map((preset) => (
					<SelectItem key={preset} value={String(preset)}>
						{preset}%
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function PlayPauseButton() {
	const isPlaying = useEditor((e) => e.playback.getIsPlaying());

	return (
		<Button
			variant="text"
			size="icon"
			onClick={() => invokeAction("toggle-play")}
		>
			<HugeiconsIcon icon={isPlaying ? PauseIcon : PlayIcon} />
		</Button>
	);
}
