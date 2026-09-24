import { getElementKeyframes } from "@opencut/animation";
import type { SceneTracks } from "@opencut/timeline";
import type { SnapPoint } from "@opencut/timeline/snapping";
import { addMediaTime } from "@opencut/wasm";

export function getAnimationKeyframeSnapPointsForTimeline({
	tracks,
	excludeElementIds,
}: {
	tracks: SceneTracks;
	excludeElementIds?: Set<string>;
}): SnapPoint[] {
	const snapPoints: SnapPoint[] = [];
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];

	for (const track of orderedTracks) {
		for (const element of track.elements) {
			if (excludeElementIds?.has(element.id)) {
				continue;
			}

			for (const keyframe of getElementKeyframes({
				animations: element.animations,
			})) {
				snapPoints.push({
					time: addMediaTime({ a: element.startTime, b: keyframe.time }),
					type: "keyframe",
					elementId: element.id,
					trackId: track.id,
				});
			}
		}
	}

	return snapPoints;
}
