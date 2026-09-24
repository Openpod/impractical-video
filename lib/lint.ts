import {
  type ClipNode,
  type GraphIssue,
  type KeyframeNode,
  type PromptNode,
  type SourceFile,
  type SourceGraph,
  buildSourceGraph,
  identityHash,
  lookupIdentityHash,
  orderedClips,
} from "@/lib/source-graph";
import {
  HIGH_SIMILARITY_HASH_DISTANCE,
  NEAR_DUPLICATE_HASH_DISTANCE,
  imageHashDistance,
  isHighSimilarityDistance,
  isNearDuplicateDistance,
} from "@/lib/image-similarity";
import {
  MAX_CONTINUOUS_CHAIN,
  type SceneState,
  sceneStateOrderSwaps,
} from "@/lib/generation-contract";

const MAX_CHARACTER_INJECTION_ATTEMPTS = 2;

/**
 * Deterministic linter over the source graph. This is where the production
 * method lives as law instead of prose:
 *
 *   identity-portfolio      recurring things need portfolio ground truth
 *   anchorless-keyframe     generated frames must be conditioned on anchors
 *   continuity-structural   "continuous" means a literally shared keyframe
 *   unpinned-chain          never chain continuity off an unenforced end
 *   stale                   dependents built against old identity hashes
 *
 * Severity: error = incoherent, fix before generating further.
 *           warning = suspicious, agent should resolve or justify.
 *           info = hygiene.
 */

export type LintIssue = GraphIssue;

export type LintResult = {
  ok: boolean;
  errorCount: number;
  warningCount: number;
  issues: LintIssue[];
};

const CUT_FAMILY = new Set([
  "cut",
  "time_jump",
  "camera_reset",
  "stylized_transition",
]);

const GENERATED_KEYFRAME_STATUSES = new Set(["generated", "approved"]);
const ACTIVE_CLIP_STATUSES = new Set(["active", "approved"]);
const RETIRED_STATUSES = new Set(["superseded", "rejected"]);
// Seedance 2.0 rewards 50-150 word prompts (subject, action, camera,
// lighting, style); the old 40/70 limits forced under-specified prompts that
// visibly degraded scenes. Flag only genuine bloat or emptiness.
const PROMPT_WORD_WARNING_LIMIT = 150;
const PROMPT_WORD_ERROR_LIMIT = 250;
const PROMPT_WORD_MIN_WARNING = 25;
const ACTION_CLIP_MAX_SECONDS = 5;
const ACTION_CLIP_MAX_BEATS = 2;
const PROMPT_BANNED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bStart frame\s*\(locked\)\b/i, label: "Start frame (locked)" },
  { pattern: /\bEnd frame\s*\(locked\)\b/i, label: "End frame (locked)" },
  { pattern: /\bDialogue contract\b/i, label: "Dialogue contract" },
  { pattern: /\bAccount for every change\b/i, label: "Account for every change" },
  { pattern: /\bEnd on\b/i, label: "End on" },
  { pattern: /\bSpeed\s*:/i, label: "Speed:" },
  {
    pattern: /\bKeep motion readable,\s*stable,\s*and continuous\b/i,
    label: "Keep motion readable, stable, and continuous",
  },
  { pattern: /\bultra-fast\b/i, label: "ultra-fast" },
  { pattern: /\bfast-paced\b/i, label: "fast-paced" },
  { pattern: /\bfrenetic\b/i, label: "frenetic" },
];

