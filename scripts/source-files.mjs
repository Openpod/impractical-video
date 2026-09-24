import { readdir, lstat } from "node:fs/promises";
import path from "node:path";

// Deliberately explicit: a developer checkout also contains customer projects,
// test renders and an upstream reference repository. None belong in a release.
const directories = [".github", "app", "components", "database", "desktop", "lib", "modal", "opencut", "public", "scripts/video_tracking", "skills", "src", "supabase", "templates", "tests", "types", "workflows"];
const files = [
  ".env.example", ".env.local.example", ".gitignore", ".nvmrc", ".vercelignore",
  "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "README.md", "CONTRIBUTING.md", "SECURITY.md", "CLAUDE.md",
  "package.json", "package-lock.json", "next.config.ts", "next-env.d.ts", "tsconfig.json",
  "middleware.ts", "postcss.config.mjs", "eslint.config.mjs", "vitest.config.ts", "trigger.config.ts", "playwright.config.ts",
  "docs/releasing.md", "docs/local-development.md", "docs/release-validation.md", "desktop/README.md",
  ...["setup-local.mjs", "doctor.mjs", "local-agent.mjs", "paper-mcp.mjs", "setup-paper-project.mjs", "check-release-env.mjs", "check-desktop-release.mjs", "source-files.mjs", "check-source.mjs", "export-source.mjs", "smoke-server.mjs", "extract-video-portfolio.ts", "backfill-published-display-images.ts", "publish-curated-portfolios.ts"].map((file) => `scripts/${file}`),
];
const excluded = /(^|\/)(node_modules|generated|__pycache__|\.temp|\.git|\.next)(\/|$)|(^|\/)providers\.json(?:\.|$)|\.tmp\.|\.pyc$|\.DS_Store$|\.tsbuildinfo$/;

export async function sourceFiles(root = process.cwd()) {
  const result = new Set();
  async function visit(relative) {
    if (excluded.test(relative)) return;
    const info = await lstat(path.join(root, relative));
    if (info.isSymbolicLink()) throw new Error(`Release source must not contain symlinks: ${relative}`);
    if (info.isDirectory()) {
      for (const entry of await readdir(path.join(root, relative))) await visit(`${relative}/${entry}`);
    } else if (info.isFile()) {
      if (/(^|\/)\.env/.test(relative) && !relative.endsWith(".example")) throw new Error(`Private environment in release: ${relative}`);
      result.add(relative);
    }
  }
  for (const relative of [...directories, ...files]) await visit(relative);
  return [...result].sort();
}
