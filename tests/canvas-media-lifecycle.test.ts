import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Canvas media lifecycle", () => {
  it("never unmutes or autoplays media merely because selection or metadata changed", async () => {
    const source = await readFile(
      `${root}/app/projects/[id]/canvas-workspace.tsx`,
      "utf8",
    );

    expect(source).not.toContain("autoUnmuteOnSelect");
    expect(source).not.toContain("if (card.id === selectedId) {\n                                  video.loop");
    expect(source).toMatch(/video\.pause\(\);\s+video\.muted = true;/);
    expect(source).toMatch(/media\.pause\(\);\s+media\.muted = true;/);
    expect(source).toContain('muted={!unmutedCardIds.includes(card.id)}');
  });

  it("decodes expensive waveform/frame resources only on explicit demand", async () => {
    const source = await readFile(
      `${root}/app/projects/[id]/canvas-workspace.tsx`,
      "utf8",
    );

    expect(source).toContain("const waveformDemandIds = useMemo");
    expect(source).toContain("for (const id of waveformDemandIds)");
    expect(source).toContain("if (src) void captureFrameStrip(card.id, src)");
    expect(source).not.toContain(
      "void captureFrameStrip(card.id, src);\n                                  rememberAspectRatio",
    );
  });

  it("unmounts the inactive editor instead of retaining its media engine", async () => {
    const source = await readFile(
      `${root}/app/projects/[id]/project-workbench.tsx`,
      "utf8",
    );
    expect(source).toContain('{workspaceView === "editor" ? (');
    expect(source).not.toContain('aria-hidden={workspaceView !== "editor"}');
  });
});
