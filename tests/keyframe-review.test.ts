import { generateObject } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  RUBRIC_CRITIC_SYSTEM,
  UNGUIDED_CRITIC_SYSTEM,
  buildReviewContent,
  mergeReviewFindings,
  reviewKeyframes,
} from "@/lib/keyframe-review";
import {
  KEYFRAME_REVIEW_RUBRIC,
  renderKeyframeReviewRubric,
} from "@/lib/keyframe-review-rubric";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

const generateObjectMock = vi.mocked(generateObject);

describe("keyframe review rubric", () => {
  it("renders every rubric entry by stable id", () => {
    const rendered = renderKeyframeReviewRubric();
    for (const entry of KEYFRAME_REVIEW_RUBRIC) {
      expect(rendered).toContain(entry.id);
      expect(rendered).toContain(entry.inspect);
      expect(rendered).toContain(entry.repair);
    }
  });

  it("keeps the unguided pass rubric-blind", () => {
    expect(UNGUIDED_CRITIC_SYSTEM).toContain("RUBRIC-BLIND pass");
    expect(UNGUIDED_CRITIC_SYSTEM).not.toContain("camera_background_coherence");
    expect(RUBRIC_CRITIC_SYSTEM).toContain("camera_background_coherence");
  });
});

describe("reviewKeyframes", () => {
  it("includes declared scene_state for both endpoint keyframes", () => {
    const content = buildReviewContent({
      portfolios: [],
      pairs: [
        {
          clipId: "clip_market",
          transition: "continuous",
          fromId: "kf_01",
          fromUrl: "https://m.example/kf_01.png",
          fromSceneState: {
            characters: [
              { id: "ivy", screen_position: "left", facing: "right" },
              { id: "ren", screen_position: "right", facing: "left" },
            ],
            props: [{ id: "helmet", owner: "ren", location: "right" }],
            set_anchors: [{ id: "stall_post", location: "center" }],
          },
          toId: "kf_02",
          toUrl: "https://m.example/kf_02.png",
          toSceneState: {
            characters: [
              { id: "ivy", screen_position: "left_center", facing: "right" },
              { id: "ren", screen_position: "right", facing: "left" },
            ],
            props: [{ id: "helmet", owner: "ren", location: "right" }],
            set_anchors: [{ id: "stall_post", location: "center" }],
          },
          intent: "Ivy and Ren square off.",
        },
      ],
    });
    const text = content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(text).toContain('Start keyframe "kf_01" declared scene_state');
    expect(text).toContain("ivy:left,facing=right");
    expect(text).toContain("helmet:owner=ren,location=right");
    expect(text).toContain("stall_post:center");
    expect(text).toContain('End keyframe "kf_02" declared scene_state');
    expect(text).toContain("ivy:left_center,facing=right");
  });

  it("runs separate unguided and rubric critic passes, then merges findings", async () => {
    generateObjectMock
      .mockResolvedValueOnce({
        object: {
          findings: [
            {
              severity: "blocker",
              implicates: ["kf_02", "kf_03"],
              summary: "Impossible camera move",
              detail: "Subjects reverse while the background stays fixed.",
            },
          ],
        },
      } as never)
      .mockResolvedValueOnce({
        object: {
          findings: [
            {
              severity: "blocker",
              implicates: ["kf_02", "kf_03"],
              summary: "Impossible camera move",
              detail: "Same finding from rubric pass.",
            },
            {
              severity: "issue",
              implicates: ["kf_03"],
              summary: "Visible prop vanishes",
              detail: "The holster disappears without an action beat.",
            },
          ],
        },
      } as never);

    const findings = await reviewKeyframes({
      model: {} as never,
      portfolios: [{ referenceId: "char_ren", url: "https://m.example/ren.png" }],
      chain: [],
      pairs: [
        {
          clipId: "clip_chase",
          transition: "continuous",
          fromId: "kf_02",
          fromUrl: "https://m.example/kf_02.png",
          toId: "kf_03",
          toUrl: "https://m.example/kf_03.png",
          intent: "Ren runs down the alley while a pursuer closes in.",
        },
      ],
    });

    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    const firstCall = generateObjectMock.mock.calls[0]?.[0];
    const secondCall = generateObjectMock.mock.calls[1]?.[0];
    expect(firstCall?.system).toBe(UNGUIDED_CRITIC_SYSTEM);
    expect(secondCall?.system).toBe(RUBRIC_CRITIC_SYSTEM);
    expect(firstCall?.messages?.[0]?.content).toEqual(secondCall?.messages?.[0]?.content);
    expect(findings).toEqual([
      {
        severity: "blocker",
        implicates: ["kf_02", "kf_03"],
        summary: "Impossible camera move",
        detail: "Subjects reverse while the background stays fixed.",
      },
      {
        severity: "issue",
        implicates: ["kf_03"],
        summary: "Visible prop vanishes",
        detail: "The holster disappears without an action beat.",
      },
    ]);
  });
});

describe("mergeReviewFindings", () => {
  it("deduplicates matching findings while preserving distinct issues", () => {
    const findings = mergeReviewFindings(
      [
        {
          severity: "blocker",
          implicates: ["kf_b", "kf_a"],
          summary: "Same issue",
          detail: "First detail.",
        },
      ],
      [
        {
          severity: "blocker",
          implicates: ["kf_a", "kf_b"],
          summary: "Same   issue",
          detail: "Second detail.",
        },
        {
          severity: "note",
          implicates: ["kf_a"],
          summary: "Different issue",
          detail: "Keep this.",
        },
      ],
    );
    expect(findings).toHaveLength(2);
    expect(findings[0]?.detail).toBe("First detail.");
    expect(findings[1]?.summary).toBe("Different issue");
  });
});
