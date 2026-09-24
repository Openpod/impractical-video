import { generateObject } from "ai";
import { z } from "zod";
import type { LanguageModel } from "ai";
import type { SceneState } from "@/lib/generation-contract";
import { renderKeyframeReviewRubric } from "@/lib/keyframe-review-rubric";

/**
 * Independent keyframe reviewer — a SEPARATE model invocation (fresh context,
 * critic role) from the one that generated the frames. The generator has a
 * bias toward approving its own work; a separate critic with a single job
 * ("find what's wrong") catches the too-similar pairs, drift, and geometry
 * breaks the in-flow model tends to skip. Same model type, different role.
 */

export type ReviewPair = {
  clipId: string;
  transition: string | null;
  fromId: string;
  fromUrl: string;
  fromSceneState?: SceneState | null;
  toId: string | null;
  toUrl: string | null;
  toSceneState?: SceneState | null;
  intent: string;
};

export type ReviewPortfolio = { referenceId: string; url: string };

export type ReviewFinding = {
  severity: "blocker" | "issue" | "note";
  implicates: string[];
  summary: string;
  detail: string;
};

const findingsSchema = z.object({
  findings: z
    .array(
      z.object({
        severity: z.enum(["blocker", "issue", "note"]),
        implicates: z
          .array(z.string())
          .describe("Keyframe ids this finding is about."),
        summary: z.string().describe("One-line description of the problem."),
        detail: z.string().describe("Specifics and a suggested fix."),
      }),
    )
    .describe("Every real problem found. Empty array if the frames are clean."),
});

export type ReviewContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string };

const BASE_CRITIC_INSTRUCTIONS = `You are an adversarial first/last-frame INTERPOLATION GATE — not a quality reviewer. You did NOT create these keyframes. A beautiful pair of stills can still be impossible to animate into one coherent clip, and catching that BEFORE expensive video generation is your only job. Be critical, not charitable.

Judge the PIXELS, not the stated intent. The clip's intent can be wrong: if it claims "slow push-in" but the frames pair a street-level shot with a bird's-eye overhead, trust the pixels and flag the contradiction. Use the stated intent only to decide whether deliberately low motion is acceptable — a held pose, slow burn, or reaction hold is SUPPOSED to be subtle, so do not flag it as "too similar."

For every pair, think in this order:
1. Describe frame A literally, then frame B literally — camera height/angle/lens, background landmarks and vanishing point, each subject's facing/scale/screen position, crowd/extras count, props/weapons, lighting. Name what is physically on screen; do not summarize as story ("a fight continues").
2. Estimate the camera move two ways — from how the SUBJECTS changed, and from how the BACKGROUND changed. If those disagree, it is impossible geometry.
3. Simulate the in-between: predict what the video model will DO between A and B, and name the failure if any — teleport, mass spawn/despawn, morph, body-rotation-in-a-fixed-world, static hold, identity swap, or hidden cut.
4. Decide: is this one continuous camera + motion path, or a cut pretending to be continuous?
5. Prescribe the repair by defect type: a local defect (hair, prop, wardrobe, lighting, a stray object) can be revised in place; a spatial/camera/staging/scale defect must be regenerated from the previous valid keyframe or bridged with an intermediate keyframe; a too-large jump should become a real cut. NEVER revise-in-place a whole-frame camera/scale failure — "keep it identical except…" makes the bad frame win.

Default to suspicion: if you cannot construct a single plausible camera path plus motion path connecting the two frames, it is a blocker. Only report REAL problems with specific evidence — do not invent issues to seem thorough; an empty findings list is correct when the frames are clean. Implicate the exact keyframe ids involved.`;

export const UNGUIDED_CRITIC_SYSTEM = `${BASE_CRITIC_INSTRUCTIONS}

This is the RUBRIC-BLIND pass. You have intentionally not been given the known-failure checklist. Look freely and adversarially for anything about the frame pairs that will break, look wrong, be impossible to interpolate, or confuse identity/continuity. Surface novel problems even if they do not fit an obvious category.`;

