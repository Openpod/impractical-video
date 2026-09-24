import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  createPartFromUri,
  createUserContent,
  FileState,
  GoogleGenAI,
  type File as GeminiFile,
} from "@google/genai";
import { z } from "zod";
import { resolveAiVideoEntryMedia } from "@/lib/ai-video-entry-media";
import { generateFalImage, uploadToFalStorage } from "@/lib/media";
import {
  DEFAULT_PORTFOLIO_FORMAT,
  getPortfolioScaffoldUrl,
  PORTFOLIO_SCAFFOLD_INSTRUCTION,
  portfolioPromptContract,
} from "@/lib/portfolio-sheet";
import type { ReferenceCategory } from "@/lib/source-graph";
import {
  assignCharacterName,
  loadCharacterLedger,
  saveCharacterLedger,
  type CharacterLedger,
} from "@/lib/video-portfolio-ledger";
import type { VideoPortfolioSink } from "@/lib/video-portfolio-sink";
import { readWorkspaceBinaryFile, safeRelativePath } from "@/lib/workspace";

const execFileAsync = promisify(execFile);

export const DEFAULT_VIDEO_PORTFOLIO_MODEL = "gemini-3-flash-preview";

export const videoPortfolioPointSchema = z.object({
  seconds: z.number().finite().min(0),
  timecode: z.string().optional(),
  description: z.string().min(1),
  confidence: z.number().finite().min(0).max(1).optional(),
});

export const videoPortfolioEntitySchema = z.object({
  name: z.string().min(1),
  category: z.enum(["character", "environment", "prop", "object", "style", "thing", "other"]),
  description: z.string().min(1),
  importanceReason: z.string().optional(),
  /** For characters: a plausible distinct proper name the model proposes. */
  properName: z.string().optional(),
  /** The original model-chosen descriptive name, retained after ledger renaming. */
  rawName: z.string().optional(),
  /** For characters in multiple outfits: the one canonical look to portray. */
  canonicalOutfit: z.string().optional(),
  timestampedPoints: z.array(videoPortfolioPointSchema).min(1),
});

export const videoPortfolioExtractionSchema = z.object({
  videoSummary: z.string().optional(),
  entities: z.array(videoPortfolioEntitySchema),
});

export type VideoPortfolioPoint = z.infer<typeof videoPortfolioPointSchema>;
export type VideoPortfolioEntity = z.infer<typeof videoPortfolioEntitySchema>;
export type VideoPortfolioExtraction = z.infer<typeof videoPortfolioExtractionSchema>;

export type PlannedVideoPortfolioEntity = VideoPortfolioEntity & {
  id: string;
  referenceCategory: ReferenceCategory;
  referencePath: string;
  portfolioPath: string;
  framePaths: string[];
  contactSheetPath: string;
};

export type PlannedVideoPortfolioWorkspace = {
  entities: PlannedVideoPortfolioEntity[];
  manifestPath: string;
};

/**
 * Where the input video comes from. Decoupled from the output sink so a DB /
 * Explore video can be extracted into a local directory without ever touching
 * a project workspace.
 */
export type VideoPortfolioSource =
  | { kind: "local"; path: string }
  | { kind: "workspace"; projectId: string; path: string }
  | { kind: "url"; url: string; ext?: string }
  | { kind: "aiVideoEntry"; entryId: string };

export type VideoPortfolioAnalyzer = "openrouter" | "gemini";

export type RunVideoPortfolioPipelineInput = {
  source: VideoPortfolioSource;
  sink: VideoPortfolioSink;
  /**
   * Which analysis backend to use. Defaults to "openrouter" when
   * OPENROUTER_API_KEY is set (reuses the app's existing key), otherwise the
   * native @google/genai Files API path ("gemini").
   */
  analyzer?: VideoPortfolioAnalyzer;
  apiKey?: string;
  model?: string;
  maxEntities?: number;
  maxPointsPerEntity?: number;
  ffmpegPath?: string;
  keepTempFiles?: boolean;
  /**
   * Extraction-only mode: run Gemini + ffmpeg evidence frames but skip the paid
   * Nano Banana 3x3 generation. Used to review candidates cheaply before
   * spending generations on approved ones only.
   */
  skipPortfolio?: boolean;
  /**
   * Path to a batch-level character-name ledger. When set, each character is
   * assigned a unique name across the batch (see lib/video-portfolio-ledger).
   */
  characterLedgerPath?: string;
};

