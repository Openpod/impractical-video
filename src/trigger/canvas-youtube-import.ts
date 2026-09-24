import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fal } from "@fal-ai/client";
import { task } from "@trigger.dev/sdk";
import {
  CANVAS_YOUTUBE_GENERATE_TASK_ID,
  CANVAS_YOUTUBE_IMPORT_TASK_ID,
  readCanvasYoutubeImportRecord,
  writeCanvasYoutubeImportRecord,
  type CanvasYoutubeImportRecord,
} from "@/lib/canvas-youtube-import";
import { billingEnabled, chargeForOp, getCreditBalance, quoteOp, refundCredits } from "@/lib/credits-service";
import type { BillableOp } from "@/lib/usage-pricing";
import {
  appendChat,
  hostProjectBytes,
  listProjectFiles,
  readWorkspaceBinaryFile,
  signedWorkspaceMediaUrl,
  readWorkspaceFile,
  refreshTimeline,
  withJsonFrontmatter,
  writeWorkspaceBinaryFile,
  writeWorkspaceFile,
} from "@/lib/workspace";

const execFileAsync = promisify(execFile);
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_TARGET_BRIEF =
  "Create an analogous video for Impractical.ai that uses the source video's storytelling mechanics, pacing, shot grammar, and escalation. Reinterpret the subject as a grounded creative workflow: tactile artist actions, real materials, ordinary workspaces, and selective product/interface beats only where the source shot is already a screen or tool beat.";

type CanvasYoutubeImportPayload = {
  brief?: string | null;
  importId: string;
  projectId: string;
  remixStrength?: number | null;
  url: string;
  userId: string;
};

type TextStrategy = "aleph_repair" | "generate" | "logo_ref" | "manual_review";
type RemixStrengthMode = "ceiling" | "locked" | "target";

type CanvasYoutubeGeneratePayload = {
  importId: string;
  projectId: string;
  userId: string;
};

type RawScene = {
  description: string;
  duration: number;
  end: number;
  id: string;
  index: number;
  start: number;
  title: string;
  visibleText?: string[];
};

type PlannedShot = RawScene & {
  analogyStrategy?: string;
  allowedChanges?: string[];
  boundaryReason: string;
  contentToReplace?: string[];
  forbiddenChanges?: string[];
  generationPrompt: string;
  mode?: "change" | "preserve" | "tweak";
  preserveExactly?: string[];
  referenceIds?: string[];
  replaceOnly?: string[];
  reviewNotes?: string;
  remixStrength?: number;
  sourceSceneIds: string[];
  sourceText?: string[];
  sourceStoryRole?: string;
  structureToPreserve?: string[];
  targetContent?: string;
  targetText?: string[];
  targetStoryRole?: string;
  textStrategy?: TextStrategy;
  mustRemoveSourceText?: boolean;
};

type PlannerShot = {
  allowedChanges?: unknown;
  contentToReplace?: unknown;
  forbiddenChanges?: unknown;
  generationPrompt?: unknown;
  mode?: unknown;
  mustRemoveSourceText?: unknown;
  preserveExactly?: unknown;
  referenceIds?: unknown;
  replaceOnly?: unknown;
  reviewNotes?: unknown;
  remixStrength?: unknown;
  shotId?: unknown;
  sourceDescription?: unknown;
  sourceText?: unknown;
  sourceStoryRole?: unknown;
  structureToPreserve?: unknown;
  targetContent?: unknown;
  targetText?: unknown;
  targetStoryRole?: unknown;
  textStrategy?: unknown;
  timeRange?: unknown;
};

type DirectorBeatGroup = {
  description: string;
  reason: string;
  sceneIds: string[];
  title: string;
  visibleText: string[];
};

type ShotVideoAnalysis = {
  contentToReplace: string[];
  generationPromptGuidance?: string;
  mustRemoveSourceText: boolean;
  preserveExactly: string[];
  replaceOnly: string[];
  reviewNotes?: string;
  runningState: Record<string, unknown>;
  shotId: string;
  sourceDescription: string;
  sourceStoryRole?: string;
  structureToPreserve: string[];
  targetContent?: string;
  targetStoryRole?: string;
  targetText: string[];
  usage?: unknown;
  visibleText: string[];
};

type PlannerAssetRequest = {
  assetId?: unknown;
  description?: unknown;
  kind?: unknown;
  label?: unknown;
  neededForShots?: unknown;
  priority?: unknown;
  reason?: unknown;
};

type PlannerBlockingQuestion = {
  question?: unknown;
  reason?: unknown;
};

type PlannerPlan = {
  analogyStrategy?: unknown;
  globalStyleLock?: unknown;
  blockingQuestions?: unknown;
  optionalAssets?: unknown;
  readyToGenerate?: unknown;
  referenceStrategy?: unknown;
  remixStrength?: unknown;
  requiredAssets?: unknown;
  risks?: unknown;
  shots?: unknown;
  sourceNarrativeArc?: unknown;
  sourceProgressionPattern?: unknown;
  sourceShotGrammar?: unknown;
  targetBriefSummary?: unknown;
  targetNarrativeArc?: unknown;
  title?: unknown;
};

type NormalizedAssetRequest = {
  assetId: string;
  description: string;
  kind: string;
  label: string;
  neededForShots: string[];
  priority: string;
  reason: string;
  required: boolean;
  resolvedPath: string | null;
  status: "missing" | "resolved";
};

type NormalizedBlockingQuestion = {
  question: string;
  reason: string;
};

type NormalizedImportPlan = {
  analogyStrategy: string;
  blockingQuestions: NormalizedBlockingQuestion[];
  createdAt: string;
  id: string;
  optionalAssets: NormalizedAssetRequest[];
  readyToGenerate: boolean;
  referenceStrategy: string;
  remixStrength: number;
  requiredAssets: NormalizedAssetRequest[];
  risks: string[];
  shots: PlannedShot[];
  sourceNarrativeArc: string;
  sourceProgressionPattern: string;
  sourceShotGrammar: string[];
  targetBrief: string;
  targetBriefSummary: string;
  targetNarrativeArc: string;
  title: string;
  version: number;
};

type PlannerResult = {
  plan: NormalizedImportPlan;
  shots: PlannedShot[];
};

type WorkspaceReference = {
  kind: string;
  label: string;
  path: string;
  summary: string;
};

type FalJob = {
  clipId: string;
  duration: number;
  endpoint: string;
  falInput: Record<string, unknown>;
  index: number;
  outputPath: string;
  requestId: string;
  sourceClipId: string;
  title: string;
  trimPath: string;
};

type BoundReference = {
  assetId: string;
  kind: string;
  label: string;
  path: string;
  reason: string;
  token: string;
  value?: string;
};

type BoundFalReferences = {
  imageUrls: string[];
  prompt: string;
  references: BoundReference[];
  videoUrls: string[];
};

type FalSubmissionBuild = {
  bound: BoundFalReferences;
  endpoint: string;
  falInput: Record<string, unknown>;
};

type UploadedReference = BoundReference & {
  url?: string;
};

class AsyncSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>) {
    await new Promise<void>((resolve) => {
      if (this.active < this.limit) {
        this.active += 1;
        resolve();
        return;
      }
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "youtube"
  );
}

function clipIndex(index: number) {
  return String(index + 1).padStart(2, "0");
}

function cleanNumber(value: number, digits = 3) {
  return Number(value.toFixed(digits));
}

function positiveIntFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizeRemixStrength(value: unknown, fallback = 50) {
  const numeric = Number(value);
  const raw = Number.isFinite(numeric) ? numeric : fallback;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function defaultRemixStrength(value?: unknown) {
  return normalizeRemixStrength(value ?? process.env.CANVAS_YOUTUBE_REMIX_STRENGTH, 50);
}

function remixStrengthMode(value?: unknown): RemixStrengthMode {
  return value === "ceiling" || value === "locked" || value === "target"
    ? value
    : process.env.CANVAS_YOUTUBE_REMIX_STRENGTH_MODE === "ceiling" ||
        process.env.CANVAS_YOUTUBE_REMIX_STRENGTH_MODE === "locked" ||
        process.env.CANVAS_YOUTUBE_REMIX_STRENGTH_MODE === "target"
      ? process.env.CANVAS_YOUTUBE_REMIX_STRENGTH_MODE
      : "target";
}

function remixStrengthBand() {
  return Math.max(0, Math.min(100, positiveIntFromEnv("CANVAS_YOUTUBE_REMIX_STRENGTH_TARGET_BAND", 15)));
}

function constrainRemixStrength(value: unknown, userTarget: number, mode = remixStrengthMode()) {
  const target = normalizeRemixStrength(userTarget, 50);
  if (mode === "locked") return target;
  const raw = normalizeRemixStrength(value, target);
  if (mode === "ceiling") return Math.min(raw, target);
  const band = remixStrengthBand();
  return Math.max(Math.max(0, target - band), Math.min(Math.min(100, target + band), raw));
}

function remixControlPromptLines(defaultStrength: number, mode = remixStrengthMode()) {
  const base = [
    `- User-selected remixStrength target: ${defaultStrength} on a 0-100 scale.`,
    "- 0 means preserve the source shot almost exactly, only removing forbidden/brand content when necessary.",
    "- 25 means keep composition, motion, subject placement, and pacing very close; change only brand/text/assets.",
    "- 50 means keep pacing, layout rhythm, camera, and story role; reinterpret product/content for the target.",
    "- 75 means keep pacing, visual style, camera language, and transitions; freely redesign objects, UI, text, and scene content.",
    "- 100 means keep only timing, rhythm, camera style, and story function; replace nearly all source subject matter.",
  ];
  if (mode === "locked") {
    return [
      ...base,
      `- Remix mode is locked: every shot must set remixStrength exactly to ${defaultStrength}. Do not lower it for brand, title, or UI beats.`,
      "- Use preserveExactly, allowedChanges, forbiddenChanges, replaceOnly, and generationPrompt to express that exact freedom level.",
      "- remixStrength is a creative freedom dial, not permission to hallucinate claims, URLs, metrics, or slogans. The target brief and references still govern facts.",
    ];
  }
  if (mode === "ceiling") {
    return [
      `- User-selected remixStrength ceiling: ${defaultStrength} on a 0-100 scale.`,
      "- Each shot must set remixStrength at or below the user-selected ceiling. Never exceed the user's ceiling.",
      "- Use the ceiling as the default target freedom level. Lower per-shot values are allowed when a shot needs tighter preservation, exact brand treatment, or exact text handling.",
      ...base.slice(1),
      "- remixStrength is a creative freedom dial, not permission to hallucinate claims, URLs, metrics, or slogans. The user's ceiling always wins over planner preference.",
    ];
  }
  const band = remixStrengthBand();
  return [
    ...base,
    `- Remix mode is target: per-shot remixStrength may vary only within +/-${band} of ${defaultStrength}.`,
    `- Do not collapse below ${Math.max(0, defaultStrength - band)} or exceed ${Math.min(100, defaultStrength + band)} unless the user explicitly changes the dial.`,
    "- If a shot needs tighter exact-brand handling, express that through textStrategy/logo_ref and forbiddenChanges, not by ignoring the user's target strength.",
    "- remixStrength is a creative freedom dial, not permission to hallucinate claims, URLs, metrics, or slogans. The target brief and references still govern facts.",
  ];
}

function modeForRemixStrength(strength: number): PlannedShot["mode"] {
  if (strength <= 20) return "preserve";
  if (strength >= 70) return "change";
  return "tweak";
}

function normalizeTextStrategy(value: unknown): TextStrategy | undefined {
  return value === "aleph_repair" || value === "generate" || value === "logo_ref" || value === "manual_review"
    ? value
    : undefined;
}

function remixGuidance(strength: number) {
  if (strength <= 10) {
    return "Remix strength 0-10: preserve the source shot almost exactly; only remove forbidden source branding/text when required.";
  }
  if (strength <= 30) {
    return "Remix strength 11-30: keep composition, subject placement, camera, motion, and pacing very close; change only brand/text/assets explicitly listed.";
  }
  if (strength <= 60) {
    return "Remix strength 31-60: preserve camera, timing, layout rhythm, and story role; reinterpret product/content for the target while keeping the shot recognizable.";
  }
  if (strength <= 85) {
    return "Remix strength 61-85: preserve pacing, camera language, transitions, and visual style; freely redesign objects, UI, text, and scene content for the target.";
  }
  return "Remix strength 86-100: keep only pacing, rhythm, camera style, and story function from the source; replace nearly all subject matter with target-specific content.";
}

function sampleTimes(start: number, end: number, requestedCount: number) {
  const duration = Math.max(0, end - start);
  const count = Math.max(1, Math.floor(requestedCount));
  if (duration <= 0.2 || count === 1) return [cleanNumber(start + duration / 2)];
  const innerStart = start + Math.min(0.15, duration * 0.15);
  const innerEnd = end - Math.min(0.15, duration * 0.15);
  if (count === 2) return [cleanNumber(innerStart), cleanNumber(innerEnd)];
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / (count - 1);
    return cleanNumber(innerStart + (innerEnd - innerStart) * ratio);
  });
}

function distributeFrameCap<T>(items: T[], maxItems: number) {
  if (items.length <= maxItems) return items;
  if (maxItems <= 1) return items.slice(0, 1);
  const selected: T[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < maxItems; index += 1) {
    const sourceIndex = Math.round((index * (items.length - 1)) / (maxItems - 1));
    if (seen.has(sourceIndex)) continue;
    seen.add(sourceIndex);
    selected.push(items[sourceIndex]!);
  }
  return selected;
}

function falDuration(duration: number) {
  return String(Math.max(4, Math.min(15, Math.round(duration))));
}

function shotIdForIndex(index: number) {
  return `shot_${String(index + 1).padStart(3, "0")}`;
}

function workspacePathKind(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return "image_ref";
  if ([".mp4", ".mov", ".webm"].includes(ext)) return "video_ref";
  if ([".txt", ".md", ".json"].includes(ext)) return "text";
  return "other";
}

function mimeForWorkspacePath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mp4") return "video/mp4";
  return "application/octet-stream";
}

function configureFal() {
  if (!process.env.FAL_KEY?.trim()) {
    throw new Error("FAL_KEY is not configured.");
  }
  fal.config({ credentials: process.env.FAL_KEY });
}

async function findDownloadedSource(workDir: string) {
  const entries = await readdir(workDir);
  const source = entries.find((entry) => /^source\.(mp4|mov|webm|mkv)$/i.test(entry));
  if (!source) throw new Error("yt-dlp did not produce a source video.");
  return path.join(workDir, source);
}

export async function durationSeconds(filePath: string) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    { timeout: 30_000 },
  );
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Could not read source video duration.");
  }
  return duration;
}

export async function downloadYoutube(url: string, workDir: string) {
  await execFileAsync(
    "yt-dlp",
    [
      "-f",
      "bv*[height<=720]+ba/b[height<=720]/best[height<=720]/best",
      "--merge-output-format",
      "mp4",
      "-o",
      path.join(workDir, "source.%(ext)s"),
      url,
    ],
    { timeout: 240_000, maxBuffer: 1024 * 1024 * 12 },
  );
  return findDownloadedSource(workDir);
}