export const RUBRIC_CRITIC_SYSTEM = `${BASE_CRITIC_INSTRUCTIONS}

This is the RUBRIC pass. Apply every known failure mode below as a consistency floor. The rubric is not a ceiling: if you notice a real problem outside the list, report it too and say which new failure mode the rubric should learn.

Known keyframe-pair failure modes:
${renderKeyframeReviewRubric()}`;

function formatSceneState(state: SceneState | null | undefined): string {
  if (!state) return "none declared";
  const characters = state.characters.length
    ? state.characters
        .map((character) => `${character.id}:${character.screen_position},facing=${character.facing}`)
        .join("; ")
    : "none";
  const props = state.props.length
    ? state.props
        .map((prop) => `${prop.id}:owner=${prop.owner ?? "none"},location=${prop.location}`)
        .join("; ")
    : "none";
  const setAnchors = state.set_anchors.length
    ? state.set_anchors.map((anchor) => `${anchor.id}:${anchor.location}`).join("; ")
    : "none";
  return `characters=[${characters}] props=[${props}] set_anchors=[${setAnchors}]`;
}

export function buildReviewContent(input: {
  pairs: ReviewPair[];
  portfolios: ReviewPortfolio[];
}): ReviewContentPart[] {
  const content: ReviewContentPart[] = [];

  if (input.portfolios.length) {
    content.push({
      type: "text",
      text: "Identity portfolios (ground truth the keyframes must match):",
    });
    for (const portfolio of input.portfolios) {
      content.push({ type: "text", text: `Portfolio for "${portfolio.referenceId}":` });
      content.push({ type: "image", image: portfolio.url });
    }
  }

  content.push({
    type: "text",
    text: "Clips and their start/end keyframe PAIRS (review each pair together):",
  });
  for (const pair of input.pairs) {
    content.push({
      type: "text",
      text: `Clip "${pair.clipId}" [${pair.transition ?? "cut"}] — ${pair.intent}\nStart keyframe "${pair.fromId}" declared scene_state: ${formatSceneState(pair.fromSceneState)}`,
    });
    content.push({ type: "image", image: pair.fromUrl });
    if (pair.toId && pair.toUrl) {
      content.push({
        type: "text",
        text: `End keyframe "${pair.toId}" declared scene_state: ${formatSceneState(pair.toSceneState)}`,
      });
      content.push({ type: "image", image: pair.toUrl });
    }
  }

  return content;
}

function findingKey(finding: ReviewFinding) {
  const implicates = [...new Set(finding.implicates)].sort().join(",");
  return [
    finding.severity,
    implicates,
    finding.summary.trim().toLowerCase().replace(/\s+/g, " "),
  ].join("|");
}

export function mergeReviewFindings(
  ...findingSets: ReviewFinding[][]
): ReviewFinding[] {
  const merged: ReviewFinding[] = [];
  const seen = new Set<string>();
  for (const finding of findingSets.flat()) {
    const key = findingKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      ...finding,
      implicates: [...new Set(finding.implicates)],
    });
  }
  return merged;
}

async function runCriticPass(input: {
  model: LanguageModel;
  system: string;
  content: ReviewContentPart[];
}) {
  const { object } = await generateObject({
    model: input.model,
    schema: findingsSchema,
    system: input.system,
    messages: [{ role: "user", content: input.content }],
  });
  return object.findings;
}

/**
 * Run the critic over the keyframe pairs + chain. Returns findings (possibly
 * empty). Infrastructure failures throw — the caller decides how to proceed.
 */
export async function reviewKeyframes(input: {
  model: LanguageModel;
  pairs: ReviewPair[];
  chain: { id: string; url: string }[];
  portfolios: ReviewPortfolio[];
}): Promise<ReviewFinding[]> {
  const content = buildReviewContent(input);
  const [unguidedFindings, rubricFindings] = await Promise.all([
    runCriticPass({
      model: input.model,
      system: UNGUIDED_CRITIC_SYSTEM,
      content,
    }),
    runCriticPass({
      model: input.model,
      system: RUBRIC_CRITIC_SYSTEM,
      content,
    }),
  ]);
  return mergeReviewFindings(unguidedFindings, rubricFindings);
}
