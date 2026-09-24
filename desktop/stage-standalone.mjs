import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const source = path.join(root, ".next", "standalone");
const destination = path.join(root, "desktop", "generated", "standalone");

await rm(destination, { force: true, recursive: true });
await mkdir(path.dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true });

// Next may copy dotenv files independently of output tracing. They belong to
// the build machine, never to a redistributable desktop runtime.
async function removeEnvironmentFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (/^\.env(?:\.|$)/.test(entry.name)) {
      await rm(candidate, { force: true, recursive: entry.isDirectory() });
    } else if (entry.isDirectory()) {
      await removeEnvironmentFiles(candidate);
    }
  }
}
await removeEnvironmentFiles(destination);

// electron-builder deliberately filters directories named node_modules from
// extraResources. Preserve Next's standalone trace under a neutral name and
// expose it to the embedded Node process through NODE_PATH at runtime.
await rename(
  path.join(destination, "node_modules"),
  path.join(destination, "server_modules"),
);

await cp(
  path.join(root, ".next", "static"),
  path.join(destination, ".next", "static"),
  { recursive: true },
);
await cp(path.join(root, "public"), path.join(destination, "public"), {
  recursive: true,
});
for (const directory of ["skills", "workflows"]) {
  await cp(path.join(root, directory), path.join(destination, directory), { recursive: true });
}

console.log("Staged traced standalone Next runtime.");
