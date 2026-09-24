import { beforeEach, describe, expect, it, vi } from "vitest";
import { listSkillSummaries } from "@/lib/skills";
import { listWorkflowSummaries, readWorkflow } from "@/lib/workflows";

const services = vi.hoisted(() => ({
  ensureCurrentAppUser: vi.fn(),
}));

vi.mock("@/lib/app-users", () => ({
  ensureCurrentAppUser: services.ensureCurrentAppUser,
}));

const workflowId = "vertical-story-episode";
const requiredSkills = [
  "reference-first-production",
  "model-prompting",
  "directors-notebook",
  "cuts",
  "storyboard-image-direction",
  "direct-eyes",
  "film-grammar",
];
const requiredCapabilities = [
  "User input and approval",
  "Plan management",
  "Project source read/write",
  "Reference and voice continuity",
  "Storyboard image generation",
  "Video generation",
  "Media inspection and frame extraction",
  "Audio generation and placement",
  "Editor timeline read and mutation",
  "Deterministic project validation",
];

beforeEach(() => {
  vi.clearAllMocks();
  services.ensureCurrentAppUser.mockResolvedValue({ userId: "workflow-test" });
});

describe("workflow loader contract", () => {
  it("loads the vertical story metadata and keeps every workflow id unique", async () => {
    const workflows = await listWorkflowSummaries();
    const workflow = workflows.find((candidate) => candidate.id === workflowId);

    expect(workflow).toEqual({
      category: "Storytelling",
      description:
        "Build a recurring 60–180 second vertical story episode in 9:16 — reusable series bible, five-to-eight dramatic beats, locked cast/world/voices, and a cliffhanger handoff.",
      id: workflowId,
      path: "workflows/vertical-story-episode.md",
      title: "Vertical Story Episode",
      use_when:
        "The user wants a serialized vertical fiction episode for TikTok, Reels, Shorts, or another phone-first series, especially when characters, locations, props, voices, and unresolved story threads must continue across episodes.",
    });
    expect(new Set(workflows.map((candidate) => candidate.id)).size).toBe(
      workflows.length,
    );
  });

  it("contains the complete episode and continuity handoff contract", async () => {
    const workflow = await readWorkflow(workflowId);

    expect(workflow.content).toContain("## Reusable series bible");
    expect(workflow.content).toContain("Plan 5–8 beats");
    expect(workflow.content).toContain("HOOK");
    expect(workflow.content).toContain("CONFLICT");
    expect(workflow.content).toContain("TURN");
    expect(workflow.content).toContain("PAYOFF");
    expect(workflow.content).toContain("CLIFFHANGER");
    expect(workflow.content).toContain("10. NEXT-EPISODE HANDOFF");
    expect(workflow.content).toContain("character and relationship states");
    expect(workflow.content).toContain("Next episode seed");
    expect(workflow.content).toContain("## Capability dependencies");
    expect(workflow.content).toContain("run `check_project`");
    expect(workflow.content).toMatch(
      /Watch the full\s+episode once muted and once with sound/,
    );
  });

  it("references installed skills and cross-surface capability labels", async () => {
    const [workflow, skills] = await Promise.all([
      readWorkflow(workflowId),
      listSkillSummaries(),
    ]);
    const installedSkills = new Set(skills.map((skill) => skill.id));

    expect(requiredSkills.every((skill) => installedSkills.has(skill))).toBe(true);
    for (const skill of requiredSkills) {
      expect(workflow.content).toContain(`\`${skill}\``);
    }
    for (const capability of requiredCapabilities) {
      expect(workflow.content).toContain(`**${capability}:**`);
    }
    expect(workflow.content).toContain(
      "these labels describe required behavior, not literal tool names",
    );
    expect(workflow.content).not.toMatch(
      /\b(?:askUser|updatePlan|generateKeyframe|generate_image|generate_clip|editor_timeline_insert)\b/,
    );
  });

  it("is visible through the authenticated workflows API", async () => {
    const { GET } = await import("@/app/api/workflows/route");
    const response = await GET();
    const body = (await response.json()) as {
      workflows: Array<{ id: string; title: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.workflows).toContainEqual(
      expect.objectContaining({ id: workflowId, title: "Vertical Story Episode" }),
    );
    expect(services.ensureCurrentAppUser).toHaveBeenCalledOnce();
  });
});
