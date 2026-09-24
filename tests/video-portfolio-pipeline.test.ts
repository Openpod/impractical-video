import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { applyCharacterLedger } from "@/lib/video-portfolio-pipeline";
import { assignCharacterName, type CharacterLedger } from "@/lib/video-portfolio-ledger";
import {
  buildPortfolioSheetPrompt,
  buildVideoPortfolioPrompt,
  formatTimestamp,
  mapEntityCategory,
  normalizeVideoPortfolioExtraction,
  parseGeminiVideoPortfolioJson,
  planVideoPortfolioWorkspace,
  renderPortfolioMarkdown,
  renderReferenceMarkdown,
  workspaceMediaUrl,
} from "@/lib/video-portfolio-pipeline";
import { buildSourceGraph, parseStrictJsonFrontmatter } from "@/lib/source-graph";
import { createLocalDirSink } from "@/lib/video-portfolio-sink";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("video portfolio pipeline helpers", () => {
  it("formats numeric seconds as stable ffmpeg/display timecodes", () => {
    expect(formatTimestamp(0)).toBe("00:00:00.000");
    expect(formatTimestamp(62.3454)).toBe("00:01:02.345");
    expect(formatTimestamp(3661.2)).toBe("01:01:01.200");
  });

  it("maps Gemini entity categories into existing reference categories", () => {
    expect(mapEntityCategory("character")).toBe("characters");
    expect(mapEntityCategory("environment")).toBe("environments");
    expect(mapEntityCategory("object")).toBe("props");
    expect(mapEntityCategory("thing")).toBe("props");
    expect(mapEntityCategory("style")).toBe("styles");
  });

  it("normalizes parsed Gemini JSON and deduplicates timestamp points", () => {
    const extraction = parseGeminiVideoPortfolioJson(`
      \`\`\`json
      {
        "entities": [
          {
            "name": "Hero Jacket",
            "category": "object",
            "description": "A red jacket.",
            "timestampedPoints": [
              { "seconds": 1.23456, "description": "front" },
              { "seconds": 1.2345, "description": "duplicate" },
              { "seconds": 5, "timecode": "ignored", "description": "back" }
            ]
          }
        ]
      }
      \`\`\`
    `);

    expect(extraction.entities[0]?.timestampedPoints).toEqual([
      { seconds: 1.235, timecode: "00:00:01.235", description: "front" },
      { seconds: 5, timecode: "00:00:05.000", description: "back" },
    ]);
  });

  it("tolerates a bare top-level entities array from the model", () => {
    const extraction = parseGeminiVideoPortfolioJson(`[
      { "name": "Hero", "category": "character", "description": "A lead.",
        "timestampedPoints": [{ "seconds": 2, "description": "portrait" }] }
    ]`);
    expect(extraction.entities).toHaveLength(1);
    expect(extraction.entities[0]?.name).toBe("Hero");
  });

  it("drops a malformed entity but keeps valid ones, and aliases title->name", () => {
    const extraction = normalizeVideoPortfolioExtraction({
      entities: [
        { description: "no name or category", timestampedPoints: [{ seconds: 1, description: "x" }] },
        {
          title: "Aliased Hero",
          type: "character",
          desc: "uses title/type/desc aliases",
          timestamps: [{ seconds: 2, description: "portrait" }],
        },
      ],
    });
    expect(extraction.entities).toHaveLength(1);
    expect(extraction.entities[0]?.name).toBe("Aliased Hero");
    expect(extraction.entities[0]?.category).toBe("character");
  });

  it("tolerates entities wrapped under an alternate key", () => {
    const extraction = normalizeVideoPortfolioExtraction({
      videoSummary: "x",
      objects: [
        {
          name: "Jacket",
          category: "object",
          description: "A red jacket.",
          timestampedPoints: [{ seconds: 1, description: "front" }],
        },
      ],
    });
    expect(extraction.entities[0]?.name).toBe("Jacket");
  });

  it("tolerates a top-level array containing an extraction envelope", () => {
    const extraction = normalizeVideoPortfolioExtraction([
      {
        videoSummary: "wrapped once",
        entities: [
          {
            name: "Artist Chick",
            category: "character",
            description: "A small yellow chick with glasses.",
            timestampedPoints: [{ seconds: 1, description: "clear view" }],
          },
        ],
      },
    ]);

    expect(extraction.videoSummary).toBe("wrapped once");
    expect(extraction.entities).toHaveLength(1);
    expect(extraction.entities[0]?.name).toBe("Artist Chick");
  });

  it("plans reference, portfolio, frame, and contact-sheet paths", () => {
    const extraction = normalizeVideoPortfolioExtraction({
      entities: [
        {
          name: "Lead Explorer",
          category: "character",
          description: "A person in a white suit.",
          timestampedPoints: [{ seconds: 12, description: "clear portrait" }],
        },
        {
          name: "Lead Explorer",
          category: "character",
          description: "A duplicate title gets a unique id.",
          timestampedPoints: [{ seconds: 24, description: "side profile" }],
        },
      ],
    });

    const plan = planVideoPortfolioWorkspace({ extraction });

    expect(plan.entities.map((entity) => entity.id)).toEqual([
      "char_lead_explorer",
      "char_lead_explorer_2",
    ]);
    expect(plan.entities[0]?.referencePath).toBe(
      "references/characters/char_lead_explorer/reference.md",
    );
    expect(plan.entities[0]?.contactSheetPath).toBe(
      "media/references/characters/char_lead_explorer/portfolio-contact-sheet.jpg",
    );
  });

  it("reserves existing reference ids when planning workspace writes", () => {
    const extraction = normalizeVideoPortfolioExtraction({
      entities: [
        {
          name: "Lead Explorer",
          category: "character",
          description: "A person in a white suit.",
          timestampedPoints: [{ seconds: 12, description: "clear portrait" }],
        },
      ],
    });

    const plan = planVideoPortfolioWorkspace({
      extraction,
      reservedIds: ["char_lead_explorer"],
    });

    expect(plan.entities[0]?.id).toBe("char_lead_explorer_2");
  });

  it("renders source-graph-compatible reference and portfolio markdown", () => {
    const extraction = normalizeVideoPortfolioExtraction({
      entities: [
        {
          name: "Neon Alley",
          category: "environment",
          description: "Wet pavement, signs, and a narrow corridor.",
          timestampedPoints: [{ seconds: 9.5, description: "wide view" }],
        },
      ],
    });
    const entity = planVideoPortfolioWorkspace({ extraction }).entities[0]!;
    const reference = renderReferenceMarkdown(entity);
    const portfolio = renderPortfolioMarkdown({
      entity,
      mediaUrl: (mediaPath) => workspaceMediaUrl("demo_project", mediaPath),
    });

    const graph = buildSourceGraph([
      { path: entity.referencePath, content: reference },
      { path: entity.portfolioPath, content: portfolio },
    ]);

    expect(graph.parseIssues).toEqual([]);
    expect(graph.references.get("env_neon_alley")?.category).toBe("environments");
    expect(graph.portfolioByReference.get("env_neon_alley")?.urls[0]).toBe(
      "/api/projects/demo_project/media/references/environments/env_neon_alley/portfolio-contact-sheet.jpg",
    );

    const parsedPortfolio = parseStrictJsonFrontmatter(portfolio);
    expect(parsedPortfolio.ok).toBe(true);
    if (parsedPortfolio.ok) {
      expect(parsedPortfolio.meta.local_path).toBe(
        "media/references/environments/env_neon_alley/portfolio-contact-sheet.jpg",
      );
    }
  });

  it("builds a Nano Banana portfolio prompt from the category contract + evidence", () => {
    const entity = planVideoPortfolioWorkspace({
      extraction: normalizeVideoPortfolioExtraction({
        entities: [
          {
            name: "Red Utility Jacket",
            category: "object",
            description: "A worn red zip jacket.",
            importanceReason: "Recurring visual marker.",
            timestampedPoints: [{ seconds: 4, description: "front" }],
          },
        ],
      }),
    }).entities[0]!;

    const prompt = buildPortfolioSheetPrompt({ entity, hasScaffold: true, evidenceFrameCount: 1 });
    // Reuses the canonical prop/object contract (props category).
    expect(prompt).toContain("3x3 cinematic portfolio contact sheet for this recurring object");
    expect(prompt).toContain("Row 1: FULL-SUBJECT views");
    // Scaffold + evidence conditioning + asset brief are all present.
    expect(prompt).toContain("blank 3x3 scaffold image");
    expect(prompt).toContain("real still frames captured from the source video");
    expect(prompt).toContain("Red Utility Jacket: A worn red zip jacket. (Recurring visual marker.)");
  });

  it("omits the evidence note when no frames were uploaded", () => {
    const entity = planVideoPortfolioWorkspace({
      extraction: normalizeVideoPortfolioExtraction({
        entities: [
          {
            name: "Neon Alley",
            category: "environment",
            description: "Wet pavement and signs.",
            timestampedPoints: [{ seconds: 1, description: "wide" }],
          },
        ],
      }),
    }).entities[0]!;
    const prompt = buildPortfolioSheetPrompt({ entity, hasScaffold: false, evidenceFrameCount: 0 });
    expect(prompt).not.toContain("real still frames captured from the source video");
    expect(prompt).toContain("scaffold image could not be attached");
  });

  it("marks the portfolio planned with no urls when generation fails", () => {
    const entity = planVideoPortfolioWorkspace({
      extraction: normalizeVideoPortfolioExtraction({
        entities: [
          {
            name: "Lead",
            category: "character",
            description: "A person.",
            timestampedPoints: [{ seconds: 2, description: "portrait" }],
          },
        ],
      }),
    }).entities[0]!;
    const portfolio = renderPortfolioMarkdown({
      entity,
      mediaUrl: (mediaPath) => workspaceMediaUrl("demo", mediaPath),
      generated: false,
      falUrl: null,
    });
    const parsed = parseStrictJsonFrontmatter(portfolio);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.meta.status).toBe("planned");
      expect(parsed.meta.urls).toEqual([]);
      expect(parsed.meta.local_path).toBeNull();
    }
  });

  it("encodes workspace media URLs segment-by-segment", () => {
    expect(workspaceMediaUrl("project one", "media/references/props/red hat/sheet.jpg")).toBe(
      "/api/projects/project%20one/media/references/props/red%20hat/sheet.jpg",
    );
  });
});

