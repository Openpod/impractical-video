import {
  artifactFocusIdentityMatches,
  type ArtifactFocusIdentity,
} from "./artifact-focus-contract";

export type CanonicalEditorPlacement = {
  durationTicks: number;
  elementId: string;
  identity: ArtifactFocusIdentity;
  sceneId: string;
  startTimeTicks: number;
  trackId: string;
  trackLabel: string;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

export function artifactIdentityFromEditorValue(
  value: unknown,
): ArtifactFocusIdentity | null {
  const raw = record(value);
  const version = record(raw?.version);
  const sourcePath =
    typeof raw?.path === "string"
      ? raw.path
      : typeof raw?.sourcePath === "string"
        ? raw.sourcePath
        : null;
  if (
    !raw ||
    typeof raw.artifactId !== "string" ||
    typeof raw.contentHash !== "string" ||
    typeof raw.entityRevision !== "number" ||
    !sourcePath
  ) {
    return null;
  }
  const versionHash =
    typeof version?.sha256 === "string"
      ? version.sha256
      : typeof raw.versionHash === "string"
        ? raw.versionHash
        : raw.contentHash;
  return {
    artifactId: raw.artifactId,
    contentHash: raw.contentHash,
    entityRevision: raw.entityRevision,
    sourcePath,
    versionHash,
    versionId:
      typeof version?.versionId === "string"
        ? version.versionId
        : typeof raw.versionId === "string"
          ? raw.versionId
          : null,
    versionIndex:
      typeof version?.index === "number"
        ? version.index
        : typeof raw.versionIndex === "number"
          ? raw.versionIndex
          : null,
  };
}

function mappedIdentity(
  mediaMap: UnknownRecord,
  mediaId: string | null,
): ArtifactFocusIdentity | null {
  if (!mediaId) return null;
  for (const value of Object.values(mediaMap)) {
    const entry = record(value);
    if (entry?.mediaId !== mediaId) continue;
    return artifactIdentityFromEditorValue(entry.artifact);
  }
  return null;
}

function sceneTracks(scene: UnknownRecord) {
  const tracks = record(scene.tracks);
  const main = record(tracks?.main);
  const overlay = Array.isArray(tracks?.overlay) ? tracks.overlay : [];
  const audio = Array.isArray(tracks?.audio) ? tracks.audio : [];
  return [main, ...overlay.map(record), ...audio.map(record)].filter(
    (value): value is UnknownRecord => Boolean(value),
  );
}

export function canonicalEditorPlacements(
  document: unknown,
): CanonicalEditorPlacement[] {
  const root = record(document);
  const project = record(root?.project);
  const mediaMap = record(root?.mediaMap) ?? {};
  if (!project || !Array.isArray(project.scenes)) return [];
  const placements: CanonicalEditorPlacement[] = [];
  for (const rawScene of project.scenes) {
    const scene = record(rawScene);
    if (!scene || typeof scene.id !== "string") continue;
    for (const track of sceneTracks(scene)) {
      if (typeof track.id !== "string" || !Array.isArray(track.elements)) {
        continue;
      }
      for (const rawElement of track.elements) {
        const element = record(rawElement);
        if (!element || typeof element.id !== "string") continue;
        const mediaId =
          typeof element.mediaId === "string" ? element.mediaId : null;
        const identity =
          artifactIdentityFromEditorValue(element.videoFsArtifact) ??
          mappedIdentity(mediaMap, mediaId);
        if (!identity) continue;
        placements.push({
          durationTicks:
            typeof element.duration === "number" ? element.duration : 0,
          elementId: element.id,
          identity,
          sceneId: scene.id,
          startTimeTicks:
            typeof element.startTime === "number" ? element.startTime : 0,
          trackId: track.id,
          trackLabel:
            typeof track.name === "string" && track.name.trim()
              ? track.name.trim()
              : track.id,
        });
      }
    }
  }
  return placements;
}

export function placementsForExactArtifact(
  placements: CanonicalEditorPlacement[],
  identity: ArtifactFocusIdentity,
) {
  return placements.filter((placement) =>
    artifactFocusIdentityMatches(placement.identity, identity),
  );
}
