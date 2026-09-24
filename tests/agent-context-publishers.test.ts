import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AgentContextIndicator,
  EMPTY_CANVAS_AGENT_CONTEXT,
  EMPTY_EDITOR_AGENT_CONTEXT,
  activeAgentContextSnapshot,
  agentConnectionIndicatorPresentation,
  agentContextViewMatches,
  agentContextIndicatorPresentation,
  agentSetupRowPresentation,
  contextVisibleCount,
  type AgentContextArtifact,
} from "@/app/projects/[id]/agent-context-publisher";
import {
  canvasAgentContextArtifact,
  type CanvasCard,
} from "@/app/projects/[id]/canvas-workspace";
import {
  editorAgentContextSnapshot,
  selectedElementsForFocusedPlacement,
} from "@/opencut/host/agent-context-publisher";

const artifact = (artifactId: string): AgentContextArtifact => ({
  artifactId,
  contentHash: "a".repeat(64),
  entityRevision: 1,
  kind: "image",
  path: `keyframes/${artifactId}.md`,
  title: artifactId,
  version: null,
});

describe("Canvas agent-context publisher", () => {
  it("treats an identical acknowledged snapshot as a reload no-op", () => {
    const snapshot = activeAgentContextSnapshot({
      activeView: "canvas",
      canvas: EMPTY_CANVAS_AGENT_CONTEXT,
      editor: EMPTY_EDITOR_AGENT_CONTEXT,
      projectRevision: "revision-7",
    });

    expect(agentContextViewMatches(snapshot, { ...snapshot })).toBe(true);
    expect(
      agentContextViewMatches(snapshot, {
        ...snapshot,
        projectRevision: "revision-8",
      }),
    ).toBe(true);
    expect(
      agentContextViewMatches(snapshot, {
        ...snapshot,
        activeView: "editor",
      }),
    ).toBe(false);
  });

  it("publishes the exact displayed historical version and canonical object kind", () => {
    const card: CanvasCard = {
      id: "upload_prop",
      kind: "image",
      path: "uploads/upload_prop.md",
      pieceKind: "prop" as never,
      src: "/current.png",
      status: "ready",
      title: "Hero prop",
      versions: [
        {
          id: "/v1.png",
          isCurrent: false,
          label: "v1",
          path: "media/uploads/upload_prop.v1.png",
          revision: 1,
          src: "/v1.png",
        },
        {
          id: "/v2.png",
          isCurrent: true,
          label: "v2",
          path: "media/uploads/upload_prop.v2.png",
          revision: 2,
          src: "/v2.png",
        },
      ],
    };

    expect(canvasAgentContextArtifact(card, 0)).toEqual({
      artifactId: "upload_prop",
      kind: "object",
      sourcePath: "uploads/upload_prop.md",
      title: "Hero prop",
      version: {
        index: 0,
        path: "media/uploads/upload_prop.v1.png",
        revision: 1,
        versionId: "v1",
      },
    });
  });

  it("keeps inactive Canvas pins but excludes inactive selections", () => {
    const selected = artifact("selected");
    const pinned = artifact("pinned");
    const editor = {
      ...EMPTY_EDITOR_AGENT_CONTEXT,
      selectedElements: [
        {
          elementId: "element",
          kind: "video",
          mediaId: "clip",
          trackId: "track",
        },
      ],
      selectedTrackIds: ["track"],
    };
    const active = activeAgentContextSnapshot({
      activeView: "editor",
      canvas: {
        focused: selected,
        pinned: [pinned],
        selected: [selected],
      },
      editor,
      projectRevision: "revision",
    });

    expect(active.canvas).toEqual({
      focused: null,
      pinned: [pinned],
      selected: [],
    });
    expect(contextVisibleCount(active)).toBe(3);
    expect(
      activeAgentContextSnapshot({
        ...active,
        activeView: "canvas",
      }).editor,
    ).toEqual(EMPTY_EDITOR_AGENT_CONTEXT);
  });

  it("preserves the user's Canvas selection order and focused artifact", () => {
    const first = artifact("first");
    const second = artifact("second");
    const active = activeAgentContextSnapshot({
      activeView: "canvas",
      canvas: {
        focused: second,
        pinned: [],
        selected: [second, first],
      },
      editor: EMPTY_EDITOR_AGENT_CONTEXT,
      projectRevision: "revision",
    });

    expect(active.canvas.selected.map((item) => item.artifactId)).toEqual([
      "second",
      "first",
    ]);
    expect(active.canvas.focused?.artifactId).toBe("second");
  });

  it("never counts a Canvas artifact before its byte identity is complete", () => {
    const unresolved = {
      ...artifact("unresolved"),
      contentHash: null,
      entityRevision: null,
    };
    expect(
      contextVisibleCount({
        activeView: "canvas",
        canvas: {
          focused: unresolved,
          pinned: [],
          selected: [unresolved],
        },
        editor: EMPTY_EDITOR_AGENT_CONTEXT,
        projectRevision: "revision",
      }),
    ).toBe(0);
  });
});

