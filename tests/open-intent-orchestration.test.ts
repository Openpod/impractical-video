import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPEN_INTENT_ORCHESTRATION } from "@/lib/open-intent-orchestration";

describe("open-intent orchestration", () => {
  it("makes free-form intent the contract and keeps workflows adaptive", () => {
    expect(OPEN_INTENT_ORCHESTRATION).toContain(
      "Do not require them to translate that intent into a tool, artifact type, mode, template, or workflow.",
    );
    expect(OPEN_INTENT_ORCHESTRATION).toContain(
      "Start making progress immediately.",
    );
    expect(OPEN_INTENT_ORCHESTRATION).toContain(
      "Workflow recipes are internal accelerators, never gates.",
    );
    expect(OPEN_INTENT_ORCHESTRATION).toContain(
      "Never force the request to fit a weak match",
    );
  });

  it("shares the contract across hosted, canvas, and desktop companion agents", () => {
    const hosted = readFileSync("app/api/projects/[id]/chat/route.ts", "utf8");
    const canvas = readFileSync(
      "app/api/projects/[id]/canvas/composer/route.ts",
      "utf8",
    );
    const companion = readFileSync("lib/companion-session.ts", "utf8");
    const paperMcp = readFileSync("scripts/paper-mcp.mjs", "utf8");

    expect(hosted).toContain("${OPEN_INTENT_ORCHESTRATION}");
    expect(canvas).toContain("OPEN_INTENT_ORCHESTRATION,");
    expect(companion).toContain("OPEN_INTENT_ORCHESTRATION,");
    expect(paperMcp).toContain('"load_workflow"');
  });

  it("does not require OpenRouter when the Electron composer uses a local agent", () => {
    const canvas = readFileSync(
      "app/api/projects/[id]/canvas/composer/route.ts",
      "utf8",
    );
    expect(canvas).toContain(
      "if (!isLocalAppMode(process.env) && !process.env.OPENROUTER_API_KEY)",
    );
  });
});

