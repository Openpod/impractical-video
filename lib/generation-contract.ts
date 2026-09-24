import {
  type SourceGraph,
  identityHash,
  lookupIdentityHash,
} from "@/lib/source-graph";

/**
 * Pure helpers that turn graph state into generation-call inputs. The agent
 * decides WHICH anchors and WHAT delta instruction; these functions guarantee
 * that decision is what physically reaches the model:
 *
 *  - identity anchors (portfolio sheets) and an optional state anchor (prior
 *    frame) resolve to ordered image URLs;
 *  - a deterministic preamble tells the image model what each image is;
 *  - built_against records dependency hashes so the linter can detect
 *    staleness later.
 */

export type ResolvedAnchor = {
  anchorId: string;
  portfolioId: string;
  referenceId: string | null;
  url: string;
};

export type AnchorResolution =
  | {
      ok: true;
      anchors: ResolvedAnchor[];
      stateAnchorUrl: string | null;
      imageUrls: string[];
    }
  | { ok: false; error: string };

/**
 * Resolve identity anchor ids (portfolio ids, or reference ids resolved to
 * their portfolio) plus an optional state-anchor keyframe into the ordered
 * image list for a conditioned generation call: identity sheets first, prior
 * frame last.
 */
export function resolveGenerationAnchors(
  graph: SourceGraph,
  input: {
    identityAnchorIds: string[];
    stateAnchorId?: string | null;
    /** Pre-resolved hosted URL for the state anchor (callers sign local-only
     * media before resolution; fal cannot fetch workspace paths). */
    stateAnchorUrlOverride?: string | null;
  },
): AnchorResolution {
  const anchors: ResolvedAnchor[] = [];
  for (const anchorId of input.identityAnchorIds) {
    const portfolio =
      graph.portfolios.get(anchorId) ??
      graph.portfolioByReference.get(anchorId) ??
      null;
    if (!portfolio) {
      return {
        ok: false,
        error: `Identity anchor "${anchorId}" resolves to no portfolio. Create and generate the portfolio first (references/<category>/<id>/portfolio.md).`,
      };
    }
    const url = portfolio.urls[0];
    if (!url) {
      return {
        ok: false,
        error: `Portfolio "${portfolio.id}" has no media urls yet; generate it before using it as an identity anchor.`,
      };
    }
    anchors.push({
      anchorId,
      portfolioId: portfolio.id,
      referenceId: portfolio.referenceId,
      url,
    });
  }

  let stateAnchorUrl: string | null = null;
  if (input.stateAnchorId) {
    const keyframe = graph.keyframes.get(input.stateAnchorId);
    if (!keyframe) {
      return {
        ok: false,
        error: `State anchor keyframe "${input.stateAnchorId}" does not exist.`,
      };
    }
    const resolvedUrl = input.stateAnchorUrlOverride ?? keyframe.url;
    if (!resolvedUrl) {
      return {
        ok: false,
        error: `State anchor keyframe "${input.stateAnchorId}" has no media url; generate or capture it first.`,
      };
    }
    stateAnchorUrl = resolvedUrl;
  }

  return {
    ok: true,
    anchors,
    stateAnchorUrl,
    imageUrls: [
      ...anchors.map((anchor) => anchor.url),
      ...(stateAnchorUrl ? [stateAnchorUrl] : []),
    ],
  };
}

/**
 * Deterministic preamble naming the role of every conditioning image. Lives
 * in code, not in the agent's prompt, so it cannot be forgotten or mangled.
 */
export function composeConditionedPrompt(input: {
  anchors: ResolvedAnchor[];
  stateAnchorUrl: string | null;
  instruction: string;
  /** Number of images that precede the anchors (e.g. a revise base image at
   * Image 1). Keeps the "Image N" labels aligned with the real image order. */
  imageOffset?: number;
  /** Optional declared-staging block (see composeStagingDirection) appended so
   * the generator sees who stands where, not just the lint/critic. */
  staging?: string | null;
}): string {
  const offset = input.imageOffset ?? 0;
  const lines: string[] = [];
  input.anchors.forEach((anchor, index) => {
    const subject = anchor.referenceId ?? anchor.portfolioId;
    lines.push(
      `Image ${offset + index + 1}: identity reference sheet for "${subject}". Copy its exact identity/design.`,
    );
  });
  if (input.stateAnchorUrl) {
    lines.push(
      `Image ${offset + input.anchors.length + 1}: the previous frame — use it to keep character identity, art style, world/location, and lighting consistent. Follow the instruction below for the new pose, subject positions, and camera framing; do NOT preserve the previous frame's pose, positions, or framing beyond what the instruction asks.`,
    );
  }
  const base =
    lines.length === 0
      ? input.instruction
      : `${lines.join("\n")}\n\nGenerate the next frame:\n${input.instruction}`;
  if (input.staging) {
    return `${base}\n\nDeclared staging (match these on-screen positions):\n${input.staging}`;
  }
  return base;
}

