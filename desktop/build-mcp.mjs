import { mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const outputDirectory = path.join(root, "desktop", "generated");
await mkdir(outputDirectory, { recursive: true });

await build({
  bundle: true,
  entryPoints: [path.join(root, "scripts", "paper-mcp.mjs")],
  format: "esm",
  outfile: path.join(outputDirectory, "paper-mcp.mjs"),
  packages: "bundle",
  platform: "node",
  sourcemap: false,
  target: "node22",
});

console.log("Bundled desktop MCP bridge.");