export function defaultAnalyzer(): VideoPortfolioAnalyzer {
  return process.env.OPENROUTER_API_KEY ? "openrouter" : "gemini";
}

export type RunVideoPortfolioPipelineResult = {
  extraction: VideoPortfolioExtraction;
  plan: PlannedVideoPortfolioWorkspace;
  writtenPaths: string[];
  sourceLabel: string;
  sourceEntryId: string | null;
  sourceTitle: string | null;
};

const CATEGORY_PREFIX: Record<ReferenceCategory, string> = {
  characters: "char",
  environments: "env",
  props: "prop",
  styles: "style",
};

function frontmatter(meta: Record<string, unknown>, body: string) {
  return `---\n${JSON.stringify(meta, null, 2)}\n---\n${body.trim()}\n`;
}

export function formatTimestamp(seconds: number) {
  const totalMillis = Math.max(0, Math.round(seconds * 1000));
  const wholeSeconds = Math.floor(totalMillis / 1000);
  const millis = totalMillis % 1000;
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const secs = wholeSeconds % 60;
  const pad2 = (value: number) => String(value).padStart(2, "0");
  const pad3 = (value: number) => String(value).padStart(3, "0");
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)}.${pad3(millis)}`;
}

export function mapEntityCategory(category: VideoPortfolioEntity["category"]): ReferenceCategory {
  if (category === "character") return "characters";
  if (category === "environment") return "environments";
  if (category === "style") return "styles";
  return "props";
}

export function slugifyVideoPortfolioId(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_")
      .slice(0, 48) || "entity"
  );
}

function uniqueId(base: string, used: Set<string>) {
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function clampPositiveInteger(value: number | undefined, fallback: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function normalizeEntity(entity: VideoPortfolioEntity): VideoPortfolioEntity {
  const pointsBySecond = new Map<string, VideoPortfolioPoint>();
  for (const point of entity.timestampedPoints) {
    const roundedSeconds = Math.max(0, Math.round(point.seconds * 1000) / 1000);
    const key = roundedSeconds.toFixed(3);
    if (pointsBySecond.has(key)) continue;
    pointsBySecond.set(key, {
      ...point,
      seconds: roundedSeconds,
      timecode: formatTimestamp(roundedSeconds),
    });
  }

  return {
    ...entity,
    name: entity.name.trim(),
    description: entity.description.trim(),
    importanceReason: entity.importanceReason?.trim() || undefined,
    timestampedPoints: [...pointsBySecond.values()].sort((a, b) => a.seconds - b.seconds),
  };
}

/**
 * Coerce the model's JSON into the `{ videoSummary?, entities[] }` shape. Gemini
 * (esp. via OpenRouter's json_object mode) is non-deterministic about the
 * envelope: it sometimes returns a bare entities array, or wraps the array
 * under a different key (objects/items/results). Normalize those before Zod.
 */
function coerceExtractionShape(input: unknown): unknown {
  if (Array.isArray(input)) {
    const wrappedObjects = input.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && !Array.isArray(item)),
    );
    if (wrappedObjects.length === 1 && Array.isArray(wrappedObjects[0].entities)) {
      return wrappedObjects[0];
    }
    if (wrappedObjects.length === input.length && wrappedObjects.every((item) => Array.isArray(item.entities))) {
      return {
        videoSummary: wrappedObjects
          .map((item) => (typeof item.videoSummary === "string" ? item.videoSummary : ""))
          .filter(Boolean)
          .join("\n"),
        entities: wrappedObjects.flatMap((item) => item.entities as unknown[]),
      };
    }
    return { entities: input };
  }
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (Array.isArray(obj.entities)) return obj;
    const arrayKey = Object.keys(obj).find((key) => Array.isArray(obj[key]));
    if (arrayKey) {
      return {
        videoSummary: typeof obj.videoSummary === "string" ? obj.videoSummary : undefined,
        entities: obj[arrayKey],
      };
    }
  }
  return input;
}

function firstString(...values: unknown[]): unknown {
  for (const value of values) if (typeof value === "string" && value.trim()) return value;
  return values.find((value) => value !== undefined);
}

/** Map common model key aliases onto our entity field names. */
function coerceEntityShape(entity: unknown): unknown {
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) return entity;
  const e = entity as Record<string, unknown>;
  const points = e.timestampedPoints ?? e.timestamped_points ?? e.timestamps ?? e.points;
  return {
    ...e,
    name: firstString(e.name, e.title, e.label),
    category: firstString(e.category, e.type, e.kind),
    description: firstString(e.description, e.desc, e.summary),
    importanceReason: firstString(e.importanceReason, e.importance_reason, e.importance),
    properName: firstString(e.properName, e.proper_name),
    canonicalOutfit: firstString(e.canonicalOutfit, e.canonical_outfit, e.outfit),
    timestampedPoints: points,
  };
}

export function normalizeVideoPortfolioExtraction(input: unknown): VideoPortfolioExtraction {
  const shaped = coerceExtractionShape(input) as { videoSummary?: unknown; entities?: unknown };
  const rawEntities = Array.isArray(shaped.entities) ? shaped.entities : [];
  // Lenient per-entity validation: a single malformed entity must not discard a
  // whole video's extraction in a batch. Drop invalid ones, keep the rest.
  const entities: VideoPortfolioEntity[] = [];
  for (const raw of rawEntities) {
    const parsed = videoPortfolioEntitySchema.safeParse(coerceEntityShape(raw));
    if (parsed.success) entities.push(normalizeEntity(parsed.data));
  }
  if (entities.length === 0) {
    // Nothing usable — let the caller surface the raw payload for debugging.
    videoPortfolioExtractionSchema.parse(coerceExtractionShape(input));
  }
  const videoSummary = typeof shaped.videoSummary === "string" ? shaped.videoSummary.trim() : "";
  return { videoSummary: videoSummary || undefined, entities };
}

export function parseGeminiVideoPortfolioJson(text: string): VideoPortfolioExtraction {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFence);
  } catch (error) {
    throw new Error(
      `Model returned non-JSON video analysis: ${error instanceof Error ? error.message : error}. Raw: ${withoutFence.slice(0, 600)}`,
    );
  }
  try {
    return normalizeVideoPortfolioExtraction(parsed);
  } catch (error) {
    throw new Error(
      `Video analysis JSON did not match the entity schema (${error instanceof Error ? error.message : error}). Raw: ${withoutFence.slice(0, 600)}`,
    );
  }
}

/**
 * Assign batch-unique proper names to character entities via the ledger,
 * keeping the model's original descriptive name as `rawName`. Non-character
 * entities pass through unchanged. Mutates the ledger; caller persists it.
 */
export function applyCharacterLedger(input: {
  extraction: VideoPortfolioExtraction;
  ledger: CharacterLedger;
  sourceEntryId: string;
}): VideoPortfolioExtraction {
  const entities = input.extraction.entities.map((entity) => {
    if (mapEntityCategory(entity.category) !== "characters") return entity;
    const rawName = entity.name;
    const assigned = assignCharacterName(input.ledger, {
      proposed: entity.properName?.trim() || rawName,
      rawName,
      sourceEntryId: input.sourceEntryId,
      entityId: `${input.sourceEntryId}:${slugifyVideoPortfolioId(rawName)}`,
      description: entity.description,
    });
    return { ...entity, name: assigned, rawName };
  });
  return { ...input.extraction, entities };
}

export function buildVideoPortfolioPrompt(input: {
  maxEntities: number;
  maxPointsPerEntity: number;
}) {
  const maxEntities = clampPositiveInteger(input.maxEntities, 24, 100);
  const maxPointsPerEntity = clampPositiveInteger(input.maxPointsPerEntity, 9, 9);
  return `Watch the video and extract only the reusable, identity-defining visual entities worth building a reference portfolio for. Quality over quantity: a few strong references beat many weak ones.