/**
 * Record the identity hash of every dependency a generated node was built
 * against. Written by tools, verified by the linter, never authored by hand.
 */
export function buildBuiltAgainst(
  graph: SourceGraph,
  dependencyIds: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of dependencyIds) {
    const hash = lookupIdentityHash(graph, id);
    if (hash) out[id] = hash;
  }
  return out;
}

/**
 * Motion rate vocabulary mapped to exact provider-prompt phrases. "real_time"
 * is the cinematography term for unmanipulated speed (events take the time
 * they would take in life).
 */
/** The only aspect ratios the app supports — landscape, vertical, square.
 * All image and video generation is standardized to one of these. */
export const ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const MOTION_RATES = {
  slow_motion: "slow motion — deliberate, high-detail movement",
  real_time: "real-time natural speed",
  accelerated: "swift, energetic, stable motion",
  frenetic: "rapid, high-energy movement with clear readable action",
} as const;

export type MotionRate = keyof typeof MOTION_RATES;

export const DIALOGUE_MODES = [
  "no_audible_speech",
  "nonverbal_only",
  "exact_dialogue",
  "voiceover_exact",
] as const;

export type DialogueMode = (typeof DIALOGUE_MODES)[number];

export type DialogueLine = {
  speaker: string;
  line: string;
  start_s: number;
  end_s: number;
  delivery?: string | null;
};

export type ClipDialogue = {
  mode: DialogueMode;
  lines?: DialogueLine[];
};

function sentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function displaySpeakerName(speaker: string): string {
  return (
    speaker
      .replace(/^char(?:acter)?[_-]/, "")
      .replace(/[_-]+/g, " ")
      .trim() || speaker
  );
}

function formatDialogueForPrompt(dialogue: ClipDialogue): string | null {
  if (dialogue.mode === "no_audible_speech") {
    return "No dialogue.";
  }
  if (dialogue.mode === "nonverbal_only") {
    return "No dialogue; use visible body language only.";
  }
  const spoken = (dialogue.lines ?? []).filter((line) => line.line.trim());
  if (spoken.length === 0) {
    return "Do not invent spoken lines.";
  }
  const lines = spoken.map((entry) => {
    const delivery = entry.delivery?.trim() ? `, ${entry.delivery.trim()}` : "";
    return `${displaySpeakerName(entry.speaker)} says "${entry.line.trim()}"${delivery}`;
  });
  const lead =
    dialogue.mode === "voiceover_exact"
      ? "Voiceover uses only these exact words:"
      : "Audible dialogue uses only these exact words:";
  return `${lead} ${lines.join("; ")}.`;
}

/**
 * Single camera move per shot — the Separation Rule from the prompting
 * research. Blending camera moves ("dolly in while panning") produces jittery
 * output; the schema constrains to one verb.
 */
export const CAMERA_MOVES = [
  "fixed",
  "push_in",
  "pull_out",
  "pan",
  "tracking",
  "orbit",
  "aerial",
  "handheld",
] as const;

export type CameraMove = (typeof CAMERA_MOVES)[number];

const CAMERA_PHRASES: Record<CameraMove, string> = {
  fixed: "a fixed, steady frame",
  push_in: "a slow push-in",
  pull_out: "a slow pull-out",
  pan: "a steady pan",
  tracking: "a smooth tracking move",
  orbit: "a single orbiting move",
  aerial: "a high aerial vantage",
  handheld: "a loose handheld frame",
};

/** How an element differs between the two observed keyframes. */
export const FRAME_DELTA_CHANGES = [
  "appeared",
  "vanished",
  "moved",
  "changed_state",
] as const;

export type FrameDeltaChange = (typeof FRAME_DELTA_CHANGES)[number];

export type FrameDeltaEntry = {
  element: string;
  change: FrameDeltaChange;
  /** intended: the motion explains it (narration required). continuity_error: a flaw to repair. */
  classification: "intended" | "continuity_error";
  /** For intended changes, how the element appears/moves on screen. */
  narration?: string | null;
};