export async function detectScenes(sourcePath: string, duration: number): Promise<RawScene[]> {
  const threshold = Number(process.env.CANVAS_YOUTUBE_SCENE_THRESHOLD ?? 0.22);
  const minSceneSeconds = Number(process.env.CANVAS_YOUTUBE_MIN_SCENE_SECONDS ?? 0.75);
  const maxSceneSeconds = Number(process.env.CANVAS_YOUTUBE_MAX_SCENE_SECONDS ?? 8);
  const { stderr, stdout } = await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      sourcePath,
      "-vf",
      `select='gt(scene,${threshold})',showinfo`,
      "-an",
      "-f",
      "null",
      "-",
    ],
    { maxBuffer: 24 * 1024 * 1024 },
  );
  const cutTimes: number[] = [];
  const log = `${stdout}\n${stderr}`;
  const pattern = /pts_time:([0-9.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(log)) !== null) {
    const time = Number(match[1]);
    if (Number.isFinite(time) && time > 0.05 && time < duration - 0.05) {
      const previous = cutTimes.at(-1);
      if (previous === undefined || time - previous >= minSceneSeconds) {
        cutTimes.push(cleanNumber(time));
      }
    }
  }
  const rawBoundaries = [0, ...cutTimes, duration];
  const boundaries: number[] = [0];
  for (const rawEnd of rawBoundaries.slice(1)) {
    let previous = boundaries.at(-1) ?? 0;
    while (maxSceneSeconds > 0 && rawEnd - previous > maxSceneSeconds) {
      previous = cleanNumber(previous + maxSceneSeconds);
      boundaries.push(previous);
    }
    if (rawEnd > (boundaries.at(-1) ?? 0)) boundaries.push(rawEnd);
  }
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1]!;
    const sceneIndex = String(index + 1).padStart(3, "0");
    return {
      description: `ffmpeg scene segment from ${start.toFixed(3)}s to ${end.toFixed(3)}s.`,
      duration: cleanNumber(end - start),
      end: cleanNumber(end),
      id: `scene_${sceneIndex}`,
      index,
      start: cleanNumber(start),
      title: `Raw Scene ${sceneIndex}`,
    };
  }).filter((scene) => scene.duration > 0.05);
}

async function extractFrame(sourcePath: string, outputPath: string, seconds: number) {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-ss",
      seconds.toFixed(3),
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      "-vf",
      "scale=960:-2",
      "-q:v",
      "2",
      outputPath,
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
}

async function dataUrl(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "video/mp4";
  return `data:${mime};base64,${(await readFile(filePath)).toString("base64")}`;
}

async function writeOptionalWorkspaceFile(projectId: string, filePath: string, content: string) {
  if (process.env.CANVAS_YOUTUBE_SKIP_WORKSPACE_ANALYSIS_WRITES === "true") return;
  await writeWorkspaceFile(projectId, filePath, content);
}

function sceneMergePrompt(scenes: RawScene[]) {
  return `You are grouping deterministic ffmpeg scene cuts into director-level beats for a video mimic workflow.

You must not invent timestamps. You may only group adjacent scene IDs from the provided list.
Think like a director: merge subshots that are part of the same scene/concept/action beat.

Rules:
- Use every scene ID exactly once.
- Groups must be chronological.
- Each group must contain adjacent scene IDs only.
- Do not merge unrelated settings, subjects, or concepts.
- Do not merge across a clear medium/style change.
- If unsure, keep scenes separate.
- Prefer accurate boundaries over a target group count.
- For each group, transcribe every readable on-screen word or logo mark visible in the representative frames.
- visible_text must include brand names, logos rendered as text, URLs, captions, slogans, claims, buttons, UI labels, product names, storefront signs, supers, legal text, and any repeated words.
- Text may appear, animate, or disappear between frames. visible_text must be the deduplicated union of every distinct readable string across all frames in the grouped beat.
- Preserve exact capitalization and punctuation when readable. If partially readable, include the best-effort text with "[uncertain]" in that string.
- Do not summarize or reinterpret visible text. Return exact source text candidates only.

Scene list:
${JSON.stringify(scenes.map((scene) => ({
  description: scene.description,
  duration: scene.duration,
  end: scene.end,
  id: scene.id,
  start: scene.start,
  title: scene.title,
})), null, 2)}

Return only JSON:
{
  "groups": [
    {
      "scene_ids": ["scene_001", "scene_002"],
      "title": "short director-level beat label",
      "description": "what happens across this grouped beat",
      "visible_text": ["exact on-screen source text/logo/URL visible in this beat"],
      "reason": "why these adjacent scenes belong together"
    }
  ]
}`;
}

function parseLooseJson(value: string) {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]!.trim());
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Planner returned non-JSON content.");
  }
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

function normalizeSceneId(value: string) {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return `scene_${trimmed.padStart(3, "0")}`;
  const match = trimmed.match(/^(?:scene|shot)[_ -]?(\d+)$/i);
  if (match) return `scene_${match[1]!.padStart(3, "0")}`;
  return trimmed;
}

