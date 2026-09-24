import { describe, expect, it } from "vitest";
import {
  buildBuiltAgainst,
  characterRegion,
  composeConditionedPrompt,
  composeStagingDirection,
  enrichPortfolioAssetPrompt,
  regionForScreenPosition,
  resolveGenerationAnchors,
  sceneStateOrderSwaps,
  type SceneState,
} from "@/lib/generation-contract";
import { buildSourceGraph, identityHash } from "@/lib/source-graph";
import { baseProject, md, withFile } from "./helpers";

function graphFromBase() {
  return buildSourceGraph(baseProject());
}

describe("sceneStateOrderSwaps", () => {
  const state = (
    chars: Array<[string, SceneState["characters"][number]["screen_position"]]>,
  ): SceneState => ({
    characters: chars.map(([id, screen_position]) => ({
      id,
      screen_position,
      facing: "neutral",
    })),
    props: [],
    set_anchors: [],
  });

  it("reports no swap when left/right order is preserved", () => {
    const a = state([["ivy", "left"], ["ren", "right"]]);
    const b = state([["ivy", "left_center"], ["ren", "right"]]);
    expect(sceneStateOrderSwaps(a, b)).toEqual([]);
  });

  it("detects two subjects crossing left/right order", () => {
    const a = state([["ivy", "left"], ["ren", "right"]]);
    const b = state([["ivy", "right"], ["ren", "left"]]);
    expect(sceneStateOrderSwaps(a, b)).toEqual(["ivy<->ren"]);
  });

  it("ignores depth/offscreen positions that carry no horizontal order", () => {
    const a = state([["ivy", "foreground"], ["ren", "left"]]);
    const b = state([["ivy", "background"], ["ren", "right"]]);
    expect(sceneStateOrderSwaps(a, b)).toEqual([]);
  });

  it("returns empty when fewer than two characters are common to both", () => {
    const a = state([["ivy", "left"], ["ren", "right"]]);
    const b = state([["ivy", "right"]]);
    expect(sceneStateOrderSwaps(a, b)).toEqual([]);
  });
});

