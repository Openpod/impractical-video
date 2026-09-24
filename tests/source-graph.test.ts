import { describe, expect, it } from "vitest";
import {
  buildSourceGraph,
  identityHash,
  orderedClips,
  parseStrictJsonFrontmatter,
  type ClipNode,
  type KeyframeNode,
  type PortfolioNode,
  type ReferenceNode,
} from "@/lib/source-graph";
import { baseProject, loadFixture, md, withFile } from "./helpers";

describe("parseStrictJsonFrontmatter", () => {
  it("parses a valid frontmatter block", () => {
    const result = parseStrictJsonFrontmatter(md({ id: "x", type: "scene" }, "Body."));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.id).toBe("x");
      expect(result.body).toBe("Body.\n");
    }
  });

  it("rejects missing frontmatter", () => {
    const result = parseStrictJsonFrontmatter("# Just markdown\n");
    expect(result.ok).toBe(false);
  });

  it("rejects malformed JSON instead of swallowing it", () => {
    const result = parseStrictJsonFrontmatter('---\n{ "id": broken }\n---\nBody.\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Invalid frontmatter JSON/);
  });

  it("rejects non-object frontmatter", () => {
    const result = parseStrictJsonFrontmatter('---\n["array"]\n---\nBody.\n');
    expect(result.ok).toBe(false);
  });
});

