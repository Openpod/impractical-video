import { describe, expect, it } from "vitest";
import {
  artifactFocusIdentityMatches,
  dispatchEditorDocumentRevision,
  removedPlacementPresentation,
  resolveArtifactFocusTarget,
  subscribeToRemovedPlacement,
  type ArtifactFocusIdentity,
} from "../opencut/host/artifact-focus-contract";

const v1: ArtifactFocusIdentity = {
  artifactId: "clip_opening",
  contentHash: "a".repeat(64),
  entityRevision: 1,
  sourcePath: "media/clips/clip_opening.v1.mp4",
  versionHash: "a".repeat(64),
  versionId: "v1",
  versionIndex: 0,
};

describe("artifact focus contract", () => {
  it("never treats a current version as the selected historical version", () => {
    const v2 = {
      ...v1,
      contentHash: "b".repeat(64),
      entityRevision: 2,
      sourcePath: "media/clips/clip_opening.v2.mp4",
      versionHash: "b".repeat(64),
      versionId: "v2",
      versionIndex: 1,
    };

    expect(artifactFocusIdentityMatches(v1, v1)).toBe(true);
    expect(artifactFocusIdentityMatches(v1, v2)).toBe(false);
  });

  it("focuses the requested exact placement", () => {
    expect(
      resolveArtifactFocusTarget({
        mediaId: "media-v1",
        placements: [{ elementId: "left" }, { elementId: "right" }],
        timelineElementId: "right",
      }),
    ).toEqual({ elementId: "right", status: "focused-placement" });
  });

  it("reveals a media-bin asset without inserting it", () => {
    expect(
      resolveArtifactFocusTarget({
        mediaId: "media-v1",
        placements: [],
      }),
    ).toEqual({ mediaId: "media-v1", status: "media-bin" });
  });

  it("requires an explicit choice for multiple placements and never guesses", () => {
    expect(
      resolveArtifactFocusTarget({
        mediaId: "media-v1",
        placements: [{ elementId: "left" }, { elementId: "right" }],
      }),
    ).toEqual({
      placements: [{ elementId: "left" }, { elementId: "right" }],
      status: "choose-placement",
    });
  });

  it("retains a deleted requested placement as removed", () => {
    expect(
      resolveArtifactFocusTarget({
        mediaId: "media-v1",
        placements: [{ elementId: "left" }],
        timelineElementId: "removed",
      }),
    ).toEqual({
      placements: [{ elementId: "left" }],
      removedElementId: "removed",
      status: "removed-placement",
    });
  });

  it("clears placement A synchronously on the real newer revision event", () => {
    const target = new EventTarget();
    const sequence: string[] = [];
    let removed:
      | {
          placements: Array<{ elementId: string }>;
          removedElementId: string;
          revision: number;
        }
      | undefined;
    const unsubscribe = subscribeToRemovedPlacement({
      clearSelection: () => sequence.push("selection-cleared"),
      eventTarget: target,
      getFocusedPlacement: () => ({
        elementId: "placement-a",
        identity: v1,
        revision: 4,
      }),
      getPlacements: () => [{ elementId: "placement-b" }],
      onRemoved: (value) => {
        sequence.push("removed-rendered");
        removed = value;
      },
      projectId: "project-a",
    });
    dispatchEditorDocumentRevision(target, {
      projectId: "project-a",
      revision: 5,
    });
    unsubscribe();

    expect(sequence).toEqual(["selection-cleared", "removed-rendered"]);
    expect(removed).toMatchObject({
      placements: [{ elementId: "placement-b" }],
      removedElementId: "placement-a",
      revision: 5,
    });
    expect(
      removedPlacementPresentation(removed?.placements ?? []),
    ).toEqual({
      actions: ["view-media", "choose-placement"],
      label: "Placement removed",
      placementIds: ["placement-b"],
    });
  });
});
