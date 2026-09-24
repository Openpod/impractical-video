import { describe, expect, it } from "vitest";
import { lintSourceFiles } from "@/lib/lint";
import {
  buildSourceGraph,
  CLIP_PLAN_HASH_SUFFIX,
  clipPlanHashValue,
  identityHash,
  type SourceFile,
} from "@/lib/source-graph";
import { baseProject, loadFixture, md, withFile } from "./helpers";

function rulesOf(files: SourceFile[], level?: "error" | "warning" | "info") {
  const result = lintSourceFiles(files);
  return result.issues
    .filter((issue) => !level || issue.level === level)
    .map((issue) => issue.rule);
}

describe("lint: coherent projects", () => {
  it("passes the valid fixture with no errors or warnings", () => {
    const result = lintSourceFiles(loadFixture("valid-continuous"));
    expect(
      result.issues.filter((issue) => issue.level !== "info"),
    ).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("passes the minimal base project", () => {
    const result = lintSourceFiles(baseProject());
    expect(
      result.issues.filter((issue) => issue.level !== "info"),
    ).toEqual([]);
  });
});

describe("lint: edge resolution", () => {
  it("flags depicts pointing at a missing reference", () => {
    const files = withFile(
      baseProject(),
      "keyframes/kf_1.md",
      md(
        {
          id: "kf_1",
          type: "keyframe",
          status: "generated",
          url: "https://m.example/kf_1.png",
          depicts: ["char_ghost"],
          identity_anchors: ["char_a_portfolio"],
        },
        "Opening frame.",
      ),
    );
    expect(rulesOf(files, "error")).toContain("missing-ref");
  });

  it("flags identity anchors that resolve to no portfolio", () => {
    const files = withFile(
      baseProject(),
      "keyframes/kf_1.md",
      md(
        {
          id: "kf_1",
          type: "keyframe",
          status: "generated",
          url: "https://m.example/kf_1.png",
          depicts: ["char_a"],
          identity_anchors: ["nonexistent_portfolio"],
        },
        "Opening frame.",
      ),
    );
    expect(rulesOf(files, "error")).toContain("missing-ref");
  });

  it("accepts a reference id as an identity anchor when its portfolio exists", () => {
    const files = withFile(
      baseProject(),
      "keyframes/kf_1.md",
      md(
        {
          id: "kf_1",
          type: "keyframe",
          status: "generated",
          url: "https://m.example/kf_1.png",
          depicts: ["char_a"],
          identity_anchors: ["char_a"],
        },
        "Opening frame.",
      ),
    );
    expect(rulesOf(files, "error")).not.toContain("missing-ref");
  });

  it("flags timeline entries pointing at missing clips", () => {
    const files = withFile(
      baseProject(),
      "timeline.json",
      JSON.stringify([{ id: "tl_x", clip_id: "clip_missing", url: null }]),
    );
    expect(rulesOf(files, "error")).toContain("timeline-missing-clip");
  });
});

describe("lint: keyframe image similarity", () => {
  const duplicateHash = "80000000000";

  function withKeyframeHashes(files: SourceFile[]) {
    return files.map((file) => {
      if (file.path === "keyframes/kf_1.md") {
        return {
          ...file,
          content: file.content.replace(
            '"state_anchor": null',
            `"state_anchor": null,\n  "image_phash": "${duplicateHash}"`,
          ),
        };
      }
      if (file.path === "keyframes/kf_2.md") {
        return {
          ...file,
          content: file.content.replace(
            '"state_anchor": "kf_1"',
            `"state_anchor": "kf_1",\n  "image_phash": "${duplicateHash}"`,
          ),
        };
      }
      return file;
    });
  }

  it("errors when an action clip's endpoint images are near-duplicates", () => {
    const files = withFile(
      withKeyframeHashes(baseProject()),
      "clips/clip_1.md",
      md(
        {
          id: "clip_1",
          type: "clip",
          scene: "scene_1",
          index: 1,
          status: "active",
          url: "https://m.example/clip_1.mp4",
          from_keyframe: "kf_1",
          to_keyframe: "kf_2",
          end_trust: "pinned",
          transition_from_previous: null,
          prompt_plan: {
            action_intent: "Fight scene; hero lunges into a hard kick.",
            action_beats: ["Hero lunges into a hard kick."],
          },
        },
        "Clip one.",
      ),
    );
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "keyframe-image-similarity",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("error");
  });

  it("warns instead of errors when a near-duplicate pair is an explicit hold", () => {
    const files = withFile(
      withKeyframeHashes(baseProject()),
      "clips/clip_1.md",
      md(
        {
          id: "clip_1",
          type: "clip",
          scene: "scene_1",
          index: 1,
          status: "active",
          url: "https://m.example/clip_1.mp4",
          from_keyframe: "kf_1",
          to_keyframe: "kf_2",
          end_trust: "pinned",
          transition_from_previous: null,
          prompt_plan: {
            action_intent: "Quiet reaction hold; the hero pauses in stillness.",
            action_beats: ["Hero holds a quiet reaction."],
          },
        },
        "Clip one.",
      ),
    );
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "keyframe-image-similarity",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
  });
});

describe("lint: identity-portfolio rule", () => {
  it("errors when a generated keyframe depicts a reference without a usable portfolio", () => {
    const files = baseProject().filter(
      (file) => file.path !== "references/characters/char_a/portfolio.md",
    );
    // Remove the anchors too; this test targets the portfolio rule.
    const stripped = withFile(
      files,
      "keyframes/kf_1.md",
      md(
        {
          id: "kf_1",
          type: "keyframe",
          status: "generated",
          url: "https://m.example/kf_1.png",
          depicts: ["char_a"],
          identity_anchors: [],
        },
        "Opening frame.",
      ),
    );
    expect(rulesOf(stripped, "error")).toContain("identity-portfolio");
  });

  it("treats a planned-only recurring reference as a warning", () => {
    const files: SourceFile[] = [
      {
        path: "references/characters/char_a/reference.md",
        content: md(
          { id: "char_a", type: "reference", category: "characters" },
          "Hero.",
        ),
      },
      {
        path: "keyframes/kf_1.md",
        content: md(
          { id: "kf_1", type: "keyframe", status: "planned", depicts: ["char_a"] },
          "Planned frame one.",
        ),
      },
      {
        path: "keyframes/kf_2.md",
        content: md(
          { id: "kf_2", type: "keyframe", status: "planned", depicts: ["char_a"] },
          "Planned frame two.",
        ),
      },
    ];
    expect(rulesOf(files, "warning")).toContain("identity-portfolio");
    expect(rulesOf(files, "error")).not.toContain("identity-portfolio");
  });

  it("downgrades style references one severity level", () => {
    const files: SourceFile[] = [
      {
        path: "references/styles/style_x/reference.md",
        content: md(
          { id: "style_x", type: "reference", category: "styles" },
          "Moody noir.",
        ),
      },
      {
        path: "keyframes/kf_1.md",
        content: md(
          {
            id: "kf_1",
            type: "keyframe",
            status: "generated",
            url: "https://m.example/kf_1.png",
            depicts: ["style_x"],
            identity_anchors: [],
          },
          "Frame.",
        ),
      },
    ];
    const result = lintSourceFiles(files);
    const portfolioIssues = result.issues.filter(
      (issue) => issue.rule === "identity-portfolio",
    );
    expect(portfolioIssues).toHaveLength(1);
    expect(portfolioIssues[0].level).toBe("warning");
  });
});

describe("lint: anchor rules", () => {
  it("errors on a generated keyframe with depicts but no identity anchors", () => {
    const files = withFile(
      baseProject(),
      "keyframes/kf_1.md",
      md(
        {
          id: "kf_1",
          type: "keyframe",
          status: "generated",
          url: "https://m.example/kf_1.png",
          depicts: ["char_a"],
          identity_anchors: [],
        },
        "Opening frame.",
      ),
    );
    expect(rulesOf(files, "error")).toContain("anchorless-keyframe");
  });

  it("exempts captured keyframes from the anchor rule", () => {
    const files = withFile(
      baseProject(),
      "keyframes/kf_cap.md",
      md(
        {
          id: "kf_cap",
          type: "keyframe",
          status: "captured",
          url: "https://m.example/kf_cap.png",
          depicts: ["char_a"],
          identity_anchors: [],
          captured_from: "clip_1",
        },
        "Captured final frame.",
      ),
    );
    expect(rulesOf(files, "error")).not.toContain("anchorless-keyframe");
  });

  it("errors on a generated keyframe without a url", () => {
    const files = withFile(
      baseProject(),
      "keyframes/kf_1.md",
      md(
        {
          id: "kf_1",
          type: "keyframe",
          status: "generated",
          url: null,
          depicts: ["char_a"],
          identity_anchors: ["char_a_portfolio"],
        },
        "Opening frame.",
      ),
    );
    expect(rulesOf(files, "error")).toContain("missing-media");
  });
});

function twoClipProject(input: {
  clipBTransition: string | null;
  clipBFrom: string;
  clipAEndTrust?: string;
  kf3StateAnchor?: string | null;
}): SourceFile[] {
  let files = baseProject();
  files = withFile(
    files,
    "keyframes/kf_3.md",
    md(
      {
        id: "kf_3",
        type: "keyframe",
        status: "generated",
        url: "https://m.example/kf_3.png",
        depicts: ["char_a"],
        identity_anchors: ["char_a_portfolio"],
        state_anchor: input.kf3StateAnchor ?? null,
      },
      "Third frame.",
    ),
  );
  if (input.clipAEndTrust) {
    files = withFile(
      files,
      "clips/clip_1.md",
      md(
        {
          id: "clip_1",
          type: "clip",
          scene: "scene_1",
          index: 1,
          status: "active",
          url: "https://m.example/clip_1.mp4",
          from_keyframe: "kf_1",
          to_keyframe: "kf_2",
          end_trust: input.clipAEndTrust,
        },
        "Clip one.",
      ),
    );
  }
  files = withFile(
    files,
    "clips/clip_2.md",
    md(
      {
        id: "clip_2",
        type: "clip",
        scene: "scene_1",
        index: 2,
        status: "active",
        url: "https://m.example/clip_2.mp4",
        from_keyframe: input.clipBFrom,
        to_keyframe: "kf_3",
        end_trust: "pinned",
        transition_from_previous: input.clipBTransition,
      },
      "Clip two.",
    ),
  );
  files = withFile(
    files,
    "timeline.json",
    JSON.stringify([
      { id: "tl_1", clip_id: "clip_1", url: "https://m.example/clip_1.mp4" },
      { id: "tl_2", clip_id: "clip_2", url: "https://m.example/clip_2.mp4" },
    ]),
  );
  return files;
}

describe("lint: continuity rules", () => {
  function withGeneratedKeyframe(
    files: SourceFile[],
    id: string,
    stateAnchor: string | null,
  ) {
    return withFile(
      files,
      `keyframes/${id}.md`,
      md(
        {
          id,
          type: "keyframe",
          status: "generated",
          url: `https://m.example/${id}.png`,
          depicts: ["char_a"],
          identity_anchors: ["char_a_portfolio"],
          state_anchor: stateAnchor,
        },
        `${id} frame.`,
      ),
    );
  }

  it("warns when a clip's start and end keyframe are identical (no motion)", () => {
    const files = withFile(
      baseProject(),
      "clips/clip_1.md",
      md(
        {
          id: "clip_1",
          type: "clip",
          scene: "scene_1",
          status: "active",
          url: "https://m.example/clip_1.mp4",
          from_keyframe: "kf_1",
          to_keyframe: "kf_1",
          end_trust: "pinned",
        },
        "Static clip.",
      ),
    );
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "static-clip",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
  });

  it("errors when a clip's aspect ratio differs from its keyframe's", () => {
    let files = withFile(
      baseProject(),
      "keyframes/kf_1.md",
      md(
        {
          id: "kf_1",
          type: "keyframe",
          status: "generated",
          url: "https://m.example/kf_1.png",
          aspect_ratio: "4:3",
          depicts: ["char_a"],
          identity_anchors: ["char_a_portfolio"],
        },
        "Opening frame at 4:3.",
      ),
    );
    files = withFile(
      files,
      "clips/clip_1.md",
      md(
        {
          id: "clip_1",
          type: "clip",
          scene: "scene_1",
          status: "active",
          url: "https://m.example/clip_1.mp4",
          from_keyframe: "kf_1",
          to_keyframe: "kf_2",
          end_trust: "pinned",
          aspect_ratio: "16:9",
        },
        "Clip at 16:9.",
      ),
    );
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "aspect-mismatch",
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].level).toBe("error");
  });

  it("accepts a continuous pair sharing a keyframe node", () => {
    const files = twoClipProject({
      clipBTransition: "continuous",
      clipBFrom: "kf_2",
      kf3StateAnchor: "kf_2",
    });
    const result = lintSourceFiles(files);
    expect(result.issues.filter((issue) => issue.level !== "info")).toEqual([]);
  });

  it("errors when declared continuous without a shared node", () => {
    let files = twoClipProject({
      clipBTransition: "continuous",
      clipBFrom: "kf_2b",
    });
    files = withFile(
      files,
      "keyframes/kf_2b.md",
      md(
        {
          id: "kf_2b",
          type: "keyframe",
          status: "generated",
          url: "https://m.example/kf_2b.png",
          depicts: ["char_a"],
          identity_anchors: ["char_a_portfolio"],
        },
        "A different node duplicating kf_2.",
      ),
    );
    expect(rulesOf(files, "error")).toContain("continuity-structural");
  });

  it("errors when continuing from an unpinned end", () => {
    const files = twoClipProject({
      clipBTransition: "continuous",
      clipBFrom: "kf_2",
      clipAEndTrust: "unknown",
    });
    expect(rulesOf(files, "error")).toContain("unpinned-chain");
  });

  it("does not enforce unpinned-chain while the previous clip is unrendered", () => {
    let files = twoClipProject({
      clipBTransition: "continuous",
      clipBFrom: "kf_2",
    });
    files = withFile(
      files,
      "clips/clip_1.md",
      md(
        {
          id: "clip_1",
          type: "clip",
          scene: "scene_1",
          index: 1,
          status: "planned",
          url: null,
          from_keyframe: "kf_1",
          to_keyframe: "kf_2",
          end_trust: "unknown",
        },
        "Planned clip.",
      ),
    );
    files = withFile(files, "timeline.json", "[]");
    expect(rulesOf(files, "error")).not.toContain("unpinned-chain");
  });

  it("warns when a declared cut structurally shares a node", () => {
    const files = twoClipProject({
      clipBTransition: "cut",
      clipBFrom: "kf_2",
    });
    expect(rulesOf(files, "warning")).toContain("continuity-contradiction");
  });

  it("warns when a post-cut keyframe is conditioned on the prior frame", () => {
    const files = twoClipProject({
      clipBTransition: "cut",
      clipBFrom: "kf_3",
      kf3StateAnchor: "kf_2",
    });
    expect(rulesOf(files, "warning")).toContain("anchor-across-cut");
  });

  it("allows prior-frame conditioning across hard_cut_same_assets", () => {
    const files = twoClipProject({
      clipBTransition: "hard_cut_same_assets",
      clipBFrom: "kf_3",
      kf3StateAnchor: "kf_2",
    });
    expect(rulesOf(files, "warning")).not.toContain("anchor-across-cut");
  });

  it("warns when a following clip declares no transition", () => {
    const files = twoClipProject({
      clipBTransition: null,
      clipBFrom: "kf_3",
    });
    expect(rulesOf(files, "warning")).toContain("missing-transition");
  });

  it("allows a short state_anchor chain up to the continuous cap", () => {
    const files = withGeneratedKeyframe(baseProject(), "kf_3", "kf_2");
    expect(rulesOf(files, "error")).not.toContain("continuous-chain-cap");
  });

  it("errors when a state_anchor chain exceeds the continuous cap", () => {
    let files = withGeneratedKeyframe(baseProject(), "kf_3", "kf_2");
    files = withGeneratedKeyframe(files, "kf_4", "kf_3");
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "continuous-chain-cap",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("error");
    expect(issues[0].nodeId).toBe("kf_4");
  });

  it("resets the state_anchor chain count at a cut keyframe", () => {
    let files = withGeneratedKeyframe(baseProject(), "kf_3", null);
    files = withGeneratedKeyframe(files, "kf_4", "kf_3");
    files = withGeneratedKeyframe(files, "kf_5", "kf_4");
    expect(rulesOf(files, "error")).not.toContain("continuous-chain-cap");
  });
});

