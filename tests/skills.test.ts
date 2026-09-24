import { describe, expect, it } from "vitest";
import { listSkillSummaries, readSkill } from "@/lib/skills";

describe("skills", () => {
  it("loads block-scalar descriptions for the storyboard image direction skill", async () => {
    const summaries = await listSkillSummaries();
    const skill = summaries.find((candidate) => candidate.id === "storyboard-image-direction");
    expect(skill).toBeTruthy();
    expect(skill?.description).toContain("Turn a story beat into a single");
    expect(skill?.description).toContain("per-shot visuals");
  });

  it("reads the storyboard image direction method used by keyframe planning", async () => {
    const skill = await readSkill("storyboard-image-direction");
    expect(skill.path).toBe("skills/storyboard-image-direction/SKILL.md");
    expect(skill.content).toContain("all generated video keyframes are anticipation frames");
    expect(skill.content).toContain("beat-stage:");
    expect(skill.content).toContain("<anticipation | action | aftermath>");
  });
});
