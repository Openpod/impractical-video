import { describe, expect, it } from "vitest";
import {
  blockingFrameDeltas,
  composeClipPrompt,
  composeModelReferenceLegend,
} from "@/lib/generation-contract";
import { lintSourceFiles } from "@/lib/lint";
import { baseProject, md, withFile } from "./helpers";
import type { SourceFile } from "@/lib/source-graph";

describe("composeClipPrompt", () => {
  function wordCount(value: string) {
    return value.trim().split(/\s+/).filter(Boolean).length;
  }

  it("compiles compact Seedance-style prose without bookkeeping headers", () => {
    const prompt = composeClipPrompt({
      actionIntent: "Anime chase scene; animate Nova escaping drones across the bridge.",
      startState: "Nova crouched frame-left on the bridge, drones upper-right.",
      endState: "Nova mid-leap toward the vortex, drones closing in.",
      actionBeats: [
        "Nova rises from the crouch",
        "Nova sprints right along the bridge",
        "Nova leaps toward the vortex as drones dive after her",
      ],
      environment: "a fracturing orbital bridge over a glowing vortex",
      cameraMove: "tracking",
      cameraNote: "follows her sprint right",
      lighting: "harsh blue rim light from the vortex",
      motionRate: "accelerated",
      dialogue: { mode: "no_audible_speech" },
    });
    expect(wordCount(prompt)).toBeLessThanOrEqual(40);
    expect(prompt).toContain("Anime chase scene");
    expect(prompt).toContain("Camera uses a smooth tracking move");
    expect(prompt).toContain("No dialogue");
    expect(prompt).not.toContain("Keep motion readable, stable, and continuous");
    expect(prompt).not.toContain("Nova crouched frame-left");
    expect(prompt).not.toContain("Nova rises from the crouch");
    expect(prompt).not.toContain("Nova leaps toward the vortex");
    expect(prompt).not.toContain("swift, energetic, stable motion");
    expect(prompt).not.toContain("harsh blue rim light from the vortex");
    expect(prompt).not.toMatch(/End on|final pose|arrive early|hold/i);
    expect(prompt).not.toMatch(/Start frame|End frame|Action:|Speed:|Dialogue contract|Account for every change/);
    expect(prompt).not.toMatch(/\bfast\b|ultra-fast|frenetic/i);
  });

  it("omits end frame for an unpinned clip and uses action intent", () => {
    const prompt = composeClipPrompt({
      actionIntent: "Quiet skyline shot; animate a slow drift across the city.",
      startState: "Wide establishing shot.",
      endState: null,
      actionBeats: ["a slow drift across the skyline"],
      cameraMove: "push_in",
      motionRate: "real_time",
      dialogue: { mode: "nonverbal_only" },
    });
    expect(prompt).toContain("a slow drift across the city");
    expect(prompt).not.toContain("a slow drift across the skyline");
    expect(prompt).not.toContain("Wide establishing shot");
    expect(prompt).not.toContain("End frame");
    expect(prompt).toContain("Camera uses a slow push-in");
    expect(prompt).toContain("body language");
  });

  it("keeps frame deltas out of model-facing prose", () => {
    const prompt = composeClipPrompt({
      actionIntent: "Animate the two balls resting together in the tree.",
      startState: "An orange ball rests in a tree.",
      endState: "An orange ball and a red ball sit together in the tree.",
      actionBeats: ["the orange ball stays put"],
      cameraMove: "fixed",
      motionRate: "real_time",
      frameDeltas: [
        {
          element: "red ball",
          change: "appeared",
          classification: "intended",
          narration: "a red ball rolls in from frame-left and settles beside the orange ball",
        },
      ],
      dialogue: { mode: "no_audible_speech" },
    });
    expect(prompt).not.toContain("a red ball rolls in from frame-left");
    expect(prompt).not.toContain("Account for every change");
    expect(prompt).not.toContain("red ball (appeared)");
  });

  it("does not add character-only constraints for vehicle-only clips", () => {
    const prompt = composeClipPrompt({
      actionIntent: "Race scene; animate the car launch as the jet shadows it.",
      startState: "A red race car idles on the starting grid.",
      endState: "The red race car crosses the finish line beside a blue jet.",
      actionBeats: ["the red race car launches cleanly", "the blue jet shadows it overhead"],
      cameraMove: "pan",
      motionRate: "frenetic",
      dialogue: { mode: "no_audible_speech" },
    });
    expect(prompt).not.toContain("rapid, high-energy movement with clear readable action");
    expect(prompt).not.toMatch(/\bbent limbs\b|\blimbs\b|\bfaces\b|\bhands\b/);
    expect(prompt).not.toMatch(/\bfast\b|ultra-fast|frenetic/i);
  });

  it("isolates continuity-error deltas as blocking", () => {
    const blocking = blockingFrameDeltas([
      { element: "red ball", change: "appeared", classification: "continuity_error" },
      { element: "hand", change: "moved", classification: "intended", narration: "waves" },
    ]);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].element).toBe("red ball");
  });

  it("renders exact dialogue lines without second-based beat markers", () => {
    const prompt = composeClipPrompt({
      actionIntent: "Dialogue close-up; Nova speaks, then turns away.",
      startState: "CU on Nova's face.",
      endState: "Nova turns away.",
      actionBeats: ["Nova speaks", "Nova turns away from camera"],
      cameraMove: "fixed",
      motionRate: "real_time",
      dialogue: {
        mode: "exact_dialogue",
        lines: [
          { speaker: "char_nova_rynn", line: "It's waking up.", start_s: 1, end_s: 2.5, delivery: "whispered" },
        ],
      },
    });
    expect(prompt).toContain('nova rynn says "It\'s waking up.", whispered');
    expect(prompt).toContain("Audible dialogue uses only these exact words");
    expect(prompt).not.toContain("[1s");
  });
});