describe("OpenCut agent-context publisher", () => {
  it("does not publish a reconciled sibling while explicit placement A is removed", () => {
    expect(
      selectedElementsForFocusedPlacement({
        focusedPlacement: {
          elementId: "placement-a",
          status: "removed",
        },
        selectedElements: [
          { elementId: "placement-b", trackId: "track-main" },
        ],
      }),
    ).toEqual([]);
  });

  it("publishes an exact focused media-bin asset without a timeline selection", () => {
    const focusedArtifact = {
      ...artifact("media_bin_history"),
      contentHash: "b".repeat(64),
      entityRevision: 7,
      path: "media/clips/media_bin_history.v1.mp4",
      version: {
        index: 0,
        sha256: "b".repeat(64),
        versionId: "v1",
      },
    };
    const context = editorAgentContextSnapshot({
      documentRevision: 12,
      focusedArtifact,
      focusedPlacement: {
        elementId: "placement-a",
        status: "removed",
      },
      playheadTicks: 0,
      project: null,
      scene: null,
      selection: {
        selectedElements: [],
        selectedKeyframes: [],
        selectedMaskPoints: null,
      },
    });
    expect(context.focusedArtifact).toEqual(focusedArtifact);
    expect(context.focusedPlacement).toEqual({
      elementId: "placement-a",
      status: "removed",
    });
    expect(
      contextVisibleCount({
        activeView: "editor",
        canvas: EMPTY_CANVAS_AGENT_CONTEXT,
        editor: context,
        projectRevision: "revision",
      }),
    ).toBe(1);
  });

  it("publishes scene, revision, selections, playhead, range, and FPS atomically", () => {
    const scene = {
      bookmarks: [],
      createdAt: new Date(0),
      id: "scene_main",
      isMain: true,
      name: "Main",
      tracks: {
        audio: [],
        main: {
          elements: [
            {
              animations: {
                opacity: {
                  keys: [
                    {
                      id: "key_opacity",
                      segmentToNext: "linear",
                      tangentMode: "auto",
                      time: 50,
                      value: 1,
                    },
                  ],
                },
              },
              duration: 200,
              id: "element_video",
              mediaId: "clip_alpha",
              name: "Alpha",
              params: {},
              startTime: 100,
              trimEnd: 0,
              trimStart: 0,
              type: "video",
            },
          ],
          hidden: false,
          id: "track_main",
          muted: false,
          name: "Main",
          type: "video",
        },
        overlay: [],
      },
      updatedAt: new Date(0),
    };
    const project = {
      currentSceneId: "scene_main",
      metadata: {
        createdAt: new Date(0),
        duration: 300,
        id: "project",
        name: "Project",
        updatedAt: new Date(0),
      },
      scenes: [scene],
      settings: {
        background: { color: "#000", type: "color" },
        canvasSize: { height: 1080, width: 1920 },
        fps: { denominator: 1001, numerator: 30000 },
      },
      version: 1,
    };

    const context = editorAgentContextSnapshot({
      documentRevision: 12,
      playheadTicks: 175,
      project: project as never,
      scene: scene as never,
      selection: {
        selectedElements: [
          { elementId: "element_video", trackId: "track_main" },
        ],
        selectedKeyframes: [
          {
            elementId: "element_video",
            keyframeId: "key_opacity",
            propertyPath: "opacity",
            trackId: "track_main",
          },
        ],
        selectedMaskPoints: {
          elementId: "element_video",
          maskId: "mask",
          pointIds: ["point_a", "point_b"],
          trackId: "track_main",
        },
      },
    });

    expect(context).toMatchObject({
      documentRevision: 12,
      fps: 30000 / 1001,
      playheadTicks: 175,
      sceneId: "scene_main",
      selectedElements: [
        {
          elementId: "element_video",
          kind: "video",
          mediaId: "clip_alpha",
          trackId: "track_main",
        },
      ],
      selectedKeyframes: [
        {
          elementId: "element_video",
          keyframeId: "key_opacity",
          property: "opacity",
          trackId: "track_main",
        },
      ],
      selectedMaskPoints: {
        elementId: "element_video",
        pointIds: ["point_a", "point_b"],
        trackId: "track_main",
      },
      selectedTrackIds: ["track_main"],
      timeRange: { endTicks: 300, startTicks: 100 },
    });
  });
});

