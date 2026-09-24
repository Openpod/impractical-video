import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { Markdown, type RefResolver } from "@/app/markdown";

const refResolver: RefResolver = (id) => {
  if (id !== "kf_02_opening_clash") return null;
  return {
    id,
    kind: "keyframe",
    path: `keyframes/${id}.md`,
    thumbUrl: "https://example.test/keyframe.png",
    title: "Opening clash momentum frame",
  };
};

function render(text: string) {
  return renderToStaticMarkup(createElement(Markdown, { text, refResolver }));
}

describe("Markdown resolved refs", () => {
  it("renders bare ids as human-readable chips", () => {
    const html = render("Updated kf_02_opening_clash.");

    expect(html).toContain("Opening clash momentum frame");
    expect(html).toContain('data-ref-id="kf_02_opening_clash"');
    expect(html).not.toContain(">kf_02_opening_clash<");
  });

  it("renders @id and @[id] mention forms", () => {
    const html = render("Updated @kf_02_opening_clash and @[kf_02_opening_clash].");

    expect(html.match(/Opening clash momentum frame/g)).toHaveLength(2);
  });

  it("renders refs inside inline code spans", () => {
    const html = render("Pair `kf_02_opening_clash -> kf_missing`.");

    expect(html).toContain("Opening clash momentum frame");
    expect(html).toContain("kf_missing");
  });

  it("leaves unresolved ids untouched", () => {
    const html = render("Updated kf_missing_frame.");

    expect(html).toContain("kf_missing_frame");
    expect(html).not.toContain("md-ref-chip");
  });

  it("does not resolve refs inside fenced code blocks", () => {
    const html = render("```json\n{\"id\":\"kf_02_opening_clash\"}\n```");

    expect(html).toContain("kf_02_opening_clash");
    expect(html).not.toContain("Opening clash momentum frame");
    expect(html).not.toContain("md-ref-chip");
  });
});
