import { describe, expect, it } from "vitest";
import { lintSourceFiles } from "@/lib/lint";
import {
  buildSourceGraph,
  identityHash,
  lookupIdentityHash,
  voiceHash,
  VOICE_HASH_SUFFIX,
  type SourceFile,
} from "@/lib/source-graph";
import { baseProject, md, withFile } from "./helpers";

function withVoice(files: SourceFile[], voiceId: string): SourceFile[] {
  return withFile(
    files,
    "references/characters/char_a/reference.md",
    md(
      {
        id: "char_a",
        type: "reference",
        category: "characters",
        status: "active",
        voice_id: voiceId,
      },
      "Hero character.",
    ),
  );
}

describe("voice as a separate identity axis", () => {
  it("parses voice_id and round-trips delivery on dialogue lines", () => {
    const files = withFile(
      withVoice(baseProject(), "elevenlabs_voice_1"),
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
          duration_seconds: 5,
          dialogue: {
            mode: "exact_dialogue",
            lines: [
              { speaker: "char_a", line: "Go.", start_s: 1, end_s: 2, delivery: "whispered" },
            ],
          },
        },
        "Clip.",
      ),
    );
    const graph = buildSourceGraph(files);
    expect(graph.references.get("char_a")?.voiceId).toBe("elevenlabs_voice_1");
    expect(graph.clips.get("clip_1")?.dialogueLines[0]?.delivery).toBe("whispered");
  });

  it("changing voice_id changes voiceHash but NOT the visual identityHash", () => {
    const before = buildSourceGraph(withVoice(baseProject(), "voice_one"));
    const after = buildSourceGraph(withVoice(baseProject(), "voice_two"));
    const refBefore = before.references.get("char_a")!;
    const refAfter = after.references.get("char_a")!;
    expect(voiceHash(refBefore)).not.toBe(voiceHash(refAfter));
    expect(identityHash({ kind: "reference", node: refBefore })).toBe(
      identityHash({ kind: "reference", node: refAfter }),
    );
  });

  it("resolves <ref>@voice through lookupIdentityHash", () => {
    const graph = buildSourceGraph(withVoice(baseProject(), "voice_one"));
    expect(lookupIdentityHash(graph, `char_a${VOICE_HASH_SUFFIX}`)).toBe(
      voiceHash(graph.references.get("char_a")!),
    );
    expect(lookupIdentityHash(graph, `ghost${VOICE_HASH_SUFFIX}`)).toBeNull();
  });

  it("a voice change marks speaking clips stale but not visual dependents", () => {
    const original = buildSourceGraph(withVoice(baseProject(), "voice_one"));
    const reference = original.references.get("char_a")!;
    const visualHash = identityHash({ kind: "reference", node: reference });
    const oldVoiceHash = voiceHash(reference);

    let files = withVoice(baseProject(), "voice_two"); // voice changed
    files = withFile(
      files,
      "keyframes/kf_1.md",
      md(
        {
          id: "kf_1",
          type: "keyframe",
          status: "generated",
          url: "https://m.example/kf_1.png",
          depicts: ["char_a"],
          identity_anchors: ["char_a_portfolio"],
          built_against: { char_a: visualHash },
        },
        "Visual dependent built against the unchanged visual hash.",
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
          duration_seconds: 5,
          dialogue: {
            mode: "exact_dialogue",
            lines: [{ speaker: "char_a", line: "Go.", start_s: 1, end_s: 2 }],
          },
          built_against: { [`char_a${VOICE_HASH_SUFFIX}`]: oldVoiceHash },
        },
        "Speaking clip built against the old voice.",
      ),
    );

    const stale = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "stale",
    );
    expect(stale.some((issue) => issue.nodeId === "clip_1")).toBe(true);
    expect(stale.some((issue) => issue.nodeId === "kf_1")).toBe(false);
  });
});

describe("lint: dialogue-speaker", () => {
  function clipWithSpeaker(speaker: string): SourceFile[] {
    return withFile(
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
          to_keyframe: "kf_2",
          end_trust: "pinned",
          duration_seconds: 5,
          dialogue: {
            mode: "exact_dialogue",
            lines: [{ speaker, line: "Hi.", start_s: 1, end_s: 2 }],
          },
        },
        "Clip.",
      ),
    );
  }

  it("accepts a characters reference id in the scene", () => {
    const issues = lintSourceFiles(clipWithSpeaker("char_a")).issues.filter(
      (issue) => issue.rule === "dialogue-speaker",
    );
    expect(issues).toEqual([]);
  });

  it("errors on a prose / unresolvable speaker", () => {
    const issues = lintSourceFiles(clipWithSpeaker("Nova Rynn")).issues.filter(
      (issue) => issue.rule === "dialogue-speaker",
    );
    expect(issues.some((issue) => issue.level === "error")).toBe(true);
  });

  it("warns when the speaker is a non-characters reference", () => {
    let files = clipWithSpeaker("env_x");
    files = withFile(
      files,
      "references/environments/env_x/reference.md",
      md(
        { id: "env_x", type: "reference", category: "environments" },
        "A place, not a person.",
      ),
    );
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "dialogue-speaker",
    );
    expect(issues.some((issue) => issue.level === "warning" && /environments/.test(issue.message))).toBe(true);
  });

  it("warns when the speaker is not in the scene's references (off-screen ok)", () => {
    let files = clipWithSpeaker("char_narrator");
    files = withFile(
      files,
      "references/characters/char_narrator/reference.md",
      md(
        { id: "char_narrator", type: "reference", category: "characters", voice_id: "v_narrator" },
        "Voiceover narrator; never on screen.",
      ),
    );
    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "dialogue-speaker",
    );
    expect(issues.some((issue) => issue.level === "warning" && /not in scene/.test(issue.message))).toBe(true);
    expect(issues.some((issue) => issue.level === "error")).toBe(false);
  });
});
