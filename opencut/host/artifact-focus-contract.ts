export type ArtifactFocusIdentity = {
  artifactId: string;
  contentHash: string;
  entityRevision: number;
  sourcePath: string;
  versionHash: string;
  versionId: string | null;
  versionIndex: number | null;
};

export type ArtifactFocusRequest = ArtifactFocusIdentity & {
  nonce: number;
  timelineElementId?: string | null;
};

export type ArtifactFocusResult =
  | {
      elementId: string;
      status: "focused-placement";
    }
  | {
      mediaId: string;
      status: "media-bin";
    }
  | {
      placements: Array<{ elementId: string }>;
      status: "choose-placement";
    }
  | {
      status: "focused-source";
    }
  | {
      message: string;
      status: "stale";
    };

export const EDITOR_DOCUMENT_REVISION_EVENT =
  "video-fs:editor-document-revision";

export type EditorDocumentRevisionDetail = {
  projectId: string;
  revision: number;
};

export function artifactFocusKey(identity: ArtifactFocusIdentity) {
  return [
    identity.artifactId,
    identity.versionId ?? "record",
    identity.versionIndex ?? "record",
    identity.versionHash,
  ].join(":");
}

export function artifactFocusIdentityMatches(
  left: ArtifactFocusIdentity,
  right: ArtifactFocusIdentity,
) {
  return (
    left.artifactId === right.artifactId &&
    left.versionId === right.versionId &&
    left.versionIndex === right.versionIndex &&
    left.versionHash === right.versionHash &&
    left.contentHash === right.contentHash &&
    left.entityRevision === right.entityRevision &&
    left.sourcePath === right.sourcePath
  );
}

export function dispatchEditorDocumentRevision(
  target: EventTarget,
  detail: EditorDocumentRevisionDetail,
) {
  const event = new Event(EDITOR_DOCUMENT_REVISION_EVENT);
  Object.defineProperty(event, "detail", { value: detail });
  target.dispatchEvent(event);
}

export function removedPlacementPresentation(
  placements: Array<{ elementId: string }>,
) {
  return {
    actions: placements.length
      ? (["view-media", "choose-placement"] as const)
      : (["view-media"] as const),
    label: "Placement removed",
    placementIds: placements.map((placement) => placement.elementId),
  };
}

export function resolveArtifactFocusTarget({
  mediaId,
  placements,
  timelineElementId,
}: {
  mediaId: string | null;
  placements: Array<{ elementId: string }>;
  timelineElementId?: string | null;
}):
  | { elementId: string; status: "focused-placement" }
  | { mediaId: string; status: "media-bin" }
  | { placements: Array<{ elementId: string }>; status: "choose-placement" }
  | {
      placements: Array<{ elementId: string }>;
      removedElementId: string;
      status: "removed-placement";
    }
  | { message: string; status: "stale" } {
  if (timelineElementId) {
    const placement = placements.find(
      (entry) => entry.elementId === timelineElementId,
    );
    return placement
      ? {
          elementId: placement.elementId,
          status: "focused-placement",
        }
      : {
          placements,
          removedElementId: timelineElementId,
          status: "removed-placement",
        };
  }
  if (placements.length === 1) {
    return {
      elementId: placements[0]!.elementId,
      status: "focused-placement",
    };
  }
  if (placements.length > 1) {
    return {
      placements,
      status: "choose-placement",
    };
  }
  return mediaId
    ? { mediaId, status: "media-bin" }
    : {
        message: "This exact artifact version is no longer in the Editor.",
        status: "stale",
      };
}

export function subscribeToRemovedPlacement<TPlacement extends { elementId: string }>({
  clearSelection,
  eventTarget,
  getFocusedPlacement,
  getPlacements,
  onRemoved,
  onRevision,
  projectId,
}: {
  clearSelection: () => void;
  eventTarget: EventTarget;
  getFocusedPlacement: () => {
    elementId: string;
    identity: ArtifactFocusIdentity;
    revision: number | null;
  } | null;
  getPlacements: (identity: ArtifactFocusIdentity) => TPlacement[];
  onRemoved: (value: {
    identity: ArtifactFocusIdentity;
    placements: TPlacement[];
    removedElementId: string;
    revision: number;
  }) => void;
  onRevision?: (detail: EditorDocumentRevisionDetail) => void;
  projectId: string;
}) {
  const handleRevision = (event: Event) => {
    const detail = (
      event as Event & { detail?: EditorDocumentRevisionDetail }
    ).detail;
    if (detail?.projectId === projectId) onRevision?.(detail);
    const focused = getFocusedPlacement();
    if (
      !detail ||
      detail.projectId !== projectId ||
      !focused ||
      (focused.revision !== null && detail.revision <= focused.revision)
    ) {
      return;
    }
    const placements = getPlacements(focused.identity);
    if (placements.some((entry) => entry.elementId === focused.elementId)) {
      return;
    }
    clearSelection();
    onRemoved({
      identity: focused.identity,
      placements,
      removedElementId: focused.elementId,
      revision: detail.revision,
    });
  };
  eventTarget.addEventListener(
    EDITOR_DOCUMENT_REVISION_EVENT,
    handleRevision,
  );
  return () =>
    eventTarget.removeEventListener(
      EDITOR_DOCUMENT_REVISION_EVENT,
      handleRevision,
    );
}