describe("composeStagingDirection", () => {
  it("renders character positions/facing, prop ownership, and set anchors", () => {
    const sceneState: SceneState = {
      characters: [
        { id: "reno", screen_position: "left", facing: "right" },
        { id: "maya", screen_position: "right_center", facing: "left" },
      ],
      props: [
        { id: "purse", owner: "maya", location: "right_center" },
        { id: "scooter", owner: null, location: "foreground" },
      ],
      set_anchors: [{ id: "ticket booth", location: "background" }],
    };
    const out = composeStagingDirection(sceneState);
    expect(out).toContain("reno is in the left of frame, facing screen-right.");
    expect(out).toContain("maya is right of center, facing screen-left.");
    expect(out).toContain("the purse is held by maya.");
    expect(out).toContain("the scooter is unattended in the foreground.");
    expect(out).toContain("ticket booth sits in the background.");
  });

  it("omits facing when neutral and returns null for empty state", () => {
    const out = composeStagingDirection({
      characters: [{ id: "solo", screen_position: "center", facing: "neutral" }],
      props: [],
      set_anchors: [],
    });
    expect(out).toBe("- solo is in the center.");
    expect(
      composeStagingDirection({ characters: [], props: [], set_anchors: [] }),
    ).toBeNull();
  });

  it("derives left/right regions that preserve horizontal order", () => {
    const left = regionForScreenPosition("left");
    const right = regionForScreenPosition("right");
    expect(left.x).toBeLessThan(right.x);
    expect(left.h).toBe(1);
    expect(regionForScreenPosition("offscreen")).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it("characterRegion prefers an explicit bbox over the derived region", () => {
    const explicit = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    expect(
      characterRegion({ id: "ava", screen_position: "right", facing: "left", bbox: explicit }),
    ).toEqual(explicit);
    expect(
      characterRegion({ id: "ava", screen_position: "right", facing: "left" }),
    ).toEqual(regionForScreenPosition("right"));
  });

  it("appends declared staging into the conditioned prompt", () => {
    const prompt = composeConditionedPrompt({
      anchors: [],
      stateAnchorUrl: null,
      instruction: "Maya lunges at the thief.",
      staging: "- maya is in the left of frame.",
    });
    expect(prompt).toContain("Maya lunges at the thief.");
    expect(prompt).toContain("Declared staging (match these on-screen positions):");
    expect(prompt).toContain("- maya is in the left of frame.");
  });
});

describe("resolveGenerationAnchors", () => {
  it("resolves portfolio ids and reference ids to ordered image urls", () => {
    const graph = graphFromBase();
    const byPortfolioId = resolveGenerationAnchors(graph, {
      identityAnchorIds: ["char_a_portfolio"],
      stateAnchorId: "kf_1",
    });
    const byReferenceId = resolveGenerationAnchors(graph, {
      identityAnchorIds: ["char_a"],
      stateAnchorId: "kf_1",
    });
    expect(byPortfolioId.ok).toBe(true);
    expect(byReferenceId.ok).toBe(true);
    if (byPortfolioId.ok && byReferenceId.ok) {
      // Identity sheets first, prior frame last.
      expect(byPortfolioId.imageUrls).toEqual([
        "https://m.example/char_a.png",
        "https://m.example/kf_1.png",
      ]);
      expect(byReferenceId.imageUrls).toEqual(byPortfolioId.imageUrls);
    }
  });

  it("fails when an anchor resolves to no portfolio", () => {
    const result = resolveGenerationAnchors(graphFromBase(), {
      identityAnchorIds: ["char_ghost"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/resolves to no portfolio/);
  });

  it("fails when the portfolio has no urls yet", () => {
    const files = withFile(
      baseProject(),
      "references/characters/char_a/portfolio.md",
      md({
        id: "char_a_portfolio",
        type: "portfolio",
        reference_id: "char_a",
        status: "planned",
        urls: [],
      }),
    );
    const result = resolveGenerationAnchors(buildSourceGraph(files), {
      identityAnchorIds: ["char_a"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no media urls/);
  });

  it("fails when the state anchor is missing or unrendered", () => {
    const graph = graphFromBase();
    const missing = resolveGenerationAnchors(graph, {
      identityAnchorIds: [],
      stateAnchorId: "kf_ghost",
    });
    expect(missing.ok).toBe(false);

    const files = baseProject().map((file) =>
      file.path === "keyframes/kf_1.md"
        ? {
            ...file,
            content: file.content
              .replace('"status": "generated"', '"status": "planned"')
              .replace('"url": "https://m.example/kf_1.png"', '"url": null'),
          }
        : file,
    );
    const unrendered = resolveGenerationAnchors(buildSourceGraph(files), {
      identityAnchorIds: [],
      stateAnchorId: "kf_1",
    });
    expect(unrendered.ok).toBe(false);
    if (!unrendered.ok) expect(unrendered.error).toMatch(/no media url/);
  });
});

describe("composeConditionedPrompt", () => {
  it("names the role of every conditioning image deterministically", () => {
    const graph = graphFromBase();
    const resolution = resolveGenerationAnchors(graph, {
      identityAnchorIds: ["char_a"],
      stateAnchorId: "kf_1",
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    const prompt = composeConditionedPrompt({
      anchors: resolution.anchors,
      stateAnchorUrl: resolution.stateAnchorUrl,
      instruction: "The hero turns toward the door.",
    });
    expect(prompt).toContain('Image 1: identity reference sheet for "char_a"');
    expect(prompt).toContain("Image 2: the previous frame");
    expect(prompt).toContain("keep character identity, art style, world/location, and lighting consistent");
    expect(prompt).toContain("The hero turns toward the door.");
    expect(prompt.indexOf("Image 1")).toBeLessThan(prompt.indexOf("Image 2"));
  });

  it("returns the raw instruction when there is nothing to condition on", () => {
    const prompt = composeConditionedPrompt({
      anchors: [],
      stateAnchorUrl: null,
      instruction: "An abstract title card.",
    });
    expect(prompt).toBe("An abstract title card.");
  });

  it("offsets image numbers when a base image precedes the anchors (revise mode)", () => {
    const graph = graphFromBase();
    const resolution = resolveGenerationAnchors(graph, {
      identityAnchorIds: ["char_a"],
      stateAnchorId: null,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    // With imageOffset 1 (a revise base frame at Image 1), the anchor must be
    // labeled Image 2 — not Image 1, which would collide with the base frame.
    const prompt = composeConditionedPrompt({
      anchors: resolution.anchors,
      stateAnchorUrl: resolution.stateAnchorUrl,
      instruction: "Remove the stray object.",
      imageOffset: 1,
    });
    expect(prompt).toContain('Image 2: identity reference sheet for "char_a"');
    expect(prompt).not.toContain('Image 1: identity reference sheet');
  });
});

describe("enrichPortfolioAssetPrompt", () => {
  it("strengthens adult female glamour portfolio prompts with concrete body and wardrobe direction", () => {
    const prompt = enrichPortfolioAssetPrompt({
      category: "characters",
      prompt:
        "Adult Asian woman general, early 30s, high-fashion beauty and commanding presence. Wardrobe includes oversized crisp white button-down shirt over white underwear, fully SFW and non-explicit.",
    });

    expect(prompt).toContain("supermodel-level facial beauty");
    expect(prompt).toContain("full bust");
    expect(prompt).toContain("defined waist");
    expect(prompt).toContain("shapely hips");
    expect(prompt).toContain("preserve and strengthen that exact wardrobe direction");
    expect(prompt).toContain("PromptCat-style decomposition");
    expect(prompt).toContain("body proportion averaging");
    expect(prompt).toContain("dataset-average female anatomy");
    expect(prompt).toContain("naturalization of prominent features");
    expect(prompt).not.toContain("Do not add pants");
    expect(prompt).not.toContain("fully SFW");
    expect(prompt).not.toContain("no nudity");
    expect(prompt).not.toContain("non-explicit");
  });

  it("does not sensualize youth-coded or explicitly modest character prompts", () => {
    const youth = "Teen girl scout character, cheerful and childlike.";
    const modest =
      "Adult woman, early 30s, modest conservative wardrobe, no cleavage, ordinary office worker.";

    expect(enrichPortfolioAssetPrompt({ category: "characters", prompt: youth })).toBe(youth);
    expect(enrichPortfolioAssetPrompt({ category: "characters", prompt: modest })).toBe(modest);
  });

  it("leaves non-character portfolio prompts unchanged", () => {
    const prompt = "Adult female mannequin-style prop in a retail window.";
    expect(enrichPortfolioAssetPrompt({ category: "props", prompt })).toBe(prompt);
  });
});

describe("buildBuiltAgainst", () => {
  it("records current identity hashes for known dependencies and skips unknowns", () => {
    const graph = graphFromBase();
    const reference = graph.references.get("char_a");
    expect(reference).toBeDefined();
    const hashes = buildBuiltAgainst(graph, ["char_a", "kf_1", "nonexistent"]);
    expect(hashes.char_a).toBe(
      identityHash({ kind: "reference", node: reference! }),
    );
    expect(hashes.kf_1).toBeDefined();
    expect(hashes.nonexistent).toBeUndefined();
  });
});