function formatDistance(value: number): string {
  return value.toFixed(3);
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function promptPlanString(
  promptPlan: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = promptPlan?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function promptPlanStrings(
  promptPlan: Record<string, unknown> | null,
  key: string,
): string[] {
  const value = promptPlan?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function clipIsExplicitHold(clip: ClipNode): boolean {
  const text = [
    promptPlanString(clip.promptPlan, "action_intent"),
    ...promptPlanStrings(clip.promptPlan, "action_beats"),
  ]
    .filter(Boolean)
    .join(" ");
  return /\b(hold|held|pause|reaction|still|static|standoff|faceoff|tableau|slow burn|breathes?|waits?)\b/i.test(
    text,
  );
}

function cameraNoteSuggestsSecondMove(note: string): boolean {
  return /\b(while|and)\b[^.]*\b(pan(?:s|ning)?|push(?:es|ing)? in|pull(?:s|ing)? out|doll(?:y|ies|ying)|track(?:s|ing)?|orbit(?:s|ing)?|tilt(?:s|ing)?|zoom(?:s|ing)?|crane(?:s|ing)?)\b/i.test(
    note,
  );
}

function clipLooksLikeAction(clip: ClipNode): boolean {
  const motionRate = promptPlanString(clip.promptPlan, "motion_rate");
  if (motionRate === "accelerated" || motionRate === "frenetic") return true;
  const beats = promptPlanStrings(clip.promptPlan, "action_beats").join(" ");
  return /\b(fight|combat|duel|chase|race|dance|run|runs|running|sprint|sprints|leap|leaps|lunge|lunges|strike|strikes|slash|slashes|cut|cuts|parry|parries|clash|collide|impact|explosion|explode|attack|attacks|kick|punch|dodge|pursue|escape)\b/i.test(
    beats,
  );
}

function propOwnerChanges(a: SceneState, b: SceneState): string[] {
  const owners = new Map(
    a.props.map((prop) => [prop.id, prop.owner?.trim() || null]),
  );
  const changed: string[] = [];
  for (const prop of b.props) {
    if (!owners.has(prop.id)) continue;
    const fromOwner = owners.get(prop.id) ?? null;
    const toOwner = prop.owner?.trim() || null;
    if (fromOwner !== toOwner) {
      changed.push(`${prop.id}: ${fromOwner ?? "unattended"}->${toOwner ?? "unattended"}`);
    }
  }
  return changed.sort();
}

function setAnchorChanges(a: SceneState, b: SceneState): string[] {
  const before = new Map(a.set_anchors.map((anchor) => [anchor.id, anchor.location]));
  const after = new Map(b.set_anchors.map((anchor) => [anchor.id, anchor.location]));
  const changes: string[] = [];
  for (const [id, location] of before) {
    const next = after.get(id);
    if (next === undefined) {
      changes.push(`${id}: vanished`);
    } else if (next !== location) {
      changes.push(`${id}: ${location}->${next}`);
    }
  }
  for (const id of after.keys()) {
    if (!before.has(id)) changes.push(`${id}: appeared`);
  }
  return changes.sort();
}

function visibleCharacterIds(keyframe: KeyframeNode, graph: SourceGraph): string[] {
  const fromSceneState = keyframe.sceneState?.characters
    .filter((character) => character.screen_position !== "offscreen")
    .map((character) => character.id);
  const candidates = fromSceneState?.length ? fromSceneState : keyframe.depicts;
  return [...new Set(candidates)].filter(
    (id) => graph.references.get(id)?.category === "characters",
  );
}

export function lintSourceGraph(graph: SourceGraph): LintResult {
  const issues: LintIssue[] = [...graph.parseIssues];
  const push = (
    level: LintIssue["level"],
    rule: string,
    node: { path: string; id: string } | null,
    message: string,
  ) => {
    issues.push({
      level,
      rule,
      path: node?.path ?? null,
      nodeId: node?.id ?? null,
      message,
    });
  };

  const nodeExists = (id: string) => graph.nodePathById.has(id);

  /** identity_anchors accept a portfolio id or a reference id (resolved to its portfolio). */
  const resolveAnchorPortfolio = (anchorId: string) =>
    graph.portfolios.get(anchorId) ??
    graph.portfolioByReference.get(anchorId) ??
    null;

  // --- Edge resolution -----------------------------------------------------

  for (const portfolio of graph.portfolios.values()) {
    if (!portfolio.referenceId) {
      push("error", "missing-ref", portfolio, "Portfolio has no reference_id.");
    } else if (!graph.references.has(portfolio.referenceId)) {
      push(
        "error",
        "missing-ref",
        portfolio,
        `Portfolio reference_id "${portfolio.referenceId}" does not exist.`,
      );
    }
  }

  for (const keyframe of graph.keyframes.values()) {
    for (const referenceId of keyframe.depicts) {
      if (!graph.references.has(referenceId)) {
        push(
          "error",
          "missing-ref",
          keyframe,
          `Keyframe depicts missing reference "${referenceId}".`,
        );
      }
    }
    for (const anchorId of keyframe.identityAnchors) {
      if (!resolveAnchorPortfolio(anchorId)) {
        push(
          "error",
          "missing-ref",
          keyframe,
          `Keyframe identity anchor "${anchorId}" resolves to no portfolio.`,
        );
      }
    }
    if (keyframe.stateAnchor && !graph.keyframes.has(keyframe.stateAnchor)) {
      push(
        "error",
        "missing-ref",
        keyframe,
        `Keyframe state_anchor "${keyframe.stateAnchor}" does not exist.`,
      );
    }
    if (keyframe.capturedFrom && !graph.clips.has(keyframe.capturedFrom)) {
      push(
        "error",
        "missing-ref",
        keyframe,
        `Keyframe captured_from clip "${keyframe.capturedFrom}" does not exist.`,
      );
    }
  }

  for (const clip of graph.clips.values()) {
    if (clip.sceneId && !graph.scenes.has(clip.sceneId)) {
      push(
        "error",
        "missing-ref",
        clip,
        `Clip scene "${clip.sceneId}" does not exist.`,
      );
    }
    for (const keyframeId of [clip.fromKeyframe, clip.toKeyframe]) {
      if (keyframeId && !graph.keyframes.has(keyframeId)) {
        push(
          "error",
          "missing-ref",
          clip,
          `Clip references missing keyframe "${keyframeId}".`,
        );
      }
    }
    // Identical start/end frame = no motion; the clip will look static. The
    // subtler "too similar" case is caught by the keyframe-pair self-review.
    if (
      clip.fromKeyframe &&
      clip.toKeyframe &&
      clip.fromKeyframe === clip.toKeyframe
    ) {
      push(
        "warning",
        "static-clip",
        clip,
        `Clip "${clip.id}" has the same keyframe as start and end (${clip.fromKeyframe}); it will have no motion. Give it a distinct end frame, or use a single-frame clip intentionally.`,
      );
    }
    // Aspect must agree across a clip and its endpoint keyframes; a mismatch
    // makes the video reframe (crop/stretch) the keyframe.
    if (clip.aspectRatio) {
      for (const keyframeId of [clip.fromKeyframe, clip.toKeyframe]) {
        const keyframe = keyframeId ? graph.keyframes.get(keyframeId) : undefined;
        if (
          keyframe?.aspectRatio &&
          keyframe.aspectRatio !== clip.aspectRatio
        ) {
          push(
            "error",
            "aspect-mismatch",
            clip,
            `Clip "${clip.id}" is ${clip.aspectRatio} but keyframe "${keyframe.id}" is ${keyframe.aspectRatio}; the video will crop/stretch the frame. Generate the keyframe and clip at the same aspect ratio.`,
          );
        }
      }
    }
  }

  // --- Perceptual similarity over generated keyframe pairs ------------------

  for (const clip of graph.clips.values()) {
    if (RETIRED_STATUSES.has(clip.status)) continue;
    if (!clip.fromKeyframe || !clip.toKeyframe) continue;
    if (clip.fromKeyframe === clip.toKeyframe) continue;
    const from = graph.keyframes.get(clip.fromKeyframe);
    const to = graph.keyframes.get(clip.toKeyframe);
    if (!from?.imagePhash || !to?.imagePhash) continue;
    const distance = imageHashDistance(from.imagePhash, to.imagePhash);
    if (isNearDuplicateDistance(distance)) {
      const level =
        clipLooksLikeAction(clip) && !clipIsExplicitHold(clip)
          ? "error"
          : "warning";
      push(
        level,
        "keyframe-image-similarity",
        clip,
        `Clip "${clip.id}" endpoint keyframes "${from.id}" and "${to.id}" are near-duplicate images (pHash distance ${formatDistance(distance)} <= ${NEAR_DUPLICATE_HASH_DISTANCE}). Regenerate the end keyframe with a clearer visual delta, or mark the clip as an intentional hold.`,
      );
    } else if (isHighSimilarityDistance(distance)) {
      push(
        "warning",
        "keyframe-image-similarity",
        clip,
        `Clip "${clip.id}" endpoint keyframes "${from.id}" and "${to.id}" are highly similar (pHash distance ${formatDistance(distance)} <= ${HIGH_SIMILARITY_HASH_DISTANCE}). Confirm the pair has enough visible delta for first/last-frame video.`,
      );
    }
  }

  for (const scene of graph.scenes.values()) {
    for (const referenceId of scene.references) {
      if (!graph.references.has(referenceId)) {
        push(
          "error",
          "missing-ref",
          scene,
          `Scene references missing reference "${referenceId}".`,
        );
      }
    }
  }

  for (const entry of graph.timeline) {
    if (entry.clipId && !graph.clips.has(entry.clipId)) {
      issues.push({
        level: "error",
        rule: "timeline-missing-clip",
        path: "timeline.json",
        nodeId: entry.id,
        message: `Timeline entry "${entry.id}" references missing clip "${entry.clipId}".`,
      });
    }
  }

  // --- Identity rule: recurring things need portfolios ----------------------

  const keyframesByReference = new Map<string, KeyframeNode[]>();
  for (const keyframe of graph.keyframes.values()) {
    for (const referenceId of keyframe.depicts) {
      const list = keyframesByReference.get(referenceId) ?? [];
      list.push(keyframe);
      keyframesByReference.set(referenceId, list);
    }
  }

  for (const reference of graph.references.values()) {
    if (RETIRED_STATUSES.has(reference.status)) continue;
    const dependents = keyframesByReference.get(reference.id) ?? [];
    if (dependents.length === 0) continue;
    const portfolio = graph.portfolioByReference.get(reference.id);
    const portfolioReady =
      portfolio &&
      ["generated", "approved"].includes(portfolio.status) &&
      portfolio.urls.length > 0;
    if (portfolioReady) continue;

    const generatedDependents = dependents.filter((keyframe) =>
      GENERATED_KEYFRAME_STATUSES.has(keyframe.status),
    );
    const isStyle = reference.category === "styles";
    if (generatedDependents.length > 0) {
      push(
        isStyle ? "warning" : "error",
        "identity-portfolio",
        reference,
        `Reference "${reference.id}" has generated keyframes but no usable portfolio (need status generated/approved with at least one url).`,
      );
    } else if (dependents.length >= 2) {
      push(
        isStyle ? "info" : "warning",
        "identity-portfolio",
        reference,
        `Reference "${reference.id}" recurs across ${dependents.length} planned keyframes; it needs a portfolio before generation.`,
      );
    }
  }

  // --- Anchor rule: generated frames must be conditioned --------------------

  for (const keyframe of graph.keyframes.values()) {
    if (!GENERATED_KEYFRAME_STATUSES.has(keyframe.status)) continue;
    if (keyframe.capturedFrom) continue; // captured frames get pixels from a clip
    if (keyframe.depicts.length > 0 && keyframe.identityAnchors.length === 0) {
      push(
        "error",
        "anchorless-keyframe",
        keyframe,
        `Generated keyframe "${keyframe.id}" depicts [${keyframe.depicts.join(", ")}] but lists no identity_anchors; its pixels cannot honor the references.`,
      );
    }
  }

  for (const keyframe of graph.keyframes.values()) {
    if (
      GENERATED_KEYFRAME_STATUSES.has(keyframe.status) &&
      keyframe.url === null
    ) {
      push(
        "error",
        "missing-media",
        keyframe,
        `Keyframe "${keyframe.id}" has status "${keyframe.status}" but no url.`,
      );
    }
  }

  // --- Identity-bound keyframe composition ---------------------------------
  // Papers that solve character drift do not pass many competing identities in
  // one reference soup. They bind one identity per generation/edit step, then
  // verify the result. For generated multi-character keyframes, require that
  // this sequential-injection contract is recorded before clips can proceed.
  for (const keyframe of graph.keyframes.values()) {
    if (!GENERATED_KEYFRAME_STATUSES.has(keyframe.status)) continue;
    const characters = visibleCharacterIds(keyframe, graph);
    if (characters.length < 2) continue;
    if (keyframe.composition?.mode !== "sequential_injection") {
      // Sequential-injection mandate DISABLED (2026-08-01, cost experiment):
      // direct multi-character generation with all references passed at once
      // is allowed while we evaluate quality vs the N+1-generation cost.
      // Keyframes that DO record sequential composition still get their
      // records validated below. To re-enable, restore this error:
      //   push("error", "multi-character-direct-generation", keyframe, ...);
      continue;
    }
    const injected = new Set(keyframe.composition.injected_references ?? []);
    const verificationStatus = new Map(
      (keyframe.composition.identity_verifications ?? []).map((verification) => [
        verification.reference_id,
        verification.status,
      ]),
    );
    const attempts = new Map(
      (keyframe.composition.injection_attempts ?? []).map((attempt) => [
        attempt.reference_id,
        attempt.attempts,
      ]),
    );
    for (const characterId of characters) {
      if (!injected.has(characterId)) {
        push(
          "error",
          "composition-missing-injection",
          keyframe,
          `Generated keyframe "${keyframe.id}" is sequentially composed but does not list character "${characterId}" in composition.injected_references.`,
        );
      }
      const status = verificationStatus.get(characterId);
      const attemptCount = attempts.get(characterId) ?? 0;
      if (attemptCount >= MAX_CHARACTER_INJECTION_ATTEMPTS && status !== "passed") {
        push(
          "error",
          "identity-injection-attempt-cap",
          keyframe,
          `Keyframe "${keyframe.id}" has exhausted ${attemptCount} identity-injection attempts for visible character "${characterId}". Do not retry this same frame; simplify the staging, isolate the character, or convert the beat to a cut/new keyframe setup.`,
        );
      }
      if (status !== "passed") {
        push(
          "error",
          "identity-verification-required",
          keyframe,
          `Generated keyframe "${keyframe.id}" needs a passed identity verification for visible character "${characterId}" before clips. Verify exactly one instance matches the portfolio, or regenerate that injection.`,
        );
      }
    }
  }

  // --- Continuous state_anchor chain cap ------------------------------------

  const chainDepthByKeyframe = new Map<string, number>();
  const visitingKeyframes = new Set<string>();
  const continuousChainDepth = (keyframe: KeyframeNode): number => {
    const cached = chainDepthByKeyframe.get(keyframe.id);
    if (cached !== undefined) return cached;
    if (!keyframe.stateAnchor) {
      chainDepthByKeyframe.set(keyframe.id, 1);
      return 1;
    }
    if (visitingKeyframes.has(keyframe.id)) {
      chainDepthByKeyframe.set(keyframe.id, MAX_CONTINUOUS_CHAIN + 1);
      return MAX_CONTINUOUS_CHAIN + 1;
    }
    const anchor = graph.keyframes.get(keyframe.stateAnchor);
    if (!anchor) {
      chainDepthByKeyframe.set(keyframe.id, 1);
      return 1;
    }
    visitingKeyframes.add(keyframe.id);
    const depth = continuousChainDepth(anchor) + 1;
    visitingKeyframes.delete(keyframe.id);
    chainDepthByKeyframe.set(keyframe.id, depth);
    return depth;
  };

  for (const keyframe of graph.keyframes.values()) {
    if (RETIRED_STATUSES.has(keyframe.status)) continue;
    const depth = continuousChainDepth(keyframe);
    if (depth <= MAX_CONTINUOUS_CHAIN) continue;
    push(
      "error",
      "continuous-chain-cap",
      keyframe,
      `Keyframe "${keyframe.id}" extends a continuous state_anchor chain to ${depth} keyframes. Insert a cut/recompose keyframe (omit state_anchor) before exceeding ${MAX_CONTINUOUS_CHAIN}; long action chains drift in image generation.`,
    );
  }

  // --- scene_state: declarative state diff across a continuous pair ----------
  // frame_delta is pairwise/reactive; scene_state is the declarative snapshot the
  // lint can diff deterministically. The high-signal, low-false-positive check is
  // a left/right ORDER SWAP across a continuous pair — two subjects crossing
  // horizontal order in one interpolation is the state signature of a 180°/screen
  // -direction break (encodes the screen_direction_geography rubric at state level).
  for (const keyframe of graph.keyframes.values()) {
    if (RETIRED_STATUSES.has(keyframe.status)) continue;
    if (!keyframe.sceneState) continue;
    // Unknown-entity guard: state ids should be things the frame actually depicts.
    const depicted = new Set(keyframe.depicts);
    if (depicted.size > 0) {
      const strays = [
        ...keyframe.sceneState.characters.map((c) => c.id),
        ...keyframe.sceneState.props.map((p) => p.id),
      ].filter((id) => !depicted.has(id));
      if (strays.length) {
        push(
          "warning",
          "scene-state-unknown-entity",
          keyframe,
          `Keyframe "${keyframe.id}" scene_state references ${strays
            .map((s) => `"${s}"`)
            .join(", ")} not in depicts; align state ids with the frame's reference ids.`,
        );
      }
    }
    // Order-swap guard only applies within a continuous chain (state_anchor set);
    // a cut is allowed to recompose horizontal order.
    if (!keyframe.stateAnchor) continue;
    const anchor = graph.keyframes.get(keyframe.stateAnchor);
    if (!anchor?.sceneState) continue;
    const swaps = sceneStateOrderSwaps(anchor.sceneState, keyframe.sceneState);
    if (swaps.length) {
      push(
        "error",
        "scene-state-order-swap",
        keyframe,
        `Keyframe "${keyframe.id}" swaps left/right screen order vs continuous anchor "${anchor.id}" (${swaps.join(
          ", ",
        )}). Two subjects cannot cross horizontal order in one interpolation — make this a cut (omit state_anchor) or add a traversable pass keyframe.`,
      );
    }
    const ownerChanges = propOwnerChanges(anchor.sceneState, keyframe.sceneState);
    if (ownerChanges.length) {
      push(
        "error",
        "scene-state-prop-owner-change",
        keyframe,
        `Keyframe "${keyframe.id}" changes prop ownership vs continuous anchor "${anchor.id}" (${ownerChanges.join(
          ", ",
        )}). Prop transfers are hard relational beats — cut around the transfer, or add explicit handoff/grab keyframes instead of one interpolation.`,
      );
    }
    const anchorChanges = setAnchorChanges(anchor.sceneState, keyframe.sceneState);
    if (anchorChanges.length) {
      push(
        "error",
        "scene-state-set-anchor-change",
        keyframe,
        `Keyframe "${keyframe.id}" changes declared set anchors vs continuous anchor "${anchor.id}" (${anchorChanges.join(
          ", ",
        )}). A continuous pair must keep major set pieces stable; use a cut/camera reset for location or set-piece changes.`,
      );
    }
  }

  // --- Continuity rules over adjacent clips ---------------------------------

  const sequence = orderedClips(graph).filter(
    (clip) => !RETIRED_STATUSES.has(clip.status),
  );
  for (let i = 1; i < sequence.length; i += 1) {
    const previous = sequence[i - 1];
    const current = sequence[i];
    const transition = current.transitionFromPrevious;
    const sharesNode =
      Boolean(current.fromKeyframe) &&
      current.fromKeyframe === previous.toKeyframe;

    if (!transition) {
      push(
        "warning",
        "missing-transition",
        current,
        `Clip "${current.id}" follows "${previous.id}" but declares no transition_from_previous.`,
      );
      continue;
    }

    if (transition === "continuous") {
      if (!sharesNode) {
        push(
          "error",
          "continuity-structural",
          current,
          `Clip "${current.id}" is declared continuous with "${previous.id}" but they do not share a keyframe node (${previous.id}.to_keyframe=${previous.toKeyframe ?? "null"}, ${current.id}.from_keyframe=${current.fromKeyframe ?? "null"}). A continuous shot means one shared node.`,
        );
      } else if (previous.endTrust === "unknown" && previous.url) {
        // Only enforce once the previous clip is actually rendered; a planned
        // chain is aspirational and already covered by structural sharing.
        push(
          "error",
          "unpinned-chain",
          current,
          `Clip "${current.id}" continues from "${previous.id}" whose end is not enforced (end_trust=unknown). Pin the end via first/last-frame generation or capture the actual final frame first.`,
        );
      } else if (previous.endTrust === "captured") {
        const sharedKeyframe = current.fromKeyframe
          ? graph.keyframes.get(current.fromKeyframe)
          : undefined;
        if (
          sharedKeyframe &&
          (sharedKeyframe.status !== "captured" ||
            sharedKeyframe.capturedFrom !== previous.id)
        ) {
          push(
            "warning",
            "unpinned-chain",
            current,
            `Clip "${previous.id}" claims a captured end but shared keyframe "${sharedKeyframe.id}" is not a frame captured from it.`,
          );
        }
      }
    } else if (CUT_FAMILY.has(transition)) {
      if (sharesNode) {
        push(
          "warning",
          "continuity-contradiction",
          current,
          `Clip "${current.id}" declares "${transition}" from "${previous.id}" but shares its keyframe node — that is structurally a continuous shot.`,
        );
      }
      // Conditioning on the prior frame across a hard cut defeats the cut.
      if (transition !== "stylized_transition") {
        const fromKeyframe = current.fromKeyframe
          ? graph.keyframes.get(current.fromKeyframe)
          : undefined;
        if (
          fromKeyframe?.stateAnchor &&
          fromKeyframe.stateAnchor === previous.toKeyframe &&
          transition !== "hard_cut_same_assets"
        ) {
          push(
            "warning",
            "anchor-across-cut",
            fromKeyframe,
            `Keyframe "${fromKeyframe.id}" opens a declared ${transition} but was conditioned on the previous frame ("${fromKeyframe.stateAnchor}"); the image model will copy composition across the cut.`,
          );
        }
      }
    }
  }

  // --- Staleness (Make-style) ------------------------------------------------

  const staleNodeIds = new Set<string>();
  const checkBuiltAgainst = (node: KeyframeNode | ClipNode | PromptNode, label: string) => {
    for (const [depId, recordedHash] of Object.entries(node.builtAgainst)) {
      const currentHash = lookupIdentityHash(graph, depId);
      if (currentHash === null) {
        push(
          "error",
          "missing-ref",
          node,
          `${label} "${node.id}" was built against "${depId}" which no longer exists.`,
        );
        continue;
      }
      if (currentHash === recordedHash) continue;
      const waived = node.intentionallyUnchanged.some(
        (entry) => entry === depId || entry === `${depId}@${recordedHash}`,
      );
      if (waived) continue;
      staleNodeIds.add(node.id);
      push(
        "warning",
        "stale",
        node,
        `${label} "${node.id}" is stale: dependency "${depId}" changed since generation (recorded ${recordedHash}, now ${currentHash}). Regenerate, supersede, or mark intentionally_unchanged.`,
      );
    }
  };

  for (const keyframe of graph.keyframes.values()) {
    if (RETIRED_STATUSES.has(keyframe.status)) continue;
    checkBuiltAgainst(keyframe, "Keyframe");
  }
  for (const clip of graph.clips.values()) {
    if (RETIRED_STATUSES.has(clip.status)) continue;
    checkBuiltAgainst(clip, "Clip");
  }
  for (const prompt of graph.prompts.values()) {
    if (RETIRED_STATUSES.has(prompt.status)) continue;
    checkBuiltAgainst(prompt, "Prompt");
  }

  // --- Planned prompt standards ----------------------------------------------

  for (const prompt of graph.prompts.values()) {
    if (RETIRED_STATUSES.has(prompt.status)) continue;
    const words = wordCount(prompt.body);
    const banned = PROMPT_BANNED_PATTERNS.find(({ pattern }) =>
      pattern.test(prompt.body),
    );
    if (banned) {
      push(
        "error",
        "prompt-content",
        prompt,
        `Prompt "${prompt.id}" contains banned model-facing prompt text "${banned.label}". Replan or edit it into compact visual prose before generating.`,
      );
    }
    if (words > PROMPT_WORD_ERROR_LIMIT) {
      push(
        "error",
        "prompt-length",
        prompt,
        `Prompt "${prompt.id}" is ${words} words; Seedance prompts work best at 50-150 words — cut repetition, keep subject, action, camera, lighting, style.`,
      );
    } else if (words > PROMPT_WORD_WARNING_LIMIT) {
      push(
        "warning",
        "prompt-length",
        prompt,
        `Prompt "${prompt.id}" is ${words} words; the Seedance sweet spot is 50-150 — trim without losing camera or lighting language.`,
      );
    } else if (words < PROMPT_WORD_MIN_WARNING) {
      push(
        "warning",
        "prompt-length",
        prompt,
        `Prompt "${prompt.id}" is only ${words} words; under-specified Seedance prompts drift — state subject, action, camera, and lighting.`,
      );
    }
  }

  for (const clip of graph.clips.values()) {
    if (RETIRED_STATUSES.has(clip.status)) continue;
    const cameraNote = promptPlanString(clip.promptPlan, "camera_note");
    if (cameraNote && cameraNoteSuggestsSecondMove(cameraNote)) {
      push(
        "warning",
        "camera-note",
        clip,
        `Clip "${clip.id}" camera_note appears to add a second camera move ("${cameraNote}"). Keep camera_move to one move and use camera_note only for speed, distance, or direction.`,
      );
    }
    if (clipLooksLikeAction(clip)) {
      const beats = promptPlanStrings(clip.promptPlan, "action_beats");
      if (beats.length > ACTION_CLIP_MAX_BEATS) {
        push(
          "error",
          "action-clip-density",
          clip,
          `Action clip "${clip.id}" has ${beats.length} action beats. Use at most ${ACTION_CLIP_MAX_BEATS} clear interpolable beat(s) per image-to-video clip; add more keyframes/clips for complex motion.`,
        );
      }
      if (
        clip.durationSeconds !== null &&
        clip.durationSeconds > ACTION_CLIP_MAX_SECONDS
      ) {
        push(
          "error",
          "action-clip-duration",
          clip,
          `Action clip "${clip.id}" is ${clip.durationSeconds}s. Keep action image-to-video spans at ${ACTION_CLIP_MAX_SECONDS}s or less; add denser keyframes instead of stretching one pair.`,
        );
      }
    }
  }

  // Transitive: clips whose endpoint keyframes are stale.
  for (const clip of graph.clips.values()) {
    if (RETIRED_STATUSES.has(clip.status) || staleNodeIds.has(clip.id)) {
      continue;
    }
    const staleEndpoint = [clip.fromKeyframe, clip.toKeyframe].find(
      (id) => id && staleNodeIds.has(id),
    );
    if (staleEndpoint) {
      push(
        "info",
        "stale-transitive",
        clip,
        `Clip "${clip.id}" depends on stale keyframe "${staleEndpoint}".`,
      );
    }
  }

  // --- Dialogue speakers --------------------------------------------------------

  for (const clip of graph.clips.values()) {
    if (RETIRED_STATUSES.has(clip.status)) continue;
    if (clip.dialogueLines.length === 0) continue;
    const scene = clip.sceneId ? graph.scenes.get(clip.sceneId) : undefined;
    for (const speaker of new Set(clip.dialogueLines.map((line) => line.speaker))) {
      const reference = graph.references.get(speaker);
      if (!reference) {
        push(
          "error",
          "dialogue-speaker",
          clip,
          `Clip "${clip.id}" dialogue speaker "${speaker}" is not a reference id. Speakers must be characters references so the voice module can resolve speaker -> reference -> voice_id.`,
        );
        continue;
      }
      if (reference.category !== "characters") {
        push(
          "warning",
          "dialogue-speaker",
          clip,
          `Clip "${clip.id}" dialogue speaker "${speaker}" is a ${reference.category ?? "uncategorized"} reference; speaking roles (including narrators) should be characters references.`,
        );
      }
      if (scene && !scene.references.includes(speaker)) {
        push(
          "warning",
          "dialogue-speaker",
          clip,
          `Clip "${clip.id}" speaker "${speaker}" is not in scene "${scene.id}" references — fine for off-screen lines, otherwise add it to the scene.`,
        );
      }
    }
  }

  // --- Clip duration contract ------------------------------------------------

  for (const clip of graph.clips.values()) {
    if (RETIRED_STATUSES.has(clip.status)) continue;
    if (
      clip.durationSeconds !== null &&
      clip.generatedSeconds !== null &&
      clip.durationSeconds !== clip.generatedSeconds
    ) {
      push(
        "error",
        "clip-duration",
        clip,
        `Clip "${clip.id}" has duration_seconds ${clip.durationSeconds}s but generated_seconds ${clip.generatedSeconds}s. These must match unless the user explicitly requested a trim workflow.`,
      );
    }
  }

  // --- Dialogue timing --------------------------------------------------------

  for (const clip of graph.clips.values()) {
    if (RETIRED_STATUSES.has(clip.status)) continue;
    if (clip.dialogueLines.length === 0) continue;
    if (
      clip.dialogueMode === "no_audible_speech" ||
      clip.dialogueMode === "nonverbal_only"
    ) {
      push(
        "warning",
        "dialogue-timing",
        clip,
        `Clip "${clip.id}" declares dialogue mode "${clip.dialogueMode}" but lists ${clip.dialogueLines.length} spoken line(s).`,
      );
    }
    // Overlap detection needs chronological order; authored order is not
    // guaranteed (unsorted-but-valid lines must not warn spuriously).
    const chronological = [...clip.dialogueLines].sort(
      (a, b) => (a.startS ?? Number.MAX_VALUE) - (b.startS ?? Number.MAX_VALUE),
    );
    let previousEnd = 0;
    for (const line of chronological) {
      if (line.startS === null || line.endS === null) {
        push(
          "error",
          "dialogue-timing",
          clip,
          `Clip "${clip.id}" dialogue line for ${line.speaker} is missing start_s/end_s.`,
        );
        continue;
      }
      if (line.startS >= line.endS) {
        push(
          "error",
          "dialogue-timing",
          clip,
          `Clip "${clip.id}" dialogue line for ${line.speaker} has start_s ${line.startS} >= end_s ${line.endS}.`,
        );
      }
      if (clip.durationSeconds !== null && line.endS > clip.durationSeconds) {
        push(
          "error",
          "dialogue-timing",
          clip,
          `Clip "${clip.id}" dialogue line for ${line.speaker} ends at ${line.endS}s but the clip is ${clip.durationSeconds}s.`,
        );
      }
      if (line.startS < previousEnd) {
        push(
          "warning",
          "dialogue-timing",
          clip,
          `Clip "${clip.id}" dialogue lines overlap around ${line.startS}s.`,
        );
      }
      previousEnd = Math.max(previousEnd, line.endS ?? 0);
    }
  }

  // --- Retired nodes still referenced ---------------------------------------

  const referenceEdges: Array<{
    from: { path: string; id: string; status: string };
    to: string;
  }> = [];
  for (const keyframe of graph.keyframes.values()) {
    for (const target of [
      ...keyframe.depicts,
      ...keyframe.identityAnchors,
      keyframe.stateAnchor,
    ]) {
      if (target) referenceEdges.push({ from: keyframe, to: target });
    }
  }
  for (const clip of graph.clips.values()) {
    for (const target of [clip.fromKeyframe, clip.toKeyframe]) {
      if (target) referenceEdges.push({ from: clip, to: target });
    }
  }
  for (const edge of referenceEdges) {
    if (RETIRED_STATUSES.has(edge.from.status)) continue;
    const targetStatus =
      graph.references.get(edge.to)?.status ??
      graph.portfolios.get(edge.to)?.status ??
      graph.portfolioByReference.get(edge.to)?.status ??
      graph.keyframes.get(edge.to)?.status ??
      graph.clips.get(edge.to)?.status;
    if (targetStatus && RETIRED_STATUSES.has(targetStatus)) {
      push(
        "error",
        "superseded-referenced",
        edge.from,
        `Active node "${edge.from.id}" references retired node "${edge.to}" (status ${targetStatus}).`,
      );
    }
  }

  // --- Timeline hygiene -------------------------------------------------------

  const timelineClipIds = new Set(
    graph.timeline.map((entry) => entry.clipId).filter(Boolean),
  );
  for (const entry of graph.timeline) {
    const clip = entry.clipId ? graph.clips.get(entry.clipId) : undefined;
    if (clip && !ACTIVE_CLIP_STATUSES.has(clip.status)) {
      issues.push({
        level: "error",
        rule: "inactive-on-timeline",
        path: "timeline.json",
        nodeId: entry.id,
        message: `Timeline includes clip "${clip.id}" with status "${clip.status}".`,
      });
    }
  }
  for (const clip of graph.clips.values()) {
    if (
      ACTIVE_CLIP_STATUSES.has(clip.status) &&
      clip.url &&
      !timelineClipIds.has(clip.id)
    ) {
      push(
        "warning",
        "clip-off-timeline",
        clip,
        `Active clip "${clip.id}" is not on the timeline.`,
      );
    }
  }

  // --- Orphans ------------------------------------------------------------------

  const usedKeyframeIds = new Set<string>();
  for (const clip of graph.clips.values()) {
    if (clip.fromKeyframe) usedKeyframeIds.add(clip.fromKeyframe);
    if (clip.toKeyframe) usedKeyframeIds.add(clip.toKeyframe);
  }
  for (const keyframe of graph.keyframes.values()) {
    if (keyframe.stateAnchor) usedKeyframeIds.add(keyframe.stateAnchor);
  }
  for (const keyframe of graph.keyframes.values()) {
    if (RETIRED_STATUSES.has(keyframe.status)) continue;
    if (!usedKeyframeIds.has(keyframe.id)) {
      push(
        "info",
        "orphan-keyframe",
        keyframe,
        `Keyframe "${keyframe.id}" is not used by any clip or as a state anchor.`,
      );
    }
  }

  // --- Findings (keyframe self-review records) --------------------------------

  for (const finding of graph.findings.values()) {
    for (const target of finding.implicates) {
      if (!graph.nodePathById.has(target)) {
        push(
          "error",
          "finding-target",
          finding,
          `Finding "${finding.id}" implicates "${target}", which does not exist.`,
        );
      }
    }
    if (finding.status === "open") {
      const unresolved =
        finding.severity === "blocker" ? "error" : finding.severity === "issue" ? "warning" : "info";
      push(
        unresolved,
        "finding-open",
        finding,
        `Open finding "${finding.id}" [${finding.severity}]: ${finding.summary} — present to the user and accept or dismiss it.`,
      );
    }
  }

  // --- Pacing report (measurement, not taste) ---------------------------------
  // Facts the cuts/prose-storyboard skills need to judge rhythm: shot count,
  // durations, transition mix, size variety, longest same-size/continuous runs.

  if (sequence.length >= 2) {
    const knownDurations = sequence
      .map((clip) => clip.durationSeconds)
      .filter((duration): duration is number => duration !== null);
    const meanDuration = knownDurations.length
      ? knownDurations.reduce((acc, d) => acc + d, 0) / knownDurations.length
      : null;
    const transitionCounts = new Map<string, number>();
    for (let i = 1; i < sequence.length; i += 1) {
      const transition = sequence[i].transitionFromPrevious ?? "undeclared";
      transitionCounts.set(transition, (transitionCounts.get(transition) ?? 0) + 1);
    }
    const sizeCounts = new Map<string, number>();
    for (const clip of sequence) {
      const size = clip.shotSize ?? "unset";
      sizeCounts.set(size, (sizeCounts.get(size) ?? 0) + 1);
    }
    let longestSameSizeRun = 1;
    let run = 1;
    for (let i = 1; i < sequence.length; i += 1) {
      run = sequence[i].shotSize === sequence[i - 1].shotSize ? run + 1 : 1;
      longestSameSizeRun = Math.max(longestSameSizeRun, run);
    }
    let longestContinuousChain = 1;
    let chain = 1;
    for (let i = 1; i < sequence.length; i += 1) {
      chain =
        sequence[i].transitionFromPrevious === "continuous" &&
        sequence[i].fromKeyframe === sequence[i - 1].toKeyframe
          ? chain + 1
          : 1;
      longestContinuousChain = Math.max(longestContinuousChain, chain);
    }
    const motivated = sequence.filter((clip) => clip.cutMotivation?.trim()).length;
    // Surface uniform durations as a fact (not a rule): vary length to the beat.
    const uniformDuration =
      knownDurations.length >= 4 && new Set(knownDurations).size === 1;
    // Tight/detail shots (CU/MCU/ECU) held long: details usually cut fast.
    const longTightShots = sequence.filter(
      (clip) =>
        clip.durationSeconds !== null &&
        clip.durationSeconds >= 3 &&
        ["MCU", "CU", "ECU"].includes(clip.shotSize ?? ""),
    );
    const fmt = (map: Map<string, number>) =>
      [...map.entries()].map(([key, count]) => `${count} ${key}`).join(", ");
    push(
      "info",
      "pacing",
      null,
      `Pacing: ${sequence.length} clips${meanDuration !== null ? `, mean ${meanDuration.toFixed(1)}s` : ""}; transitions: ${fmt(transitionCounts)}; shot sizes: ${fmt(sizeCounts)}; longest same-size run: ${longestSameSizeRun}; longest continuous chain: ${longestContinuousChain} clips; cut motivations named: ${motivated}/${sequence.length}.${uniformDuration ? ` All ${knownDurations.length} shots are ${knownDurations[0]}s — uniform durations flatten the emotional contour; consider varying length to match each beat.` : ""}${longTightShots.length ? ` Tight/detail shots held ≥3s: ${longTightShots.map((c) => c.id).join(", ")} — inserts/details usually cut by ~1.5s; shorten unless it's an emotional-peak close-up.` : ""}`,
    );
  }

  const errorCount = issues.filter((item) => item.level === "error").length;
  const warningCount = issues.filter((item) => item.level === "warning").length;
  return { ok: errorCount === 0, errorCount, warningCount, issues };
}

export function lintSourceFiles(files: SourceFile[]): LintResult {
  return lintSourceGraph(buildSourceGraph(files));
}
