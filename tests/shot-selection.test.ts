import { describe, expect, it } from "vitest";
import { lintSourceFiles } from "@/lib/lint";
import { buildSourceGraph, type SourceFile } from "@/lib/source-graph";
import { baseProject, md, withFile } from "./helpers";

function plannedShot(input: {
  id: string;
  index: number;
  shotSize?: string;
  duration?: number;
  transition?: string | null;
  motivation?: string | null;
  from?: string;
  to?: string;
}): SourceFile {
  return {
    path: `clips/${input.id}.md`,
    content: md(
      {
        id: input.id,
        type: "clip",
        scene: "scene_1",
        index: input.index,
        status: "planned",
        from_keyframe: input.from ?? "kf_1",
        to_keyframe: input.to ?? "kf_2",
        end_trust: "unknown",
        shot_size: input.shotSize ?? null,
        duration_seconds: input.duration ?? null,
        transition_from_previous: input.transition ?? null,
        cut_motivation: input.motivation ?? null,
      },
      "Planned shot.",
    ),
  };
}

describe("shot fields on clips", () => {
  it("parses shot_size and cut_motivation; rejects unknown sizes", () => {
    let files = baseProject().filter((file) => !file.path.startsWith("clips/"));
    const cu = plannedShot({
      id: "clip_cu",
      index: 1,
      shotSize: "CU",
      motivation: "reaction: her face sells the reveal",
    });
    const bad = plannedShot({ id: "clip_bad", index: 2, shotSize: "XXL" });
    files = withFile(files, cu.path, cu.content);
    files = withFile(files, bad.path, bad.content);
    const graph = buildSourceGraph(files);
    expect(graph.clips.get("clip_cu")?.shotSize).toBe("CU");
    expect(graph.clips.get("clip_cu")?.cutMotivation).toMatch(/reaction/);
    expect(graph.clips.get("clip_bad")?.shotSize).toBeNull();
  });
});

describe("lint: pacing report", () => {
  it("is absent for single-clip projects", () => {
    const issues = lintSourceFiles(baseProject()).issues.filter(
      (issue) => issue.rule === "pacing",
    );
    expect(issues).toEqual([]);
  });

  it("reports counts, transitions, sizes, runs, and motivations", () => {
    let files = baseProject().filter((file) => file.path !== "timeline.json");
    files = withFile(files, "timeline.json", "[]");
    const shots = [
      plannedShot({ id: "c1", index: 1, shotSize: "ELS", duration: 3, motivation: "establish geography" }),
      plannedShot({ id: "c2", index: 2, shotSize: "MS", duration: 2, transition: "cut", motivation: "advance story" }),
      plannedShot({ id: "c3", index: 3, shotSize: "MS", duration: 2, transition: "cut" }),
      plannedShot({ id: "c4", index: 4, shotSize: "CU", duration: 1, transition: "hard_cut_same_assets", motivation: "impact detail" }),
    ];
    for (const shot of shots) files = withFile(files, shot.path, shot.content);

    const issues = lintSourceFiles(files).issues.filter(
      (issue) => issue.rule === "pacing",
    );
    expect(issues).toHaveLength(1);
    const message = issues[0].message;
    expect(message).toContain("5 clips"); // 4 planned shots + base clip_1
    expect(message).toMatch(/transitions: .*2 cut/);
    expect(message).toMatch(/1 hard_cut_same_assets/);
    expect(message).toMatch(/shot sizes: .*2 MS/);
    expect(message).toMatch(/longest same-size run: 2/);
    expect(message).toMatch(/cut motivations named: 3\/5/);
    expect(message).not.toMatch(/uniform durations/);
    expect(issues[0].level).toBe("info");
  });

  it("flags uniform durations across 4+ shots", () => {
    let files = baseProject().filter((file) => file.path !== "timeline.json");
    files = withFile(files, "timeline.json", "[]");
    // base clip_1 has no duration; add 4 same-duration planned shots.
    for (let i = 0; i < 4; i += 1) {
      const shot = plannedShot({ id: `u${i}`, index: i + 1, shotSize: "MS", duration: 8 });
      files = withFile(files, shot.path, shot.content);
    }
    const pacing = lintSourceFiles(files).issues.find((issue) => issue.rule === "pacing");
    expect(pacing?.message).toMatch(/All 4 shots are 8s — uniform durations/);
  });
});
