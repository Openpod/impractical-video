import { readFile } from "node:fs/promises";
import path from "node:path";
import { sourceFiles } from "./source-files.mjs";

export async function checkSource(root = process.cwd()) {
  const files = await sourceFiles(root);
  const findings = [];
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:sk_live_|rk_live_|sk-or-v1-|sk-proj-|sk-ant-)[A-Za-z0-9_-]{24,}/,
    /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}/,
    /\bAKIA[A-Z0-9]{16}\b/,
    /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}/,
    /\/Users\/simarkohli\//,
  ];
  for (const relative of files) {
    if (/\.(png|jpg|jpeg|avif|ico|icns|woff2?|ttf|wasm)$/i.test(relative)) continue;
    const body = await readFile(path.join(root, relative), "utf8");
    for (const [index, line] of body.split("\n").entries()) {
      if (patterns.some((pattern) => pattern.test(line))) findings.push(`${relative}:${index + 1}: possible private content`);
    }
  }
  if (findings.length) throw new Error(`Source export blocked:\n${findings.join("\n")}`);
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const files = await checkSource();
  console.log(`Checked ${files.length} release source files; no matching credential or personal-path patterns. Git history was not scanned.`);
}
