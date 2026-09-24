import type { EditorAgentContext } from "@/app/projects/[id]/agent-context-publisher";
import type { SelectedKeyframeRef } from "@opencut/animation/types";
import type { SelectedMaskPointSelection } from "@opencut/selection/editor-selection";
import type {
  ElementRef,
  TimelineElement,
  TimelineTrack,
  TScene,
} from "@opencut/timeline/types";
import type { TProject } from "@opencut/project/types";

type EditorSelectionInput = {
  selectedElements: ElementRef[];
  selectedKeyframes: SelectedKeyframeRef[];
  selectedMaskPoints: SelectedMaskPointSelection | null;
};

export function selectedElementsForFocusedPlacement({
  focusedPlacement,
  selectedElements,
}: {
  focusedPlacement: EditorAgentContext["focusedPlacement"];
  selectedElements: ElementRef[];
}) {
  return focusedPlacement
    ? selectedElements.filter(
        (element) =>
          focusedPlacement.status === "focused" &&
          element.elementId === focusedPlacement.elementId,
      )
    : selectedElements;
}

function sceneTracks(scene: TScene | null): TimelineTrack[] {
  if (!scene) return [];
  return [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio];
}

function selectedElement(
  tracks: TimelineTrack[],
  reference: ElementRef,
): { element: TimelineElement; track: TimelineTrack } | null {
  const track = tracks.find((entry) => entry.id === reference.trackId);
  const element = track?.elements.find(
    (entry) => entry.id === reference.elementId,
  );
  return track && element ? { element, track } : null;
}

function keyframeTime(value: unknown, keyframeId: string): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.keys)) {
    const key = record.keys.find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        (entry as Record<string, unknown>).id === keyframeId,
    ) as Record<string, unknown> | undefined;
    return typeof key?.time === "number" ? key.time : null;
  }
  for (const nested of Object.values(record)) {
    const time = keyframeTime(nested, keyframeId);
    if (time !== null) return time;
  }
  return null;
}

function framesPerSecond(project: TProject | null) {
  const fps = project?.settings.fps as
    | { denominator?: number; numerator?: number }
    | number
    | undefined;
  if (typeof fps === "number") return Number.isFinite(fps) && fps > 0 ? fps : null;
  const numerator = fps?.numerator;
  const denominator = fps?.denominator;
  if (
    typeof numerator !== "number" ||
    typeof denominator !== "number" ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return null;
  }
  return numerator / denominator;
}

function rangeFromTimes(times: number[]) {
  const safe = times.filter(
    (time) => Number.isFinite(time) && time >= 0,
  );
  if (!safe.length) return null;
  return {
    endTicks: Math.round(Math.max(...safe)),
    startTicks: Math.round(Math.min(...safe)),
  };
}

export function editorAgentContextSnapshot({
  documentRevision,
  focusedArtifact = null,
  focusedPlacement = null,
  playheadTicks,
  project,
  scene,
  selection,
}: {
  documentRevision: number | null;
  focusedArtifact?: EditorAgentContext["focusedArtifact"];
  focusedPlacement?: EditorAgentContext["focusedPlacement"];
  playheadTicks: number | null;
  project: TProject | null;
  scene: TScene | null;
  selection: EditorSelectionInput;
}): EditorAgentContext {
  const tracks = sceneTracks(scene);
  const selected = selection.selectedElements
    .map((reference) => selectedElement(tracks, reference))
    .filter(
      (
        entry,
      ): entry is { element: TimelineElement; track: TimelineTrack } =>
        Boolean(entry),
    );
  const selectedTrackIds = [
    ...new Set([
      ...selection.selectedElements.map((entry) => entry.trackId),
      ...selection.selectedKeyframes.map((entry) => entry.trackId),
      ...(selection.selectedMaskPoints
        ? [selection.selectedMaskPoints.trackId]
        : []),
    ]),
  ];
  const rangeTimes: number[] = [];
  for (const { element } of selected) {
    rangeTimes.push(element.startTime, element.startTime + element.duration);
  }
  for (const keyframe of selection.selectedKeyframes) {
    const match = selectedElement(tracks, keyframe);
    const relative = match
      ? keyframeTime(
          match.element.animations?.[keyframe.propertyPath],
          keyframe.keyframeId,
        )
      : null;
    if (match && relative !== null) {
      rangeTimes.push(match.element.startTime + relative);
    }
  }
  if (selection.selectedMaskPoints) {
    const match = selectedElement(tracks, selection.selectedMaskPoints);
    if (match) {
      rangeTimes.push(
        match.element.startTime,
        match.element.startTime + match.element.duration,
      );
    }
  }
  return {
    documentRevision,
    fps: framesPerSecond(project),
    focusedArtifact,
    focusedPlacement,
    playheadTicks:
      typeof playheadTicks === "number" &&
      Number.isFinite(playheadTicks) &&
      playheadTicks >= 0
        ? Math.round(playheadTicks)
        : null,
    sceneId: scene?.id ?? null,
    selectedElements: selected.map(({ element, track }) => ({
      elementId: element.id,
      kind: element.type,
      mediaId:
        "mediaId" in element && typeof element.mediaId === "string"
          ? element.mediaId
          : null,
      trackId: track.id,
    })),
    selectedKeyframes: selection.selectedKeyframes.map((keyframe) => ({
      elementId: keyframe.elementId,
      keyframeId: keyframe.keyframeId,
      property: keyframe.propertyPath,
      trackId: keyframe.trackId,
    })),
    selectedMaskPoints: selection.selectedMaskPoints
      ? {
          elementId: selection.selectedMaskPoints.elementId,
          pointIds: [...selection.selectedMaskPoints.pointIds],
          trackId: selection.selectedMaskPoints.trackId,
        }
      : null,
    selectedTrackIds,
    timeRange: rangeFromTimes(rangeTimes),
  };
}