/** Continuity-error deltas block clip generation until the keyframe is repaired. */
export function blockingFrameDeltas(deltas: FrameDeltaEntry[]): FrameDeltaEntry[] {
  return deltas.filter((delta) => delta.classification === "continuity_error");
}

/* ──────────────────────────────────────────────────────────────────────────
 * Cut-default planning + declarative scene state (STAGE / Captain Cinema /
 * CANVAS / EntityBench clone). These are orchestration + validation primitives,
 * NOT generator bbox conditioning: text-specified placement is unreliable in
 * nano-banana (AutoStudio / POCI-Diff finding), so scene_state exists to be
 * diffed by the critic/lint across a span — it is not a "place the character
 * here" instruction to the image model.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Max keyframes allowed in one continuous `state_anchor` chain before a cut must
 * reset composition. A keyframe WITH `state_anchor` extends the continuous chain;
 * a keyframe WITHOUT it is a cut/recompose that resets the count. Action should
 * default to cuts and use continuity only for short, simple, local single-motion
 * beats — so the count of mutually-coherent endpoints we ask the model to hold
 * stays small. (lint/checkProject enforces this cap; codex owns that side.)
 */
export const MAX_CONTINUOUS_CHAIN = 3;

/** Coarse screen-position buckets for state diffing (NOT bbox conditioning). */
export const SCREEN_POSITIONS = [
  "left",
  "left_center",
  "center",
  "right_center",
  "right",
  "foreground",
  "background",
  "offscreen",
] as const;

export type ScreenPosition = (typeof SCREEN_POSITIONS)[number];

/** Coarse facing direction for catching screen-direction flips across a span. */
export const FACINGS = [
  "left",
  "right",
  "toward_camera",
  "away_from_camera",
  "neutral",
] as const;

export type Facing = (typeof FACINGS)[number];

export type CharacterState = {
  /** Stable proper noun / reference id (no pronouns), matching keyframe `depicts`. */
  id: string;
  screen_position: ScreenPosition;
  facing: Facing;
  /** Optional explicit injection region (normalized 0..1, origin top-left). When
   * present it overrides the coarse region derived from screen_position and is
   * rasterized into a mask for region-bounded identity injection. */
  bbox?: RegionBox | null;
};

/** Normalized rectangle (fractions of frame width/height; origin top-left). */
export type RegionBox = { x: number; y: number; w: number; h: number };

export type PropState = {
  id: string;
  /** Character id currently holding/controlling the prop, or null if unattended. */
  owner?: string | null;
  location: ScreenPosition;
};

export type SetAnchor = {
  /** Named fixed set piece, e.g. "ticket booth", "overturned crate". */
  id: string;
  location: ScreenPosition;
};

/**
 * Declarative per-keyframe state snapshot, persisted in keyframe frontmatter as
 * `scene_state`. The critic/lint diff this across a continuous span (and across a
 * cut, where order/identity should persist even though composition resets) to
 * catch left/right order swaps, facing flips, and prop owner/location jumps that
 * the pairwise `frame_delta` cannot see. This is the declarative layer;
 * `frame_delta` stays the pairwise/reactive layer.
 */
export type SceneState = {
  characters: CharacterState[];
  props: PropState[];
  set_anchors: SetAnchor[];
};

/**
 * Coarse injection region implied by a screen-position bucket, used to rasterize
 * a mask when no explicit bbox is supplied. Left/right buckets are full-height
 * vertical bands (so order reads), foreground/background trade height for depth,
 * offscreen is empty. Normalized 0..1, origin top-left.
 */
export function regionForScreenPosition(position: ScreenPosition): RegionBox {
  switch (position) {
    case "left":
      return { x: 0, y: 0, w: 0.4, h: 1 };
    case "left_center":
      return { x: 0.15, y: 0, w: 0.4, h: 1 };
    case "center":
      return { x: 0.3, y: 0, w: 0.4, h: 1 };
    case "right_center":
      return { x: 0.45, y: 0, w: 0.4, h: 1 };
    case "right":
      return { x: 0.6, y: 0, w: 0.4, h: 1 };
    case "foreground":
      return { x: 0.2, y: 0.35, w: 0.6, h: 0.65 };
    case "background":
      return { x: 0.3, y: 0.1, w: 0.4, h: 0.5 };
    case "offscreen":
      return { x: 0, y: 0, w: 0, h: 0 };
  }
}

