import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CanvasLoadingPiece,
  canvasPieceKind,
  canvasPieceState,
  durableCanvasPieceStatus,
  resolvePieceAspectRatio,
  type CanvasPieceKind,
  type CanvasPieceState,
} from "../app/projects/[id]/canvas-loading-piece";

describe("canonical Canvas loading piece", () => {
  it("classifies every durable work state without inventing progress", () => {
    const fixtures: Array<[string, boolean, CanvasPieceState]> = [
      ["queued", false, "queued"],
      ["imagining", true, "preparing"],
      ["generating", true, "generating"],
      ["processing", true, "processing"],
      ["needs_assets", false, "awaiting-input"],
      ["failed", false, "failed"],
      ["cancelled", false, "cancelled"],
      ["generated", false, "ready"],
      ["vendor-mystery-state", false, "unknown"],
    ];
    for (const [status, generating, expected] of fixtures) {
      expect(canvasPieceState(status, generating)).toBe(expected);
    }
  });

  it("uses explicit, tool, workflow, intrinsic, then square aspect priority", () => {
    expect(
      resolvePieceAspectRatio({
        explicit: "9:16",
        tool: "4:3",
        workflowDefault: "16:9",
        intrinsic: "3:2",
      }),
    ).toBe("9 / 16");
    expect(
      resolvePieceAspectRatio({
        explicit: null,
        intrinsic: "3:2",
        tool: "4:3",
        workflowDefault: "16:9",
      }),
    ).toBe("4 / 3");
    expect(
      resolvePieceAspectRatio({
        explicit: null,
        intrinsic: "3:2",
        tool: null,
        workflowDefault: "16:9",
      }),
    ).toBe("16 / 9");
    expect(
      resolvePieceAspectRatio({
        explicit: null,
        intrinsic: "3:2",
        tool: null,
        workflowDefault: null,
      }),
    ).toBe("3 / 2");
    expect(resolvePieceAspectRatio({})).toBe("1 / 1");
  });

  it("keeps declared geometry immutable when processing media is replaced", () => {
    const processing = renderToStaticMarkup(
      createElement(CanvasLoadingPiece, {
        aspectRatio: "9:16",
        intrinsicAspectRatio: null,
        kind: "video",
        state: "processing",
      }),
    );
    const completed = renderToStaticMarkup(
      createElement(CanvasLoadingPiece, {
        aspectRatio: "9:16",
        intrinsicAspectRatio: "16:9",
        kind: "video",
        state: "ready",
      }),
    );
    expect(processing).toContain("--piece-aspect:9 / 16");
    expect(completed).toContain("--piece-aspect:9 / 16");
  });

  it("normalizes prop records to object and unknown records safely", () => {
    expect(canvasPieceKind("prop")).toBe("object");
    expect(canvasPieceKind("objects")).toBe("object");
    expect(canvasPieceKind("keyframe")).toBe("image");
    expect(canvasPieceKind("unrecognized-provider-output")).toBe("unknown");
    expect(canvasPieceKind(null)).toBe("unknown");
  });

  it("preserves durable upload processing state instead of inventing readiness", () => {
    expect(durableCanvasPieceStatus("processing", true)).toBe("processing");
    expect(durableCanvasPieceStatus("awaiting-input", false)).toBe("awaiting-input");
    expect(durableCanvasPieceStatus("vendor-phase", false)).toBe("vendor-phase");
    expect(durableCanvasPieceStatus(null, true)).toBe("uploaded");
    expect(durableCanvasPieceStatus(null, false)).toBe("unknown");
  });

  it("renders every media kind and state through one bounded component", () => {
    const kinds: CanvasPieceKind[] = [
      "image",
      "video",
      "audio",
      "reference",
      "object",
      "unknown",
    ];
    const states: CanvasPieceState[] = [
      "queued",
      "preparing",
      "generating",
      "processing",
      "awaiting-input",
      "failed",
      "cancelled",
      "ready",
      "unknown",
    ];
    for (const kind of kinds) {
      for (const state of states) {
        const markup = renderToStaticMarkup(
          createElement(CanvasLoadingPiece, {
            kind,
            remediation: "Fixture detail",
            state,
          }),
        );
        expect(markup).toContain(`data-loading-state="${state}"`);
        expect(markup).not.toContain('role="progressbar"');
      }
    }
  });

  it("shows numeric progress only when real progress is provided", () => {
    const markup = renderToStaticMarkup(
      createElement(CanvasLoadingPiece, {
        kind: "video",
        progress: 0.42,
        state: "processing",
      }),
    );
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="42"');
  });

  it("never labels processing or unknown lifecycle states as ready", () => {
    const processing = renderToStaticMarkup(
      createElement(CanvasLoadingPiece, {
        kind: "image",
        state: canvasPieceState("processing"),
      }),
    );
    const unknown = renderToStaticMarkup(
      createElement(CanvasLoadingPiece, {
        kind: "unknown",
        state: canvasPieceState("provider-specific-state"),
      }),
    );
    expect(processing).toContain("Processing");
    expect(processing).not.toContain("Ready");
    expect(unknown).toContain("Status unavailable");
    expect(unknown).not.toContain("Media unavailable");
    expect(unknown).not.toContain("Ready");
  });
});