describe("buildSourceGraph", () => {
  it("builds all node types from the valid fixture", () => {
    const graph = buildSourceGraph(loadFixture("valid-continuous"));
    expect(graph.parseIssues).toEqual([]);
    expect([...graph.references.keys()].sort()).toEqual(["char_astro", "env_pluto"]);
    expect(graph.portfolioByReference.get("char_astro")?.id).toBe("char_astro_portfolio");
    expect(graph.keyframes.size).toBe(5);
    expect(graph.scenes.size).toBe(2);
    expect(graph.clips.size).toBe(3);
    expect(graph.timeline.map((entry) => entry.clipId)).toEqual([
      "clip_a",
      "clip_b",
      "clip_c",
    ]);
  });

  it("reports duplicate ids", () => {
    const files = withFile(
      baseProject(),
      "keyframes/kf_dup.md",
      md({ id: "kf_1", type: "keyframe", status: "planned" }, "Duplicate."),
    );
    const graph = buildSourceGraph(files);
    expect(
      graph.parseIssues.some(
        (issue) => issue.rule === "duplicate-id" && issue.nodeId === "kf_1",
      ),
    ).toBe(true);
  });

  it("reports missing id and malformed frontmatter as parse issues", () => {
    const graph = buildSourceGraph([
      { path: "keyframes/no-id.md", content: md({ type: "keyframe" }) },
      { path: "clips/broken.md", content: "---\n{ broken\n---\nBody.\n" },
    ]);
    const rules = graph.parseIssues.map((issue) => issue.rule);
    expect(rules.filter((rule) => rule === "parse")).toHaveLength(2);
  });

  it("infers node type from path when frontmatter omits it", () => {
    const graph = buildSourceGraph([
      {
        path: "keyframes/kf_x.md",
        content: md({ id: "kf_x", status: "planned" }, "No type field."),
      },
    ]);
    expect(graph.keyframes.has("kf_x")).toBe(true);
  });

  it("ignores README, brief, legacy prompts, and operations files", () => {
    const graph = buildSourceGraph([
      { path: "scenes/_README.md", content: "# Conventions\n" },
      { path: "brief.md", content: "# Brief\n" },
      { path: "prompts/p1.prompt.md", content: "# Prompt\n" },
      { path: "operations/op1.operation.md", content: "# Op\n" },
    ]);
    expect(graph.parseIssues).toEqual([]);
    expect(graph.nodePathById.size).toBe(0);
  });

  it("parses planned prompt files with frontmatter as graph nodes", () => {
    const graph = buildSourceGraph([
      {
        path: "prompts/asset_clip_1.prompt.md",
        content: md(
          {
            id: "prompt_asset_clip_1",
            type: "prompt",
            status: "planned",
            clip_id: "clip_1",
            compiler: "composeClipPrompt:v3",
            compiler_hash: "abc123",
            built_against: { kf_1: "hash" },
          },
          "Stored prompt.",
        ),
      },
    ]);
    expect(graph.parseIssues).toEqual([]);
    expect(graph.prompts.get("prompt_asset_clip_1")?.clipId).toBe("clip_1");
  });

  it("parses media version history for keyframes and clips", () => {
    const graph = buildSourceGraph([
      {
        path: "keyframes/kf_versions.md",
        content: md({
          id: "kf_versions",
          type: "keyframe",
          status: "generated",
          url: "https://m.example/kf.v2.png",
          versions: [
            {
              version: 1,
              url: "https://m.example/kf.v1.png",
              local_path: "media/keyframes/kf_versions.v1.png",
            },
            {
              version: 2,
              url: "https://m.example/kf.v2.png",
              local_path: "media/keyframes/kf_versions.v2.png",
            },
          ],
        }),
      },
      {
        path: "clips/clip_versions.md",
        content: md({
          id: "clip_versions",
          type: "clip",
          status: "active",
          url: "https://m.example/clip.v2.mp4",
          versions: [
            {
              version: 1,
              url: "https://m.example/clip.v1.mp4",
              local_path: "media/clips/clip_versions.v1.mp4",
            },
          ],
        }),
      },
    ]);

    expect(graph.keyframes.get("kf_versions")?.versions).toEqual([
      {
        version: 1,
        url: "https://m.example/kf.v1.png",
        localPath: "media/keyframes/kf_versions.v1.png",
      },
      {
        version: 2,
        url: "https://m.example/kf.v2.png",
        localPath: "media/keyframes/kf_versions.v2.png",
      },
    ]);
    expect(graph.clips.get("clip_versions")?.versions).toEqual([
      {
        version: 1,
        url: "https://m.example/clip.v1.mp4",
        localPath: "media/clips/clip_versions.v1.mp4",
      },
    ]);
  });

  it("parses keyframe perceptual image hashes", () => {
    const graph = buildSourceGraph(
      withFile(
        baseProject(),
        "keyframes/kf_1.md",
        md(
          {
            id: "kf_1",
            type: "keyframe",
            status: "generated",
            url: "https://m.example/kf_1.png",
            image_phash: "80000000000",
            depicts: ["char_a"],
            identity_anchors: ["char_a_portfolio"],
          },
          "Opening frame.",
        ),
      ),
    );
    expect(graph.keyframes.get("kf_1")?.imagePhash).toBe("80000000000");
  });

  it("parses keyframe composition metadata", () => {
    const graph = buildSourceGraph([
      {
        path: "keyframes/kf_composed.md",
        content: md(
          {
            id: "kf_composed",
            type: "keyframe",
            status: "generated",
            url: "https://m.example/kf.png",
            composition: {
              mode: "sequential_injection",
              plate_keyframe: "kf_plate",
              injected_references: ["char_a", "char_b"],
              identity_verifications: [
                {
                  reference_id: "char_a",
                  portfolio_id: "char_a_portfolio",
                  status: "passed",
                  summary: "one matching instance",
                },
              ],
            },
          },
          "Composed keyframe.",
        ),
      },
    ]);
    expect(graph.keyframes.get("kf_composed")?.composition).toEqual({
      mode: "sequential_injection",
      plate_keyframe: "kf_plate",
      injected_references: ["char_a", "char_b"],
      identity_verifications: [
        {
          reference_id: "char_a",
          portfolio_id: "char_a_portfolio",
          status: "passed",
          summary: "one matching instance",
        },
      ],
    });
  });

  it("preserves keyframe scene-state character bboxes", () => {
    const graph = buildSourceGraph([
      {
        path: "keyframes/kf_bbox.md",
        content: md(
          {
            id: "kf_bbox",
            type: "keyframe",
            status: "generated",
            scene_state: {
              characters: [
                {
                  id: "char_maya",
                  screen_position: "left",
                  facing: "right",
                  bbox: { x: 0.12, y: 0.18, w: 0.24, h: 0.72 },
                },
              ],
              props: [],
              set_anchors: [],
            },
          },
          "BBox frame.",
        ),
      },
    ]);

    expect(graph.keyframes.get("kf_bbox")?.sceneState?.characters[0]?.bbox).toEqual({
      x: 0.12,
      y: 0.18,
      w: 0.24,
      h: 0.72,
    });
  });
});

