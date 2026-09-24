import { describe, expect, it } from "vitest";
import {
  canonicalEditorPlacements,
  placementsForExactArtifact,
} from "../opencut/host/editor-placement-contract";

const identity = {
  artifactId: "clip_history",
  contentHash: "a".repeat(64),
  entityRevision: 4,
  path: "media/clips/clip_history.v1.mp4",
  version: {
    index: 0,
    sha256: "a".repeat(64),
    versionId: "v1",
  },
};

function documentWithElements(elements: unknown[]) {
  return {
    mediaMap: {},
    project: {
      scenes: [
        {
          id: "scene_main",
          tracks: {
            audio: [],
            main: {
              elements,
              id: "track_main",
              name: "Main",
            },
            overlay: [],
          },
        },
      ],
    },
    revision: 8,
  };
}

describe("revisioned Editor placement contract", () => {
  it("uses OpenCut element IDs and exact embedded artifact versions", () => {
    const placements = canonicalEditorPlacements(
      documentWithElements([
        {
          duration: 90,
          id: "element_opening",
          mediaId: "media_v1",
          startTime: 30,
          type: "video",
          videoFsArtifact: identity,
        },
      ]),
    );
    expect(placements).toEqual([
      {
        durationTicks: 90,
        elementId: "element_opening",
        identity: {
          artifactId: "clip_history",
          contentHash: "a".repeat(64),
          entityRevision: 4,
          sourcePath: "media/clips/clip_history.v1.mp4",
          versionHash: "a".repeat(64),
          versionId: "v1",
          versionIndex: 0,
        },
        sceneId: "scene_main",
        startTimeTicks: 30,
        trackId: "track_main",
        trackLabel: "Main",
      },
    ]);
  });

  it("refreshes insert, split, and remove results from the current document", () => {
    const before = canonicalEditorPlacements(
      documentWithElements([
        {
          duration: 90,
          id: "element_before",
          startTime: 0,
          videoFsArtifact: identity,
        },
      ]),
    );
    const afterSplit = canonicalEditorPlacements(
      documentWithElements([
        {
          duration: 30,
          id: "element_before",
          startTime: 0,
          videoFsArtifact: identity,
        },
        {
          duration: 60,
          id: "element_after",
          startTime: 30,
          videoFsArtifact: identity,
        },
      ]),
    );
    const afterRemove = canonicalEditorPlacements(documentWithElements([]));
    expect(before.map((item) => item.elementId)).toEqual(["element_before"]);
    expect(afterSplit.map((item) => item.elementId)).toEqual([
      "element_before",
      "element_after",
    ]);
    expect(afterRemove).toEqual([]);
  });

  it("rejects legacy timeline IDs and mismatched current versions", () => {
    const placements = canonicalEditorPlacements({
      project: { scenes: [] },
      timeline: [{ clip_id: "clip_history", id: "legacy_timeline_id" }],
    });
    expect(placements).toEqual([]);

    const v1 = canonicalEditorPlacements(
      documentWithElements([
        {
          duration: 90,
          id: "element_v1",
          startTime: 0,
          videoFsArtifact: identity,
        },
      ]),
    );
    expect(
      placementsForExactArtifact(v1, {
        artifactId: "clip_history",
        contentHash: "b".repeat(64),
        entityRevision: 5,
        sourcePath: "media/clips/clip_history.v2.mp4",
        versionHash: "b".repeat(64),
        versionId: "v2",
        versionIndex: 1,
      }),
    ).toEqual([]);
  });

  it("derives UI placements from exact revisioned media-map identity", () => {
    const document = {
      ...documentWithElements([
        {
          duration: 45,
          id: "element_ui",
          mediaId: "media_ui",
          startTime: 12,
        },
      ]),
      mediaMap: {
        source: {
          artifact: {
            artifactId: "clip_history",
            contentHash: "a".repeat(64),
            entityRevision: 4,
            sourcePath: "media/clips/clip_history.v1.mp4",
            versionHash: "a".repeat(64),
            versionId: "v1",
            versionIndex: 0,
          },
          mediaId: "media_ui",
        },
      },
    };
    expect(canonicalEditorPlacements(document)[0]).toMatchObject({
      elementId: "element_ui",
      identity: {
        artifactId: "clip_history",
        versionId: "v1",
        versionIndex: 0,
      },
    });
  });
});
