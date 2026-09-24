import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const canvasRoute = readFileSync(
  "app/api/projects/[id]/canvas/state/route.ts",
  "utf8",
);
const publisher = readFileSync(
  "app/projects/[id]/agent-context-publisher.tsx",
  "utf8",
);

describe("settled desktop restart integrity", () => {
  it("does not touch groups or project metadata for an unchanged mirror", () => {
    expect(canvasRoute).toContain('readWorkspaceFile(id, "canvas/groups.json")');
    expect(canvasRoute).toContain("changed: false");
    expect(canvasRoute.indexOf("changed: false")).toBeLessThan(
      canvasRoute.indexOf("await writeWorkspaceFile"),
    );
  });

  it("does not publish the transient pre-hydration context", () => {
    expect(publisher).toContain("initialHydrationRef");
    expect(publisher).toContain("initialReconciliationRef");
    expect(publisher).toContain("contextVisibleCount(currentView) > 0");
    expect(publisher).toContain(
      "initialHydrationRef.current ? 900 : 120",
    );
    expect(publisher).not.toContain("if (!paused) void drain();");
  });
});