describe("identityHash", () => {
  const reference: ReferenceNode = {
    id: "char_a",
    path: "references/characters/char_a/reference.md",
    category: "characters",
    status: "active",
    voiceId: null,
    body: "Hero character.",
  };

  it("ignores status flips (cosmetic) but tracks body changes (identity)", () => {
    const before = identityHash({ kind: "reference", node: reference });
    const approved = identityHash({
      kind: "reference",
      node: { ...reference, status: "approved" },
    });
    const reworded = identityHash({
      kind: "reference",
      node: { ...reference, body: "Hero character, now in a red jacket." },
    });
    expect(approved).toBe(before);
    expect(reworded).not.toBe(before);
  });

  it("hashes portfolios by urls, order-independent", () => {
    const portfolio: PortfolioNode = {
      id: "p",
      path: "references/characters/char_a/portfolio.md",
      referenceId: "char_a",
      status: "generated",
      urls: ["https://a.png", "https://b.png"],
    };
    const reordered = identityHash({
      kind: "portfolio",
      node: { ...portfolio, urls: ["https://b.png", "https://a.png"] },
    });
    const changed = identityHash({
      kind: "portfolio",
      node: { ...portfolio, urls: ["https://c.png"] },
    });
    expect(reordered).toBe(identityHash({ kind: "portfolio", node: portfolio }));
    expect(changed).not.toBe(identityHash({ kind: "portfolio", node: portfolio }));
  });

  it("hashes generated keyframes by url and planned keyframes by content", () => {
    const keyframe: KeyframeNode = {
      id: "kf",
      path: "keyframes/kf.md",
      status: "generated",
      url: "https://m.example/kf.png",
      versions: [],
      imagePhash: null,
      aspectRatio: null,
      depicts: [],
      identityAnchors: [],
      stateAnchor: null,
      sceneState: null,
      composition: null,
      capturedFrom: null,
      builtAgainst: {},
      intentionallyUnchanged: [],
      prompt: null,
      body: "Frame.",
    };
    const urlChanged = identityHash({
      kind: "keyframe",
      node: { ...keyframe, url: "https://m.example/kf_v2.png" },
    });
    expect(urlChanged).not.toBe(identityHash({ kind: "keyframe", node: keyframe }));

    const planned = { ...keyframe, url: null };
    const plannedReworded = identityHash({
      kind: "keyframe",
      node: { ...planned, body: "Different frame description." },
    });
    expect(plannedReworded).not.toBe(
      identityHash({ kind: "keyframe", node: planned }),
    );
  });

  it("ignores media version history when hashing active media identity", () => {
    const keyframe: KeyframeNode = {
      id: "kf",
      path: "keyframes/kf.md",
      status: "generated",
      url: "https://m.example/kf.v2.png",
      versions: [
        {
          version: 1,
          url: "https://m.example/kf.v1.png",
          localPath: "media/keyframes/kf.v1.png",
        },
      ],
      imagePhash: null,
      aspectRatio: null,
      depicts: [],
      identityAnchors: [],
      stateAnchor: null,
      sceneState: null,
      composition: null,
      capturedFrom: null,
      builtAgainst: {},
      intentionallyUnchanged: [],
      prompt: null,
      body: "Frame.",
    };

    const withLongerHistory = identityHash({
      kind: "keyframe",
      node: {
        ...keyframe,
        versions: [
          ...keyframe.versions,
          {
            version: 2,
            url: "https://m.example/kf.v2.png",
            localPath: "media/keyframes/kf.v2.png",
          },
        ],
      },
    });
    expect(withLongerHistory).toBe(identityHash({ kind: "keyframe", node: keyframe }));

    const graph = buildSourceGraph([
      {
        path: "clips/clip.md",
        content: md({
          id: "clip",
          type: "clip",
          status: "active",
          url: "https://m.example/clip.v2.mp4",
          versions: [
            {
              version: 1,
              url: "https://m.example/clip.v1.mp4",
              local_path: "media/clips/clip.v1.mp4",
            },
          ],
        }),
      },
    ]);
    const clip = graph.clips.get("clip");
    expect(clip).toBeDefined();
    expect(
      identityHash({
        kind: "clip",
        node: {
          ...clip!,
          versions: [
            ...clip!.versions,
            {
              version: 2,
              url: "https://m.example/clip.v2.mp4",
              localPath: "media/clips/clip.v2.mp4",
            },
          ],
        },
      }),
    ).toBe(identityHash({ kind: "clip", node: clip! }));
  });
});