describe("lint: scene_state", () => {
  function withSecondCharacter(files: SourceFile[]) {
    files = withFile(
      files,
      "references/characters/char_b/reference.md",
      md(
        {
          id: "char_b",
          type: "reference",
          category: "characters",
          status: "active",
        },
        "Second character.",
      ),
    );
    return withFile(
      files,
      "references/characters/char_b/portfolio.md",
      md({
        id: "char_b_portfolio",
        type: "portfolio",
        reference_id: "char_b",
        status: "generated",
        urls: ["https://m.example/char_b.png"],
      }),
    );
  }

  function keyframeWithState(
    id: string,
    stateAnchor: string | null,
    chars: Array<[string, string]>,
    depicts?: string[],
    options?: {
      props?: Array<[string, string | null, string]>;
      setAnchors?: Array<[string, string]>;
    },
  ) {
    return md(
      {
        id,
        type: "keyframe",
        status: "generated",
        url: `https://m.example/${id}.png`,
        depicts: depicts ?? chars.map(([c]) => c),
        identity_anchors: ["char_a_portfolio"],
        state_anchor: stateAnchor,
        scene_state: {
          characters: chars.map(([cid, pos]) => ({
            id: cid,
            screen_position: pos,
            facing: "neutral",
          })),
          props: (options?.props ?? []).map(([pid, owner, location]) => ({
            id: pid,
            owner,
            location,
          })),
          set_anchors: (options?.setAnchors ?? []).map(([sid, location]) => ({
            id: sid,
            location,
          })),
        },
      },
      `${id} frame.`,
    );
  }

  it("errors when characters swap left/right order across a continuous pair", () => {
    let files = withFile(
      baseProject(),
      "keyframes/kf_a.md",
      keyframeWithState("kf_a", null, [["char_a", "left"], ["char_b", "right"]]),
    );
    files = withFile(
      files,
      "keyframes/kf_b.md",
      keyframeWithState("kf_b", "kf_a", [["char_a", "right"], ["char_b", "left"]]),
    );
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "scene-state-order-swap",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("error");
    expect(issues[0].nodeId).toBe("kf_b");
  });

  it("does not flag an order swap across a cut (no state_anchor)", () => {
    let files = withFile(
      baseProject(),
      "keyframes/kf_a.md",
      keyframeWithState("kf_a", null, [["char_a", "left"], ["char_b", "right"]]),
    );
    files = withFile(
      files,
      "keyframes/kf_b.md",
      keyframeWithState("kf_b", null, [["char_a", "right"], ["char_b", "left"]]),
    );
    expect(rulesOf(files, "error")).not.toContain("scene-state-order-swap");
  });

  it("allows a continuous pair that preserves left/right order", () => {
    let files = withFile(
      baseProject(),
      "keyframes/kf_a.md",
      keyframeWithState("kf_a", null, [["char_a", "left"], ["char_b", "right"]]),
    );
    files = withFile(
      files,
      "keyframes/kf_b.md",
      keyframeWithState("kf_b", "kf_a", [["char_a", "left_center"], ["char_b", "right"]]),
    );
    expect(rulesOf(files, "error")).not.toContain("scene-state-order-swap");
  });

  it("warns when scene_state references an entity not in depicts", () => {
    const files = withFile(
      baseProject(),
      "keyframes/kf_a.md",
      keyframeWithState("kf_a", null, [["char_a", "left"], ["ghost", "right"]], ["char_a"]),
    );
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "scene-state-unknown-entity",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
  });

  it("errors when prop ownership changes across a continuous pair", () => {
    let files = withFile(
      baseProject(),
      "keyframes/kf_a.md",
      keyframeWithState(
        "kf_a",
        null,
        [["char_a", "left"], ["char_b", "right"]],
        ["char_a", "char_b", "prop_bag"],
        { props: [["prop_bag", "char_a", "left"]] },
      ),
    );
    files = withFile(
      files,
      "keyframes/kf_b.md",
      keyframeWithState(
        "kf_b",
        "kf_a",
        [["char_a", "left"], ["char_b", "right"]],
        ["char_a", "char_b", "prop_bag"],
        { props: [["prop_bag", "char_b", "right"]] },
      ),
    );
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "scene-state-prop-owner-change",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("error");
    expect(issues[0].nodeId).toBe("kf_b");
  });

  it("allows prop ownership changes across a cut", () => {
    let files = withFile(
      baseProject(),
      "keyframes/kf_a.md",
      keyframeWithState(
        "kf_a",
        null,
        [["char_a", "left"], ["char_b", "right"]],
        ["char_a", "char_b", "prop_bag"],
        { props: [["prop_bag", "char_a", "left"]] },
      ),
    );
    files = withFile(
      files,
      "keyframes/kf_b.md",
      keyframeWithState(
        "kf_b",
        null,
        [["char_a", "left"], ["char_b", "right"]],
        ["char_a", "char_b", "prop_bag"],
        { props: [["prop_bag", "char_b", "right"]] },
      ),
    );
    expect(rulesOf(files, "error")).not.toContain(
      "scene-state-prop-owner-change",
    );
  });

  it("errors when set anchors move across a continuous pair", () => {
    let files = withFile(
      baseProject(),
      "keyframes/kf_a.md",
      keyframeWithState("kf_a", null, [["char_a", "left"]], ["char_a"], {
        setAnchors: [["ticket_booth", "background"]],
      }),
    );
    files = withFile(
      files,
      "keyframes/kf_b.md",
      keyframeWithState("kf_b", "kf_a", [["char_a", "left"]], ["char_a"], {
        setAnchors: [["ticket_booth", "foreground"]],
      }),
    );
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "scene-state-set-anchor-change",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("error");
  });

  it("errors when set anchors appear or vanish across a continuous pair", () => {
    let files = withFile(
      baseProject(),
      "keyframes/kf_a.md",
      keyframeWithState("kf_a", null, [["char_a", "left"]], ["char_a"], {
        setAnchors: [["subway_platform", "background"]],
      }),
    );
    files = withFile(
      files,
      "keyframes/kf_b.md",
      keyframeWithState("kf_b", "kf_a", [["char_a", "left"]], ["char_a"], {
        setAnchors: [["stairwell", "background"]],
      }),
    );
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "scene-state-set-anchor-change",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("subway_platform: vanished");
    expect(issues[0].message).toContain("stairwell: appeared");
  });

  it("allows direct multi-character generation (sequential-injection mandate disabled)", () => {
    const files = withFile(
      withSecondCharacter(baseProject()),
      "keyframes/kf_multi.md",
      keyframeWithState(
        "kf_multi",
        null,
        [["char_a", "left"], ["char_b", "right"]],
        ["char_a", "char_b"],
      ),
    );
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "multi-character-direct-generation",
    );
    // The sequential-injection mandate is disabled (cost experiment):
    // direct multi-character generation no longer raises an error.
    expect(issues).toHaveLength(0);
  });

  it("requires passed identity verification for each visible injected character", () => {
    const files = withFile(
      withSecondCharacter(baseProject()),
      "keyframes/kf_multi.md",
      md(
        {
          id: "kf_multi",
          type: "keyframe",
          status: "generated",
          url: "https://m.example/kf_multi.png",
          depicts: ["char_a", "char_b"],
          identity_anchors: ["char_a_portfolio", "char_b_portfolio"],
          scene_state: {
            characters: [
              { id: "char_a", screen_position: "left", facing: "right" },
              { id: "char_b", screen_position: "right", facing: "left" },
            ],
            props: [],
            set_anchors: [],
          },
          composition: {
            mode: "sequential_injection",
            injected_references: ["char_a", "char_b"],
            identity_verifications: [
              { reference_id: "char_a", status: "passed" },
              { reference_id: "char_b", status: "pending" },
            ],
          },
        },
        "Multi-character frame.",
      ),
    );
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "identity-verification-required",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("char_b");
  });

  it("flags exhausted identity injection attempts as a cut-or-simplify failure", () => {
    const files = withFile(
      withSecondCharacter(baseProject()),
      "keyframes/kf_multi.md",
      md(
        {
          id: "kf_multi",
          type: "keyframe",
          status: "generated",
          url: "https://m.example/kf_multi.png",
          depicts: ["char_a", "char_b"],
          identity_anchors: ["char_a_portfolio", "char_b_portfolio"],
          scene_state: {
            characters: [
              { id: "char_a", screen_position: "left", facing: "right" },
              { id: "char_b", screen_position: "right", facing: "left" },
            ],
            props: [],
            set_anchors: [],
          },
          composition: {
            mode: "sequential_injection",
            injected_references: ["char_a", "char_b"],
            injection_attempts: [
              { reference_id: "char_a", attempts: 2 },
              { reference_id: "char_b", attempts: 1 },
            ],
            identity_verifications: [
              { reference_id: "char_a", status: "failed" },
              { reference_id: "char_b", status: "passed" },
            ],
          },
        },
        "Multi-character frame.",
      ),
    );
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "identity-injection-attempt-cap",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("simplify the staging");
  });

  it("accepts a generated multi-character keyframe with injected and verified characters", () => {
    const files = withFile(
      withSecondCharacter(baseProject()),
      "keyframes/kf_multi.md",
      md(
        {
          id: "kf_multi",
          type: "keyframe",
          status: "generated",
          url: "https://m.example/kf_multi.png",
          depicts: ["char_a", "char_b"],
          identity_anchors: ["char_a_portfolio", "char_b_portfolio"],
          scene_state: {
            characters: [
              { id: "char_a", screen_position: "left", facing: "right" },
              { id: "char_b", screen_position: "right", facing: "left" },
            ],
            props: [],
            set_anchors: [],
          },
          composition: {
            mode: "sequential_injection",
            injected_references: ["char_a", "char_b"],
            identity_verifications: [
              { reference_id: "char_a", status: "passed" },
              { reference_id: "char_b", status: "passed" },
            ],
          },
        },
        "Multi-character frame.",
      ),
    );
    const rules = rulesOf(files, "error");
    expect(rules).not.toContain("multi-character-direct-generation");
    expect(rules).not.toContain("composition-missing-injection");
    expect(rules).not.toContain("identity-verification-required");
  });
});