function cleanStringList(values: unknown[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.replace(/\s+/g, " ").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function textCandidatesFromRecord(item: Record<string, unknown>) {
  return cleanStringList([
    ...arrayOfStrings(item.visible_text),
    ...arrayOfStrings(item.visibleText),
    ...arrayOfStrings(item.on_screen_text),
    ...arrayOfStrings(item.onScreenText),
    ...arrayOfStrings(item.source_text),
    ...arrayOfStrings(item.sourceText),
    ...arrayOfStrings(item.logos),
    ...arrayOfStrings(item.urls),
    ...arrayOfStrings(item.captions),
  ]);
}

function groupScenesFromParsed(parsed: unknown, scenes: RawScene[]) {
  const rawGroups = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? ((parsed as Record<string, unknown>).groups ??
        (parsed as Record<string, unknown>).scene_groups ??
        (parsed as Record<string, unknown>).sceneGroups)
      : [];
  const sceneIds = scenes.map((scene) => scene.id);
  const sceneIdSet = new Set(sceneIds);
  const used = new Set<string>();
  const groups: DirectorBeatGroup[] = [];

  for (const rawGroup of Array.isArray(rawGroups) ? rawGroups : []) {
    const item = rawGroup && typeof rawGroup === "object" ? rawGroup as Record<string, unknown> : {};
    const rawIds = Array.isArray(item.scene_ids)
      ? item.scene_ids
      : Array.isArray(item.sceneIds)
        ? item.sceneIds
        : [];
    const ids = rawIds
      .filter((id): id is string => typeof id === "string")
      .map(normalizeSceneId)
      .filter((id) => sceneIdSet.has(id) && !used.has(id));
    if (!ids.length) continue;
    ids.sort((a, b) => sceneIds.indexOf(a) - sceneIds.indexOf(b));
    if (ids.some((id, index) => index > 0 && sceneIds.indexOf(id) !== sceneIds.indexOf(ids[index - 1]!) + 1)) {
      continue;
    }
    for (const id of ids) used.add(id);
    const memberVisibleText = ids.flatMap((id) => scenes.find((scene) => scene.id === id)?.visibleText ?? []);
    const visibleText = textCandidatesFromRecord(item);
    groups.push({
      description: typeof item.description === "string" ? item.description : "",
      reason: typeof item.reason === "string" ? item.reason : "",
      sceneIds: ids,
      title: typeof item.title === "string" ? item.title : "",
      visibleText: visibleText.length ? visibleText : cleanStringList(memberVisibleText),
    });
  }

  for (const scene of scenes) {
    if (used.has(scene.id)) continue;
    groups.push({
      description: scene.description,
      reason: "Scene was not grouped by Gemini; preserved as its own beat.",
      sceneIds: [scene.id],
      title: scene.title,
      visibleText: cleanStringList(scene.visibleText ?? []),
    });
  }
  groups.sort((a, b) => sceneIds.indexOf(a.sceneIds[0]!) - sceneIds.indexOf(b.sceneIds[0]!));
  return groups;
}

export async function groupScenes(sourcePath: string, workDir: string, scenes: RawScene[]) {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return scenes.map((scene) => ({
      description: scene.description,
      reason: "OpenRouter/Gemini unavailable; preserved raw scene as its own beat.",
      sceneIds: [scene.id],
      title: scene.title,
      visibleText: cleanStringList(scene.visibleText ?? []),
    }));
  }

  const frameDir = path.join(workDir, "merge-frames");
  await mkdir(frameDir, { recursive: true });
  const content: unknown[] = [{ type: "text", text: sceneMergePrompt(scenes) }];
  const framesPerScene = positiveIntFromEnv("CANVAS_YOUTUBE_ANALYSIS_FRAMES_PER_SCENE", 3);
  const frameRequests = scenes.flatMap((scene) =>
    sampleTimes(scene.start, scene.end, framesPerScene).map((seconds, sampleIndex) => ({
      sampleIndex,
      scene,
      seconds,
    })),
  );
  const maxFrames = positiveIntFromEnv(
    "CANVAS_YOUTUBE_MAX_MERGE_FRAMES",
    Math.max(120, frameRequests.length),
  );
  const selectedFrames = distributeFrameCap(frameRequests, maxFrames);
  for (const frame of selectedFrames) {
    const framePath = path.join(frameDir, `${frame.scene.id}_${String(frame.sampleIndex + 1).padStart(2, "0")}.jpg`);
    await extractFrame(sourcePath, framePath, frame.seconds);
    content.push(
      {
        type: "text",
        text: [
          `Representative frame ${frame.sampleIndex + 1} for ${frame.scene.id}`,
          `sceneRange=${frame.scene.start.toFixed(3)}s-${frame.scene.end.toFixed(3)}s`,
          `timestamp=${frame.seconds.toFixed(3)}s`,
          "Transcribe any readable text visible in this frame into that scene/group's visible_text.",
        ].join(" | "),
      },
      { type: "image_url", image_url: { url: await dataUrl(framePath) } },
    );
  }
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost/video-fs-agent",
      "X-Title": "video-fs-agent canvas youtube import",
    },
    body: JSON.stringify({
      max_tokens: 12000,
      messages: [{ role: "user", content }],
      model: process.env.CANVAS_YOUTUBE_OPENROUTER_MODEL || "google/gemini-3-flash-preview",
      response_format: { type: "json_object" },
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenRouter scene grouping failed (${response.status}): ${text.slice(0, 1000)}`);
  }
  const payload = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    error?: { message?: string };
  };
  if (payload.error) throw new Error(`OpenRouter scene grouping failed: ${payload.error.message}`);
  return groupScenesFromParsed(parseLooseJson(messageText(payload.choices?.[0]?.message?.content)), scenes);
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function targetBriefForImport(brief?: string | null) {
  return brief?.trim() || process.env.CANVAS_YOUTUBE_DEFAULT_TARGET_BRIEF || DEFAULT_TARGET_BRIEF;
}

function textPreview(value: string | undefined, fallback = "") {
  return (value ?? fallback).replace(/\s+/g, " ").trim().slice(0, 280);
}

function firstMarkdownHeading(content: string | undefined, fallback: string) {
  const line = content?.split(/\r?\n/).find((item) => item.startsWith("# "));
  return line?.slice(2).trim() || fallback;
}

function referenceKindForPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return "image_ref";
  if ([".mp4", ".mov", ".webm"].includes(ext)) return "video_ref";
  if ([".md", ".json", ".txt"].includes(ext)) return "text";
  return "other";
}

export function workspaceReferenceCatalog(
  files: Awaited<ReturnType<typeof listProjectFiles>>,
): WorkspaceReference[] {
  const candidates = files
    .filter((file) =>
      (
        file.path.startsWith("references/") ||
        file.path.startsWith("assets/") ||
        file.path.startsWith("media/") ||
        file.path.startsWith("clips/")
      ) &&
      !file.path.startsWith("media/clips/") &&
      !file.path.includes("/youtube/") &&
      !file.path.startsWith("requirements/") &&
      !file.path.startsWith("plans/"),
    )
    .slice(0, Number(process.env.CANVAS_YOUTUBE_MAX_WORKSPACE_REFERENCES ?? 80));
  return candidates.map((file) => {
    const fileName = path.basename(file.path);
    const label = firstMarkdownHeading(file.content, fileName);
    return {
      kind: referenceKindForPath(file.path),
      label,
      path: file.path,
      summary: textPreview(file.content, file.kind === "media" ? "uploaded media asset" : label),
    };
  });
}

function timeRangeForShot(shot: PlannedShot) {
  return `${shot.start.toFixed(3)}s-${shot.end.toFixed(3)}s`;
}

function buildPlannerPrompt(input: {
  defaultRemixStrength: number;
  sourceDuration: number;
  shots: PlannedShot[];
  targetBrief: string;
  workspaceReferences: WorkspaceReference[];
}) {
  return [
    "You are a senior video creative director and generation-prompt planner.",
    "",
    "TASK:",
    "Watch the attached source video. Treat it as a storytelling template that a user wants to mimic for their own company/product/story.",
    "The user is NOT asking for literal object swaps. They want an analogous video: same storytelling mechanics, pacing, shot grammar, and escalation, re-instantiated with a new subject.",
    "",
    "TARGET BRIEF:",
    input.targetBrief,
    "",
    "REMIX CONTROL:",
    ...remixControlPromptLines(input.defaultRemixStrength),
    "- Pair remixStrength with allowedChanges and forbiddenChanges so downstream generation knows what is allowed to move.",
    "- Choose textStrategy per shot: logo_ref for target wordmarks/brand names, generate for non-critical atmospheric text, aleph_repair for in-scene/moving text that must be exact after generation, manual_review when exact text is critical but no reliable automatic repair is available.",
    "",
    "AVAILABLE WORKSPACE REFERENCES:",
    input.workspaceReferences.length
      ? JSON.stringify(input.workspaceReferences, null, 2)
      : "- none provided in this import.",
    "",
    "WORKSPACE REFERENCE RULES:",
    "- The paths above are durable workspace files the user already uploaded or created.",
    "- If an available workspace reference satisfies a need, do not request it again. Use its exact path in referenceIds and describe how it should be used.",
    "- If a workspace file is only partially sufficient, use it and request only the missing asset or decision.",
    "- Never invent referenceIds. Use only paths from AVAILABLE WORKSPACE REFERENCES.",
    "- referenceIds must be exact existing reference paths or exact resolved asset IDs already present in the plan/requirements. Do not emit generic semantic IDs such as product-ui-examples, brand-logo, app-demo, style-reference, or similar placeholders.",
    "- If a workspace reference is clearly a desired style/example clip, use it as a style reference in referenceStrategy/reviewNotes and, where useful, in referenceIds. Do not ignore explicit style examples.",
    "- If a workspace reference is a logo/brand mark for the target company, use that exact referenceId for intentional target brand marks, title cards, outro cards, product cards, or logo replacement beats. Do not use the target logo merely to cover a source watermark.",
    "- If a workspace reference is an app screen recording, demo recording, dashboard recording, or product UI reference, use that exact referenceId for shots that show product UI, devices, dashboards, screen content, workflow/library interfaces, or demo output. Do not hallucinate the product UI when a reference exists.",
    "",
    "SOURCE VIDEO METADATA:",
    `- durationSeconds: ${cleanNumber(input.sourceDuration, 2)}`,
    "",
    "AUTHORITATIVE SHOT / BEAT LIST:",
    "These timestamps come from ffmpeg scene cuts plus adjacent-ID director grouping. You must use these IDs and time ranges exactly. Do not invent timestamps or skip IDs.",
    `Required shot count: ${input.shots.length}`,
    `Required shot IDs in exact order: ${input.shots.map((shot) => shot.id).join(", ")}`,
    JSON.stringify(
      input.shots.map((shot) => ({
        boundaryReason: shot.boundaryReason,
        allowedChanges: shot.allowedChanges ?? [],
        contentToReplace: shot.contentToReplace ?? [],
        description: shot.description,
        duration: cleanNumber(shot.duration),
        end: cleanNumber(shot.end),
        forbiddenChanges: shot.forbiddenChanges ?? [],
        id: shot.id,
        preserveExactly: shot.preserveExactly ?? [],
        replaceOnly: shot.replaceOnly ?? [],
        reviewNotes: shot.reviewNotes,
        remixStrength: shot.remixStrength ?? input.defaultRemixStrength,
        sourceStoryRole: shot.sourceStoryRole,
        start: cleanNumber(shot.start),
        structureToPreserve: shot.structureToPreserve ?? [],
        targetContent: shot.targetContent,
        targetStoryRole: shot.targetStoryRole,
        targetText: shot.targetText ?? [],
        textStrategy: shot.textStrategy,
        timeRange: timeRangeForShot(shot),
        title: shot.title,
        visibleText: cleanStringList([...(shot.visibleText ?? []), ...(shot.sourceText ?? [])]),
      })),
      null,
      2,
    ),
    "",
    "PLANNING RULES:",
    "- First infer the source video's abstract narrative arc. Do not start by replacing objects.",
    "- If the authoritative shot list includes sourceStoryRole, structureToPreserve, contentToReplace, targetContent, targetText, or reviewNotes from the per-shot video analyzer, treat those as grounded evidence from Gemini's shot-level video pass.",
    "- For every shot, choose remixStrength first. Then choose preserveExactly, allowedChanges, forbiddenChanges, replaceOnly, targetContent, targetText, textStrategy, and generationPrompt to match that strength.",
    "- Lower remixStrength values must produce more restrictive preserveExactly/replaceOnly lists. Higher remixStrength values may use broader allowedChanges but must still preserve the requested pacing/style/story role.",
    "- Preserve the structural spine: pacing, shot order logic, POV/hand grammar when present, escalation curve, and reveal mechanics.",
    "- Reinterpret semantic content for the target brief.",
    "- Treat source product/category specifics as placeholders unless the target brief explicitly wants them. Do not preserve source-specific domains like translation, books, lessons, credits, language learning, source user names, source file names, or source dashboard labels except as timing/layout mechanics to replace.",
    "- Think in terms of pacing, style, layout rhythm, camera motion, transitions, and story function first; only then choose target-specific Impractical.ai content that fits those beats.",
    "- Avoid generic marketing filler. Every target shot must map to a source shot's story role.",
    "- Default to grounded, concrete target visuals that fit the source shot's real-world camera, lighting, lens, scale, hand placement, and material constraints. Prefer physical objects, real locations, ordinary devices, paper, screens, tools, props, and surfaces over abstract metaphors.",
    "- The target brief must identify the product/offer, audience, 3-5 core claims/features, approved wording/taglines, brand/visual rules when relevant, CTA URLs when the source has an end-card URL, and forbidden claims/phrases. If those are missing, set readyToGenerate=false and ask blockingQuestions. Do not invent product positioning.",
    "- Do not coin campaign concepts, slogans, brand colors, launch dates, URLs, or category claims unless the target brief or workspace references explicitly provide them. If you have an idea, ask as a blocking question.",
    "- If brand colors, CTA URLs, or approved slogans are missing, blockingQuestions may ask for them, but analogyStrategy, targetContent, targetText, and generationPrompt must remain neutral and must not include guessed colors, fake URLs, provisional slogans, or coined campaign names.",
    "- Forbidden phrases/concepts may appear only in sourceText when copied from the source video or inside the targetBrief. They must not appear in targetText, targetContent, analogyStrategy, reviewNotes, or generationPrompt.",
    "- If a style reference is provided, match its visual language before matching generic source-video aesthetics.",
    "- For every shot, decide preserveExactly before writing targetContent. The target content must fit inside the original shot's camera position, shot size, hand placement, lens feel, motion, and timing.",
    "- For every shot, decide replaceOnly. Do not replace unrelated source structure just because the subject changes.",
    "- Produce exactly one plan row per authoritative shot/beat ID above.",
    `- The shots array length must be exactly ${input.shots.length}.`,
    `- The shots array must contain exactly these shotIds in order: ${input.shots.map((shot) => shot.id).join(", ")}.`,
    "- Use the provided shot IDs exactly, such as shot_001. Do not rename them to shot-001.",
    "- Use the provided timeRange strings exactly. Copy them verbatim, including the trailing 's'.",
    "- Do not merge, split, reorder, skip, or invent shots in this planning step.",
    "- Each row should describe one generatable clip. If a provided beat still contains rapid internal cuts, flag that in reviewNotes instead of hiding it.",
    "- Keep prompts aligned with successful Seedance tests: concise, directive, source-video-as-structure for skeleton-preserving shots.",
    "- Most generation prompts should start from the source shot as the structural reference. Say what to keep from @Video1, then state exactly what to replace or reinterpret.",
    "- Use this prompt grammar whenever possible: 'Use @Video1 as the exact camera/framing/motion/timing reference. Preserve [preserveExactly]. Replace only [replaceOnly] with [grounded target content]. Keep [camera/hand motion/pacing/composition]. Do not include [source brand/product/subject content].'",
    "- Avoid vague prompts that only say 'in the style of @Video1'.",
    "- Avoid aesthetic escalation words unless they are visible in the source shot. Banned words in generationPrompt unless directly describing a visible source element: futuristic, holographic, glowing, nebula, particle, floating interface, complex digital workstation, cinematic future, 3D digital scene, sci-fi.",
    "- Digital/product UI is allowed only when the source shot is already a screen/tool beat or when an explicit workspace reference/target brief requires it. Even then, preserve the source shot's real camera/framing and avoid futuristic UI invention.",
    "- Avoid prompts that contain numbered sub-shots, rapid montages, or multiple unrelated camera setups inside one generationPrompt.",
    "- Do not write generic standalone text-to-video prompts unless the target shot intentionally abandons the source shot structure.",
    "- Prefer source-video conditioning for shots that preserve the source composition/motion skeleton.",
    "- If a shot should change substantially, still describe what structure from the source should remain.",
    "- If a shot needs a video reference, describe the concrete target object/action from that reference and where it belongs in the source composition. Do not force video references into unrelated shots.",
    "- For reference binding, name exact referenceIds and state what visual details must carry through. The system will attach referenced media and convert them into @Image/@Video tokens after planning.",
    "- Source shots that are primarily logo/title cards, kinetic typography, URL cards, or text-on-solid-background are high risk for source text leakage. Keep target text short, explicit, and grounded in targetText; do not invent campaign concepts or URLs.",
    "- The AUTHORITATIVE SHOT / BEAT LIST includes visibleText from the video-analysis pass. Treat visibleText as exact source text/logo/URL candidates that may need replacement.",
    "- For every shot, copy all relevant visibleText items into sourceText, adding any additional exact source text/logos you can read from the attached frames/video. If no text/logos are visible, use an empty array.",
    "- Do not summarize sourceText. It must contain exact source words, logos, URLs, captions, claims, UI labels, or signage that appear in the source.",
    "- For every sourceText item that must disappear, provide exact replacement copy in targetText and set mustRemoveSourceText=true.",
    "- For text-heavy kinetic typography or logo/title cards, keep targetText short and exact, and write generationPrompt as a practical large-type replacement instruction. Exact text still belongs in targetText for audit.",
    "- Remove ALL source brand names, logos, URLs, claims, and campaign language unless the user explicitly asks to keep them.",
    "- Persistent source watermarks/corner marks must be called out explicitly in generationPrompt: blank, clean, or remove the persistent source watermark/logo in every frame. Do not replace corner watermarks with the target logo unless the shot is intentionally a brand/title/outro beat.",
    "- Generation prompts should be practical Seedance prompts. No long essays, no hidden planning prose, no markdown.",
    "",
    "ASSET REQUEST RULES:",
    "- If the target brief needs concrete user-specific material that is not visible in the source video and not provided in references, request it instead of hallucinating it.",
    "- Request assets for logos, product screenshots, app screen recordings, slogans, metrics, testimonials, brand rules, product names, and exact on-screen text.",
    "- Tie every asset request to the exact shot IDs where it will be used.",
    "- Tag each asset kind as one of: image_ref, video_ref, on_screen_text, metric, slogan, brand_rule, other.",
    "- If any required asset or blocking creative decision is missing, set readyToGenerate=false. Do not pretend the plan is ready.",
    "- Optional assets may improve quality but must not block generation.",
    "",
    "OUTPUT STRICT JSON ONLY. No prose outside JSON.",
    "Schema:",
    JSON.stringify(
      {
        analogyStrategy: "string",
        blockingQuestions: [
          {
            question: "creative decision needed from the user",
            reason: "why the planner cannot decide this safely",
          },
        ],
        globalStyleLock: "string",
        optionalAssets: [
          {
            assetId: "optional-short-id",
            description: "nice-to-have asset",
            kind: "image_ref|video_ref|on_screen_text|metric|slogan|brand_rule|other",
            label: "human label",
            neededForShots: ["shot_004"],
            priority: "low|medium|high",
            reason: "why it would help",
          },
        ],
        readyToGenerate: false,
        referenceStrategy: "string",
        remixStrength: input.defaultRemixStrength,
        requiredAssets: [
          {
            assetId: "product-demo-reference",
            description: "video or image reference needed to ground a product-specific visual",
            kind: "video_ref",
            label: "Product demo reference",
            neededForShots: ["shot_004", "shot_008"],
            priority: "high",
            reason: "needed to ground the concrete target product visual",
          },
        ],
        risks: ["string"],
        shots: [
          {
            contentToReplace: ["source-specific content to remove or reinterpret"],
            allowedChanges: ["brand_text", "logo", "product_ui"],
            forbiddenChanges: ["source watermark", "source URL", "misspelled target brand"],
            generationPrompt: "final concise prompt for this shot; mention @Video1 for source-structure preservation",
            mode: "preserve|tweak|change",
            preserveExactly: ["explicit visual structure that must remain identical from @Video1"],
            referenceIds: [],
            replaceOnly: ["specific source object/text/subject to replace, not the whole shot"],
            reviewNotes: "why this is analogous and what to inspect before generation",
            remixStrength: input.defaultRemixStrength,
            shotId: "shot_001",
            sourceDescription: "what is visibly happening",
            sourceText: ["exact visible source text or logo, copied verbatim"],
            sourceStoryRole: "why this shot exists in the source story",
            structureToPreserve: ["camera angle", "motion/timing", "composition", "transition role"],
            targetContent: "specific target content for the user's target brief",
            targetText: ["exact replacement text for this shot"],
            targetStoryRole: "analogous role in the target story",
            textStrategy: "logo_ref|generate|aleph_repair|manual_review",
            mustRemoveSourceText: true,
            timeRange: "0.000s-4.200s",
          },
        ],
        sourceNarrativeArc: "string",
        sourceProgressionPattern: "string",
        sourceShotGrammar: ["string"],
        targetBriefSummary: "string",
        targetNarrativeArc: "string",
        title: "string",
      },
      null,
      2,
    ),
  ].join("\n");
}

async function extractPlanningFrames(sourcePath: string, workDir: string, shots: PlannedShot[]) {
  const dir = path.join(workDir, "planning-frames");
  await mkdir(dir, { recursive: true });
  const framesPerShot = positiveIntFromEnv("CANVAS_YOUTUBE_PLANNING_FRAMES_PER_SHOT", 3);
  const frameRequests = shots.flatMap((shot) =>
    sampleTimes(shot.start, shot.end, framesPerShot).map((seconds, sampleIndex) => ({
      end: shot.end,
      id: shot.id,
      sampleIndex,
      seconds,
      start: shot.start,
    })),
  );
  const maxFrames = positiveIntFromEnv(
    "CANVAS_YOUTUBE_MAX_PLANNING_FRAMES",
    Math.max(120, frameRequests.length),
  );
  const frames: Array<{ end: number; id: string; path: string; sampleIndex: number; seconds: number; start: number }> = [];
  for (const frame of distributeFrameCap(frameRequests, maxFrames)) {
    const framePath = path.join(dir, `${frame.id}_${String(frame.sampleIndex + 1).padStart(2, "0")}.jpg`);
    await extractFrame(sourcePath, framePath, frame.seconds);
    frames.push({ ...frame, path: framePath });
  }
  return frames;
}

function normalizePlannerShot(raw: PlannerShot, fallback: PlannedShot, analogyStrategy: string): PlannedShot {
  const remixStrength = constrainRemixStrength(raw.remixStrength, fallback.remixStrength ?? 50);
  const mode = raw.mode === "preserve" || raw.mode === "tweak" || raw.mode === "change"
    ? raw.mode
    : modeForRemixStrength(remixStrength);
  const generationPrompt =
    typeof raw.generationPrompt === "string" && raw.generationPrompt.trim()
      ? raw.generationPrompt.trim()
      : fallback.generationPrompt;
  const fallbackSourceText = cleanStringList([...(fallback.sourceText ?? []), ...(fallback.visibleText ?? [])]);
  const sourceText = arrayOfStrings(raw.sourceText);
  return {
    ...fallback,
    analogyStrategy,
    allowedChanges: arrayOfStrings(raw.allowedChanges),
    contentToReplace: arrayOfStrings(raw.contentToReplace),
    description:
      typeof raw.sourceDescription === "string" && raw.sourceDescription.trim()
        ? raw.sourceDescription.trim()
        : fallback.description,
    forbiddenChanges: arrayOfStrings(raw.forbiddenChanges),
    generationPrompt,
    mode,
    mustRemoveSourceText: raw.mustRemoveSourceText === true,
    preserveExactly: arrayOfStrings(raw.preserveExactly),
    referenceIds: arrayOfStrings(raw.referenceIds),
    replaceOnly: arrayOfStrings(raw.replaceOnly),
    reviewNotes: typeof raw.reviewNotes === "string" ? raw.reviewNotes : undefined,
    remixStrength,
    sourceText: sourceText.length ? sourceText : fallbackSourceText,
    sourceStoryRole: typeof raw.sourceStoryRole === "string" ? raw.sourceStoryRole : undefined,
    structureToPreserve: arrayOfStrings(raw.structureToPreserve),
    targetContent: typeof raw.targetContent === "string" ? raw.targetContent : undefined,
    targetText: arrayOfStrings(raw.targetText),
    targetStoryRole: typeof raw.targetStoryRole === "string" ? raw.targetStoryRole : undefined,
    textStrategy: normalizeTextStrategy(raw.textStrategy) ?? fallback.textStrategy,
  };
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function safeFileStem(value: string, fallback: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || fallback
  );
}

function normalizeAssetKind(value: unknown) {
  const kind = stringValue(value, "other");
  return [
    "image_ref",
    "video_ref",
    "on_screen_text",
    "metric",
    "slogan",
    "brand_rule",
    "other",
  ].includes(kind)
    ? kind
    : "other";
}

function normalizeAssetPriority(value: unknown) {
  const priority = stringValue(value, "medium").toLowerCase();
  return ["low", "medium", "high"].includes(priority) ? priority : "medium";
}

function normalizeAssetRequest(
  rawValue: unknown,
  index: number,
  required: boolean,
  shotIds: Set<string>,
): NormalizedAssetRequest {
  const raw = rawValue && typeof rawValue === "object" ? rawValue as PlannerAssetRequest : {};
  const label = stringValue(raw.label, required ? `Required asset ${index + 1}` : `Optional asset ${index + 1}`);
  const assetId = safeFileStem(stringValue(raw.assetId, label), `asset-${index + 1}`);
  const neededForShots = arrayOfStrings(raw.neededForShots).filter((shotId) => shotIds.has(shotId));
  return {
    assetId,
    description: stringValue(raw.description, label),
    kind: normalizeAssetKind(raw.kind),
    label,
    neededForShots,
    priority: normalizeAssetPriority(raw.priority),
    reason: stringValue(raw.reason, required ? "Needed before generation." : "Could improve generation quality."),
    required,
    resolvedPath: null,
    status: "missing",
  };
}

function referenceMatchesAssetKind(assetKind: string, referencePath: string) {
  const kind = referenceKindForPath(referencePath);
  if (assetKind === "image_ref") return kind === "image_ref";
  if (assetKind === "video_ref") return kind === "video_ref";
  if (assetKind === "brand_rule") return kind === "text";
  if (assetKind === "other") return true;
  return false;
}

function comparableToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function referenceLooksLikeAsset(asset: NormalizedAssetRequest, referencePath: string) {
  const haystack = comparableToken(referencePath);
  const needles = [
    asset.assetId,
    asset.label,
    asset.description,
  ]
    .map(comparableToken)
    .filter((item) => item.length >= 4);
  return needles.some((needle) => haystack.includes(needle) || needle.includes(haystack));
}

function resolveAssetFromBoundReferences(
  asset: NormalizedAssetRequest,
  shots: PlannedShot[],
): NormalizedAssetRequest {
  if (asset.status === "resolved" && asset.resolvedPath) return asset;
  const neededShotIds = new Set(asset.neededForShots);
  const scopedShots = neededShotIds.size
    ? shots.filter((shot) => neededShotIds.has(shot.id))
    : shots;
  const candidates = new Map<string, number>();
  for (const shot of scopedShots) {
    for (const referencePath of shot.referenceIds ?? []) {
      if (!referenceMatchesAssetKind(asset.kind, referencePath)) continue;
      candidates.set(referencePath, (candidates.get(referencePath) ?? 0) + 1);
    }
  }
  const sorted = [...candidates.entries()].sort((a, b) => b[1] - a[1]);
  const matched = sorted.find(([referencePath]) => referenceLooksLikeAsset(asset, referencePath))?.[0];
  const fallback = sorted.length === 1 ? sorted[0]?.[0] : undefined;
  const resolvedPath = matched ?? fallback;
  return resolvedPath
    ? { ...asset, resolvedPath, status: "resolved" }
    : asset;
}

function resolveAssetsFromBoundReferences(
  assets: NormalizedAssetRequest[],
  shots: PlannedShot[],
) {
  return assets.map((asset) => resolveAssetFromBoundReferences(asset, shots));
}

function normalizeBlockingQuestions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): NormalizedBlockingQuestion | null => {
      if (!item || typeof item !== "object") return null;
      const raw = item as PlannerBlockingQuestion;
      const question = stringValue(raw.question);
      if (!question) return null;
      return {
        question,
        reason: stringValue(raw.reason, "The planner needs this decision before generation."),
      };
    })
    .filter((item): item is NormalizedBlockingQuestion => Boolean(item));
}

function fallbackImportPlan(input: {
  blockingReason?: string;
  remixStrength?: number;
  importId: string;
  shots: PlannedShot[];
  targetBrief: string;
}): NormalizedImportPlan {
  const remixStrength = defaultRemixStrength(input.remixStrength);
  const blockingQuestions = input.blockingReason
    ? [{ question: "Review or rerun the import planner before generation.", reason: input.blockingReason }]
    : [];
  return {
    analogyStrategy: "",
    blockingQuestions,
    createdAt: new Date().toISOString(),
    id: input.importId,
    optionalAssets: [],
    readyToGenerate: false,
    referenceStrategy: "Use each source clip as the direct motion/framing reference for its generated shot.",
    remixStrength,
    requiredAssets: [],
    risks: [],
    shots: input.shots.map((shot) => ({ ...shot, remixStrength: shot.remixStrength ?? remixStrength })),
    sourceNarrativeArc: "",
    sourceProgressionPattern: "",
    sourceShotGrammar: [],
    targetBrief: input.targetBrief,
    targetBriefSummary: input.targetBrief,
    targetNarrativeArc: "",
    title: "YouTube mimic import plan",
    version: 1,
  };
}

function normalizeImportPlan(
  parsed: PlannerPlan,
  input: {
    importId: string;
    remixStrength: number;
    shots: PlannedShot[];
    targetBrief: string;
  },
): NormalizedImportPlan {
  const remixStrength = constrainRemixStrength(parsed.remixStrength, input.remixStrength);
  const shotIds = new Set(input.shots.map((shot) => shot.id));
  const requiredAssets = resolveAssetsFromBoundReferences(Array.isArray(parsed.requiredAssets)
    ? parsed.requiredAssets.map((asset, index) => normalizeAssetRequest(asset, index, true, shotIds))
    : [], input.shots);
  const optionalAssets = resolveAssetsFromBoundReferences(Array.isArray(parsed.optionalAssets)
    ? parsed.optionalAssets.map((asset, index) => normalizeAssetRequest(asset, index, false, shotIds))
    : [], input.shots);
  const blockingQuestions = normalizeBlockingQuestions(parsed.blockingQuestions);
  const plannerReady = parsed.readyToGenerate === true;
  const missingRequiredAssets = requiredAssets.filter((asset) => asset.status !== "resolved");
  return {
    analogyStrategy: stringValue(parsed.analogyStrategy),
    blockingQuestions,
    createdAt: new Date().toISOString(),
    id: input.importId,
    optionalAssets,
    readyToGenerate: plannerReady && missingRequiredAssets.length === 0 && blockingQuestions.length === 0,
    referenceStrategy: stringValue(parsed.referenceStrategy),
    remixStrength,
    requiredAssets,
    risks: arrayOfStrings(parsed.risks),
    shots: input.shots.map((shot) => ({ ...shot, remixStrength: shot.remixStrength ?? remixStrength })),
    sourceNarrativeArc: stringValue(parsed.sourceNarrativeArc),
    sourceProgressionPattern: stringValue(parsed.sourceProgressionPattern),
    sourceShotGrammar: arrayOfStrings(parsed.sourceShotGrammar),
    targetBrief: input.targetBrief,
    targetBriefSummary: stringValue(parsed.targetBriefSummary, input.targetBrief),
    targetNarrativeArc: stringValue(parsed.targetNarrativeArc),
    title: stringValue(parsed.title, "YouTube mimic import plan"),
    version: 1,
  };
}

export async function planShotsWithOpenRouter(input: {
  importId: string;
  projectId: string;
  remixStrength?: number;
  sourceDuration: number;
  sourcePath: string;
  shots: PlannedShot[];
  targetBrief: string;
  workDir: string;
  workspaceReferences: WorkspaceReference[];
}): Promise<PlannerResult> {
  const remixStrength = defaultRemixStrength(input.remixStrength);
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    const plan = fallbackImportPlan({
      blockingReason: "OPENROUTER_API_KEY is not configured, so the full adaptation planner could not run.",
      importId: input.importId,
      remixStrength,
      shots: input.shots,
      targetBrief: input.targetBrief,
    });
    return { plan, shots: input.shots };
  }
  const prompt = buildPlannerPrompt({
    defaultRemixStrength: remixStrength,
    sourceDuration: input.sourceDuration,
    shots: input.shots,
    targetBrief: input.targetBrief,
    workspaceReferences: input.workspaceReferences,
  });
  await writeFile(path.join(input.workDir, "planner-prompt.txt"), prompt);
  await writeOptionalWorkspaceFile(
    input.projectId,
    `analysis/youtube/${safeFileStem(input.importId, "import")}/planner-prompt.txt`,
    prompt,
  );
  const frames = await extractPlanningFrames(input.sourcePath, input.workDir, input.shots);
  const content: unknown[] = [{ type: "text", text: prompt }];
  for (const frame of frames) {
    content.push(
      {
        type: "text",
        text: [
          `Representative frame ${frame.sampleIndex + 1} for ${frame.id}`,
          `shotRange=${frame.start.toFixed(3)}s-${frame.end.toFixed(3)}s`,
          `timestamp=${frame.seconds.toFixed(3)}s`,
          "Use this as labeled visual evidence for that exact shot ID, including any source text visible only at this timestamp.",
        ].join(" | "),
      },
      { type: "image_url", image_url: { url: await dataUrl(frame.path) } },
    );
  }
  content.push({ type: "video_url", video_url: { url: await dataUrl(input.sourcePath) } });

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost/video-fs-agent",
      "X-Title": "video-fs-agent canvas youtube planner",
    },
    body: JSON.stringify({
      max_tokens: Number(process.env.CANVAS_YOUTUBE_PLANNER_MAX_TOKENS ?? 16000),
      messages: [{ role: "user", content }],
      model: process.env.CANVAS_YOUTUBE_OPENROUTER_MODEL || "google/gemini-3-flash-preview",
      response_format: { type: "json_object" },
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenRouter planning failed (${response.status}): ${text.slice(0, 1000)}`);
  }
  const payload = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    error?: { message?: string };
  };
  if (payload.error) throw new Error(`OpenRouter planning failed: ${payload.error.message}`);
  const raw = messageText(payload.choices?.[0]?.message?.content);
  await writeFile(path.join(input.workDir, "planner-raw-response.txt"), raw);
  await writeOptionalWorkspaceFile(
    input.projectId,
    `analysis/youtube/${safeFileStem(input.importId, "import")}/planner-raw-response.txt`,
    raw,
  );
  const plan = parseLooseJson(raw) as PlannerPlan;
  const rawShots = Array.isArray(plan.shots) ? plan.shots : [];
  const rowsById = new Map<string, PlannerShot>();
  for (const rawShot of rawShots) {
    const row = rawShot && typeof rawShot === "object" ? rawShot as PlannerShot : {};
    if (typeof row.shotId === "string") rowsById.set(row.shotId, row);
  }
  const analogyStrategy = typeof plan.analogyStrategy === "string" ? plan.analogyStrategy : "";
  const planned = input.shots.map((shot) => {
    const row = rowsById.get(shot.id);
    return row ? normalizePlannerShot(row, shot, analogyStrategy) : shot;
  });
  const normalizedPlan = normalizeImportPlan(plan, {
    importId: input.importId,
    remixStrength,
    shots: planned,
    targetBrief: input.targetBrief,
  });
  await writeFile(path.join(input.workDir, "planner-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  await writeFile(path.join(input.workDir, "planner-normalized-plan.json"), `${JSON.stringify(normalizedPlan, null, 2)}\n`);
  await writeOptionalWorkspaceFile(
    input.projectId,
    `analysis/youtube/${safeFileStem(input.importId, "import")}/planner-normalized-plan.json`,
    `${JSON.stringify(normalizedPlan, null, 2)}\n`,
  );
  return { plan: normalizedPlan, shots: planned };
}

export function plannedShotsFromGroups(
  groups: DirectorBeatGroup[],
  scenes: RawScene[],
): PlannedShot[] {
  const maxShotSeconds = Number(process.env.CANVAS_YOUTUBE_MAX_SHOT_SECONDS ?? 8);
  const remixStrength = defaultRemixStrength();
  const expandedGroups = groups.flatMap((group): DirectorBeatGroup[] => {
    if (!(maxShotSeconds > 0)) return [group];
    const chunks: DirectorBeatGroup[] = [];
    let currentIds: string[] = [];
    let currentDuration = 0;
    for (const sceneId of group.sceneIds) {
      const scene = scenes.find((item) => item.id === sceneId);
      if (!scene) continue;
      if (currentIds.length && currentDuration + scene.duration > maxShotSeconds) {
        chunks.push({
          ...group,
          reason: `${group.reason || "Grouped adjacent scene cuts into one director-level beat."} Split to keep generated shot duration under ${maxShotSeconds}s.`,
          sceneIds: currentIds,
          title: chunks.length ? `${group.title} part ${chunks.length + 1}` : group.title,
        });
        currentIds = [];
        currentDuration = 0;
      }
      currentIds.push(sceneId);
      currentDuration += scene.duration;
    }
    if (currentIds.length) {
      chunks.push({
        ...group,
        reason: chunks.length
          ? `${group.reason || "Grouped adjacent scene cuts into one director-level beat."} Split to keep generated shot duration under ${maxShotSeconds}s.`
          : group.reason,
        sceneIds: currentIds,
        title: chunks.length ? `${group.title} part ${chunks.length + 1}` : group.title,
      });
    }
    return chunks.length ? chunks : [group];
  });
  return expandedGroups.map((group, index) => {
    const members = group.sceneIds
      .map((id) => scenes.find((scene) => scene.id === id))
      .filter((scene): scene is RawScene => Boolean(scene));
    const first = members[0]!;
    const last = members[members.length - 1]!;
    const title = group.title || `Shot ${clipIndex(index)}`;
    const description = group.description || members.map((scene) => scene.description).join(" ");
    const visibleText = cleanStringList([
      ...group.visibleText,
      ...members.flatMap((scene) => scene.visibleText ?? []),
    ]);
    return {
      allowedChanges: ["brand_text", "logo", "source_specific_content"],
      boundaryReason: group.reason || "Grouped adjacent scene cuts into one director-level beat.",
      description,
      duration: cleanNumber(last.end - first.start),
      end: last.end,
      forbiddenChanges: ["source watermark", "source URL", "misspelled target brand"],
      generationPrompt: [
        "Use @Video1 as the exact camera/framing/motion/timing reference.",
        `Preserve the source shot structure: ${description}`,
        "Replace only source-specific brand/product/person content if needed; keep the hand motion, camera move, pacing, and composition grounded in the reference.",
        "Create a clean, production-ready video clip with no captions, watermarks, or UI overlays unless they are visibly part of the reference shot.",
      ].join(" "),
      id: `shot_${String(index + 1).padStart(3, "0")}`,
      index,
      mode: modeForRemixStrength(remixStrength),
      remixStrength,
      sourceSceneIds: members.map((scene) => scene.id),
      sourceText: visibleText,
      start: first.start,
      title,
      visibleText,
    };
  });
}

function shotVideoAnalysisPrompt(input: {
  priorAnalyses: ShotVideoAnalysis[];
  runningState: Record<string, unknown>;
  shot: PlannedShot;
  targetBrief: string;
}) {
  return [
    "You are the shot-by-shot video analyst for a video mimic/adaptation pipeline.",
    "You will receive exactly one source shot clip as video. Analyze the actual video over time, not just the first frame.",
    "",
    "TARGET BRIEF:",
    input.targetBrief,
    "",
    "CURRENT SHOT:",
    JSON.stringify({
      description: input.shot.description,
      duration: input.shot.duration,
      id: input.shot.id,
      timeRange: timeRangeForShot(input.shot),
      title: input.shot.title,
      visibleTextFromFrameSampler: input.shot.visibleText ?? input.shot.sourceText ?? [],
    }, null, 2),
    "",
    "RUNNING ADAPTATION STATE FROM PRIOR SHOTS:",
    JSON.stringify(input.runningState, null, 2),
    "",
    "PRIOR SHOT ANALYSES (text only; prior videos are intentionally not resent):",
    JSON.stringify(input.priorAnalyses.map((analysis) => ({
      contentToReplace: analysis.contentToReplace,
      preserveExactly: analysis.preserveExactly,
      shotId: analysis.shotId,
      sourceStoryRole: analysis.sourceStoryRole,
      targetContent: analysis.targetContent,
      targetStoryRole: analysis.targetStoryRole,
      targetText: analysis.targetText,
      visibleText: analysis.visibleText,
    })), null, 2),
    "",
    "INSTRUCTIONS:",
    "- Watch the attached shot clip as video. Use temporal/motion details: text appearing/disappearing, wipes, camera moves, hand motion, object transitions, and end-state reveals.",
    "- List every readable on-screen word, logo text, URL, claim, caption, UI label, sign, button, superscript, legal line, or repeated phrase visible anywhere in the shot.",
    "- Do not summarize visible text. Preserve exact capitalization and punctuation when readable. If uncertain, include '[uncertain]' in that item.",
    "- Identify source-specific content that must change for the target brief.",
    "- Specifically flag persistent source watermarks, corner logos, or brand marks that recur across frames. These must be removed from generated output.",
    "- Identify the shot's story function in the original ad.",
    "- Propose the analogous Impractical.ai content for this shot using only the target brief and prior state. Do not invent unsupported claims, URLs, slogans, launch dates, brand colors, or metrics.",
    "- Do not carry over source product/category semantics unless they are truly the abstract story mechanic. For example, source labels about translation, books, credits, lessons, languages, user names, or source dashboard features should become analogous Impractical.ai video-generation concepts, not remain as source-domain specifics.",
    "- Identify what must be preserved from the source shot: camera, motion, timing, composition, physical actions, lens/lighting, transitions, and pacing.",
    "- Update runningState with concise explicit decisions that later shots should know. Do not include hidden reasoning.",
    "",
    "Return strict JSON only:",
    JSON.stringify({
      contentToReplace: ["source-specific object/text/logo/person/claim to remove or reinterpret"],
      generationPromptGuidance: "one concise sentence that the later prompt planner should follow",
      mustRemoveSourceText: true,
      preserveExactly: ["camera push", "hand motion", "lighting", "composition"],
      replaceOnly: ["specific source elements to replace, not the whole shot"],
      reviewNotes: "risks or ambiguity to inspect",
      runningState: {
        recurringSourceElementsToRemove: ["source brand/claims that should keep being removed"],
        targetMessagingDecisions: ["approved target phrasing or substitutions used so far"],
        targetNarrativeArcSoFar: "concise explicit state for later shots",
        visualContinuityRules: ["style/prop/motion rules to keep consistent"],
      },
      shotId: input.shot.id,
      sourceDescription: "what visibly happens over the full shot video",
      sourceStoryRole: "why this shot exists in the source story",
      structureToPreserve: ["camera angle", "timing", "composition"],
      targetContent: "specific analogous content for Impractical.ai",
      targetStoryRole: "analogous role in the target story",
      targetText: ["exact replacement text, if any"],
      visibleText: ["exact source text/logo/URL visible anywhere in the shot"],
    }, null, 2),
  ].join("\n");
}

function normalizeShotVideoAnalysis(
  rawValue: unknown,
  fallback: PlannedShot,
  previousState: Record<string, unknown>,
  usage?: unknown,
): ShotVideoAnalysis {
  const raw = rawValue && typeof rawValue === "object" ? rawValue as Record<string, unknown> : {};
  const visibleText = textCandidatesFromRecord(raw);
  const runningState = raw.runningState && typeof raw.runningState === "object" && !Array.isArray(raw.runningState)
    ? raw.runningState as Record<string, unknown>
    : previousState;
  return {
    contentToReplace: arrayOfStrings(raw.contentToReplace),
    generationPromptGuidance: stringValue(raw.generationPromptGuidance) || undefined,
    mustRemoveSourceText: raw.mustRemoveSourceText === true,
    preserveExactly: arrayOfStrings(raw.preserveExactly),
    replaceOnly: arrayOfStrings(raw.replaceOnly),
    reviewNotes: stringValue(raw.reviewNotes) || undefined,
    runningState,
    shotId: stringValue(raw.shotId, fallback.id),
    sourceDescription: stringValue(raw.sourceDescription, fallback.description),
    sourceStoryRole: stringValue(raw.sourceStoryRole) || undefined,
    structureToPreserve: arrayOfStrings(raw.structureToPreserve),
    targetContent: stringValue(raw.targetContent) || undefined,
    targetStoryRole: stringValue(raw.targetStoryRole) || undefined,
    targetText: arrayOfStrings(raw.targetText),
    usage,
    visibleText: cleanStringList([
      ...visibleText,
      ...(fallback.visibleText ?? []),
      ...(fallback.sourceText ?? []),
    ]),
  };
}

function applyShotVideoAnalysis(shot: PlannedShot, analysis: ShotVideoAnalysis): PlannedShot {
  return {
    ...shot,
    contentToReplace: analysis.contentToReplace.length ? analysis.contentToReplace : shot.contentToReplace,
    description: analysis.sourceDescription || shot.description,
    mustRemoveSourceText: analysis.mustRemoveSourceText || shot.mustRemoveSourceText,
    preserveExactly: analysis.preserveExactly.length ? analysis.preserveExactly : shot.preserveExactly,
    replaceOnly: analysis.replaceOnly.length ? analysis.replaceOnly : shot.replaceOnly,
    reviewNotes: cleanStringList([shot.reviewNotes ?? "", analysis.reviewNotes ?? "", analysis.generationPromptGuidance ?? ""])
      .join(" "),
    sourceStoryRole: analysis.sourceStoryRole ?? shot.sourceStoryRole,
    sourceText: analysis.visibleText.length ? analysis.visibleText : shot.sourceText,
    structureToPreserve: analysis.structureToPreserve.length ? analysis.structureToPreserve : shot.structureToPreserve,
    targetContent: analysis.targetContent ?? shot.targetContent,
    targetStoryRole: analysis.targetStoryRole ?? shot.targetStoryRole,
    targetText: analysis.targetText.length ? analysis.targetText : shot.targetText,
    visibleText: analysis.visibleText.length ? analysis.visibleText : shot.visibleText,
  };
}

export async function analyzeShotsWithGemini(input: {
  importId: string;
  projectId: string;
  shots: PlannedShot[];
  sourcePath: string;
  targetBrief: string;
  workDir: string;
}) {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return { analyses: [] as ShotVideoAnalysis[], shots: input.shots };

  const analysisDir = `analysis/youtube/${safeFileStem(input.importId, "import")}`;
  const clipDir = path.join(input.workDir, "shot-video-analysis-clips");
  await mkdir(clipDir, { recursive: true });
  const analyses: ShotVideoAnalysis[] = [];
  let runningState: Record<string, unknown> = {
    targetBrief: input.targetBrief,
    targetNarrativeArcSoFar: "",
    targetMessagingDecisions: [],
    recurringSourceElementsToRemove: [],
    visualContinuityRules: [],
  };

  const maxShots = positiveIntFromEnv("CANVAS_YOUTUBE_SHOT_ANALYSIS_MAX_SHOTS", input.shots.length);
  const selectedShots = input.shots.slice(0, maxShots);
  const enrichedShots = [...input.shots];

  for (const shot of selectedShots) {
    const clipPath = path.join(clipDir, `${shot.id}.mp4`);
    await extractSourceClip(input.sourcePath, clipPath, shot.start, shot.duration);
    const prompt = shotVideoAnalysisPrompt({
      priorAnalyses: analyses,
      runningState,
      shot,
      targetBrief: input.targetBrief,
    });
    const content: unknown[] = [
      { type: "text", text: prompt },
      { type: "video_url", video_url: { url: await dataUrl(clipPath) } },
    ];
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost/video-fs-agent",
        "X-Title": "video-fs-agent per-shot video analyzer",
      },
      body: JSON.stringify({
        max_tokens: Number(process.env.CANVAS_YOUTUBE_SHOT_ANALYZER_MAX_TOKENS ?? 7000),
        messages: [{ role: "user", content }],
        model: process.env.CANVAS_YOUTUBE_OPENROUTER_MODEL || "google/gemini-3-flash-preview",
        response_format: { type: "json_object" },
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`OpenRouter shot video analysis failed for ${shot.id} (${response.status}): ${text.slice(0, 1000)}`);
    }
    const payload = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      error?: { message?: string };
      usage?: unknown;
    };
    if (payload.error) throw new Error(`OpenRouter shot video analysis failed for ${shot.id}: ${payload.error.message}`);
    const raw = messageText(payload.choices?.[0]?.message?.content);
    await writeFile(path.join(clipDir, `${shot.id}.analysis.raw.json`), raw);
    await writeOptionalWorkspaceFile(input.projectId, `${analysisDir}/shot-video-analysis/${shot.id}.raw.json`, raw);
    const analysis = normalizeShotVideoAnalysis(parseLooseJson(raw), shot, runningState, payload.usage);
    runningState = analysis.runningState;
    analyses.push(analysis);
    enrichedShots[shot.index] = applyShotVideoAnalysis(shot, analysis);
    await writeOptionalWorkspaceFile(
      input.projectId,
      `${analysisDir}/shot-video-analysis/${shot.id}.json`,
      `${JSON.stringify(analysis, null, 2)}\n`,
    );
  }

  await writeOptionalWorkspaceFile(
    input.projectId,
    `${analysisDir}/shot-video-analysis/index.json`,
    `${JSON.stringify({
      analyses,
      createdAt: new Date().toISOString(),
      finalRunningState: runningState,
      importId: input.importId,
      model: process.env.CANVAS_YOUTUBE_OPENROUTER_MODEL || "google/gemini-3-flash-preview",
      shotsAnalyzed: analyses.length,
      type: "youtube_import_shot_video_analysis",
    }, null, 2)}\n`,
  );

  return { analyses, shots: enrichedShots };
}