describe("agent-context indicator and CAS boundary", () => {
  it("uses truthful state precedence without a fake thinking state", () => {
    expect(
      agentContextIndicatorPresentation({
        approvalRequired: true,
        connected: false,
        contextRevision: null,
        staleCount: 1,
        syncing: false,
        visibleCount: 2,
      }).label,
    ).toBe("Approval required");
    expect(
      agentContextIndicatorPresentation({
        approvalRequired: false,
        connected: false,
        contextRevision: null,
        staleCount: 0,
        syncing: false,
        visibleCount: 0,
      }).label,
    ).toBe("Desktop unavailable");
    expect(
      agentContextIndicatorPresentation({
        approvalRequired: false,
        connected: true,
        contextRevision: 3,
        staleCount: 1,
        syncing: false,
        visibleCount: 1,
      }).label,
    ).toBe("Context stale");
    expect(
      agentContextIndicatorPresentation({
        approvalRequired: false,
        connected: true,
        contextRevision: 3,
        staleCount: 0,
        syncing: false,
        visibleCount: 0,
      }).label,
    ).toBe("Context off");
    expect(
      renderToStaticMarkup(
        createElement(AgentContextIndicator, {
          approvalRequired: false,
          projectId: "project",
          state: {
            connected: true,
            contextRevision: 3,
            staleCount: 0,
            syncing: false,
            visibleCount: 2,
          },
        }),
      ),
    ).toContain("Desktop connected");
    expect(agentConnectionIndicatorPresentation(true)).toEqual({
      label: "Desktop connected",
      title: "Video FS Desktop is connected.",
      tone: "connected",
    });
    expect(agentConnectionIndicatorPresentation(false)).toEqual({
      label: "Desktop unavailable",
      title: "Video FS Desktop is unavailable.",
      tone: "disconnected",
    });
    expect(
      agentContextIndicatorPresentation({
        approvalRequired: false,
        connected: true,
        contextRevision: 3,
        staleCount: 0,
        syncing: true,
        visibleCount: 2,
      }),
    ).toMatchObject({
      label: "Syncing context",
      title: expect.stringContaining("still sees 2 items"),
    });
  });

  it("shows only observed setup and context states", () => {
    const connected = {
      connected: true,
      contextRevision: 3,
      staleCount: 0,
      syncing: false,
      visibleCount: 2,
    };
    expect(
      agentSetupRowPresentation({
        approvalRequired: false,
        configInstalled: true,
        contextHookInstalled: true,
        desktopAvailable: true,
        setupLoading: false,
        state: connected,
      }),
    ).toEqual({ label: "Context acknowledged", tone: "ready" });
    expect(
      agentSetupRowPresentation({
        approvalRequired: false,
        configInstalled: true,
        contextHookInstalled: false,
        desktopAvailable: true,
        setupLoading: false,
        state: { ...connected, visibleCount: 0 },
      }),
    ).toEqual({ label: "Config installed", tone: "ready" });
    expect(
      agentSetupRowPresentation({
        approvalRequired: false,
        configInstalled: true,
        contextHookInstalled: true,
        desktopAvailable: false,
        setupLoading: false,
        state: connected,
      }),
    ).toEqual({ label: "Desktop unavailable", tone: "attention" });
    expect(
      agentSetupRowPresentation({
        approvalRequired: true,
        configInstalled: true,
        contextHookInstalled: true,
        desktopAvailable: true,
        setupLoading: false,
        state: connected,
      }),
    ).toEqual({ label: "Approval required", tone: "attention" });
    expect(
      agentSetupRowPresentation({
        approvalRequired: false,
        configInstalled: true,
        contextHookInstalled: true,
        desktopAvailable: true,
        setupLoading: false,
        state: { ...connected, staleCount: 1 },
      }),
    ).toEqual({ label: "Context stale", tone: "stale" });
  });

  it("sends complete snapshots through acknowledged compare-and-swap updates", async () => {
    const source = await readFile(
      `${process.cwd()}/app/projects/[id]/agent-context-publisher.tsx`,
      "utf8",
    );
    expect(source).toContain("baseContextRevision: revisionRef.current");
    expect(source).toContain("canvas: currentDesired.canvas");
    expect(source).toContain("editor: currentDesired.editor");
    expect(source).toContain("if (response.status === 409)");
    expect(source).toContain("await readCurrent()");
    expect(source).toContain("acknowledge(payload");
    expect(source).toContain("await verifyArtifactIdentityBeforeAcknowledge");
    expect(source).toContain("drainPendingRef.current = true");
    expect(source).toContain("queueMicrotask(() => void drainRef.current())");
    expect(source).toContain(
      "current.syncing ? { ...current, syncing: false } : current",
    );
    expect(source).not.toContain("thinking");

    const canvasSource = await readFile(
      `${process.cwd()}/app/projects/[id]/canvas-workspace.tsx`,
      "utf8",
    );
    expect(canvasSource).toContain("stagedCardIds?: string[]");
    expect(canvasSource).toContain("onAgentContextClear?.()");
  });
});
