import { splitAnimationsAtTime } from "@opencut/animation";
import type {
	CreateTimelineElement,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	TrackType,
} from "@opencut/timeline";
import {
	findTrackInSceneTracks,
	isRetimableElement,
	updateElementInSceneTracks,
} from "@opencut/timeline";
import type {
	PlannedElementMove,
	PlannedTrackCreation,
} from "@opencut/timeline/group-move";
import {
	applyPlacement,
	buildEmptyTrack,
	canElementGoOnTrack,
	resolveTrackPlacement,
	validateElementTrackCompatibility,
} from "@opencut/timeline/placement";
import { requiresMediaId } from "@opencut/timeline/element-utils";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@opencut/timeline/creation";
import { applyElementUpdate } from "@opencut/timeline/update-pipeline";
import { getSourceSpanAtClipTime } from "@opencut/retime";
import {
	addMediaTime,
	type MediaTime,
	roundMediaTime,
	subMediaTime,
} from "@opencut/wasm";

export type InsertElementPlacement =
	| { mode: "explicit"; trackId: string }
	| { mode: "auto"; trackType?: TrackType; insertIndex?: number };

export function applyInsertElementMutation({
	element,
	elementId,
	placement,
	tracks,
}: {
	element: CreateTimelineElement;
	elementId: string;
	placement: InsertElementPlacement;
	tracks: SceneTracks;
}): {
	element: TimelineElement;
	targetTrackId: string;
	updatedTracks: SceneTracks;
} | null {
	if (!validateElementBasics(element)) return null;
	const nextElement = {
		...element,
		id: elementId,
		startTime: element.startTime,
		trimStart: element.trimStart ?? 0,
		trimEnd: element.trimEnd ?? 0,
		duration: element.duration ?? DEFAULT_NEW_ELEMENT_DURATION,
	} as TimelineElement;

	if (
		placement.mode === "auto" &&
		placement.trackType &&
		!canElementGoOnTrack({
			elementType: nextElement.type,
			trackType: placement.trackType,
		})
	) {
		return null;
	}
	const placementResult = resolveTrackPlacement({
		tracks,
		...(placement.mode === "auto" && placement.trackType
			? { trackType: placement.trackType }
			: { elementType: nextElement.type }),
		timeSpans: [
			{
				startTime: nextElement.startTime,
				duration: nextElement.duration,
			},
		],
		strategy:
			placement.mode === "explicit"
				? { type: "explicit", trackId: placement.trackId }
				: { type: "firstAvailable" },
	});
	if (!placementResult) {
		if (placement.mode === "explicit") {
			const targetTrack = findTrackInSceneTracks({
				tracks,
				trackId: placement.trackId,
			});
			if (!targetTrack) return null;
			if (
				!validateElementTrackCompatibility({
					element: nextElement,
					track: targetTrack,
				}).isValid
			) {
				return null;
			}
		}
		return null;
	}
	const elementToPlace =
		placementResult.kind === "existingTrack"
			? {
					...nextElement,
					startTime:
						placementResult.adjustedStartTime !== undefined
							? roundMediaTime({
									time: placementResult.adjustedStartTime,
								})
							: nextElement.startTime,
				}
			: nextElement;
	const applied = applyPlacement({
		tracks,
		placementResult,
		elements: [elementToPlace],
		newTrackInsertIndexOverride:
			placement.mode === "auto" && typeof placement.insertIndex === "number"
				? placement.insertIndex
				: undefined,
	});
	if (!applied) return null;
	return {
		element: elementToPlace,
		targetTrackId: applied.targetTrackId,
		updatedTracks: applied.updatedTracks,
	};
}