async function extractSourceClip(sourcePath: string, outputPath: string, start: number, duration: number) {
  const needsPadding = duration < 2.05;
  const firstOutputPath = needsPadding ? `${outputPath}.raw.mp4` : outputPath;
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      start.toFixed(3),
      "-i",
      sourcePath,
      "-t",
      duration.toFixed(3),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      "-y",
      firstOutputPath,
    ],
    { timeout: 120_000, maxBuffer: 1024 * 1024 * 8 },
  );
  if (!needsPadding) return;
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      firstOutputPath,
      "-vf",
      `tpad=stop_mode=add:stop_duration=${(2.05 - duration).toFixed(3)}:color=white,format=yuv420p`,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-movflags",
      "+faststart",
      "-y",
      outputPath,
    ],
    { timeout: 120_000, maxBuffer: 1024 * 1024 * 8 },
  );
}

async function trimVideo(inputPath: string, outputPath: string, duration: number) {
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-t",
      duration.toFixed(3),
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-y",
      outputPath,
    ],
    { timeout: 180_000, maxBuffer: 1024 * 1024 * 8 },
  );
}

function collectUrls(value: unknown, urls: string[] = []): string[] {
  if (!value) return urls;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) urls.push(value);
    return urls;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, urls);
    return urls;
  }
  if (typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) collectUrls(child, urls);
  }
  return urls;
}

