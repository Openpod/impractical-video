import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const paperTools = readFileSync("lib/paper-tools.ts", "utf8");
const mediaRoute = readFileSync(
  "app/api/projects/[id]/media/[...path]/route.ts",
  "utf8",
);

describe("paper image version contract", () => {
  it("appends regenerated images to an immutable version path", () => {
    const implementation = paperTools.slice(
      paperTools.indexOf("export async function paperGenerateImage"),
      paperTools.indexOf("/** In-flight clip generations"),
    );

    expect(implementation).toContain("mediaVersionState(existingMeta)");
    expect(implementation).toContain("mediaVersionWriteState(existingMeta");
    expect(implementation).toContain(
      "`media/keyframes/${id}.v${versionState.nextVersion}`",
    );
    expect(implementation).not.toContain("`media/keyframes/${id}.v1`");
  });

  it("revalidates workspace media instead of pinning mutable bytes", () => {
    expect(mediaRoute).toContain(
      '"cache-control": "private, no-cache, max-age=0, must-revalidate"',
    );
    expect(mediaRoute).not.toContain("max-age=86400");
  });
});