Return only JSON with this exact top-level shape:
{
  "videoSummary": "short summary",
  "entities": [
    {
      "name": "canonical title",
      "category": "character | environment | prop | style",
      "description": "visual identity description useful for recreating it",
      "importanceReason": "why this entity matters to the scene",
      "properName": "(characters only) a plausible distinct proper name for this individual",
      "canonicalOutfit": "(characters only) the single outfit/look to portray if they appear in several",
      "timestampedPoints": [
        {
          "seconds": 12.345,
          "timecode": "00:00:12.345",
          "description": "what aspect is visible at this exact timestamp",
          "confidence": 0.93
        }
      ]
    }
  ]
}

What to EXTRACT:
- characters: named/foreground people, creatures, robots, or piloted/worn mecha that read as a distinct individual.
- environments: locations, sets, rooms, landscapes that establish place.
- props: ONLY large or story-important objects — a piloted mecha, a hero vehicle, a signature weapon, a giant portal, a major set piece.
- style: a distinctive, recurring visual treatment (lighting language, palette, rendering/medium, texture).

What to SKIP (do NOT make references for these):
- Clothing, wardrobe, jewelry, accessories, or held minor items just because a character wears/holds them (e.g. a "gothic necklace", a hat, a handbag) — UNLESS that item is itself the clear subject or is plot-critical.
- Incidental background clutter, furniture, generic small props.
- Logos, captions, UI, or text overlays.

