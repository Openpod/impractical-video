import { describe, expect, it } from "vitest";
import { lintSourceFiles } from "@/lib/lint";
import { buildSourceGraph, type SourceFile } from "@/lib/source-graph";
import { baseProject, md, withFile } from "./helpers";

function withFinding(meta: Record<string, unknown>): SourceFile[] {
  return withFile(
    baseProject(),
    "findings/find_1.md",
    md(
      {
        id: "find_1",
        type: "finding",
        status: "open",
        severity: "issue",
        implicates: ["kf_1"],
        summary: "Stray red ball near the tree in kf_1.",
        ...meta,
      },
      "The end frame has an unexplained red ball.",
    ),
  );
}

describe("findings as graph nodes", () => {
  it("parses a finding into the graph", () => {
    const graph = buildSourceGraph(withFinding({}));
    const finding = graph.findings.get("find_1");
    expect(finding?.status).toBe("open");
    expect(finding?.severity).toBe("issue");
    expect(finding?.implicates).toEqual(["kf_1"]);
    expect(finding?.summary).toMatch(/red ball/);
  });

  it("surfaces an open issue finding as a warning", () => {
    const issues = lintSourceFiles(withFinding({})).issues.filter(
      (issue) => issue.rule === "finding-open",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
  });

  it("surfaces an open blocker finding as an error", () => {
    const result = lintSourceFiles(withFinding({ severity: "blocker" }));
    const blocking = result.issues.filter((issue) => issue.rule === "finding-open");
    expect(blocking[0].level).toBe("error");
    expect(result.ok).toBe(false);
  });

  it("does not surface accepted/dismissed/resolved findings", () => {
    for (const status of ["accepted", "dismissed", "resolved"]) {
      const issues = lintSourceFiles(withFinding({ status })).issues.filter(
        (issue) => issue.rule === "finding-open",
      );
      expect(issues).toEqual([]);
    }
  });

  it("errors when a finding implicates a missing node", () => {
    const issues = lintSourceFiles(withFinding({ implicates: ["kf_ghost"] })).issues.filter(
      (issue) => issue.rule === "finding-target",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("error");
  });
});
