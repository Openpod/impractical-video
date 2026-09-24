export type CanvasPlaybackEntry = {
  currentTime: number;
  muted: boolean;
  playbackRate: number;
  selectedVersion: number;
  wasPlaying: boolean;
};

export type CanvasPlaybackState = Record<string, CanvasPlaybackEntry>;

const DEFAULT_ENTRY: CanvasPlaybackEntry = {
  currentTime: 0,
  muted: true,
  playbackRate: 1,
  selectedVersion: -1,
  wasPlaying: false,
};

export function canvasPlaybackStorageKey(projectId: string) {
  return `video-fs:canvas-playback:${projectId}`;
}

export function normalizePlaybackEntry(
  value: Partial<CanvasPlaybackEntry> | null | undefined,
): CanvasPlaybackEntry {
  const rate =
    typeof value?.playbackRate === "number" && Number.isFinite(value.playbackRate)
      ? Math.max(0.1, Math.min(4, value.playbackRate))
      : DEFAULT_ENTRY.playbackRate;
  return {
    currentTime:
      typeof value?.currentTime === "number" && Number.isFinite(value.currentTime)
        ? Math.max(0, value.currentTime)
        : DEFAULT_ENTRY.currentTime,
    // Restoration is intentionally always silent. `muted: false` is remembered
    // only as user intent and needs a fresh explicit gesture after remount.
    muted: value?.muted !== false,
    playbackRate: rate,
    selectedVersion:
      typeof value?.selectedVersion === "number" && Number.isInteger(value.selectedVersion)
        ? Math.max(-1, value.selectedVersion)
        : DEFAULT_ENTRY.selectedVersion,
    wasPlaying: value?.wasPlaying === true,
  };
}

export function readCanvasPlaybackState(projectId: string): CanvasPlaybackState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(canvasPlaybackStorageKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<CanvasPlaybackEntry>>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([id, entry]) => [id, normalizePlaybackEntry(entry)]),
    );
  } catch {
    return {};
  }
}

export function writeCanvasPlaybackState(projectId: string, state: CanvasPlaybackState) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(canvasPlaybackStorageKey(projectId), JSON.stringify(state));
}
