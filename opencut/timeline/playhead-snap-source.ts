import type { SnapPoint } from "@opencut/timeline/snapping";
import type { MediaTime } from "@opencut/wasm";

export function getPlayheadSnapPoints({
	playheadTime,
}: {
	playheadTime: MediaTime;
}): SnapPoint[] {
	return [{ time: playheadTime, type: "playhead" }];
}