describe("extraction policy + character ledger", () => {
  it("tightens scope and adds character/outfit rules in the prompt", () => {
    const prompt = buildVideoPortfolioPrompt({ maxEntities: 24, maxPointsPerEntity: 9 });
    expect(prompt).toContain("SEPARATE character entity for each distinct individual");
    expect(prompt).toContain("Do NOT create generic group references");
    expect(prompt).toMatch(/Clothing, wardrobe, jewelry/);
    expect(prompt).toContain("canonicalOutfit");
  });

  it("assigns unique names and disambiguates collisions between distinct characters", () => {
    const ledger: CharacterLedger = { byName: {} };
    const a = assignCharacterName(ledger, {
      proposed: "Mira",
      rawName: "Sea Woman",
      sourceEntryId: "v1",
      entityId: "v1:sea_woman",
      description: "teal hair",
    });
    const b = assignCharacterName(ledger, {
      proposed: "Mira",
      rawName: "Diver",
      sourceEntryId: "v2",
      entityId: "v2:diver",
      description: "different person",
    });
    expect(a).toBe("Mira");
    expect(b).not.toBe("Mira");
    expect(b.startsWith("Mira ")).toBe(true);
    // Idempotent: the same entity re-requesting keeps its name.
    expect(
      assignCharacterName(ledger, {
        proposed: "Mira",
        rawName: "Sea Woman",
        sourceEntryId: "v1",
        entityId: "v1:sea_woman",
        description: "teal hair",
      }),
    ).toBe("Mira");
  });

  it("renames only character entities and keeps the raw name", () => {
    const ledger: CharacterLedger = { byName: {} };
    const extraction = normalizeVideoPortfolioExtraction({
      entities: [
        {
          name: "Young Asian Woman",
          category: "character",
          description: "A model.",
          properName: "Lina Soto",
          timestampedPoints: [{ seconds: 1, description: "portrait" }],
        },
        {
          name: "Neon Alley",
          category: "environment",
          description: "Wet pavement.",
          timestampedPoints: [{ seconds: 2, description: "wide" }],
        },
      ],
    });
    const out = applyCharacterLedger({ extraction, ledger, sourceEntryId: "vid1" });
    expect(out.entities[0]?.name).toBe("Lina Soto");
    expect(out.entities[0]?.rawName).toBe("Young Asian Woman");
    // Environment untouched.
    expect(out.entities[1]?.name).toBe("Neon Alley");
    expect(out.entities[1]?.rawName).toBeUndefined();
  });
});

describe("local-dir sink (isolated DB/Explore output)", () => {
  it("references portfolio media by portable relative path, not an app URL", () => {
    const sink = createLocalDirSink("/tmp/out");
    expect(sink.mediaUrl("media/references/props/red_hat/sheet.jpg")).toBe(
      "media/references/props/red_hat/sheet.jpg",
    );
  });

  it("writes the reference tree to disk and reports existing ids for reservation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vp-sink-"));
    try {
      const sink = createLocalDirSink(dir);
      await sink.writeText("references/characters/char_a/reference.md", "hello");
      await sink.writeBinary("media/references/characters/char_a/frame-01.jpg", Buffer.from([1, 2]));

      expect(await readFile(path.join(dir, "references/characters/char_a/reference.md"), "utf8")).toBe(
        "hello",
      );
      // A pre-existing reference in a sibling category should be reserved too.
      await mkdir(path.join(dir, "references/props/prop_x"), { recursive: true });
      await writeFile(path.join(dir, "references/props/prop_x/reference.md"), "x");

      expect((await sink.existingReferenceIds()).sort()).toEqual(["char_a", "prop_x"]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