/** The injection region for a character: explicit bbox if given, else derived
 * from screen_position. Empty (w/h = 0) means no maskable region (offscreen). */
export function characterRegion(character: CharacterState): RegionBox {
  return character.bbox ?? regionForScreenPosition(character.screen_position);
}

export const KEYFRAME_COMPOSITION_MODES = [
  "direct",
  "sequential_injection",
] as const;

export type KeyframeCompositionMode =
  (typeof KEYFRAME_COMPOSITION_MODES)[number];

export const IDENTITY_VERIFICATION_STATUSES = [
  "pending",
  "passed",
  "failed",
] as const;

export type IdentityVerificationStatus =
  (typeof IDENTITY_VERIFICATION_STATUSES)[number];

export type IdentityVerification = {
  reference_id: string;
  portfolio_id?: string | null;
  status: IdentityVerificationStatus;
  /** Short visual evidence from the verifier; null for pending. */
  summary?: string | null;
};

export type IdentityInjectionAttempt = {
  reference_id: string;
  attempts: number;
};

/**
 * How a keyframe's pixels were composed. Direct generation is the legacy
 * kitchen-sink call. Sequential injection is the IdentityStory-style API clone:
 * generate a plate, then edit in one identity-bound character at a time and
 * verify each visible character before clips.
 */
export type KeyframeComposition = {
  mode: KeyframeCompositionMode;
  plate_keyframe?: string | null;
  injected_references?: string[];
  injection_attempts?: IdentityInjectionAttempt[];
  identity_verifications?: IdentityVerification[];
};

/** Left↔right rank for screen positions; null for depth/offscreen buckets that
 * carry no horizontal order. */
export function screenPositionLrRank(position: ScreenPosition): number | null {
  switch (position) {
    case "left":
      return 0;
    case "left_center":
      return 1;
    case "center":
      return 2;
    case "right_center":
      return 3;
    case "right":
      return 4;
    default:
      return null; // foreground | background | offscreen — no horizontal order
  }
}

/**
 * Detect characters that swapped left↔right order between two scene states. A
 * swap across a CONTINUOUS pair is the state-level signature of a
 * screen-direction / 180°-line break: two bodies cannot cross horizontal order
 * via one near-linear interpolation without a cut or a traversable path. Returns
 * canonical "idA<->idB" labels for each inverted pair (empty when order holds).
 */
export function sceneStateOrderSwaps(a: SceneState, b: SceneState): string[] {
  const rankIn = (state: SceneState) => {
    const map = new Map<string, number>();
    for (const character of state.characters) {
      const rank = screenPositionLrRank(character.screen_position);
      if (rank !== null) map.set(character.id, rank);
    }
    return map;
  };
  const ra = rankIn(a);
  const rb = rankIn(b);
  const common = [...ra.keys()].filter((id) => rb.has(id));
  const swaps: string[] = [];
  for (let i = 0; i < common.length; i += 1) {
    for (let j = i + 1; j < common.length; j += 1) {
      const x = common[i];
      const y = common[j];
      const da = ra.get(x)! - ra.get(y)!;
      const db = rb.get(x)! - rb.get(y)!;
      if (da !== 0 && db !== 0 && Math.sign(da) !== Math.sign(db)) {
        swaps.push([x, y].sort().join("<->"));
      }
    }
  }
  return [...new Set(swaps)].sort();
}

function positionPhrase(p: ScreenPosition): string {
  switch (p) {
    case "left":
      return "in the left of frame";
    case "left_center":
      return "left of center";
    case "center":
      return "in the center";
    case "right_center":
      return "right of center";
    case "right":
      return "in the right of frame";
    case "foreground":
      return "in the foreground";
    case "background":
      return "in the background";
    case "offscreen":
      return "off-screen";
  }
}

function facingPhrase(f: Facing): string | null {
  switch (f) {
    case "left":
      return "facing screen-left";
    case "right":
      return "facing screen-right";
    case "toward_camera":
      return "facing the camera";
    case "away_from_camera":
      return "facing away from camera";
    case "neutral":
      return null;
  }
}

/**
 * Render a keyframe's declared scene_state into a compact, human-readable staging
 * block for the image prompt — closing the loop so the GENERATOR sees who stands
 * where, not just the lint/critic. Coarse guidance only: text-specified placement
 * is unreliable in the image model (AutoStudio/POCI-Diff), so this aids staging,
 * it does not guarantee it; cuts/framing remain the reliable lever for hard
 * relational beats. Returns null when there is nothing to declare.
 */
