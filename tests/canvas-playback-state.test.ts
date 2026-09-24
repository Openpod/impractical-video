import { describe, expect, it } from "vitest";
import {
  canvasPlaybackStorageKey,
  normalizePlaybackEntry,
} from "../app/projects/[id]/canvas-playback-state";

describe("Canvas playback persistence", () => {
  it("keeps valid time/rate/version intent while bounding unsafe values", () => {
    expect(
      normalizePlaybackEntry({
        currentTime: 18.2,
        muted: false,
        playbackRate: 2,
        selectedVersion: 3,
        wasPlaying: true,
      }),
    ).toEqual({
      currentTime: 18.2,
      muted: false,
      playbackRate: 2,
      selectedVersion: 3,
      wasPlaying: true,
    });
    expect(
      normalizePlaybackEntry({
        currentTime: -5,
        playbackRate: 99,
        selectedVersion: -10,
      }),
    ).toMatchObject({
      currentTime: 0,
      muted: true,
      playbackRate: 4,
      selectedVersion: -1,
    });
  });

  it("isolates state by project", () => {
    expect(canvasPlaybackStorageKey("project-a")).not.toBe(
      canvasPlaybackStorageKey("project-b"),
    );
  });
});