CHARACTER rules:
- If multiple visually DISTINCT people appear, create a SEPARATE character entity for each distinct individual. Do not lump them together.
- Do NOT create generic group references (e.g. "Long-Ranged Snipers", "Guards", "Dancers") when the individuals are visually distinguishable — split them into individuals instead.
- If a group is an indistinct background crowd with no distinguishable individual, SKIP it rather than making a weak group reference.
- Give every character a "properName" (a plausible distinct proper name). Keep the descriptive look in "description".
- If a character appears in several outfits, set "canonicalOutfit" to ONE coherent look and select timestampedPoints that show that look. Do not mix outfits.

General rules:
- Merge repeated appearances of the SAME entity into one canonical entity.
- Return at most ${maxEntities} entities; prefer fewer, stronger ones.
- Return 1-${maxPointsPerEntity} timestampedPoints per entity.
- Use numeric seconds as the canonical timestamp because ffmpeg will seek with it.
- Pick timestamps where the entity is large, unobstructed, and visually representative.
- If a timestamp is approximate, still return the best numeric second value.`;
}

export function planVideoPortfolioWorkspace(input: {
  extraction: VideoPortfolioExtraction;
  maxPointsPerEntity?: number;
  reservedIds?: Iterable<string>;
}): PlannedVideoPortfolioWorkspace {
  const usedIds = new Set(input.reservedIds ?? []);
  const maxPointsPerEntity = clampPositiveInteger(input.maxPointsPerEntity, 9, 9);

  return {
    manifestPath: "operations/video-portfolio-extraction.json",
    entities: input.extraction.entities.map((entity) => {
      const referenceCategory = mapEntityCategory(entity.category);
      const prefix = CATEGORY_PREFIX[referenceCategory];
      const id = uniqueId(`${prefix}_${slugifyVideoPortfolioId(entity.name)}`, usedIds);
      const pointCount = Math.min(entity.timestampedPoints.length, maxPointsPerEntity);
      const framePaths = Array.from({ length: pointCount }, (_, index) => {
        const frame = String(index + 1).padStart(2, "0");
        return `media/references/${referenceCategory}/${id}/frame-${frame}.jpg`;
      });
      const contactSheetPath = `media/references/${referenceCategory}/${id}/portfolio-contact-sheet.jpg`;
      return {
        ...entity,
        id,
        referenceCategory,
        referencePath: `references/${referenceCategory}/${id}/reference.md`,
        portfolioPath: `references/${referenceCategory}/${id}/portfolio.md`,
        framePaths,
        contactSheetPath,
      };
    }),
  };
}

export function renderReferenceMarkdown(entity: PlannedVideoPortfolioEntity) {
  const renamed = entity.rawName && entity.rawName !== entity.name;
  return frontmatter(
    {
      id: entity.id,
      type: "reference",
      category: entity.referenceCategory,
      status: "active",
      ...(renamed ? { raw_title: entity.rawName } : {}),
      ...(entity.canonicalOutfit ? { canonical_outfit: entity.canonicalOutfit } : {}),
    },
    `# ${entity.name}