describe("lint: staleness", () => {
  function projectWithBuiltAgainst(recordedHash: string, waived = false) {
    return withFile(
      baseProject(),
      "keyframes/kf_1.md",
      md(
        {
          id: "kf_1",
          type: "keyframe",
          status: "generated",
          url: "https://m.example/kf_1.png",
          depicts: ["char_a"],
          identity_anchors: ["char_a_portfolio"],
          built_against: { char_a: recordedHash },
          ...(waived ? { intentionally_unchanged: ["char_a"] } : {}),
        },
        "Opening frame.",
      ),
    );
  }

  function currentCharAHash(files: SourceFile[]): string {
    const graph = buildSourceGraph(files);
    const reference = graph.references.get("char_a");
    if (!reference) throw new Error("fixture missing char_a");
    return identityHash({ kind: "reference", node: reference });
  }

  it("accepts matching built_against hashes", () => {
    const files = projectWithBuiltAgainst("placeholder");
    const fixed = projectWithBuiltAgainst(currentCharAHash(files));
    expect(rulesOf(fixed, "warning")).not.toContain("stale");
  });

  it("warns on hash mismatch and marks dependent clips transitively stale", () => {
    const files = projectWithBuiltAgainst("0000000000000000");
    const result = lintSourceFiles(files);
    expect(result.issues.map((issue) => issue.rule)).toContain("stale");
    expect(result.issues.map((issue) => issue.rule)).toContain(
      "stale-transitive",
    );
  });

  it("respects intentionally_unchanged waivers", () => {
    const files = projectWithBuiltAgainst("0000000000000000", true);
    expect(rulesOf(files, "warning")).not.toContain("stale");
  });

  it("errors when a built_against dependency no longer exists", () => {
    const files = withFile(
      baseProject(),
      "keyframes/kf_1.md",
      md(
        {
          id: "kf_1",
          type: "keyframe",
          status: "generated",
          url: "https://m.example/kf_1.png",
          depicts: ["char_a"],
          identity_anchors: ["char_a_portfolio"],
          built_against: { deleted_node: "abc123" },
        },
        "Opening frame.",
      ),
    );
    expect(rulesOf(files, "error")).toContain("missing-ref");
  });

  it("warns when a planned prompt was built against an old clip plan", () => {
    const originalPlan = {
      start_state: "Nova stands frame-left.",
      end_state: "Nova reaches the door.",
      action_beats: ["Nova crosses to the door"],
      action_intent: "Nova crosses to the door.",
      camera_move: "tracking",
      camera_note: null,
      dialogue: { mode: "no_audible_speech", lines: [] },
      duration_seconds: 5,
      environment: null,
      frame_delta: [],
      from_keyframe: "kf_1",
      lighting: null,
      motion_rate: "real_time",
      to_keyframe: "kf_2",
    };
    const changedPlan = {
      ...originalPlan,
      action_beats: ["Nova crosses to the door", "Nova turns back in alarm"],
    };
    const filesWithClip = withFile(
      baseProject(),
      "clips/clip_1.md",
      md(
        {
          id: "clip_1",
          type: "clip",
          scene: "scene_1",
          index: 1,
          status: "planned",
          url: null,
          from_keyframe: "kf_1",
          to_keyframe: "kf_2",
          end_trust: "pinned",
          transition_from_previous: null,
          prompt_plan: changedPlan,
        },
        "Clip one.",
      ),
    );
    const graph = buildSourceGraph(filesWithClip);
    const kf1 = graph.keyframes.get("kf_1");
    const kf2 = graph.keyframes.get("kf_2");
    if (!kf1 || !kf2) throw new Error("fixture missing keyframes");
    const files = withFile(
      filesWithClip,
      "prompts/asset_clip_1.prompt.md",
      md(
        {
          id: "prompt_asset_clip_1",
          type: "prompt",
          status: "planned",
          clip_id: "clip_1",
          compiler: "composeClipPrompt:v3",
          compiler_hash: "promptbodyhash",
          built_against: {
            kf_1: identityHash({ kind: "keyframe", node: kf1 }),
            kf_2: identityHash({ kind: "keyframe", node: kf2 }),
            [`clip_1${CLIP_PLAN_HASH_SUFFIX}`]: clipPlanHashValue(originalPlan),
          },
        },
        "Stored prompt body.",
      ),
    );
    const result = lintSourceFiles(files);
    expect(
      result.issues.some(
        (issue) =>
          issue.rule === "stale" &&
          issue.nodeId === "prompt_asset_clip_1" &&
          issue.message.includes(`clip_1${CLIP_PLAN_HASH_SUFFIX}`),
      ),
    ).toBe(true);
  });
});

