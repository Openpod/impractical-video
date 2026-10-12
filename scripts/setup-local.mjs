import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** The env loader unescapes nothing inside single quotes or backticks. Inside
 * double quotes a Windows path comes back with every backslash doubled, and
 * with a line break wherever a folder name starts with "n" or "r". */
function envValue(value) {
  if (!/[\\"]/.test(value)) return JSON.stringify(value);
  if (!value.includes("'")) return `'${value}'`;
  return value.includes("`") ? value : `\`${value}\``;
}

export async function setupLocal(root = process.cwd()) {
  const template = await readFile(path.join(root, ".env.example"), "utf8");
  const contents = template
    .replace(/^PAPER_MCP_TOKEN=$/m, `PAPER_MCP_TOKEN=${randomBytes(32).toString("hex")}`)
    .replace(/^VIDEO_FS_DATA_ROOT=$/m, () => `VIDEO_FS_DATA_ROOT=${envValue(path.join(root, "data", "projects"))}`);
  try {
    await writeFile(path.join(root, ".env.local"), contents, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  console.log(await setupLocal() ? "Created private .env.local for local mode." : "Kept existing .env.local unchanged. Compare it with .env.example to enable local mode.");
  console.log("Run npm run doctor, then npm run dev (web) or npm run desktop:dev (desktop).");
}