${entity.description}
${renamed ? `\nObserved as: ${entity.rawName}\n` : ""}${entity.importanceReason ? `\nImportance: ${entity.importanceReason}\n` : ""}`,
  );
}

export function workspaceMediaUrl(projectId: string, mediaPath: string) {
  const clean = safeRelativePath(mediaPath).replace(/^media\//, "");
  return `/api/projects/${encodeURIComponent(projectId)}/media/${clean
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

export function renderPortfolioMarkdown(input: {
  entity: PlannedVideoPortfolioEntity;
  mediaUrl: (mediaPath: string) => string;
  /** Whether the Nano Banana 3x3 sheet was produced (default true). */
  generated?: boolean;
  /** The fal-hosted URL of the generated sheet, for provenance. */
  falUrl?: string | null;
}) {
  const entity = input.entity;
  const generated = input.generated ?? true;
  return frontmatter(
    {
      id: `${entity.id}_portfolio`,
      type: "portfolio",
      reference_id: entity.id,
      portfolio_format: DEFAULT_PORTFOLIO_FORMAT,
      status: generated ? "generated" : "planned",
      // The generated 3x3 contact sheet is the portfolio's identity ground
      // truth; the raw evidence frames below are kept as provenance.
      urls: generated ? [input.mediaUrl(entity.contactSheetPath)] : [],
      local_path: generated ? entity.contactSheetPath : null,
      source: {
        type: "video_portfolio_extraction",
        generator: "nano-banana",
        fal_url: input.falUrl ?? null,
        evidence_frames: entity.timestampedPoints
          .slice(0, entity.framePaths.length)
          .map((point, index) => ({
            seconds: point.seconds,
            timecode: point.timecode ?? formatTimestamp(point.seconds),
            description: point.description,
            frame_path: entity.framePaths[index],
          })),
      },
    },
    `# ${entity.name} portfolio

A 3x3 ranging-shot portfolio generated by Nano Banana, conditioned on real evidence frames extracted from the source video at the timestamps Gemini selected.`,
  );
}

function mimeTypeForPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".m4v") return "video/x-m4v";
  return "video/mp4";
}

async function waitForGeminiFile(input: {
  ai: GoogleGenAI;
  file: GeminiFile;
  pollMs?: number;
  timeoutMs?: number;
}) {
  const name = input.file.name;
  if (!name) throw new Error("Gemini upload did not return a file name.");
  const deadline = Date.now() + (input.timeoutMs ?? 10 * 60 * 1000);
  let file = input.file;

  while (file.state === FileState.PROCESSING || !file.state) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for Gemini to process uploaded video ${name}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, input.pollMs ?? 2500));
    file = await input.ai.files.get({ name });
  }

  if (file.state === FileState.FAILED) {
    throw new Error(`Gemini failed to process uploaded video ${name}: ${file.error?.message ?? "unknown error"}`);
  }
  return file;
}

export async function analyzeVideoWithGemini(input: {
  videoPath: string;
  apiKey?: string;
  model?: string;
  maxEntities?: number;
  maxPointsPerEntity?: number;
}) {
  const apiKey = input.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is required for video portfolio extraction.");

  const maxEntities = clampPositiveInteger(input.maxEntities, 24, 100);
  const maxPointsPerEntity = clampPositiveInteger(input.maxPointsPerEntity, 9, 9);
  const ai = new GoogleGenAI({ apiKey });
  const uploaded = await ai.files.upload({
    file: input.videoPath,
    config: {
      mimeType: mimeTypeForPath(input.videoPath),
    },
  });
  const file = await waitForGeminiFile({ ai, file: uploaded });
  if (!file.uri || !file.mimeType) {
    throw new Error("Gemini uploaded file is missing uri or mimeType.");
  }

  const response = await ai.models.generateContent({
    model: input.model ?? process.env.GEMINI_VIDEO_PORTFOLIO_MODEL ?? DEFAULT_VIDEO_PORTFOLIO_MODEL,
    contents: createUserContent([
      createPartFromUri(file.uri, file.mimeType),
      buildVideoPortfolioPrompt({ maxEntities, maxPointsPerEntity }),
    ]),
    config: {
      responseMimeType: "application/json",
      maxOutputTokens: 16384,
    },
  });

  return parseGeminiVideoPortfolioJson(response.text ?? "");
}