export function composeStagingDirection(sceneState: SceneState): string | null {
  const lines: string[] = [];
  for (const character of sceneState.characters) {
    const facing = facingPhrase(character.facing);
    lines.push(
      `- ${character.id} is ${positionPhrase(character.screen_position)}${facing ? `, ${facing}` : ""}.`,
    );
  }
  for (const prop of sceneState.props) {
    lines.push(
      prop.owner
        ? `- the ${prop.id} is held by ${prop.owner}.`
        : `- the ${prop.id} is unattended ${positionPhrase(prop.location)}.`,
    );
  }
  for (const anchor of sceneState.set_anchors) {
    lines.push(`- ${anchor.id} sits ${positionPhrase(anchor.location)}.`);
  }
  return lines.length ? lines.join("\n") : null;
}

/**
 * Deterministic video prompt for a clip, compiled into the Seedance dialect
 * the current first/last-frame path needs: loose action intent, dialogue state,
 * and an optional camera phrase. The rich plan stays in clip metadata for
 * validation and user review; the model-facing prompt stays deliberately
 * small and movement-first.
 */
export function composeClipPrompt(input: {
  actionIntent: string;
  startState: string;
  endState?: string | null;
  actionBeats: string[];
  environment?: string | null;
  cameraMove: CameraMove;
  cameraNote?: string | null;
  lighting?: string | null;
  motionRate: MotionRate;
  frameDeltas?: FrameDeltaEntry[];
  dialogue: ClipDialogue;
}): string {
  const visualParts: string[] = [];
  visualParts.push(sentence(input.actionIntent));

  const cameraNote = input.cameraNote?.trim();
  if (input.cameraMove !== "fixed" || cameraNote) {
    const camera = `Camera uses ${CAMERA_PHRASES[input.cameraMove]}${
      cameraNote ? `, ${cameraNote}` : ""
    }`;
    visualParts.push(sentence(camera));
  }
  const dialogue = formatDialogueForPrompt(input.dialogue);
  if (dialogue) visualParts.push(dialogue);

  return visualParts.filter(Boolean).join(" ");
}

const ADULT_FEMALE_TERMS =
  /\b(adult woman|adult female|adult lady|woman|women|female|lady|female-presenting)\b/i;
const ADULT_TERMS = /\b(adult|early 20s|mid 20s|late 20s|20s|early 30s|mid 30s|late 30s|30s)\b/i;
const YOUTH_CODED_TERMS =
  /\b(minor|underage|teen|teenage|child|kid|girlhood|schoolgirl|student uniform|childlike|youthful|young girl)\b/i;
const GLAMOUR_CONFLICT_TERMS =
  /\b(modest|conservative|plain|ordinary|average-looking|covered up|no cleavage|small bust|flat[- ]?chested|elderly|senior|grandmother|androgynous)\b/i;
const GLAMOUR_INTENT_TERMS =
  /\b(attractive|beautiful|beauty|pretty|gorgeous|stunning|sensual|seductive|alluring|sexy|glamou?r|supermodel|model-like|fashion model|voluptuous|busty|curvy|hourglass|cleavage|neckline|underwear|bodysuit|swimsuit|lingerie-inspired|revealing|sultry)\b/i;

const ADULT_FEMALE_GLAMOUR_PORTFOLIO_DEFAULT = [
  "Adult female glamour requirement: make the character unmistakably adult, late 20s to 30s, with supermodel-level facial beauty and a conventionally glamorous physique.",
  "Use striking symmetrical features, sculpted cheekbones, expressive eyes, full lips, luminous skin, polished hair, and high-end editorial makeup.",
  "Default body design is voluptuous and fashion-model attractive: full bust, defined waist, shapely hips, long elegant legs, confident posture, and sensual but composed body language.",
  "Wardrobe must emphasize the intended silhouette and neckline with high-fashion editorial glamour.",
  "If the asset-specific brief requests cleavage, a bodysuit, underwear, fitted clothing, or other sensual styling, preserve and strengthen that exact wardrobe direction instead of covering it with conservative clothing.",
  "Use PromptCat-style decomposition: subject, anatomy, wardrobe fit, pose, camera angle, lighting, skin/fabric texture, mood, and realism must all reinforce the same attractive adult identity.",
  "Preservation negatives for the portfolio: avoid anatomy normalization, body proportion averaging, smaller bust than briefed, reduced chest volume, flattened or compressed curves, slimmed torso, generic dataset-average female anatomy, beauty-filter smoothing, plastic skin, airbrushed texture, and naturalization of prominent features.",
  "Treat attractiveness as a core identity anchor across all nine cells, not a single beauty-shot variation.",
].join("\n");

