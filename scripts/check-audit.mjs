import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// No patched braces release exists. Only this advisory in the reviewed,
// dev-only lint dependency chain is accepted until the mandatory review date.
// See SECURITY.md. Never add a package-wide or production exception here.
const exception = {
  url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
  expires: "2026-11-10T00:00:00Z",
  versions: {
    braces: "3.0.3",
    micromatch: "4.0.8",
    "fast-glob": "3.3.1",
    "@next/eslint-plugin-next": "16.4.0",
    "eslint-config-next": "16.4.0",
  },
};

export function evaluateAudit(report, lock, now = new Date()) {
  if (report?.error || report?.auditReportVersion !== 2 ||
      !report.vulnerabilities || typeof report.vulnerabilities !== "object" ||
      Array.isArray(report.vulnerabilities) || !lock?.packages ||
      !Number.isFinite(now.getTime())) {
    throw new Error("Invalid npm audit report, lockfile, or review date; refusing to pass.");
  }
  const findings = report.vulnerabilities;
  const accepted = [];
  const blocked = [];
  const levels = ["info", "low", "moderate", "high", "critical"];

  function isException(name, seen = new Set()) {
    const finding = findings[name];
    const version = exception.versions[name];
    if (!version || !finding || seen.has(name) || now >= new Date(exception.expires) ||
        finding.severity !== "high" || !Array.isArray(finding.nodes) ||
        finding.nodes.length !== 1 || finding.nodes[0] !== `node_modules/${name}` ||
        lock.packages[finding.nodes[0]]?.dev !== true ||
        lock.packages[finding.nodes[0]]?.version !== version ||
        !Array.isArray(finding.via) || !finding.via.length) return false;
    const visited = new Set([...seen, name]);
    return finding.via.every((cause) => typeof cause === "string"
      ? isException(cause, visited)
      : name === "braces" && cause?.name === "braces" &&
        cause.url === exception.url && cause.severity === "high");
  }

  for (const [name, finding] of Object.entries(findings)) {
    if (!finding || !levels.includes(finding.severity) ||
        !Array.isArray(finding.via) || !finding.via.length) {
      throw new Error(`Invalid audit finding for ${name}; refusing to pass.`);
    }
    if (!["high", "critical"].includes(finding.severity)) continue;
    (isException(name) ? accepted : blocked).push(name);
  }
  return { accepted, blocked };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    const args = ["audit", "--json", "--include=dev"];
    const result = process.env.npm_execpath
      ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], { encoding: "utf8" })
      : spawnSync("npm", args, { encoding: "utf8" });
    if (result.error || ![0, 1].includes(result.status)) {
      throw new Error(result.error?.message || result.stderr || `npm audit exited ${result.status}`);
    }
    const report = JSON.parse(result.stdout);
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const { accepted, blocked } = evaluateAudit(report, lock);
    console.log("npm audit totals:", report.metadata?.vulnerabilities);
    if (accepted.length) {
      console.warn(`Temporary dev-only exception (${exception.url}, expires ${exception.expires}): ${accepted.join(", ")}`);
    }
    for (const name of blocked) console.error(JSON.stringify(report.vulnerabilities[name], null, 2));
    if (blocked.length) throw new Error(`Dependency audit blocked: ${blocked.join(", ")}`);
    console.log("Dependency audit passed: no unaccepted high or critical findings.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