function chooseVideoUrl(value: unknown) {
  const urls = collectUrls(value);
  return (
    urls.find((url) => [".mp4", ".webm", ".mov"].some((extension) => url.toLowerCase().includes(extension))) ??
    urls[0] ??
    null
  );
}

async function downloadUrl(url: string, outputPath: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download generated video (${response.status} ${response.statusText}).`);
  }
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
}

function clipMarkdown(input: {
  assetId: string;
  body: string;
  clipId: string;
  duration: number;
  generatedPath?: string | null;
  importId: string;
  importedFrom: string;
  index: number;
  inTimeline: boolean;
  kind: "reference" | "generated";
  planner?: PlannedShot;
  prompt: string;
  sourceClipId?: string;
  sourcePath?: string | null;
  start: number;
  status: "active" | "failed" | "generating" | "planned";
  title: string;
}) {
  const meta: Record<string, unknown> = {
    asset_id: input.assetId,
    aspect_ratio: "16:9",
    duration_seconds: cleanNumber(input.duration, 2),
    generated_seconds: cleanNumber(input.duration, 2),
    id: input.clipId,
    import_id: input.importId,
    import_kind: input.kind === "reference" ? "youtube_reference" : "youtube_generated",
    imported_from: input.importedFrom,
    in_timeline: input.inTimeline,
    index: input.index,
    scene: "youtube_import",
    source_clip_id: input.sourceClipId,
    source_local_path: input.sourcePath,
    source_start_seconds: cleanNumber(input.start, 2),
    status: input.status,
    type: "clip",
  };
  if (input.generatedPath) {
    meta.local_path = input.generatedPath;
    meta.versions = [{ local_path: input.generatedPath, version: 1 }];
  }
  if (input.planner) {
    meta.planner_mode = input.planner.mode;
    meta.source_story_role = input.planner.sourceStoryRole;
    meta.target_story_role = input.planner.targetStoryRole;
    meta.target_content = input.planner.targetContent;
    meta.structure_to_preserve = input.planner.structureToPreserve;
    meta.preserve_exactly = input.planner.preserveExactly;
    meta.content_to_replace = input.planner.contentToReplace;
    meta.allowed_changes = input.planner.allowedChanges;
    meta.forbidden_changes = input.planner.forbiddenChanges;
    meta.replace_only = input.planner.replaceOnly;
    meta.reference_ids = input.planner.referenceIds;
    meta.review_notes = input.planner.reviewNotes;
    meta.analogy_strategy = input.planner.analogyStrategy;
    meta.remix_strength = input.planner.remixStrength;
    meta.source_text = input.planner.sourceText;
    meta.target_text = input.planner.targetText;
    meta.text_strategy = input.planner.textStrategy;
    meta.must_remove_source_text = input.planner.mustRemoveSourceText;
  }
  return withJsonFrontmatter(
    meta,
    `# ${input.title}\n\n## Prompt\n\n${input.prompt}\n\n${input.body.trim()}`,
  );
}

async function writePrompt(projectId: string, assetId: string, clipId: string, prompt: string) {
  await writeWorkspaceFile(
    projectId,
    `prompts/${assetId}.prompt.md`,
    withJsonFrontmatter(
      {
        clip_id: clipId,
        compiler: "canvas-youtube-import",
        id: `prompt_${clipId}`,
        status: "active",
        type: "prompt",
      },
      prompt,
    ),
  );
}

function planDirectory(importId: string) {
  return `plans/youtube/${safeFileStem(importId, "import")}`;
}

function requirementsDirectory(importId: string) {
  return `requirements/youtube/${safeFileStem(importId, "import")}`;
}

async function writeImportPlanFiles(projectId: string, plan: NormalizedImportPlan) {
  const baseDir = planDirectory(plan.id);
  const planPath = `${baseDir}/plan.v${plan.version}.json`;
  const activePlanPath = `${baseDir}/active.json`;
  const payload = `${JSON.stringify({
    type: "youtube_import_plan",
    ...plan,
  }, null, 2)}\n`;
  await writeWorkspaceFile(projectId, planPath, payload);
  await writeWorkspaceFile(projectId, activePlanPath, payload);
  return activePlanPath;
}

async function writeRequirementFiles(projectId: string, plan: NormalizedImportPlan) {
  const baseDir = requirementsDirectory(plan.id);
  const requirements = [...plan.requiredAssets, ...plan.optionalAssets];
  const indexPath = `${baseDir}/_index.json`;
  await Promise.all(
    requirements.map((asset) =>
      writeWorkspaceFile(
        projectId,
        `${baseDir}/${safeFileStem(asset.assetId, "asset")}.json`,
        `${JSON.stringify({
          type: "youtube_import_requirement",
          importId: plan.id,
          planPath: `${planDirectory(plan.id)}/active.json`,
          planVersion: plan.version,
          ...asset,
        }, null, 2)}\n`,
      ),
    ),
  );
  await writeWorkspaceFile(
    projectId,
    indexPath,
    `${JSON.stringify({
      type: "youtube_import_requirements_index",
      importId: plan.id,
      planPath: `${planDirectory(plan.id)}/active.json`,
      planVersion: plan.version,
      required: plan.requiredAssets.map((asset) => asset.assetId),
      optional: plan.optionalAssets.map((asset) => asset.assetId),
      blockingQuestions: plan.blockingQuestions,
      readyToGenerate: plan.readyToGenerate,
    }, null, 2)}\n`,
  );
  return indexPath;
}