function stripSafetyHedging(value: string): string {
  return value
    .replace(/\bfully\s+SFW\s+and\s+non[- ]explicit\b/gi, "")
    .replace(/\bfully\s+SFW\b/gi, "")
    .replace(/\bSFW\b/g, "")
    .replace(/\bnon[- ]explicit\b/gi, "")
    .replace(/\s+([,.])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Portfolio prompts are identity ground truth. This code-level enrichment keeps
 * adult female glamour intent from being softened by generic character wording
 * before the image model sees it.
 */
export function enrichPortfolioAssetPrompt(input: {
  category: "characters" | "environments" | "props" | "styles";
  prompt: string;
}): string {
  if (input.category !== "characters") return input.prompt;
  if (!ADULT_FEMALE_TERMS.test(input.prompt) || !ADULT_TERMS.test(input.prompt)) {
    return input.prompt;
  }
  if (YOUTH_CODED_TERMS.test(input.prompt) || GLAMOUR_CONFLICT_TERMS.test(input.prompt)) {
    return input.prompt;
  }

  const hasGlamourIntent = GLAMOUR_INTENT_TERMS.test(input.prompt);
  const prompt = stripSafetyHedging(input.prompt.trim());
  const lead = hasGlamourIntent
    ? "The brief contains adult female glamour/sensual styling intent; preserve it strongly."
    : "Apply the default adult female glamour aesthetic unless the brief explicitly says otherwise.";
  return `${prompt}\n\n${lead}\n${ADULT_FEMALE_GLAMOUR_PORTFOLIO_DEFAULT}`;
}

export type ModelReferenceLegendInput = {
  id: string;
  body: string;
};

function displayNameForReference(reference: ModelReferenceLegendInput): string {
  const firstLine = reference.body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const named = firstLine?.match(/^([^:]{1,80}):/);
  if (named?.[1]?.trim()) return named[1].trim();
  return (
    reference.id
      .replace(/^char(?:acter)?[_-]/, "")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase())
      .trim() || reference.id
  );
}

function clampWords(value: string, maxWords: number): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return words.slice(0, maxWords).join(" ");
}

function cleanReferenceSummary(value: string): string {
  // Normalize whitespace/punctuation only. Author-written wardrobe and
  // body-language detail (including SFW sexualized phrasing) is preserved
  // verbatim — we do not strip creative intent from the model legend.
  return value
    .replace(/\s+([,.])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function referenceSummaryForModel(reference: ModelReferenceLegendInput): string {
  const name = displayNameForReference(reference);
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = reference.body
    .replace(/^---[\s\S]*?---/, "")
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(new RegExp(`^${escapedName}\\s*:\\s*`, "i"), "");
  const sentences = body
    .match(/[^.!?]+[.!?]?/g)
    ?.map((part) => part.trim())
    .filter(Boolean) ?? [body];
  const visual = sentences.filter(
    (sentenceText) => !/^(Fighting style|Anime 2D|Style)\b/i.test(sentenceText),
  );
  const first = visual[0] ?? body;
  const wardrobe = visual.find((sentenceText) => /^Wardrobe:/i.test(sentenceText));
  const weapon = visual.find((sentenceText) => /^Weapon:/i.test(sentenceText));
  const summary = cleanReferenceSummary(
    [first, wardrobe, weapon]
      .filter((part, index, parts) => part && parts.indexOf(part) === index)
      .join(" "),
  );
  return clampWords(summary.replace(/[.!?]+$/g, ""), 34);
}

export function composeModelReferenceLegend(
  references: ModelReferenceLegendInput[],
): string | null {
  const lines = references
    .map((reference) => {
      const summary = referenceSummaryForModel(reference);
      if (!summary) return null;
      return `${displayNameForReference(reference)}: ${summary}.`;
    })
    .filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join("\n") : null;
}

/** Hash for a node that is being written in the same operation (not yet in the graph). */
export function hashForNewKeyframe(url: string): string {
  return identityHash({
    kind: "keyframe",
    node: {
      id: "_",
      path: "_",
      status: "generated",
      url,
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
      body: "",
    },
  });
}
