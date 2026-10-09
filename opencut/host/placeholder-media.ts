import { artifactIdentityFromEditorValue } from "./editor-placement-contract";

/** A Canvas file the Editor's media bin holds. `sourcePath` is the version's
 * project-relative file, or the record path of an unversioned artifact;
 * `hostAssetIds` are the host asset ids resolving to the file (the artifact
 * id itself names the artifact's current file). */
export type HeldArtifactMedia = {
  artifactId: string;
  hostAssetIds: readonly string[];
  mediaId: string;
  sourceKey: string;
  sourcePath: string;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

/** The comparison the server applies to media source keys (pathname only,
 * percent-decoded), so client and server agree on which file a key names. */
export function mediaSourcePath(sourceKey: string | undefined) {
  if (!sourceKey) return null;
  try {
    return decodeURIComponent(
      new URL(sourceKey, "http://video-fs.local").pathname,
    );
  } catch {
    return null;
  }
}

function relativePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\/+/, "").replace(/^(\.\/)+/, "");
}

/** Media id -> source key, for every entry of an edit document media map. */
export function mediaMapSources(mediaMap: unknown) {
  const sources = new Map<string, string>();
  for (const value of Object.values(record(mediaMap) ?? {})) {
    const entry = record(value);
    if (
      typeof entry?.mediaId === "string" &&
      typeof entry.sourceKey === "string"
    ) {
      sources.set(entry.mediaId, entry.sourceKey);
    }
  }
  return sources;
}

function sceneElements(scenes: readonly unknown[]) {
  const elements: UnknownRecord[] = [];
  for (const rawScene of scenes) {
    const tracks = record(record(rawScene)?.tracks);
    const overlay = Array.isArray(tracks?.overlay) ? tracks.overlay : [];
    const audio = Array.isArray(tracks?.audio) ? tracks.audio : [];
    for (const track of [
      record(tracks?.main),
      ...overlay.map(record),
      ...audio.map(record),
    ]) {
      if (!track || !Array.isArray(track.elements)) continue;
      for (const rawElement of track.elements) {
        const element = record(rawElement);
        if (element) elements.push(element);
      }
    }
  }
  return elements;
}

function heldMediaForIdentity(
  value: unknown,
  heldMedia: readonly HeldArtifactMedia[],
) {
  const identity = artifactIdentityFromEditorValue(value);
  if (!identity) return null;
  const sameArtifact = heldMedia.filter(
    (media) => media.artifactId === identity.artifactId,
  );
  if (identity.versionIndex !== null) {
    // A version placement names its file; another version is not a stand-in.
    const path = relativePath(identity.sourcePath);
    return (
      sameArtifact.find((media) => relativePath(media.sourcePath) === path) ??
      null
    );
  }
  // A record placement shows the record's current file.
  return (
    sameArtifact.find((media) =>
      media.hostAssetIds.includes(identity.artifactId),
    ) ?? null
  );
}

/** Agent inserts reference media through the edit document's media map. When
 * that map has no entry for the exact file, the server writes a placeholder
 * media id (`videofs-…`) on the element and records the file's source key
 * under it (ensureArtifactEditorMedia). The Editor draws nothing for a media
 * id its bin does not hold, so each such id maps to the bin id of the same
 * file: the file its placeholder entry names (and none other, until the bin
 * holds it), or, with no entry left, the file the element's artifact identity
 * names. Ids the bin holds are never touched. */
export function heldMediaReplacements({
  heldMedia,
  knownMediaIds,
  placeholderSources,
  scenes,
}: {
  heldMedia: readonly HeldArtifactMedia[];
  knownMediaIds: ReadonlySet<string>;
  placeholderSources: ReadonlyMap<string, string>;
  scenes: readonly unknown[];
}) {
  const usable = heldMedia.filter((media) => knownMediaIds.has(media.mediaId));
  const bySourcePath = new Map<string, HeldArtifactMedia>();
  for (const media of usable) {
    const path = mediaSourcePath(media.sourceKey);
    if (path && !bySourcePath.has(path)) bySourcePath.set(path, media);
  }
  const replacements = new Map<string, string>();
  for (const element of sceneElements(scenes)) {
    const mediaId =
      typeof element.mediaId === "string" ? element.mediaId : null;
    if (!mediaId || knownMediaIds.has(mediaId) || replacements.has(mediaId)) {
      continue;
    }
    const placeholderPath = mediaSourcePath(placeholderSources.get(mediaId));
    const held = placeholderPath
      ? bySourcePath.get(placeholderPath)
      : heldMediaForIdentity(element.videoFsArtifact, usable);
    if (held) replacements.set(mediaId, held.mediaId);
  }
  return replacements;
}
