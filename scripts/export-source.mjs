import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { checkSource } from "./check-source.mjs";

const root = process.cwd();
const destination = path.resolve(process.argv[2] || path.join(root, "dist", "source", "video-fs"));
const files = await checkSource(root);
await mkdir(path.dirname(destination), { recursive: true });
// Never merge with or delete an existing export: stale/private files could survive.
await mkdir(destination);
for (const relative of files) {
  const target = path.join(destination, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(root, relative), target, { errorOnExist: true, force: false });
}
console.log(`Exported ${files.length} source files to ${destination}`);
console.log("No Git history, credentials, local projects, or experiment outputs were included.");