export function applyMoveElementsMutation({
	createTracks = [],
	moves,
	tracks,
}: {
	createTracks?: PlannedTrackCreation[];
	moves: PlannedElementMove[];
	tracks: SceneTracks;
}) {
	let tracksToUpdate = tracks;
	for (const createTrack of [...createTracks].sort(
		(first, second) => first.index - second.index,
	)) {
		tracksToUpdate = insertTrackAtDisplayIndex({
			tracks: tracksToUpdate,
			track: buildEmptyTrack({
				id: createTrack.id,
				type: createTrack.type,
			}),
			insertIndex: createTrack.index,
		});
	}

	const movedById = new Map<string, TimelineElement>();
	for (const move of moves) {
		const sourceTrack = findTrackInSceneTracks({
			tracks,
			trackId: move.sourceTrackId,
		});
		const sourceElement = sourceTrack?.elements.find(
			(element) => element.id === move.elementId,
		);
		if (!sourceTrack || !sourceElement) {
			throw new Error("Source track or element not found");
		}
		const targetTrack = findTrackInSceneTracks({
			tracks: tracksToUpdate,
			trackId: move.targetTrackId,
		});
		if (!targetTrack) throw new Error("Target track not found");
		const validation = validateElementTrackCompatibility({
			element: sourceElement,
			track: targetTrack,
		});
		if (!validation.isValid) throw new Error(validation.errorMessage);
		movedById.set(move.elementId, {
			...sourceElement,
			startTime: move.newStartTime,
		});
	}

	const movedIds = new Set(moves.map((move) => move.elementId));
	const byTarget = new Map<string, TimelineElement[]>();
	for (const move of moves) {
		const element = movedById.get(move.elementId);
		if (!element) continue;
		byTarget.set(move.targetTrackId, [
			...(byTarget.get(move.targetTrackId) ?? []),
			element,
		]);
	}
	return mapSceneTracks({
		tracks: tracksToUpdate,
		update: (track) => ({
			...track,
			elements: [
				...track.elements.filter((element) => !movedIds.has(element.id)),
				...(byTarget.get(track.id) ?? []),
			],
		}),
	});
}

export function applyUpdateElementsMutation({
	tracks,
	updates,
}: {
	tracks: SceneTracks;
	updates: Array<{
		trackId: string;
		elementId: string;
		patch: Partial<TimelineElement>;
	}>;
}) {
	let updatedTracks = tracks;
	for (const update of updates) {
		const track = findTrackInSceneTracks({
			tracks: updatedTracks,
			trackId: update.trackId,
		});
		const element = track?.elements.find(
			(candidate) => candidate.id === update.elementId,
		);
		if (!track || !element) continue;
		const next = applyElementUpdate({
			element,
			patch: update.patch,
			context: { tracks: updatedTracks, trackId: update.trackId },
		});
		updatedTracks = updateElementInSceneTracks({
			tracks: updatedTracks,
			trackId: update.trackId,
			elementId: update.elementId,
			update: () => next,
		});
	}
	return updatedTracks;
}

