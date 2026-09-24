export type KeyframeReviewSeverity = "blocker" | "issue" | "note";

export type KeyframeReviewRubricEntry = {
  id: string;
  category: "motion_delta" | "geometry" | "identity" | "continuity";
  severity: KeyframeReviewSeverity;
  inspect: string;
  whyItBreaksI2v: string;
  examples: string[];
  repair: string;
};

export const KEYFRAME_REVIEW_RUBRIC: KeyframeReviewRubricEntry[] = [
  {
    id: "meaningful_visual_delta",
    category: "motion_delta",
    severity: "blocker",
    inspect:
      "For any clip whose intent implies visible change, compare subject pose, subject position, object placement, camera perspective, and environment state.",
    whyItBreaksI2v:
      "First/last-frame video models can only animate the visible delta between the pinned frames; near-identical endpoints produce static or holding clips.",
    examples: [
      "guard stance -> same guard stance",
      "swords locked -> swords still locked with more sparks",
      "lightning strike in the same place -> same lightning shape slightly brighter",
    ],
    repair:
      "Regenerate the endpoint with a clear physical or environmental state change matched to the clip intent.",
  },
  {
    id: "fx_only_delta",
    category: "motion_delta",
    severity: "blocker",
    inspect:
      "Decide whether the pair differs only in texture, noise, glow, sparks, rain shape, lightning shape, facial intensity, blade angle, or other generated detail.",
    whyItBreaksI2v:
      "FX-only changes give the video model no body, object, camera, or environment motion to interpolate.",
    examples: [
      "same locked blades plus brighter sparks",
      "same sky with a rerendered lightning bolt",
      "same face and pose with slightly harsher expression",
    ],
    repair:
      "Change the underlying action state, not just surface effects: separation, impact aftermath, object movement, camera motion, or environment damage.",
  },
  {
    id: "camera_background_coherence",
    category: "geometry",
    severity: "blocker",
    inspect:
      "Estimate the camera move implied by subject facing, scale, and screen position; separately estimate the camera move implied by background perspective, vanishing lines, signage, and landmarks. They must agree.",
    whyItBreaksI2v:
      "If subjects imply an orbit/reverse angle but the background stays fixed, the model must rotate bodies inside a stationary world, causing smears, swaps, or teleporting.",
    examples: [
      "front-facing chase -> rear-facing chase while street signs and vanishing point remain fixed",
      "subject rotates 180 degrees but background perspective barely changes",
      "background swings to a new angle while character pose and lighting remain pasted in place",
    ],
    repair:
      "Regenerate one endpoint so subjects and background share one coherent camera path, or split the move across a cut/intermediate keyframe.",
  },
  {
    id: "uninterpolable_jump",
    category: "geometry",
    severity: "blocker",
    inspect:
      "Check whether pose, crop, framing, screen geography, camera placement, or action state changed too far for one clean interpolation.",
    whyItBreaksI2v:
      "Large multi-axis jumps ask the model to invent a cut inside a continuous morph, producing warps and body/object teleports.",
    examples: [
      "wide street chase -> tight alley grapple in one continuous pair",
      "standing guard -> airborne strike plus new camera angle plus new location",
      "fighter at frame-left -> fighter at frame-right with no traversable path",
    ],
    repair:
      "Insert one or more intermediate keyframes or make the transition a cut with a new shot setup.",
  },
  {
    id: "identity_portfolio_drift",
    category: "identity",
    severity: "blocker",
    inspect:
      "Compare each recurring character, object, location, and style against the supplied portfolio images and earlier keyframes.",
    whyItBreaksI2v:
      "Identity drift gives the video model conflicting anchors, so faces, bodies, costumes, and locations morph between frames.",
    examples: [
      "long-sleeve tactical outfit -> sleeveless muscular redesign",
      "grounded photoreal style -> comic-book anatomy",
      "same location changes architectural layout without a cut",
    ],
    repair:
      "Regenerate the drifting keyframe from the portfolio and previous state anchor, preserving identity/style while changing only the intended delta.",
  },
  {
    id: "prop_continuity",
    category: "continuity",
    severity: "issue",
    inspect:
      "Track visible carried props, weapons, tools, injuries, bags, and important set objects across the pair.",
    whyItBreaksI2v:
      "Props that appear or vanish without action create visible pop-in/out and can confuse identity and hand/body motion.",
    examples: [
      "visible sidearm holster disappears in the next frame",
      "weapon switches hands without a transfer beat",
      "bright crate appears in the same foreground with no motivation",
    ],
    repair:
      "Keep the prop visible and consistent, or add a keyframe/action beat that clearly removes, drops, or introduces it.",
  },
  {
    id: "screen_direction_geography",
    category: "geometry",
    severity: "blocker",
    inspect:
      "Check screen direction, the 180-degree line, relative placement, pursuit vectors, and landmark geography across consecutive frames.",
    whyItBreaksI2v:
      "Direction/geography breaks make the interpolation reverse motion or swap positions without a physical path.",
    examples: [
      "runner moving toward camera -> runner moving away without a coherent camera orbit",
      "pursuer behind-left -> suddenly ahead-right with no pass",
      "landmarks imply the camera is stationary while character vectors reverse",
    ],
    repair:
      "Preserve screen direction within the continuous shot, add an intermediate pass/turn keyframe, or make the change a cut.",
  },
  {
    id: "lighting_aspect_consistency",
    category: "continuity",
    severity: "issue",
    inspect:
      "Compare light direction, light intensity, lens feel, aspect ratio, and canvas crop unless the clip intent declares an environment or camera change.",
    whyItBreaksI2v:
      "Unmotivated lighting or aspect changes read as a cut and create morphing or flicker inside the generated clip.",
    examples: [
      "front-lit subject after a claimed camera orbit should become rim-lit or back-lit",
      "night alley becomes daylight with no environment-state transition",
      "16:9 frame paired with a 9:16 endpoint",
    ],
    repair:
      "Regenerate with consistent lighting/canvas, or explicitly split the lighting or format change into a separate transition.",
  },
  {
    id: "subject_readability",
    category: "identity",
    severity: "issue",
    inspect:
      "Verify each recurring subject remains distinguishable by stable visible traits, not just name or assumed story role.",
    whyItBreaksI2v:
      "If characters become indistinguishable silhouettes, the model can swap, merge, or lose who is performing the action.",
    examples: [
      "hero and pursuer become identical dark back-view silhouettes",
      "two fighters with similar costumes lose their distinct hair, wardrobe, or weapon cues",
      "named character appears only as an unreadable blur",
    ],
    repair:
      "Restore stable visible identity cues: silhouette, wardrobe color, weapon, hair, face angle, or spacing.",
  },
  {
    id: "scene_state_order_persistence",
    category: "geometry",
    severity: "blocker",
    inspect:
      "Across a continuous pair (no cut), confirm the recurring characters keep their left-to-right screen order and their general facing, and that carried props keep the same owner and rough on-screen location. Within a continuous shot, two named subjects must not trade left/right places, and a prop must not jump to another character or across the frame without a transfer/throw beat.",
    whyItBreaksI2v:
      "A first/last-frame model cannot cross two bodies through each other or teleport a prop in one near-linear interpolation; declared order/owner swaps force a hidden cut or a morph mid-clip.",
    examples: [
      "left fighter and right fighter swap sides within one continuous pair",
      "bag held by the thief in frame A is held by the victim in frame B with no grab beat",
      "subject faces camera-right, then camera-left, while the background says the camera did not move",
    ],
    repair:
      "Preserve left/right order and prop ownership within the continuous shot, or make the change a cut (recompose) or add an intermediate pass/transfer keyframe.",
  },
  {
    id: "crowd_extras_count_stability",
    category: "continuity",
    severity: "blocker",
    inspect:
      "Count the background crowd, extras, enemies, or vehicles in each frame. A large change in how many bodies or objects are present is not motion.",
    whyItBreaksI2v:
      "The video model cannot interpolate a changing population; it must spawn or despawn many bodies mid-clip, producing pop-in, morphing, and chaotic motion.",
    examples: [
      "3 aliens -> 30 aliens surrounding the heroes",
      "empty street -> dense crowd with no arrival beat",
      "a squad of enemies vanishes between frames with no exit",
    ],
    repair:
      "Keep the crowd/extras count stable across the pair, or make the count change a cut or an explicit arrival/reveal beat with its own keyframe.",
  },
];

export function renderKeyframeReviewRubric(
  entries: readonly KeyframeReviewRubricEntry[] = KEYFRAME_REVIEW_RUBRIC,
) {
  return entries
    .map((entry, index) => {
      const examples = entry.examples.map((example) => `   - ${example}`).join("\n");
      return [
        `${index + 1}. ${entry.id} [${entry.category}, default ${entry.severity}]`,
        `   Inspect: ${entry.inspect}`,
        `   Why it breaks image-to-video: ${entry.whyItBreaksI2v}`,
        `   Examples:\n${examples}`,
        `   Repair: ${entry.repair}`,
      ].join("\n");
    })
    .join("\n\n");
}
