import { describe, expect, it } from "vitest";
// @ts-expect-error The packaged ESM helper intentionally has no TS declaration.
import { evaluateAudit } from "../scripts/check-audit.mjs";

const reviewDate = new Date("2026-10-11T00:00:00Z");
const advisory = {
  name: "braces",
  url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
  severity: "high",
};

function fixture() {
  return {
    report: {
      auditReportVersion: 2,
      vulnerabilities: {
        braces: { severity: "high", nodes: ["node_modules/braces"], via: [advisory] },
        micromatch: { severity: "high", nodes: ["node_modules/micromatch"], via: ["braces"] },
      },
    },
    lock: { packages: {
      "node_modules/braces": { version: "3.0.3", dev: true },
      "node_modules/micromatch": { version: "4.0.8", dev: true },
    } },
  };
}

describe("dependency security gate", () => {
  it("accepts only the reviewed development advisory and its inherited findings", () => {
    const { report, lock } = fixture();
    expect(evaluateAudit(report, lock, reviewDate)).toEqual({ accepted: ["braces", "micromatch"], blocked: [] });
  });

  it("blocks new advisories on an otherwise accepted package and its dependents", () => {
    const { report, lock } = fixture();
    report.vulnerabilities.braces.via.push({ ...advisory, url: "https://github.com/advisories/GHSA-new" });
    expect(evaluateAudit(report, lock, reviewDate).blocked).toEqual(["braces", "micromatch"]);
  });

  it("blocks unreviewed high and critical packages", () => {
    const { lock } = fixture();
    for (const severity of ["high", "critical"]) {
      const report = { auditReportVersion: 2, vulnerabilities: {
        next: { severity, nodes: ["node_modules/next"], via: [{ name: "next", severity }] },
      } };
      expect(evaluateAudit(report, lock, reviewDate).blocked).toEqual(["next"]);
    }
  });

  it("does not accept a severity escalation for the same advisory", () => {
    const { report, lock } = fixture();
    report.vulnerabilities.braces.severity = "critical";
    expect(evaluateAudit(report, lock, reviewDate).blocked).toEqual(["braces", "micromatch"]);
  });

  it("blocks the exception when it expires", () => {
    const { report, lock } = fixture();
    expect(evaluateAudit(report, lock, new Date("2026-11-10T00:00:00Z")).blocked).toEqual(["braces", "micromatch"]);
  });

  it("blocks production usage or unreviewed versions", () => {
    for (const change of [{ dev: false }, { version: "3.0.4" }]) {
      const { report, lock } = fixture();
      Object.assign(lock.packages["node_modules/braces"], change);
      expect(evaluateAudit(report, lock, reviewDate).blocked).toEqual(["braces", "micromatch"]);
    }
  });

  it("blocks additional installations, missing lock entries, and unknown dependency paths", () => {
    const { report, lock } = fixture();
    report.vulnerabilities.braces.nodes.push("node_modules/other/node_modules/braces");
    expect(evaluateAudit(report, lock, reviewDate).blocked).toEqual(["braces", "micromatch"]);
    report.vulnerabilities.braces.nodes.pop();
    expect(evaluateAudit(report, { packages: {} }, reviewDate).blocked).toEqual(["braces", "micromatch"]);
    report.vulnerabilities.micromatch.via = ["missing"];
    expect(evaluateAudit(report, lock, reviewDate).blocked).toEqual(["micromatch"]);
  });

  it("fails closed on audit errors or malformed reports", () => {
    const { report, lock } = fixture();
    for (const invalid of [{}, { error: { code: "ENOTFOUND" }, ...report },
      { ...report, auditReportVersion: 1 }, { ...report, vulnerabilities: [] },
      { ...report, vulnerabilities: { braces: { severity: "unknown" } } }]) {
      expect(() => evaluateAudit(invalid, lock, reviewDate)).toThrow();
    }
  });

  it("preserves the high-severity threshold and accepts a clean report", () => {
    const { lock } = fixture();
    for (const vulnerabilities of [{}, { logger: { severity: "moderate", via: [{ name: "logger" }] } }]) {
      expect(evaluateAudit({ auditReportVersion: 2, vulnerabilities }, lock, reviewDate))
        .toEqual({ accepted: [], blocked: [] });
    }
  });
});