async function extractFrame(input: {
  ffmpegPath: string;
  videoPath: string;
  seconds: number;
  outputPath: string;
}) {
  await execFileAsync(
    input.ffmpegPath,
    [
      "-y",
      "-ss",
      String(input.seconds),
      "-i",
      input.videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      input.outputPath,
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
}

export type PortfolioSheetResult = {
  ok: boolean;
  bytes: Buffer | null;
  falUrl: string | null;
  error: string | null;
  conditioningImageUrls: string[];
};

/**
 * Build the Nano Banana prompt for an entity's portfolio sheet, conditioned on
 * the entity's identity and the fact that the reference images are real stills
 * from the source video (so the model preserves the actual appearance rather
 * than inventing one). Mirrors the app's canonical portfolio prompt assembly.
 */
export function buildPortfolioSheetPrompt(input: {
  entity: PlannedVideoPortfolioEntity;
  hasScaffold: boolean;
  evidenceFrameCount: number;
}) {
  const { entity } = input;
  const scaffoldNote = input.hasScaffold
    ? `\n\n${PORTFOLIO_SCAFFOLD_INSTRUCTION}`
    : "\n\nA blank 3x3 scaffold image could not be attached; still follow the written nine-cell grid exactly.";
  const evidenceNote = input.evidenceFrameCount
    ? "\n\nThe remaining reference images are real still frames captured from the source video of this exact subject. Preserve its real identity, colors, materials, proportions, and design across all nine cells; do not substitute a different-looking subject."
    : "";
  const outfitNote =
    entity.referenceCategory === "characters" && entity.canonicalOutfit
      ? `\n\nDepict this character in ONE consistent look across all nine cells: ${entity.canonicalOutfit}. Do not mix outfits or wardrobe changes between cells.`
      : "";
  const brief = `\n\nAsset-specific brief:\n${entity.name}: ${entity.description}${
    entity.importanceReason ? ` (${entity.importanceReason})` : ""
  }`;
  return `${portfolioPromptContract(entity.referenceCategory)}${scaffoldNote}${evidenceNote}${outfitNote}${brief}`;
}

/**
 * Generate the 3x3 ranging-shot portfolio sheet with Nano Banana, using the
 * extracted evidence frames as identity references. Returns the downloaded
 * sheet bytes (for the sink to write) plus provenance. Never throws — a failed
 * generation is reported so one entity can't abort a batch.
 */
export async function generatePortfolioSheet(input: {
  entity: PlannedVideoPortfolioEntity;
  localFramePaths: string[];
  aspectRatio?: string;
}): Promise<PortfolioSheetResult> {
  try {
    const uploads = await Promise.all(
      input.localFramePaths.map(async (framePath, index) => {
        const bytes = await readFile(framePath);
        return uploadToFalStorage(bytes, `${input.entity.id}-frame-${index + 1}.jpg`, "image/jpeg");
      }),
    );
    const frameUrls = uploads.flatMap((upload) => (upload.ok ? [upload.url] : []));

    const scaffoldUrl = await getPortfolioScaffoldUrl();
    const conditioningImageUrls = [scaffoldUrl, ...frameUrls].filter(
      (url): url is string => Boolean(url),
    );

    const prompt = buildPortfolioSheetPrompt({
      entity: input.entity,
      hasScaffold: Boolean(scaffoldUrl),
      evidenceFrameCount: frameUrls.length,
    });

    const generation = await generateFalImage({
      prompt,
      aspectRatio: input.aspectRatio ?? "1:1",
      imageUrls: conditioningImageUrls,
    });
    if (!generation.ok || !generation.url) {
      return {
        ok: false,
        bytes: null,
        falUrl: generation.url ?? null,
        error: generation.error ?? "Nano Banana portfolio generation failed.",
        conditioningImageUrls,
      };
    }

    const response = await fetch(generation.url);
    if (!response.ok) {
      return {
        ok: false,
        bytes: null,
        falUrl: generation.url,
        error: `Failed to download generated sheet (${response.status} ${response.statusText}).`,
        conditioningImageUrls,
      };
    }
    return {
      ok: true,
      bytes: Buffer.from(await response.arrayBuffer()),
      falUrl: generation.url,
      error: null,
      conditioningImageUrls,
    };
  } catch (error) {
    return {
      ok: false,
      bytes: null,
      falUrl: null,
      error: error instanceof Error ? error.message : String(error),
      conditioningImageUrls: [],
    };
  }
}

async function downloadToFile(url: string, destPath: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download video (${response.status} ${response.statusText}): ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destPath, buffer);
}

function extFromUrl(url: string): string {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return ext && ext.length <= 5 ? ext : ".mp4";
  } catch {
    return ".mp4";
  }
}