describe("lint: planned prompt standards", () => {
  it("warns and errors when planned prompt bodies exceed the compact Seedance target", () => {
    const promptWithWords = (id: string, words: number) =>
      md(
        {
          id,
          type: "prompt",
          status: "planned",
          clip_id: "clip_1",
          compiler: "composeClipPrompt:v3",
          compiler_hash: "hash",
          built_against: {},
        },
        Array.from({ length: words }, (_, index) => `word${index}`).join(" "),
      );
    const files = [
      {
        path: "prompts/warn.prompt.md",
        content: promptWithWords("prompt_warn", 151),
      },
      {
        path: "prompts/error.prompt.md",
        content: promptWithWords("prompt_error", 251),
      },
      {
        path: "prompts/thin.prompt.md",
        content: promptWithWords("prompt_thin", 12),
      },
      {
        path: "prompts/sweet.prompt.md",
        content: promptWithWords("prompt_sweet", 120),
      },
    ];
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "prompt-length",
    );
    expect(
      issues.some((issue) => issue.level === "warning" && issue.nodeId === "prompt_warn"),
    ).toBe(true);
    expect(
      issues.some((issue) => issue.level === "error" && issue.nodeId === "prompt_error"),
    ).toBe(true);
    expect(
      issues.some((issue) => issue.level === "warning" && issue.nodeId === "prompt_thin"),
    ).toBe(true);
    expect(issues.some((issue) => issue.nodeId === "prompt_sweet")).toBe(false);
  });

  it("errors when planned prompt bodies reintroduce bookkeeping or banned speed text", () => {
    const files = [
      {
        path: "prompts/bad.prompt.md",
        content: md(
          {
            id: "prompt_bad",
            type: "prompt",
            status: "planned",
            clip_id: "clip_1",
            compiler: "composeClipPrompt:v3",
            compiler_hash: "hash",
            built_against: {},
          },
          "Start frame (locked): Nova waits. Dialogue contract: no speech. Speed: ultra-fast. Keep motion readable, stable, and continuous.",
        ),
      },
    ];
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "prompt-content",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("error");
  });

  it("warns when camera_note appears to add a second camera move", () => {
    const files = withFile(
      baseProject(),
      "clips/clip_1.md",
      md(
        {
          id: "clip_1",
          type: "clip",
          scene: "scene_1",
          index: 1,
          status: "planned",
          url: null,
          from_keyframe: "kf_1",
          to_keyframe: "kf_2",
          end_trust: "pinned",
          transition_from_previous: null,
          prompt_plan: {
            camera_move: "tracking",
            camera_note: "follows Nova while panning upward",
          },
        },
        "Clip one.",
      ),
    );
    expect(rulesOf(files, "warning")).toContain("camera-note");
  });

  it("errors when an action clip spans too many beats or seconds", () => {
    const files = withFile(
      baseProject(),
      "clips/clip_1.md",
      md(
        {
          id: "clip_1",
          type: "clip",
          scene: "scene_1",
          index: 1,
          status: "planned",
          url: null,
          from_keyframe: "kf_1",
          to_keyframe: "kf_2",
          end_trust: "pinned",
          transition_from_previous: null,
          duration_seconds: 10,
          prompt_plan: {
            motion_rate: "frenetic",
            action_beats: [
              "Akio lunges",
              "Ren parries",
              "Akio rolls through",
              "Ren counters",
            ],
          },
        },
        "Clip one.",
      ),
    );
    expect(rulesOf(files, "error")).toContain("action-clip-density");
    expect(rulesOf(files, "error")).toContain("action-clip-duration");
  });
});