function plannerGateSummary(plan: NormalizedImportPlan) {
  const required = plan.requiredAssets.filter((asset) => asset.status !== "resolved");
  const lines = [
    "I planned the YouTube import and prepared the source/reference clips, but I paused before paid generation because the plan needs inputs.",
  ];
  if (required.length) {
    lines.push(
      "",
      "Required assets:",
      ...required.map((asset) => {
        const shots = asset.neededForShots.length ? ` for ${asset.neededForShots.join(", ")}` : "";
        return `- ${asset.label}${shots}: ${asset.description}`;
      }),
    );
  }
  if (plan.blockingQuestions.length) {
    lines.push(
      "",
      "Questions:",
      ...plan.blockingQuestions.map((question) => `- ${question.question}`),
    );
  }
  lines.push("", `Plan file: ${planDirectory(plan.id)}/active.json`);
  lines.push(`Requirements: ${requirementsDirectory(plan.id)}/_index.json`);
  return lines.join("\n");
}

async function readActiveImportPlan(projectId: string, record: CanvasYoutubeImportRecord) {
  if (!record.planPath) throw new Error("Import plan is missing.");
  const parsed = JSON.parse(await readWorkspaceFile(projectId, record.planPath)) as NormalizedImportPlan;
  return parsed;
}

function allPlanAssets(plan: NormalizedImportPlan) {
  return [...plan.requiredAssets, ...plan.optionalAssets];
}

function assetAppliesToShot(asset: NormalizedAssetRequest, shot: PlannedShot) {
  if (!asset.resolvedPath || asset.status !== "resolved") return false;
  const shotIds = new Set([shot.id, shotIdForIndex(shot.index)]);
  return asset.neededForShots.some((shotId) => shotIds.has(shotId));
}

function bindResolvedAssetsToShots(plan: NormalizedImportPlan) {
  const assets = allPlanAssets(plan);
  let changed = false;
  const shots = plan.shots.map((shot) => {
    const referenceIds = new Set(shot.referenceIds ?? []);
    for (const asset of assets) {
      if (assetAppliesToShot(asset, shot) && asset.resolvedPath && !referenceIds.has(asset.resolvedPath)) {
        referenceIds.add(asset.resolvedPath);
        changed = true;
      }
    }
    const nextReferenceIds = [...referenceIds];
    if (!changed && nextReferenceIds.length === (shot.referenceIds ?? []).length) return shot;
    return { ...shot, referenceIds: nextReferenceIds };
  });
  return changed ? { ...plan, shots } : plan;
}

async function ensureResolvedAssetsBound(projectId: string, record: CanvasYoutubeImportRecord, plan: NormalizedImportPlan) {
  const nextPlan = bindResolvedAssetsToShots(plan);
  if (nextPlan !== plan && record.planPath) {
    await writeWorkspaceFile(
      projectId,
      record.planPath,
      `${JSON.stringify({ type: "youtube_import_plan", ...nextPlan }, null, 2)}\n`,
    );
  }
  return nextPlan;
}

async function ensurePlanReadyForGeneration(projectId: string, record: CanvasYoutubeImportRecord) {
  const plan = await ensureResolvedAssetsBound(projectId, record, await readActiveImportPlan(projectId, record));
  const missing = plan.requiredAssets.filter((asset) => asset.status !== "resolved");
  if (missing.length || plan.blockingQuestions.length || !plan.readyToGenerate) {
    throw new Error(
      [
        "Import plan is not ready to generate.",
        missing.length ? `Missing assets: ${missing.map((asset) => asset.label).join(", ")}` : "",
        plan.blockingQuestions.length
          ? `Unanswered questions: ${plan.blockingQuestions.map((question) => question.question).join(" ")}`
          : "",
      ].filter(Boolean).join(" "),
    );
  }
  return plan;
}

function referenceAssetForIdOrPath(plan: NormalizedImportPlan, referenceId: string): NormalizedAssetRequest | null {
  const comparableReference = comparableToken(referenceId);
  const referenceBase = comparableToken(path.basename(referenceId, path.extname(referenceId)));
  return allPlanAssets(plan).find((asset) => {
    const candidates = [
      asset.assetId,
      asset.label,
      asset.resolvedPath ?? "",
      asset.resolvedPath ? path.basename(asset.resolvedPath, path.extname(asset.resolvedPath)) : "",
    ].map(comparableToken);
    return candidates.some((candidate) =>
      candidate &&
      (candidate === comparableReference ||
        candidate === referenceBase ||
        candidate.includes(comparableReference) ||
        comparableReference.includes(candidate)),
    );
  }) ?? null;
}

function referenceInstruction(ref: BoundReference) {
  const text = `${ref.assetId} ${ref.label} ${ref.kind} ${ref.reason}`.toLowerCase();
  if (ref.kind === "image_ref" && text.includes("logo")) {
    return `Use ${ref.token} as the exact Impractical.ai logo/brand mark wherever this shot calls for the logo; do not invent a substitute mark.`;
  }
  if (ref.kind === "video_ref") {
    return `Use ${ref.token} as the resolved video reference only where this shot's prompt explicitly calls for that reference. Do not turn unrelated shots into software/UI demos.`;
  }
  if (ref.kind === "image_ref") {
    return `Use ${ref.token} as the replacement visual reference for this shot.`;
  }
  if (ref.value) {
    return `Use this ${ref.label} guidance exactly where relevant: ${ref.value}`;
  }
  return `Use ${ref.token} only when this shot needs ${ref.label}.`;
}

function rewritePromptForReferences(shot: PlannedShot, references: BoundReference[]) {
  const prompt = shot.generationPrompt.trim();
  const remixStrength = normalizeRemixStrength(shot.remixStrength, 50);
  const lines = [
    "In this video, @Video1 is the original source shot. Use it for camera movement, framing, timing, and pacing only.",
    "Blank, clean, or remove persistent source watermarks/corner logos. Do not replace source watermarks with the Impractical.ai logo unless this shot is explicitly an intentional brand/title/outro beat.",
    remixGuidance(remixStrength),
    `remixStrength=${remixStrength}.`,
    ...(shot.allowedChanges?.length ? [`Allowed changes: ${shot.allowedChanges.join(", ")}.`] : []),
    ...(shot.forbiddenChanges?.length ? [`Forbidden changes: ${shot.forbiddenChanges.join(", ")}.`] : []),
    ...(shot.textStrategy ? [`Text strategy: ${shot.textStrategy}. If exact text cannot be rendered reliably, keep the design clean and flag for post-generation repair rather than inventing misspelled text.`] : []),
    ...references.map((ref) => `In this video, ${ref.token} is ${ref.label}: ${ref.reason || ref.path}.`),
    ...(references.length ? ["Replacement references are authoritative. If @Video1 conflicts with a replacement reference, replace the source content with the new reference."] : []),
    ...references.map(referenceInstruction),
  ];
  const hasChange = shot.mode === "change" || references.some((ref) => ref.kind === "video_ref");
  if (hasChange) {
    lines.push("Do not preserve the original source subject matter; preserve only the camera/motion skeleton.");
  }
  let rewritten = prompt
    .replace(/Use @Video1 as the exact camera\/framing\/motion\/timing reference\.\s*/i, "")
    .replace(/\bthe Impractical\.ai logo\b/gi, () => {
      const logo = references.find((ref) => `${ref.assetId} ${ref.label}`.toLowerCase().includes("logo"));
      return logo ? `${logo.token} Impractical.ai logo` : "the Impractical.ai logo";
    })
    .trim();
  for (const ref of references) {
    const fileName = path.basename(ref.path);
    if (fileName) {
      rewritten = rewritten
        .split(ref.path).join(ref.token)
        .split(`@${fileName}`).join(ref.token)
        .split(fileName).join(ref.token);
    }
    if (`${ref.assetId} ${ref.label}`.toLowerCase().includes("logo")) {
      rewritten = rewritten.replace(/@[\w.-]*logo[\w.-]*/gi, ref.token);
    }
  }
  if (!rewritten) rewritten = shot.targetContent || shot.description;
  return `${lines.join("\n")}\n\n${rewritten}`.trim();
}

async function buildFalReferencesForShot(input: {
  plan: NormalizedImportPlan;
  projectId: string;
  shot: PlannedShot;
  sourceVideoUrl: string | null;
  uploadCache: Map<string, Promise<string>>;
  workDir: string;
}) {
  const imageUrls: string[] = [];
  const referenceIds = input.shot.referenceIds ?? [];
  const references: BoundReference[] = [];
  const textReferences: BoundReference[] = [];
  const videoUrls = input.sourceVideoUrl ? [input.sourceVideoUrl] : [];
  let imageIndex = 1;
  let videoIndex = 2;
  const resolvedReferencePaths = new Set<string>();

  for (const referenceId of referenceIds) {
    const asset = referenceAssetForIdOrPath(input.plan, referenceId);
    const referencePath = asset?.resolvedPath ?? referenceId;
    const comparableReferencePath = comparableToken(referencePath);
    if (resolvedReferencePaths.has(comparableReferencePath)) continue;
    resolvedReferencePaths.add(comparableReferencePath);
    const kind = asset?.kind === "image_ref" || asset?.kind === "video_ref" || asset?.kind === "brand_rule" || asset?.kind === "slogan" || asset?.kind === "metric" || asset?.kind === "on_screen_text"
      ? asset.kind
      : workspacePathKind(referencePath);
    const base = {
      assetId: asset?.assetId ?? path.basename(referencePath, path.extname(referencePath)),
      kind,
      label: asset?.label ?? path.basename(referencePath),
      path: referencePath,
      reason: asset?.reason ?? asset?.description ?? "Resolved workspace reference.",
    };
    if (kind === "image_ref" || workspacePathKind(referencePath) === "image_ref") {
      const url = await uploadWorkspaceReference(input.projectId, referencePath, input.uploadCache);
      const ref = { ...base, kind: "image_ref", token: `@Image${imageIndex++}`, url };
      imageUrls.push(url);
      references.push(ref);
      continue;
    }
    if (kind === "video_ref" || workspacePathKind(referencePath) === "video_ref") {
      const remainingVideoBudget = Math.min(6, 14.8 - input.shot.duration);
      if (remainingVideoBudget >= 1.5) {
        const url = await uploadWorkspaceVideoReference(
          input.projectId,
          referencePath,
          input.uploadCache,
          input.workDir,
          remainingVideoBudget,
        );
        const ref = { ...base, kind: "video_ref", token: `@Video${videoIndex++}`, url };
        videoUrls.push(url);
        references.push(ref);
      } else {
        const url = await uploadWorkspaceVideoFrameReference(
          input.projectId,
          referencePath,
          input.uploadCache,
          input.workDir,
        );
        const ref = {
          ...base,
          kind: "image_ref",
          reason: `${base.reason} A still frame is used because the source shot already uses the video-reference duration budget.`,
          token: `@Image${imageIndex++}`,
          url,
        };
        imageUrls.push(url);
        references.push(ref);
      }
      continue;
    }
    const value = (await readWorkspaceFile(input.projectId, referencePath).catch(() => "")).trim();
    if (value) {
      textReferences.push({ ...base, token: base.label, value });
    }
  }

  const prompt = rewritePromptForReferences(input.shot, [...references, ...textReferences]);
  return {
    imageUrls,
    prompt,
    references: [...references, ...textReferences],
    videoUrls,
  } satisfies BoundFalReferences;
}

function importShotOp(seconds: number): BillableOp {
  return {
    kind: "clip",
    tool: "youtubeImport.shot",
    pinned: true, // reference-to-video runs the standard tier
    resolution: "720p",
    seconds: Math.max(1, Math.round(seconds)),
  };
}

/** Reject the whole batch up front when the account can't afford it. */
async function preflightImportBatch(userId: string, secondsPerShot: number[]): Promise<void> {
  if (!billingEnabled()) return;
  const required = secondsPerShot.reduce((sum, seconds) => sum + quoteOp(importShotOp(seconds)), 0);
  const balance = await getCreditBalance(userId);
  if (balance.total < required) {
    throw new Error(
      `Insufficient credits: this import needs ~${required} credits for ${secondsPerShot.length} generated clips but the account has ${balance.total}.`,
    );
  }
}

/** Charge one generated shot after its media landed (idempotent, fire-and-forget). */
async function settleImportShot(
  userId: string,
  projectId: string,
  seconds: number,
  shotId: string,
  artifact?: { path?: string | null; title?: string | null; url?: string | null },
): Promise<void> {
  if (!billingEnabled()) return;
  // Stable key per shot so the Trigger task's auto-retries can't double-charge.
  await chargeForOp({
    userId,
    op: importShotOp(seconds),
    projectId,
    idempotencyKey: `import:${projectId}:${shotId}`,
    description: `youtubeImport.shot (${projectId})`,
    artifact,
  }).catch(() => {});
}

async function buildFalSubmissionForShot(input: {
  plan: NormalizedImportPlan;
  projectId: string;
  referenceToVideoEndpoint: string;
  shot: PlannedShot;
  sourceVideoUrl: string | null;
  uploadCache: Map<string, Promise<string>>;
  workDir: string;
}) {
  const bound = await buildFalReferencesForShot({
    plan: input.plan,
    projectId: input.projectId,
    shot: input.shot,
    sourceVideoUrl: input.sourceVideoUrl,
    uploadCache: input.uploadCache,
    workDir: input.workDir,
  });
  const falInput = {
    aspect_ratio: process.env.CANVAS_YOUTUBE_IMPORT_ASPECT_RATIO || "auto",
    bitrate_mode: process.env.CANVAS_YOUTUBE_IMPORT_BITRATE_MODE || "standard",
    duration: falDuration(input.shot.duration),
    generate_audio: process.env.CANVAS_YOUTUBE_IMPORT_GENERATE_AUDIO === "true",
    ...(bound.imageUrls.length ? { image_urls: bound.imageUrls } : {}),
    prompt: bound.prompt,
    resolution: process.env.CANVAS_YOUTUBE_IMPORT_RESOLUTION || "720p",
    video_urls: bound.videoUrls,
  };
  return {
    bound,
    endpoint: input.referenceToVideoEndpoint,
    falInput,
  } satisfies FalSubmissionBuild;
}

async function writeFalSubmitManifest(input: {
  bound: BoundFalReferences;
  clipId: string;
  endpoint: string;
  falInput: Record<string, unknown>;
  importId: string;
  projectId: string;
  requestId: string;
  shot: PlannedShot;
  sourcePath: string | null;
}) {
  const videoUrls = Array.isArray(input.falInput.video_urls) ? input.falInput.video_urls : [];
  const imageUrls = Array.isArray(input.falInput.image_urls) ? input.falInput.image_urls : [];
  const hasImageUrl = typeof input.falInput.image_url === "string" && input.falInput.image_url.length > 0;
  const manifest = {
    clipId: input.clipId,
    endpoint: input.endpoint,
    generatedAt: new Date().toISOString(),
    imageUrlCount: imageUrls.length + (hasImageUrl ? 1 : 0),
    importId: input.importId,
    prompt: input.bound.prompt,
    requestId: input.requestId,
    shotId: input.shot.id,
    tokenMap: [
      ...(videoUrls.length
        ? [
            {
              kind: "source_video",
              path: input.sourcePath,
              role: "camera_motion_timing_skeleton",
              token: "@Video1",
            },
          ]
        : input.sourcePath
          ? [
              {
                kind: "source_video",
                path: input.sourcePath,
                role: "not_submitted_image_to_video_mode",
                token: null,
              },
            ]
          : []),
      ...input.bound.references.map((ref) => ({
        assetId: ref.assetId,
        kind: ref.kind,
        label: ref.label,
        path: ref.path,
        reason: ref.reason,
        token: ref.token,
        valueProvided: Boolean(ref.value),
      })),
    ],
    videoUrlCount: videoUrls.length,
  };
  const baseDir = `imports/youtube/${safeFileStem(input.importId, "import")}/submissions`;
  const clipStem = safeFileStem(input.clipId, "clip");
  const requestStem = safeFileStem(input.requestId, "request");
  const payload = `${JSON.stringify(manifest, null, 2)}\n`;
  await Promise.all([
    writeWorkspaceFile(input.projectId, `${baseDir}/${clipStem}.json`, payload),
    writeWorkspaceFile(input.projectId, `${baseDir}/${clipStem}.${requestStem}.json`, payload),
  ]);
}