describe("orderedClips", () => {
  it("orders by scene index then clip index, ignoring stored timeline order", () => {
    // timeline.json lists clips scrambled (as parallel generation would write
    // them); canonical order must still be by (scene index, clip index).
    const files = baseProject()
      .filter((file) => !file.path.startsWith("clips/"))
      .concat([
        {
          path: "clips/clip_c.md",
          content: md({ id: "clip_c", type: "clip", scene: "scene_1", index: 3, status: "active", url: "https://m/c.mp4", from_keyframe: "kf_1", to_keyframe: "kf_2" }),
        },
        {
          path: "clips/clip_a.md",
          content: md({ id: "clip_a", type: "clip", scene: "scene_1", index: 1, status: "active", url: "https://m/a.mp4", from_keyframe: "kf_1", to_keyframe: "kf_2" }),
        },
        {
          path: "clips/clip_b.md",
          content: md({ id: "clip_b", type: "clip", scene: "scene_1", index: 2, status: "active", url: "https://m/b.mp4", from_keyframe: "kf_1", to_keyframe: "kf_2" }),
        },
        {
          path: "timeline.json",
          content: JSON.stringify([
            { id: "tl_clip_c", clip_id: "clip_c" },
            { id: "tl_clip_a", clip_id: "clip_a" },
            { id: "tl_clip_b", clip_id: "clip_b" },
          ]),
        },
      ]);
    const graph = buildSourceGraph(files);
    expect(orderedClips(graph).map((clip) => clip.id)).toEqual([
      "clip_a",
      "clip_b",
      "clip_c",
    ]);
  });

  it("falls back to scene index then clip index", () => {
    const files = baseProject()
      .filter((file) => file.path !== "timeline.json")
      .concat([
        {
          path: "scenes/002-two/scene.md",
          content: md({ id: "scene_2", type: "scene", index: 2, references: [] }),
        },
        {
          path: "clips/clip_0.md",
          content: md({
            id: "clip_0",
            type: "clip",
            scene: "scene_2",
            index: 1,
            status: "planned",
            from_keyframe: null,
            to_keyframe: null,
          }),
        },
        {
          path: "clips/clip_1b.md",
          content: md({
            id: "clip_1b",
            type: "clip",
            scene: "scene_1",
            index: 2,
            status: "planned",
            from_keyframe: "kf_2",
            to_keyframe: null,
            transition_from_previous: "continuous",
          }),
        },
        { path: "timeline.json", content: "[]" },
      ]);
    const graph = buildSourceGraph(files);
    const order = orderedClips(graph).map((clip: ClipNode) => clip.id);
    expect(order).toEqual(["clip_1", "clip_1b", "clip_0"]);
  });
});
