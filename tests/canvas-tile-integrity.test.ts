import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Canvas tile replacement integrity", () => {
  it("keeps the placeholder identity and tool-reserved geometry after completion", async () => {
    const workbench = await readFile(
      `${root}/app/projects/[id]/project-workbench.tsx`,
      "utf8",
    );
    const canvas = await readFile(
      `${root}/app/projects/[id]/canvas-workspace.tsx`,
      "utf8",
    );

    expect(workbench).toContain("id: placeholder.id");
    expect(workbench).toContain(
      "toolAspectRatio: placeholder.toolAspectRatio ?? replacement?.toolAspectRatio",
    );
    expect(canvas).toContain("const visualCardKey = originId ?? card.id");
    expect(canvas).toContain("explicit: card.aspectRatio");
    expect(canvas).toContain("tool: card.toolAspectRatio");
    expect(canvas).toContain("intrinsic: measuredAspectRatios[card.id]");
  });

  it("uses the revisioned OpenCut document for tile and Inspector usage", async () => {
    const workbench = await readFile(
      `${root}/app/projects/[id]/project-workbench.tsx`,
      "utf8",
    );
    const canvas = await readFile(
      `${root}/app/projects/[id]/canvas-workspace.tsx`,
      "utf8",
    );

    expect(workbench).toContain("editorPlacements={editorPlacements}");
    expect(workbench).toContain("canonicalEditorPlacements");
    expect(workbench).not.toContain("timeline={snapshot.timeline}");
    expect(canvas).toContain("usedCards={inspectorUsedCards}");
    expect(canvas).not.toContain(
      "timelineName={inspectorCard ? connectionByCardId.get(inspectorCard.id)?.name",
    );
  });

  it("uses the canonical piece kind in selection, accessibility, and Inspector output", async () => {
    const canvas = await readFile(
      `${root}/app/projects/[id]/canvas-workspace.tsx`,
      "utf8",
    );

    expect(canvas).toContain(
      "kind: canvasPieceKindForCard(card), title: card.title",
    );
    expect(canvas).toContain(
      'aria-label={`${card.title}, ${canvasPieceKindForCard(card)}${primaryFocused ? ", primary selection" : selected ? ", selected" : ""}`}',
    );
    expect(canvas).toContain("kind: canvasPieceKindForCard(card)");
  });
});
