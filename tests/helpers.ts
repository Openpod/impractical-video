import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { SourceFile } from "@/lib/source-graph";

export function md(meta: Record<string, unknown>, body = ""): string {
  return `---\n${JSON.stringify(meta, null, 2)}\n---\n${body}\n`;
}

export function loadFixture(name: string): SourceFile[] {
  const root = path.join(__dirname, "fixtures", name);
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        files.push({
          path: path.relative(root, full).split(path.sep).join("/"),
          content: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(root);
  return files;
}

/** Minimal coherent project the rule tests mutate to plant one violation. */
export function baseProject(): SourceFile[] {
  return [
    {
      path: "references/characters/char_a/reference.md",
      content: md(
        {
          id: "char_a",
          type: "reference",
          category: "characters",
          status: "active",
        },
        "Hero character.",
      ),
    },
    {
      path: "references/characters/char_a/portfolio.md",
      content: md({
        id: "char_a_portfolio",
        type: "portfolio",
        reference_id: "char_a",
        status: "generated",
        urls: ["https://m.example/char_a.png"],
      }),
    },
    {
      path: "keyframes/kf_1.md",
      content: md(
        {
          id: "kf_1",
          type: "keyframe",
          status: "generated",
          url: "https://m.example/kf_1.png",
          depicts: ["char_a"],
          identity_anchors: ["char_a_portfolio"],
          state_anchor: null,
        },
        "Opening frame.",
      ),
    },
    {
      path: "keyframes/kf_2.md",
      content: md(
        {
          id: "kf_2",
          type: "keyframe",
          status: "generated",
          url: "https://m.example/kf_2.png",
          depicts: ["char_a"],
          identity_anchors: ["char_a_portfolio"],
          state_anchor: "kf_1",
        },
        "Closing frame.",
      ),
    },
    {
      path: "scenes/001-one/scene.md",
      content: md(
        { id: "scene_1", type: "scene", index: 1, references: ["char_a"] },
        "Scene one.",
      ),
    },
    {
      path: "clips/clip_1.md",
      content: md(
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
          transition_from_previous: null,
        },
        "Clip one.",
      ),
    },
    {
      path: "timeline.json",
      content: JSON.stringify([
        {
          id: "tl_clip_1",
          clip_id: "clip_1",
          url: "https://m.example/clip_1.mp4",
        },
      ]),
    },
  ];
}

/** Replace a file in a project (or add it if absent). */
export function withFile(
  files: SourceFile[],
  filePath: string,
  content: string,
): SourceFile[] {
  const next = files.filter((file) => file.path !== filePath);
  next.push({ path: filePath, content });
  return next;
}