describe("composeModelReferenceLegend", () => {
  it("builds short model-only name bindings from character reference prose", () => {
    const legend = composeModelReferenceLegend([
      {
        id: "char_akira",
        body: "Akira: young adult man, lean athletic build, short tousled black hair, intense amber eyes. Wardrobe: dark sleeveless shinobi-style top, charcoal hakama pants. Weapon: black-handled katana. Fighting style is fast and precise.",
      },
      {
        id: "char_reina",
        body: "Reina: young adult woman, athletic curvy build, long dark auburn hair tied in a high ponytail, fierce violet eyes. Wardrobe: revealing battle kimono in crimson and black with a deep V neckline and pronounced cleavage while still fully SFW, wide obi belt. Weapon: elegant red-lacquer katana.",
      },
    ]);

    expect(legend).toContain("Akira: young adult man");
    expect(legend).toContain("short tousled black hair");
    expect(legend).toContain("dark sleeveless shinobi-style top");
    expect(legend).toContain("Reina: young adult woman");
    expect(legend).toContain("long dark auburn hair");
    expect(legend).toContain("crimson and black");
    // Author-written SFW wardrobe detail is preserved, not sanitized.
    expect(legend).toContain("deep V neckline");
    expect(legend).toContain("revealing");
    // Structural section filter (non-visual prose) still applies.
    expect(legend).not.toMatch(/Fighting style/i);
  });

  it("falls back to a display name derived from the reference id", () => {
    const legend = composeModelReferenceLegend([
      { id: "char_masked_rider", body: "Tall masked rider in a blue coat." },
    ]);

    expect(legend).toBe("Masked Rider: Tall masked rider in a blue coat.");
  });
});

function clipWithDialogue(meta: Record<string, unknown>): SourceFile[] {
  return withFile(
    baseProject(),
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
        duration_seconds: 5,
        ...meta,
      },
      "Clip one.",
    ),
  );
}

describe("lint: dialogue-timing", () => {
  it("accepts well-timed dialogue inside the clip duration", () => {
    const files = clipWithDialogue({
      dialogue: {
        mode: "exact_dialogue",
        lines: [
          { speaker: "char_a", line: "Go.", start_s: 0.5, end_s: 1.2 },
          { speaker: "char_a", line: "Now!", start_s: 2, end_s: 3 },
        ],
      },
    });
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "dialogue-timing",
    );
    expect(issues).toEqual([]);
  });

  it("errors when a line ends past the clip duration", () => {
    const files = clipWithDialogue({
      dialogue: {
        mode: "exact_dialogue",
        lines: [{ speaker: "char_a", line: "Too long.", start_s: 4, end_s: 7 }],
      },
    });
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "dialogue-timing" && issue.level === "error",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/ends at 7s but the clip is 5s/);
  });

  it("errors on inverted timing and warns on overlap", () => {
    const files = clipWithDialogue({
      dialogue: {
        mode: "exact_dialogue",
        lines: [
          { speaker: "char_a", line: "Backwards.", start_s: 4, end_s: 3.5 },
          { speaker: "char_a", line: "First.", start_s: 1, end_s: 2.5 },
          { speaker: "char_a", line: "Overlap.", start_s: 2, end_s: 3 },
        ],
      },
    });
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "dialogue-timing",
    );
    expect(issues.some((issue) => issue.level === "error" && /start_s 4 >= end_s 3.5/.test(issue.message))).toBe(true);
    expect(issues.some((issue) => issue.level === "warning" && /overlap/.test(issue.message))).toBe(true);
  });

  it("does not warn for unsorted-but-valid lines", () => {
    const files = clipWithDialogue({
      dialogue: {
        mode: "exact_dialogue",
        lines: [
          { speaker: "char_a", line: "Second.", start_s: 3, end_s: 4 },
          { speaker: "char_a", line: "First.", start_s: 0.5, end_s: 2 },
        ],
      },
    });
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "dialogue-timing",
    );
    expect(issues).toEqual([]);
  });

  it("warns when a silent mode declares spoken lines", () => {
    const files = clipWithDialogue({
      dialogue: {
        mode: "no_audible_speech",
        lines: [{ speaker: "char_a", line: "Shh.", start_s: 1, end_s: 2 }],
      },
    });
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "dialogue-timing" && issue.level === "warning",
    );
    expect(issues.some((issue) => /declares dialogue mode "no_audible_speech"/.test(issue.message))).toBe(true);
  });

  it("errors when timing fields are missing", () => {
    const files = clipWithDialogue({
      dialogue: {
        mode: "exact_dialogue",
        lines: [{ speaker: "char_a", line: "When?" }],
      },
    });
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "dialogue-timing" && issue.level === "error",
    );
    expect(issues.some((issue) => /missing start_s\/end_s/.test(issue.message))).toBe(true);
  });
});
