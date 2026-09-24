import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  areCanvasCardsDeletable,
  captureCanvasModifierSelectionIntent,
  isCanvasCardDeletable,
  nextCanvasSelection,
  preservesCanvasSelectionOnFocus,
} from "../app/projects/[id]/canvas-selection";
import {
  canvasAgentContextArtifact,
  type CanvasCard,
} from "../app/projects/[id]/canvas-workspace";
import { timelineUsageForCard } from "../app/projects/[id]/canvas-tile-inspector";

const root = process.cwd();

describe("Canvas tile inspector", () => {
  it("is keyboard reachable and returns focus to its tile", async () => {
    const source = await readFile(
      `${root}/app/projects/[id]/canvas-workspace.tsx`,
      "utf8",
    );
    expect(source).toContain('if (event.key === "Enter")');
    expect(source).toContain("focusInspectorCard(card.id)");
    expect(source).toContain("<CanvasTileInspector");
    expect(source).toContain("inspectorReturnFocusRef");
    expect(source).toContain("?.focus({ preventScroll: true })");
  });

  it("shows only designer-facing content: prompt, made-with grid, versions, remediation", async () => {
    const source = await readFile(
      `${root}/app/projects/[id]/canvas-tile-inspector.tsx`,
      "utf8",
    );
    for (const label of [
      "<h3>Prompt</h3>",
      "<h3>Uses</h3>",
      "<h3>Versions</h3>",
      "canvas-inspector-used-grid",
      "onDoubleClick",
      "commitRename",
    ]) {
      expect(source).toContain(label);
    }
    for (const jargon of [
      "Primary properties",
      "Timeline Usage",
      "Lineage",
      "Advanced / Provenance",
      "connected dependenc",
      "Not placed on a timeline",
      "View source",
      "<dt>Identity</dt>",
    ]) {
      expect(source).not.toContain(jargon);
    }
    expect(source).toContain("card.remediation?.trim()");
    expect(source).toContain('role="status"');
  });

  it("bridges exact Canvas versions to Editor placements and back", async () => {
    const [inspector, canvas, workbench, editor] = await Promise.all([
      readFile(`${root}/app/projects/[id]/canvas-tile-inspector.tsx`, "utf8"),
      readFile(`${root}/app/projects/[id]/canvas-workspace.tsx`, "utf8"),
      readFile(`${root}/app/projects/[id]/project-workbench.tsx`, "utf8"),
      readFile(`${root}/opencut/host/editor-mount.tsx`, "utf8"),
    ]);
    expect(canvas).toContain("focusRequest.artifact.versionIndex");
    expect(canvas).toContain("focusRequest.openInspector");
    expect(workbench).toContain("verifyArtifactFocusIdentity");
    expect(workbench).toContain("showEditorSourceOnCanvas");
    expect(editor).toContain("resolveArtifactFocusTarget");
    expect(editor).toContain("requestRevealMedia(mediaId)");
    // The focus bridge is headless: no banner strip above the properties panel.
    expect(editor).not.toContain("data-host-artifact-focus");
    expect(editor).not.toContain("Choose placement");
    expect(editor).not.toContain("Media bin");
  });

  it("uses a docked desktop region and a selection-preserving compact overlay", async () => {
    const [inspector, canvas, styles] = await Promise.all([
      readFile(`${root}/app/projects/[id]/canvas-tile-inspector.tsx`, "utf8"),
      readFile(`${root}/app/projects/[id]/canvas-workspace.tsx`, "utf8"),
      readFile(`${root}/app/globals.css`, "utf8"),
    ]);
    expect(canvas).toContain('className="canvas-stage"');
    expect(styles).toContain("flex: 0 0 400px");
    expect(styles).toContain("@media (max-width: 1080px)");
    expect(styles).toContain("@keyframes canvas-inspector-enter");
    expect(styles).toContain("animation: canvas-inspector-enter");
    expect(styles).toContain("animation: none !important");
    expect(inspector).toContain('event.key !== "Escape"');
    expect(canvas).toContain("inspectorReturnFocusRef");
    expect(canvas).toContain("if (focusedInspectorCardId)");
    expect(canvas).toContain(
      "inspectorVisible && selectedInspectorCards.length ?",
    );
    expect(canvas).toContain(
      "inspectorReturnFocusRef.current ?? focusedInspectorCardId",
    );
    expect(canvas).toContain(
      'window.addEventListener("keydown", onKeyDown, true)',
    );
    expect(canvas).toContain("?.focus({ preventScroll: true })");
    expect(canvas).toContain("setFocusedInspectorCardId(null)");
  });

  it("autoplays focused media and keeps every operation in the Inspector", async () => {
    const [inspector, canvas] = await Promise.all([
      readFile(`${root}/app/projects/[id]/canvas-tile-inspector.tsx`, "utf8"),
      readFile(`${root}/app/projects/[id]/canvas-workspace.tsx`, "utf8"),
    ]);
    expect(inspector).toContain("controls");
    expect(inspector).toContain("muted");
    expect(inspector).toContain("autoPlay");
    for (const label of [
      '"Crop"',
      '"Adjust"',
      '"Duplicate"',
      '"Delete"',
      '"Track object"',
      '"Draw"',
      "cycleSpeed",
      "InspectorTrimStrip",
      "canvas-inspector-footer",
    ]) {
      expect(inspector).toContain(label);
    }
    expect(inspector).not.toContain("Revise");
    expect(inspector).not.toContain("Open in Editor");
    // Referencing moved to the tile hover affordance on the canvas.
    expect(inspector).not.toContain("Use as reference");
    expect(canvas).toContain('className={`canvas-card-stage');
    expect(inspector).not.toContain("Archive");
    expect(canvas).not.toContain("canvas-version-preload");
    expect(canvas).not.toContain('aria-label="Rename tile"');
    expect(canvas).not.toContain("Inspect piece");
    expect(canvas).not.toContain("canvas-focused-toolbar");
  });

  it("renders only for explicit selection and exposes mixed batch state", async () => {
    const [inspector, canvas] = await Promise.all([
      readFile(`${root}/app/projects/[id]/canvas-tile-inspector.tsx`, "utf8"),
      readFile(`${root}/app/projects/[id]/canvas-workspace.tsx`, "utf8"),
    ]);
    expect(inspector).not.toContain("Shape the pieces, then assemble them.");
    expect(inspector).not.toContain("canvas-inspector-empty");
    expect(inspector).toContain("if (!cards.length || !open) return null");
    expect(inspector).toContain("`${cards.length} selected`");
    expect(inspector).toContain("Mixed values are preserved");
    expect(inspector).toContain("Batch actions");
    expect(canvas).toContain(
      "{inspectorVisible && selectedInspectorCards.length ? (",
    );
  });

  it("never surfaces file paths or source records in the Inspector", async () => {
    const [inspector, canvas] = await Promise.all([
      readFile(`${root}/app/projects/[id]/canvas-tile-inspector.tsx`, "utf8"),
      readFile(`${root}/app/projects/[id]/canvas-workspace.tsx`, "utf8"),
    ]);
    expect(inspector).not.toContain("canvas-inspector-source-record");
    expect(inspector).not.toContain("canvas-inspector-path");
    expect(inspector).not.toContain("onOpenSource");
    expect(inspector).not.toContain("<code>{card.path}</code>");
    expect(canvas).not.toContain(
      'if (inspectorCard?.path && inspectorCard.path !== "#") onOpenFile',
    );
  });

  it("keeps Inspector focus distinct from ordered selection", async () => {
    const source = await readFile(
      `${root}/app/projects/[id]/canvas-workspace.tsx`,
      "utf8",
    );
    expect(source).toContain(
      "const [focusedInspectorCardId, setFocusedInspectorCardId] =",
    );
    expect(source).toContain("useState<string | null>(null)");
    expect(source).toContain('aria-multiselectable="true"');
    expect(source).toContain(
      'aria-current={primaryFocused ? "true" : undefined}',
    );
    expect(source).toContain("is-primary-focused");
    expect(source).toContain("is-secondary-selected");
    expect(source).toContain('primaryFocused ? ", primary selection"');
    expect(source).toContain("setFocusedInspectorCardId(null)");
    expect(source).toContain("if (!requestSelectOnly(null)) return");
  });

  it("preserves ordered additive and range selections", () => {
    expect(
      nextCanvasSelection({
        additive: false,
        allIds: ["a", "b", "c", "d"],
        currentIds: ["a"],
        primaryId: "a",
        range: true,
        targetId: "c",
      }),
    ).toEqual({ ids: ["a", "b", "c"], primaryId: "c" });

    expect(
      nextCanvasSelection({
        additive: true,
        allIds: ["a", "b", "c", "d"],
        currentIds: ["a", "c"],
        primaryId: "c",
        range: false,
        targetId: "d",
      }),
    ).toEqual({ ids: ["a", "c", "d"], primaryId: "d" });

    expect(
      nextCanvasSelection({
        additive: false,
        allIds: ["a", "b", "c"],
        currentIds: ["a", "c"],
        primaryId: "c",
        range: false,
        targetId: "b",
      }),
    ).toEqual({ ids: ["b"], primaryId: "b" });

    expect(
      nextCanvasSelection({
        additive: true,
        allIds: ["a", "b", "c"],
        currentIds: ["a", "b"],
        primaryId: "b",
        range: false,
        targetId: "b",
      }),
    ).toEqual({ ids: ["a"], primaryId: "a" });
  });

  it("preserves modifier intent through browser pointer-down, focus, click order", async () => {
    const allIds = ["a", "b", "c"];
    let selection = { ids: ["a"], primaryId: "a" as string | null };
    const browserEvents: string[] = [];

    browserEvents.push("pointer-down-capture");
    const pendingIntent = captureCanvasModifierSelectionIntent({
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
      targetId: "b",
    });

    browserEvents.push("focus");
    if (!preservesCanvasSelectionOnFocus(pendingIntent, "b")) {
      selection = nextCanvasSelection({
        additive: false,
        allIds,
        currentIds: selection.ids,
        primaryId: selection.primaryId,
        range: false,
        targetId: "b",
      });
    }

    browserEvents.push("click");
    selection = nextCanvasSelection({
      additive: pendingIntent?.additive ?? false,
      allIds,
      currentIds: selection.ids,
      primaryId: selection.primaryId,
      range: pendingIntent?.range ?? false,
      targetId: "b",
    });

    const cards: CanvasCard[] = allIds.slice(0, 2).map((id) => ({
      id,
      kind: "image",
      path: `keyframes/${id}.md`,
      src: `/media/${id}.png`,
      status: "ready",
      title: id.toUpperCase(),
    }));
    const selected = selection.ids.map((id) =>
      canvasAgentContextArtifact(
        cards.find((card) => card.id === id)!,
        null,
      ),
    );
    const contextSnapshot = {
      focused:
        selected.find((item) => item.artifactId === selection.primaryId) ??
        null,
      pinned: [],
      selected,
    };
    const optionStates = allIds.map((id) => ({
      primary: id === selection.primaryId,
      selected: selection.ids.includes(id),
    }));
    const source = await readFile(
      `${root}/app/projects/[id]/canvas-workspace.tsx`,
      "utf8",
    );

    expect(browserEvents).toEqual([
      "pointer-down-capture",
      "focus",
      "click",
    ]);
    expect(optionStates.filter((option) => option.selected)).toHaveLength(2);
    expect(optionStates.filter((option) => option.primary)).toHaveLength(1);
    expect(contextSnapshot.selected).toHaveLength(2);
    expect(contextSnapshot.focused?.artifactId).toBe("b");
    expect(source).toContain('aria-multiselectable="true"');
    expect(source).toContain("onPointerDownCapture");
    expect(source).toContain("preservesCanvasSelectionOnFocus");
    expect(source).toContain(
      'event.shiftKey || event.metaKey || event.ctrlKey',
    );
  });

  it("uses one strict deletion eligibility contract", () => {
    for (const path of [
      "clips/clip_1.md",
      "keyframes/kf_1.md",
      "uploads/upload_1.md",
    ]) {
      expect(isCanvasCardDeletable({ path })).toBe(true);
    }
    for (const path of [
      "#",
      "references/ref_1.md",
      "clips/nested/clip_1.md",
      "uploads/upload_1.png",
      "clips",
    ]) {
      expect(isCanvasCardDeletable({ path })).toBe(false);
    }
    expect(
      areCanvasCardsDeletable([
        { path: "clips/clip_1.md" },
        { path: "references/ref_1.md" },
      ]),
    ).toBe(false);
  });

  it("initializes version resolution before Inspector-derived state", async () => {
    const source = await readFile(
      `${root}/app/projects/[id]/canvas-workspace.tsx`,
      "utf8",
    );
    const resolverIndex = source.indexOf(
      "const resolveVersionIndex = useCallback",
    );
    const inspectorCardsIndex = source.indexOf(
      "const selectedInspectorCards = useMemo",
    );
    expect(resolverIndex).toBeGreaterThan(-1);
    expect(resolverIndex).toBeLessThan(inspectorCardsIndex);
  });

  it("derives placement from exact canonical artifact and version references", () => {
    const v2 = {
      artifactId: "clip_01",
      contentHash: "b".repeat(64),
      entityRevision: 2,
      sourcePath: "media/clip_01.v2.mp4",
      versionHash: "b".repeat(64),
      versionId: "v2",
      versionIndex: 1,
    };
    const v1 = {
      ...v2,
      contentHash: "a".repeat(64),
      entityRevision: 1,
      sourcePath: "media/clip_01.v1.mp4",
      versionHash: "a".repeat(64),
      versionId: "v1",
      versionIndex: 0,
    };
    const placements = [
      {
        durationTicks: 90,
        elementId: "element_v2",
        identity: v2,
        sceneId: "scene",
        startTimeTicks: 30,
        trackId: "track_main",
        trackLabel: "Main",
      },
      {
        durationTicks: 60,
        elementId: "element_other",
        identity: { ...v2, artifactId: "other" },
        sceneId: "scene",
        startTimeTicks: 0,
        trackId: "track_main",
        trackLabel: "Main",
      },
    ];
    expect(
      timelineUsageForCard({
        identity: v2,
        placements,
      }),
    ).toEqual([
      {
        durationTicks: 90,
        id: "element_v2",
        relation: "selected-version",
        startTimeTicks: 30,
        title: "element_v2",
        trackId: "track_main",
        trackLabel: "Main",
        usesSelectedVersion: true,
      },
    ]);
    expect(
      timelineUsageForCard({
        identity: v1,
        placements,
      }),
    ).toEqual([
      {
        durationTicks: 90,
        id: "element_v2",
        relation: "artifact",
        startTimeTicks: 30,
        title: "element_v2",
        trackId: "track_main",
        trackLabel: "Main",
        usesSelectedVersion: false,
      },
    ]);
  });

  it("rejects legacy timeline identifiers without exact Editor identity", () => {
    const usage = timelineUsageForCard({
      identity: {
        artifactId: "kf_1",
        contentHash: "a".repeat(64),
        entityRevision: 1,
        sourcePath: "media/keyframes/kf_1.v3.png",
        versionHash: "a".repeat(64),
        versionId: "v3",
        versionIndex: 2,
      },
      placements: [],
    });
    expect(usage).toEqual([]);
  });
});