/**
 * Materialize any source into a local temp file path for upload + ffmpeg, and
 * return a human-readable label describing where it came from.
 */
async function resolveVideoSource(
  source: VideoPortfolioSource,
  tempDir: string,
): Promise<{ localPath: string; label: string; entryId: string | null; title: string | null }> {
  switch (source.kind) {
    case "local":
      return { localPath: source.path, label: source.path, entryId: null, title: null };
    case "workspace": {
      const video = await readWorkspaceBinaryFile(source.projectId, source.path);
      const ext = path.extname(source.path) || ".mp4";
      const localPath = path.join(tempDir, `input${ext}`);
      await writeFile(localPath, video.content);
      return {
        localPath,
        label: `workspace:${source.projectId}/${source.path}`,
        entryId: null,
        title: null,
      };
    }
    case "url": {
      const ext = source.ext ?? extFromUrl(source.url);
      const localPath = path.join(tempDir, `input${ext}`);
      await downloadToFile(source.url, localPath);
      return { localPath, label: source.url, entryId: null, title: null };
    }
    case "aiVideoEntry": {
      const resolved = await resolveAiVideoEntryMedia(source.entryId);
      const localPath = path.join(tempDir, `input${resolved.ext}`);
      await downloadToFile(resolved.url, localPath);
      return {
        localPath,
        label: `ai-video-entry:${resolved.id}${resolved.title ? ` (${resolved.title})` : ""}`,
        entryId: resolved.id,
        title: resolved.title,
      };
    }
    default: {
      const exhaustive: never = source;
      throw new Error(`Unsupported video source: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export async function runVideoPortfolioPipeline(
  input: RunVideoPortfolioPipelineInput,
): Promise<RunVideoPortfolioPipelineResult> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "video-portfolio-"));
  const writtenPaths: string[] = [];
  const sink = input.sink;

  try {
    const {
      localPath: localVideoPath,
      label: sourceLabel,
      entryId: sourceEntryId,
      title: sourceTitle,
    } = await resolveVideoSource(input.source, tempDir);
    const analyzer = input.analyzer ?? defaultAnalyzer();
    const rawExtraction =
      analyzer === "openrouter"
        ? await (await import("@/lib/video-portfolio-openrouter")).analyzeVideoWithOpenRouter({
            videoPath: localVideoPath,
            apiKey: input.apiKey,
            model: input.model,
            maxEntities: input.maxEntities,
            maxPointsPerEntity: input.maxPointsPerEntity,
          })
        : await analyzeVideoWithGemini({
            videoPath: localVideoPath,
            apiKey: input.apiKey,
            model: input.model,
            maxEntities: input.maxEntities,
            maxPointsPerEntity: input.maxPointsPerEntity,
          });

    // Assign batch-unique character names via the ledger before planning, so
    // reference ids/titles use the assigned proper names.
    let extraction = rawExtraction;
    if (input.characterLedgerPath) {
      const ledger = await loadCharacterLedger(input.characterLedgerPath);
      extraction = applyCharacterLedger({
        extraction: rawExtraction,
        ledger,
        sourceEntryId: sourceEntryId ?? sourceLabel,
      });
      await saveCharacterLedger(input.characterLedgerPath, ledger);
    }

    const plan = planVideoPortfolioWorkspace({
      extraction,
      maxPointsPerEntity: input.maxPointsPerEntity,
      reservedIds: await sink.existingReferenceIds(),
    });
    const ffmpegPath = input.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";

    for (const entity of plan.entities) {
      const entityTempDir = path.join(tempDir, entity.id);
      await mkdir(entityTempDir, { recursive: true });

      // 1. Extract raw evidence frames at the Gemini-selected timestamps.
      const localFramePaths: string[] = [];
      for (const [index, point] of entity.timestampedPoints
        .slice(0, entity.framePaths.length)
        .entries()) {
        const localFramePath = path.join(entityTempDir, `frame-${String(index + 1).padStart(2, "0")}.jpg`);
        await extractFrame({
          ffmpegPath,
          videoPath: localVideoPath,
          seconds: point.seconds,
          outputPath: localFramePath,
        });
        localFramePaths.push(localFramePath);
      }

      // 2. Persist the raw frames as provenance/evidence.
      for (const framePath of entity.framePaths) {
        const localFramePath = path.join(entityTempDir, path.basename(framePath));
        await sink.writeBinary(framePath, await readFile(localFramePath));
        writtenPaths.push(framePath);
      }

      // 3. Generate the 3x3 ranging-shot portfolio with Nano Banana, using the
      //    evidence frames as identity references. Skipped in extraction-only
      //    mode so candidates can be reviewed before spending generations.
      const sheet = input.skipPortfolio
        ? null
        : await generatePortfolioSheet({ entity, localFramePaths });
      if (sheet?.ok && sheet.bytes) {
        await sink.writeBinary(entity.contactSheetPath, sheet.bytes);
        writtenPaths.push(entity.contactSheetPath);
      } else if (sheet && !sheet.ok) {
        console.warn(`Portfolio sheet generation failed for ${entity.id}: ${sheet.error}`);
      }

      await sink.writeText(entity.referencePath, renderReferenceMarkdown(entity));
      await sink.writeText(
        entity.portfolioPath,
        renderPortfolioMarkdown({
          entity,
          mediaUrl: sink.mediaUrl,
          generated: Boolean(sheet?.ok),
          falUrl: sheet?.falUrl ?? null,
        }),
      );
      writtenPaths.push(entity.referencePath, entity.portfolioPath);
    }

    await sink.writeText(
      plan.manifestPath,
      JSON.stringify(
        {
          created_at: new Date().toISOString(),
          analyzer,
          model:
            input.model ??
            (analyzer === "openrouter"
              ? process.env.GEMINI_VIDEO_PORTFOLIO_OPENROUTER_MODEL ?? "google/gemini-3-flash-preview"
              : process.env.GEMINI_VIDEO_PORTFOLIO_MODEL ?? DEFAULT_VIDEO_PORTFOLIO_MODEL),
          portfolio_generator: "nano-banana",
          portfolio_format: DEFAULT_PORTFOLIO_FORMAT,
          skip_portfolio: Boolean(input.skipPortfolio),
          source: sourceLabel,
          source_entry_id: sourceEntryId,
          source_video_title: sourceTitle,
          sink: sink.label,
          extraction,
          entities: plan.entities.map((entity) => ({
            id: entity.id,
            name: entity.name,
            raw_title: entity.rawName ?? entity.name,
            character_name: entity.referenceCategory === "characters" ? entity.name : null,
            canonical_outfit: entity.canonicalOutfit ?? null,
            category: entity.category,
            reference_category: entity.referenceCategory,
            reference_path: entity.referencePath,
            portfolio_path: entity.portfolioPath,
            contact_sheet_path: entity.contactSheetPath,
            portfolio_generated: !input.skipPortfolio,
            frame_paths: entity.framePaths,
            timestamped_points: entity.timestampedPoints,
          })),
        },
        null,
        2,
      ),
    );
    writtenPaths.push(plan.manifestPath);

    return { extraction, plan, writtenPaths, sourceLabel, sourceEntryId, sourceTitle };
  } finally {
    if (!input.keepTempFiles) await rm(tempDir, { force: true, recursive: true });
  }
}