describe("lint: retirement and timeline hygiene", () => {
  it("errors when an active node references a superseded one", () => {
    const files = withFile(
      baseProject(),
      "references/characters/char_a/reference.md",
      md(
        {
          id: "char_a",
          type: "reference",
          category: "characters",
          status: "superseded",
        },
        "Old hero design.",
      ),
    );
    expect(rulesOf(files, "error")).toContain("superseded-referenced");
  });

  it("errors when the timeline includes a non-active clip", () => {
    const files = withFile(
      baseProject(),
      "clips/clip_1.md",
      md(
        {
          id: "clip_1",
          type: "clip",
          scene: "scene_1",
          status: "planned",
          from_keyframe: "kf_1",
          to_keyframe: "kf_2",
        },
        "Planned clip still on timeline.",
      ),
    );
    expect(rulesOf(files, "error")).toContain("inactive-on-timeline");
  });

  it("warns when an active rendered clip is missing from the timeline", () => {
    const files = withFile(baseProject(), "timeline.json", "[]");
    expect(rulesOf(files, "warning")).toContain("clip-off-timeline");
  });

  it("reports orphan keyframes as info", () => {
    const files = withFile(
      baseProject(),
      "keyframes/kf_orphan.md",
      md(
        {
          id: "kf_orphan",
          type: "keyframe",
          status: "planned",
          depicts: [],
          identity_anchors: [],
        },
        "Unused frame.",
      ),
    );
    expect(rulesOf(files, "info")).toContain("orphan-keyframe");
  });
});
