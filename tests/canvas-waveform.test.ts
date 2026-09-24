import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CanvasWaveform } from "@/app/projects/[id]/canvas-waveform";

describe("CanvasWaveform", () => {
  it("renders a bounded SVG visualization rather than one DOM node per sample", () => {
    const html = renderToStaticMarkup(
      createElement(CanvasWaveform, {
        progress: 0.42,
        values: Array.from({ length: 96 }, (_, index) => (index % 12) / 12),
      }),
    );

    expect(html).toContain("<svg");
    expect(html.match(/<path/g)).toHaveLength(2);
    expect(html).not.toContain("<span");
    expect(html).toContain('width="42"');
  });
});