function uploadWorkspaceReference(projectId: string, filePath: string, cache: Map<string, Promise<string>>) {
  const cached = cache.get(filePath);
  if (cached) return cached;
  const upload = (async () => {
    // Workspace media is already in OUR storage — sign it, never re-host on fal.
    const signed = await signedWorkspaceMediaUrl(projectId, filePath);
    if (!signed) throw new Error(`Workspace media "${filePath}" could not be signed — Supabase storage hosting required.`);
    return signed;
  })();
  cache.set(filePath, upload);
  return upload;
}

function uploadWorkspaceVideoReference(
  projectId: string,
  filePath: string,
  cache: Map<string, Promise<string>>,
  workDir: string,
  duration: number,
) {
  const cacheKey = `${filePath}:video:${duration.toFixed(2)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const upload = (async () => {
    const source = await readWorkspaceBinaryFile(projectId, filePath);
    const inputPath = path.join(workDir, `${safeFileStem(path.basename(filePath), "reference")}.source${path.extname(filePath) || ".mp4"}`);
    const outputPath = path.join(workDir, `${safeFileStem(path.basename(filePath), "reference")}.${duration.toFixed(2)}s.mp4`);
    await writeFile(inputPath, source.content);
    await trimVideo(inputPath, outputPath, duration);
    const hosted = await hostProjectBytes(projectId, path.basename(outputPath), await readFile(outputPath));
    if (!hosted.ok) throw new Error(hosted.error);
    return hosted.url;
  })();
  cache.set(cacheKey, upload);
  return upload;
}

function uploadWorkspaceVideoFrameReference(
  projectId: string,
  filePath: string,
  cache: Map<string, Promise<string>>,
  workDir: string,
) {
  const cacheKey = `${filePath}:frame`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const upload = (async () => {
    const source = await readWorkspaceBinaryFile(projectId, filePath);
    const inputPath = path.join(workDir, `${safeFileStem(path.basename(filePath), "reference")}.source${path.extname(filePath) || ".mp4"}`);
    const framePath = path.join(workDir, `${safeFileStem(path.basename(filePath), "reference")}.frame.jpg`);
    await writeFile(inputPath, source.content);
    await extractFrame(inputPath, framePath, 0.1);
    const hosted = await hostProjectBytes(projectId, path.basename(framePath), await readFile(framePath));
    if (!hosted.ok) throw new Error(hosted.error);
    return hosted.url;
  })();
  cache.set(cacheKey, upload);
  return upload;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const canvasYoutubeGenerateTask = task({
  id: CANVAS_YOUTUBE_GENERATE_TASK_ID,
  machine: {
    preset: "medium-1x",
  },
  maxDuration: 36000,
  run: async (payload: CanvasYoutubeGeneratePayload) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "canvas-youtube-generate-"));
    let record = await readCanvasYoutubeImportRecord(payload.projectId, payload.importId);
    let writeChain = Promise.resolve(record);
    const mutateRecord = async (
      updater: (current: CanvasYoutubeImportRecord) => CanvasYoutubeImportRecord,
    ) => {
      record = updater(record);
      writeChain = writeChain.then(() => writeCanvasYoutubeImportRecord(payload.projectId, record));
      record = await writeChain;
      return record;
    };

    try {
      const plan = await ensurePlanReadyForGeneration(payload.projectId, record);
      const referenceToVideoEndpoint =
        process.env.CANVAS_YOUTUBE_IMPORT_FAL_ENDPOINT || "bytedance/seedance-2.0/reference-to-video";
      configureFal();
      await mutateRecord((current) => ({ ...current, status: "generating" }));
      const uploadCache = new Map<string, Promise<string>>();

      const pendingSlots = record.slots.filter((slot) => slot.status !== "completed");
      await Promise.all(
        pendingSlots.map(async (slot) => {
          const shot = plan.shots.find((item) => item.index === slot.index) ?? plan.shots[slot.index];
          if (!shot) return;
          await writeWorkspaceFile(
            payload.projectId,
            `clips/${slot.clipId}.md`,
            clipMarkdown({
              assetId: `asset_${slot.clipId}`,
              body: `## Source Reference\n\n${slot.sourcePath ?? ""}\n\n## Status\n\nGenerating clip.`,
              clipId: slot.clipId,
              duration: slot.duration,
              importId: payload.importId,
              importedFrom: record.sourceUrl,
              index: slot.index * 2 + 2,
              inTimeline: true,
              kind: "generated",
              planner: shot,
              prompt: shot.generationPrompt,
              sourceClipId: slot.sourceClipId,
              sourcePath: slot.sourcePath ?? null,
              start: slot.start,
              status: "generating",
              title: `Generated ${slot.index + 1}: ${slot.title}`,
            }),
          );
        }),
      );
      await refreshTimeline(payload.projectId);

      const uploads = await Promise.all(
        pendingSlots.map(async (slot) => {
          if (!slot.sourcePath) throw new Error(`Missing source clip for ${slot.clipId}.`);
          const shot = plan.shots.find((item) => item.index === slot.index) ?? plan.shots[slot.index];
          if (!shot) throw new Error(`Missing planned shot for ${slot.clipId}.`);
          if (slot.requestId) {
            return { requestId: slot.requestId, shot, slot, videoUrl: null };
          }
          const signed = await signedWorkspaceMediaUrl(payload.projectId, slot.sourcePath);
          if (!signed) throw new Error(`Workspace media "${slot.sourcePath}" could not be signed — Supabase storage hosting required.`);
          return { requestId: null, shot, slot, videoUrl: signed };
        }),
      );

      await preflightImportBatch(
        payload.userId,
        uploads.map(({ slot }) => slot.duration),
      );
      const jobs: FalJob[] = await Promise.all(
        uploads.map(async ({ requestId: existingRequestId, shot, slot, videoUrl }) => {
          const submission = await buildFalSubmissionForShot({
            plan,
            projectId: payload.projectId,
            referenceToVideoEndpoint,
            shot,
            sourceVideoUrl: videoUrl,
            uploadCache,
            workDir: tempDir,
          });
          const { bound, endpoint, falInput } = submission;
          await writePrompt(payload.projectId, `asset_${slot.clipId}`, slot.clipId, bound.prompt);
          await writeWorkspaceFile(
            payload.projectId,
            `clips/${slot.clipId}.md`,
            clipMarkdown({
              assetId: `asset_${slot.clipId}`,
              body: `## Source Reference\n\n${slot.sourcePath ?? ""}\n\n## Status\n\nGenerating clip.`,
              clipId: slot.clipId,
              duration: slot.duration,
              importId: payload.importId,
              importedFrom: record.sourceUrl,
              index: slot.index * 2 + 2,
              inTimeline: true,
              kind: "generated",
              planner: shot,
              prompt: bound.prompt,
              sourceClipId: slot.sourceClipId,
              sourcePath: slot.sourcePath ?? null,
              start: slot.start,
              status: "generating",
              title: `Generated ${slot.index + 1}: ${slot.title}`,
            }),
          );
          const requestId = existingRequestId ?? (await fal.queue.submit(endpoint, { input: falInput })).request_id;
          await writeFalSubmitManifest({
            bound,
            clipId: slot.clipId,
            endpoint,
            falInput,
            importId: payload.importId,
            projectId: payload.projectId,
            requestId,
            shot,
            sourcePath: slot.sourcePath ?? null,
          });
          if (!existingRequestId) {
            await mutateRecord((current) => ({
              ...current,
              slots: current.slots.map((currentSlot) =>
                currentSlot.clipId === slot.clipId
                  ? { ...currentSlot, requestId, status: "submitted" }
                  : currentSlot,
              ),
            }));
          }
          return {
            clipId: slot.clipId,
            duration: slot.duration,
            endpoint,
            falInput,
            index: slot.index,
            outputPath: path.join(tempDir, `${slot.clipId}.generated.mp4`),
            requestId,
            sourceClipId: slot.sourceClipId,
            title: slot.title,
            trimPath: path.join(tempDir, `${slot.clipId}.trimmed.mp4`),
          };
        }),
      );

      const localConcurrency = Math.max(1, Number(process.env.CANVAS_YOUTUBE_LOCAL_CONCURRENCY ?? 4));
      const localSemaphore = new AsyncSemaphore(localConcurrency);
      const pollIntervalMs = Math.max(1000, Number(process.env.CANVAS_YOUTUBE_POLL_INTERVAL_MS ?? 5000));
      const timeoutMs = Math.max(60_000, Number(process.env.CANVAS_YOUTUBE_REQUEST_TIMEOUT_MS ?? 45 * 60 * 1000));

      await Promise.all(
        jobs.map(async (job) => {
          let charged = false;
          try {
            const started = Date.now();
            let lastStatus = "";
            while (true) {
              const status = await fal.queue.status(job.endpoint, { logs: true, requestId: job.requestId });
              const statusValue = String(status.status);
              if (statusValue !== lastStatus) {
                lastStatus = statusValue;
                await mutateRecord((current) => ({
                  ...current,
                  slots: current.slots.map((slot) =>
                    slot.clipId === job.clipId
                      ? { ...slot, status: statusValue === "COMPLETED" ? slot.status : "generating" }
                      : slot,
                  ),
                }));
              }
              if (statusValue === "COMPLETED") break;
              if (statusValue === "FAILED" || statusValue === "ERROR") {
                throw new Error(`Fal request ${job.requestId} failed with status ${statusValue}.`);
              }
              if (Date.now() - started > timeoutMs) {
                throw new Error(`Timed out waiting for fal request ${job.requestId}.`);
              }
              await sleep(pollIntervalMs);
            }

            await localSemaphore.run(async () => {
              const result = await fal.queue.result(job.endpoint, { requestId: job.requestId });
              const raw = "data" in result ? result.data : result;
              const videoUrl = chooseVideoUrl(raw);
              if (!videoUrl) throw new Error(`Fal returned no video URL for ${job.clipId}.`);
              await downloadUrl(videoUrl, job.outputPath);
              await trimVideo(job.outputPath, job.trimPath, job.duration);
              const generatedPath = `media/clips/${job.clipId}.v1.mp4`;
              await writeWorkspaceBinaryFile(payload.projectId, generatedPath, await readFile(job.trimPath));
              await settleImportShot(payload.userId, payload.projectId, job.duration, job.clipId, { path: generatedPath, url: videoUrl });
              charged = true;
              const sourceSlot = record.slots.find((slot) => slot.clipId === job.clipId);
              const planner = plan.shots.find((shot) => shot.index === job.index);
              const prompt = String(job.falInput.prompt ?? "");
              await writeWorkspaceFile(
                payload.projectId,
                `clips/${job.clipId}.md`,
                clipMarkdown({
                  assetId: `asset_${job.clipId}`,
                  body: `## Source Reference\n\n${sourceSlot?.sourcePath ?? ""}\n\n## Media\n\n${generatedPath}`,
                  clipId: job.clipId,
                  duration: job.duration,
                  generatedPath,
                  importId: payload.importId,
                  importedFrom: record.sourceUrl,
                  index: job.index * 2 + 2,
                  inTimeline: true,
                  kind: "generated",
                  planner,
                  prompt,
                  sourceClipId: job.sourceClipId,
                  sourcePath: sourceSlot?.sourcePath ?? null,
                  start: sourceSlot?.start ?? 0,
                  status: "active",
                  title: `Generated ${job.index + 1}: ${job.title}`,
                }),
              );
              await mutateRecord((current) => ({
                  ...current,
                  slots: current.slots.map((slot) =>
                    slot.clipId === job.clipId
                      ? { ...slot, generatedPath, requestId: slot.requestId ?? job.requestId, status: "completed" }
                      : slot,
                  ),
                }));
              await refreshTimeline(payload.projectId);
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Charged this shot but its media ultimately failed to persist —
            // refund so the user isn't billed for a clip that never landed.
            if (charged) {
              await refundCredits({
                userId: payload.userId,
                credits: quoteOp(importShotOp(job.duration)),
                projectId: payload.projectId,
                idempotencyKey: `refund:import:${payload.projectId}:${job.clipId}`,
                description: "Refund: shot generation failed",
              }).catch(() => {});
            }
            await mutateRecord((current) => ({
              ...current,
              slots: current.slots.map((slot) =>
                slot.clipId === job.clipId ? { ...slot, error: message, status: "failed" } : slot,
              ),
            }));
          }
        }),
      );

      const failed = record.slots.filter((slot) => slot.status === "failed").length;
      await mutateRecord((current) => ({
        ...current,
        completedAt: new Date().toISOString(),
        status: failed ? "failed" : "completed",
      }));
      await appendChat(payload.projectId, {
        role: "assistant",
        text: failed
          ? `YouTube import generation finished with ${failed} failed clip${failed === 1 ? "" : "s"}.`
          : "YouTube import generation finished. Generated clips have been added to the canvas.",
      });
      return { failed, importId: payload.importId, ok: failed === 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : "YouTube generation failed.";
      await mutateRecord((current) => ({
        ...current,
        error: message,
        status: "failed",
      }));
      await appendChat(payload.projectId, {
        role: "assistant",
        text: `YouTube import generation failed: ${message}`,
      }).catch(() => undefined);
      return { error: message, importId: payload.importId, ok: false };
    } finally {
      await writeChain.catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
});

export const canvasYoutubeImportTask = task({
  id: CANVAS_YOUTUBE_IMPORT_TASK_ID,
  machine: {
    preset: "medium-1x",
  },
  maxDuration: 36000,
  run: async (payload: CanvasYoutubeImportPayload) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "canvas-youtube-import-"));
    let record = await readCanvasYoutubeImportRecord(payload.projectId, payload.importId);
    let generatedPlaceholders: Array<{
      clipId: string;
      duration: number;
      index: number;
      prompt: string;
      sourceClipId: string;
      sourcePath: string;
      start: number;
      title: string;
    }> = [];
    let writeChain = Promise.resolve(record);
    const mutateRecord = async (
      updater: (current: CanvasYoutubeImportRecord) => CanvasYoutubeImportRecord,
    ) => {
      record = updater(record);
      writeChain = writeChain.then(() => writeCanvasYoutubeImportRecord(payload.projectId, record));
      record = await writeChain;
      return record;
    };

    try {
      await mutateRecord((current) => ({ ...current, status: "running" }));
      const sourcePath = await downloadYoutube(payload.url, tempDir);
      const duration = await durationSeconds(sourcePath);
      await mutateRecord((current) => ({ ...current, status: "planning" }));

      const targetBrief = targetBriefForImport(payload.brief);
      await mutateRecord((current) => ({ ...current, targetBrief }));
      const scenes = await detectScenes(sourcePath, duration);
      const groups = await groupScenes(sourcePath, tempDir, scenes).catch((error) => {
        console.warn(error);
        return scenes.map((scene) => ({
          description: scene.description,
          reason: "Scene grouping failed; preserved raw scene as its own beat.",
          sceneIds: [scene.id],
          title: scene.title,
          visibleText: cleanStringList(scene.visibleText ?? []),
        }));
      });
      const baseShots = plannedShotsFromGroups(groups, scenes);
      const shotVideoAnalysis = await analyzeShotsWithGemini({
        importId: payload.importId,
        projectId: payload.projectId,
        shots: baseShots,
        sourcePath,
        targetBrief,
        workDir: tempDir,
      }).catch((error) => {
        console.warn(error);
        return { analyses: [] as ShotVideoAnalysis[], shots: baseShots };
      });
      const analyzedShots = shotVideoAnalysis.shots;
      const analysisDir = `analysis/youtube/${safeFileStem(payload.importId, "import")}`;
      await writeWorkspaceFile(
        payload.projectId,
        `${analysisDir}/source-analysis.json`,
        `${JSON.stringify({
          baseShots: analyzedShots,
          createdAt: new Date().toISOString(),
          groups,
          importId: payload.importId,
          scenes,
          shotVideoAnalyses: shotVideoAnalysis.analyses,
          sourceDuration: duration,
          sourceUrl: payload.url,
          type: "youtube_import_source_analysis",
        }, null, 2)}\n`,
      );
      const workspaceReferences = workspaceReferenceCatalog(
        await listProjectFiles(payload.projectId, true).catch(() => []),
      );
      const plannerResult = await planShotsWithOpenRouter({
        importId: payload.importId,
        projectId: payload.projectId,
        remixStrength: payload.remixStrength ?? undefined,
        shots: analyzedShots,
        sourceDuration: duration,
        sourcePath,
        targetBrief,
        workDir: tempDir,
        workspaceReferences,
      }).catch((error) => {
        console.warn(error);
        const fallbackPlan = fallbackImportPlan({
          blockingReason: error instanceof Error ? error.message : "The planner failed before producing a usable plan.",
          importId: payload.importId,
          remixStrength: payload.remixStrength ?? undefined,
          shots: analyzedShots,
          targetBrief,
        });
        return { plan: fallbackPlan, shots: analyzedShots };
      });
      const shots = plannerResult.shots;
      const planPath = await writeImportPlanFiles(payload.projectId, plannerResult.plan);
      const requirementsPath = await writeRequirementFiles(payload.projectId, plannerResult.plan);
      await mutateRecord((current) => ({
        ...current,
        planPath,
        requirementsPath,
      }));
      const importStem = slug(payload.importId);
      const readyToGenerate = plannerResult.plan.readyToGenerate;

      await writeWorkspaceFile(
        payload.projectId,
        "scenes/001-youtube-import/scene.md",
        withJsonFrontmatter(
          {
            id: "youtube_import",
            index: 1,
            references: [],
            source_url: payload.url,
            status: "active",
            type: "scene",
          },
          `# YouTube Import\n\nSource: ${payload.url}\n`,
        ),
      );

      const sourceFiles: Array<{ clipId: string; filePath: string; shot: PlannedShot; sourceClipId: string; sourcePath: string }> = [];
      for (const shot of shots) {
        const indexLabel = clipIndex(shot.index);
        const sourceClipId = `${importStem}_source_${indexLabel}`;
        const clipId = `${importStem}_shot_${indexLabel}`;
        const sourceLocalPath = `media/clips/${sourceClipId}.v1.mp4`;
        const sourceOutputPath = path.join(tempDir, `${sourceClipId}.mp4`);
        await extractSourceClip(sourcePath, sourceOutputPath, shot.start, shot.duration);
        await writeWorkspaceBinaryFile(payload.projectId, sourceLocalPath, await readFile(sourceOutputPath));

        const referencePrompt = [
          `Reference source beat ${shot.index + 1} from ${payload.url}.`,
          shot.description,
          `Source range: ${shot.start.toFixed(2)}s-${shot.end.toFixed(2)}s.`,
        ].join("\n\n");
        const generatedPrompt = shot.generationPrompt;
        const sourceAssetId = `asset_${sourceClipId}`;
        const generatedAssetId = `asset_${clipId}`;
        await writePrompt(payload.projectId, sourceAssetId, sourceClipId, referencePrompt);
        await writePrompt(payload.projectId, generatedAssetId, clipId, generatedPrompt);
        await writeWorkspaceFile(
          payload.projectId,
          `clips/${sourceClipId}.md`,
          clipMarkdown({
            assetId: sourceAssetId,
            body: `## Media\n\n${sourceLocalPath}\n\n## Provenance\n\n${shot.boundaryReason}`,
            clipId: sourceClipId,
            duration: shot.duration,
            generatedPath: sourceLocalPath,
            importId: payload.importId,
            importedFrom: payload.url,
            index: shot.index * 2 + 1,
            inTimeline: false,
            kind: "reference",
            planner: shot,
            prompt: referencePrompt,
            sourcePath: sourceLocalPath,
            start: shot.start,
            status: "active",
            title: `Reference ${shot.index + 1}: ${shot.title}`,
          }),
        );
        await writeWorkspaceFile(
          payload.projectId,
          `clips/${clipId}.md`,
          clipMarkdown({
            assetId: generatedAssetId,
            body: `## Source Reference\n\n${sourceLocalPath}\n\n## Status\n\nWaiting for generated clip.`,
            clipId,
            duration: shot.duration,
            importId: payload.importId,
            importedFrom: payload.url,
            index: shot.index * 2 + 2,
            inTimeline: true,
            kind: "generated",
            planner: shot,
            prompt: generatedPrompt,
            sourceClipId,
            sourcePath: sourceLocalPath,
            start: shot.start,
            status: readyToGenerate ? "generating" : "planned",
            title: `Generated ${shot.index + 1}: ${shot.title}`,
          }),
        );
        sourceFiles.push({
          clipId,
          filePath: sourceOutputPath,
          shot,
          sourceClipId,
          sourcePath: sourceLocalPath,
        });
      }

      await mutateRecord((current) => ({
        ...current,
        slots: sourceFiles.map(({ clipId, shot, sourceClipId, sourcePath }) => ({
          clipId,
          duration: shot.duration,
          end: shot.end,
          index: shot.index,
          sourceClipId,
          sourcePath,
          start: shot.start,
          status: "source_ready",
          title: shot.title,
        })),
        status: readyToGenerate ? "source_ready" : "needs_assets",
      }));
      await refreshTimeline(payload.projectId);

      if (!readyToGenerate) {
        const message = plannerGateSummary(plannerResult.plan);
        await appendChat(payload.projectId, {
          role: "assistant",
          text: message,
        });
        return {
          importId: payload.importId,
          needsAssets: true,
          ok: true,
          planPath,
          requiredAssets: plannerResult.plan.requiredAssets.length,
          requirementsPath,
          questions: plannerResult.plan.blockingQuestions.length,
        };
      }

      generatedPlaceholders = sourceFiles.map((entry) => ({
        clipId: entry.clipId,
        duration: entry.shot.duration,
        index: entry.shot.index,
        prompt: entry.shot.generationPrompt,
        sourceClipId: entry.sourceClipId,
        sourcePath: entry.sourcePath,
        start: entry.shot.start,
        title: entry.shot.title,
      }));
      configureFal();
      await mutateRecord((current) => ({ ...current, status: "generating" }));
      const referenceToVideoEndpoint =
        process.env.CANVAS_YOUTUBE_IMPORT_FAL_ENDPOINT || "bytedance/seedance-2.0/reference-to-video";
      const uploadCache = new Map<string, Promise<string>>();
      const uploads = await Promise.all(
        sourceFiles.map(async (entry) => {
          const hosted = await hostProjectBytes(payload.projectId, `${entry.sourceClipId}.mp4`, await readFile(entry.filePath));
          if (!hosted.ok) throw new Error(hosted.error);
          return { ...entry, videoUrl: hosted.url };
        }),
      );
      await preflightImportBatch(
        payload.userId,
        uploads.map((entry) => entry.shot?.duration ?? 5),
      );
      const jobs: FalJob[] = await Promise.all(
        uploads.map(async (entry) => {
          const submission = await buildFalSubmissionForShot({
            plan: plannerResult.plan,
            projectId: payload.projectId,
            referenceToVideoEndpoint,
            shot: entry.shot,
            sourceVideoUrl: entry.videoUrl,
            uploadCache,
            workDir: tempDir,
          });
          const { bound, endpoint, falInput } = submission;
          await writePrompt(payload.projectId, `asset_${entry.clipId}`, entry.clipId, bound.prompt);
          const submitted = await fal.queue.submit(endpoint, { input: falInput });
          const requestId = submitted.request_id;
          await writeFalSubmitManifest({
            bound,
            clipId: entry.clipId,
            endpoint,
            falInput,
            importId: payload.importId,
            projectId: payload.projectId,
            requestId,
            shot: entry.shot,
            sourcePath: entry.sourcePath,
          });
          await mutateRecord((current) => ({
            ...current,
            slots: current.slots.map((slot) =>
              slot.clipId === entry.clipId
                ? { ...slot, requestId, status: "submitted" }
                : slot,
            ),
          }));
          return {
            clipId: entry.clipId,
            duration: entry.shot.duration,
            endpoint,
            falInput,
            index: entry.shot.index,
            outputPath: path.join(tempDir, `${entry.clipId}.generated.mp4`),
            requestId,
            sourceClipId: entry.sourceClipId,
            title: entry.shot.title,
            trimPath: path.join(tempDir, `${entry.clipId}.trimmed.mp4`),
          };
        }),
      );

      const localConcurrency = Math.max(1, Number(process.env.CANVAS_YOUTUBE_LOCAL_CONCURRENCY ?? 4));
      const localSemaphore = new AsyncSemaphore(localConcurrency);
      const pollIntervalMs = Math.max(1000, Number(process.env.CANVAS_YOUTUBE_POLL_INTERVAL_MS ?? 5000));
      const timeoutMs = Math.max(60_000, Number(process.env.CANVAS_YOUTUBE_REQUEST_TIMEOUT_MS ?? 45 * 60 * 1000));

      await Promise.all(
        jobs.map(async (job) => {
          let charged = false;
          try {
            const started = Date.now();
            let lastStatus = "";
            while (true) {
              const status = await fal.queue.status(job.endpoint, { logs: true, requestId: job.requestId });
              const statusValue = String(status.status);
              if (statusValue !== lastStatus) {
                lastStatus = statusValue;
                await mutateRecord((current) => ({
                  ...current,
                  slots: current.slots.map((slot) =>
                    slot.clipId === job.clipId
                      ? { ...slot, status: statusValue === "COMPLETED" ? slot.status : "generating" }
                      : slot,
                  ),
                }));
              }
              if (statusValue === "COMPLETED") break;
              if (statusValue === "FAILED" || statusValue === "ERROR") {
                throw new Error(`Fal request ${job.requestId} failed with status ${statusValue}.`);
              }
              if (Date.now() - started > timeoutMs) {
                throw new Error(`Timed out waiting for fal request ${job.requestId}.`);
              }
              await sleep(pollIntervalMs);
            }

            await localSemaphore.run(async () => {
              const result = await fal.queue.result(job.endpoint, { requestId: job.requestId });
              const raw = "data" in result ? result.data : result;
              const videoUrl = chooseVideoUrl(raw);
              if (!videoUrl) throw new Error(`Fal returned no video URL for ${job.clipId}.`);
              await downloadUrl(videoUrl, job.outputPath);
              await trimVideo(job.outputPath, job.trimPath, job.duration);
              const generatedPath = `media/clips/${job.clipId}.v1.mp4`;
              await writeWorkspaceBinaryFile(payload.projectId, generatedPath, await readFile(job.trimPath));
              await settleImportShot(payload.userId, payload.projectId, job.duration, job.clipId, { path: generatedPath, url: videoUrl });
              charged = true;
              const sourceSlot = record.slots.find((slot) => slot.clipId === job.clipId);
              const prompt = String(job.falInput.prompt ?? "");
              await writeWorkspaceFile(
                payload.projectId,
                `clips/${job.clipId}.md`,
                clipMarkdown({
                  assetId: `asset_${job.clipId}`,
                  body: `## Source Reference\n\n${sourceSlot?.sourcePath ?? ""}\n\n## Media\n\n${generatedPath}`,
                  clipId: job.clipId,
                  duration: job.duration,
                  generatedPath,
                  importId: payload.importId,
                  importedFrom: payload.url,
                  index: job.index * 2 + 2,
                  inTimeline: true,
                  kind: "generated",
                  planner: sourceSlot
                    ? shots.find((shot) => `${importStem}_shot_${clipIndex(shot.index)}` === job.clipId)
                    : undefined,
                  prompt,
                  sourceClipId: job.sourceClipId,
                  sourcePath: sourceSlot?.sourcePath ?? null,
                  start: sourceSlot?.start ?? 0,
                  status: "active",
                  title: `Generated ${job.index + 1}: ${job.title}`,
                }),
              );
              await mutateRecord((current) => ({
                  ...current,
                  slots: current.slots.map((slot) =>
                    slot.clipId === job.clipId
                      ? { ...slot, generatedPath, requestId: slot.requestId ?? job.requestId, status: "completed" }
                      : slot,
                  ),
                }));
              await refreshTimeline(payload.projectId);
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Charged this shot but its media ultimately failed to persist —
            // refund so the user isn't billed for a clip that never landed.
            if (charged) {
              await refundCredits({
                userId: payload.userId,
                credits: quoteOp(importShotOp(job.duration)),
                projectId: payload.projectId,
                idempotencyKey: `refund:import:${payload.projectId}:${job.clipId}`,
                description: "Refund: shot generation failed",
              }).catch(() => {});
            }
            await mutateRecord((current) => ({
              ...current,
              slots: current.slots.map((slot) =>
                slot.clipId === job.clipId ? { ...slot, error: message, status: "failed" } : slot,
              ),
            }));
            await writeWorkspaceFile(
              payload.projectId,
              `clips/${job.clipId}.md`,
              clipMarkdown({
                assetId: `asset_${job.clipId}`,
                body: `## Error\n\n${message}`,
                clipId: job.clipId,
                duration: job.duration,
                importId: payload.importId,
                importedFrom: payload.url,
                index: job.index * 2 + 2,
                inTimeline: true,
                kind: "generated",
                prompt: String(job.falInput.prompt ?? ""),
                sourceClipId: job.sourceClipId,
                start: 0,
                status: "failed",
                title: `Generated ${job.index + 1}: ${job.title}`,
              }),
            );
          }
        }),
      );

      const failed = record.slots.filter((slot) => slot.status === "failed").length;
      await mutateRecord((current) => ({
        ...current,
        completedAt: new Date().toISOString(),
        status: failed ? "failed" : "completed",
      }));
      await appendChat(payload.projectId, {
        role: "assistant",
        text: failed
          ? `YouTube import finished with ${failed} failed generated clip${failed === 1 ? "" : "s"}.`
          : "YouTube import finished. Generated clips have been added to the canvas in source order.",
      });
      return { failed, importId: payload.importId, ok: failed === 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : "YouTube import failed.";
      await Promise.all(
        generatedPlaceholders.map((placeholder) =>
          writeWorkspaceFile(
            payload.projectId,
            `clips/${placeholder.clipId}.md`,
            clipMarkdown({
              assetId: `asset_${placeholder.clipId}`,
              body: `## Source Reference\n\n${placeholder.sourcePath}\n\n## Error\n\n${message}`,
              clipId: placeholder.clipId,
              duration: placeholder.duration,
              importId: payload.importId,
              importedFrom: payload.url,
              index: placeholder.index * 2 + 2,
              inTimeline: true,
              kind: "generated",
              prompt: placeholder.prompt,
              sourceClipId: placeholder.sourceClipId,
              sourcePath: placeholder.sourcePath,
              start: placeholder.start,
              status: "failed",
              title: `Generated ${placeholder.index + 1}: ${placeholder.title}`,
            }),
          ),
        ),
      ).catch(() => undefined);
      await mutateRecord((current) => ({
        ...current,
        completedAt: new Date().toISOString(),
        error: message,
        status: "failed",
      }));
      await appendChat(payload.projectId, {
        role: "assistant",
        text: `YouTube import failed: ${message}`,
      }).catch(() => undefined);
      return { error: message, importId: payload.importId, ok: false };
    } finally {
      await writeChain.catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
});