export function applySplitElementsMutation({
	createId,
	elements,
	retainSide = "both",
	splitTime,
	tracks,
}: {
	createId: () => string;
	elements: { trackId: string; elementId: string }[];
	retainSide?: "both" | "left" | "right";
	splitTime: MediaTime;
	tracks: SceneTracks;
}) {
	const rightSideElements: { trackId: string; elementId: string }[] = [];
	const splitTrack = <
		TTrack extends { id: string; elements: TimelineElement[] },
	>(
		track: TTrack,
	): TTrack => {
		const targets = elements.filter((target) => target.trackId === track.id);
		if (!targets.length) return track;
		const nextElements = track.elements.flatMap((element) => {
			if (!targets.some((target) => target.elementId === element.id)) {
				return [element];
			}
			const effectiveEnd = element.startTime + element.duration;
			if (splitTime <= element.startTime || splitTime >= effectiveEnd) {
				return [element];
			}
			const relativeTime = subMediaTime({
				a: splitTime,
				b: element.startTime,
			});
			const rightVisibleDuration = subMediaTime({
				a: element.duration,
				b: relativeTime,
			});
			const retime = isRetimableElement(element) ? element.retime : undefined;
			const leftSourceSpan = roundMediaTime({
				time: getSourceSpanAtClipTime({
					clipTime: relativeTime,
					retime,
				}),
			});
			const totalSourceSpan = roundMediaTime({
				time: getSourceSpanAtClipTime({
					clipTime: element.duration,
					retime,
				}),
			});
			const rightSourceSpan = subMediaTime({
				a: totalSourceSpan,
				b: leftSourceSpan,
			});
			const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
				animations: element.animations,
				splitTime: relativeTime,
				shouldIncludeSplitBoundary: true,
			});
			const left = {
				...element,
				duration: relativeTime,
				trimEnd: addMediaTime({
					a: element.trimEnd,
					b: rightSourceSpan,
				}),
				name: `${element.name} (left)`,
				animations: leftAnimations,
				...(retime !== undefined ? { retime } : {}),
			} as TimelineElement;
			if (retainSide === "left") return [left];
			const rightId = createId();
			const right = {
				...element,
				id: rightId,
				startTime: splitTime,
				duration: rightVisibleDuration,
				trimStart: addMediaTime({
					a: element.trimStart,
					b: leftSourceSpan,
				}),
				name: `${element.name} (right)`,
				animations: rightAnimations,
				...(retime !== undefined ? { retime } : {}),
			} as TimelineElement;
			rightSideElements.push({ trackId: track.id, elementId: rightId });
			if (retainSide === "right") return [right];
			return [left, right];
		});
		return { ...track, elements: nextElements } as TTrack;
	};
	return {
		rightSideElements,
		updatedTracks: {
			overlay: tracks.overlay.map((track) => splitTrack(track)),
			main: splitTrack(tracks.main),
			audio: tracks.audio.map((track) => splitTrack(track)),
		} satisfies SceneTracks,
	};
}

export function applyDeleteElementsMutation({
	elements,
	tracks,
}: {
	elements: { trackId: string; elementId: string }[];
	tracks: SceneTracks;
}) {
	return {
		overlay: tracks.overlay.map((track) =>
			removeTrackElements({ track, elements }),
		),
		main: removeTrackElements({ track: tracks.main, elements }),
		audio: tracks.audio.map((track) =>
			removeTrackElements({ track, elements }),
		),
	} satisfies SceneTracks;
}

function validateElementBasics(element: CreateTimelineElement) {
	if (requiresMediaId({ element }) && !("mediaId" in element)) return false;
	if (
		element.type === "audio" &&
		element.sourceType === "library" &&
		!element.sourceUrl
	) {
		return false;
	}
	if (element.type === "sticker" && !element.stickerId) return false;
	if (element.type === "text" && !element.params.content) return false;
	if (element.type === "effect" && !element.effectType) return false;
	return true;
}

function mapSceneTracks({
	tracks,
	update,
}: {
	tracks: SceneTracks;
	update: <TTrack extends TimelineTrack>(track: TTrack) => TTrack;
}): SceneTracks {
	return {
		overlay: tracks.overlay.map((track) => update(track)),
		main: update(tracks.main),
		audio: tracks.audio.map((track) => update(track)),
	};
}

function insertTrackAtDisplayIndex({
	insertIndex,
	track,
	tracks,
}: {
	insertIndex: number;
	track: TimelineTrack;
	tracks: SceneTracks;
}): SceneTracks {
	if (track.type === "audio") {
		const audioIndex = Math.max(
			0,
			Math.min(insertIndex - tracks.overlay.length - 1, tracks.audio.length),
		);
		return {
			...tracks,
			audio: [
				...tracks.audio.slice(0, audioIndex),
				track,
				...tracks.audio.slice(audioIndex),
			],
		};
	}
	const overlayIndex = Math.max(0, Math.min(insertIndex, tracks.overlay.length));
	return {
		...tracks,
		overlay: [
			...tracks.overlay.slice(0, overlayIndex),
			track,
			...tracks.overlay.slice(overlayIndex),
		],
	};
}

function removeTrackElements<TTrack extends TimelineTrack>({
	elements,
	track,
}: {
	elements: { trackId: string; elementId: string }[];
	track: TTrack;
}): TTrack {
	return {
		...track,
		elements: track.elements.filter(
			(element) =>
				!elements.some(
					(target) =>
						target.trackId === track.id && target.elementId === element.id,
				),
		),
	} as TTrack;
}
