import { generateObject, stepCountIs, streamText, tool, type ModelMessage } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { ensureCurrentAppUser } from "@/lib/app-users";
import {
  appendChat,
  checkProject,
  getProjectSnapshot,
  listProjectFiles,
  parseJsonFrontmatter,
  patchWorkspaceFile,
  readWorkspaceBinaryFile,
  readWorkspaceFile,
  refreshTimeline,
  safeRelativePath,
  withJsonFrontmatter,
  writeWorkspaceBinaryFile,
  writeWorkspaceFile,
  type ChatToolCall,
  type ProjectCheck,
} from "@/lib/workspace";
import {
  cropImageToAspect,
  extractVideoFrame,
  generateFalAudio,
  generateFalImage,
  generateFalMaskedImageEdit,
  generateFalReferenceVideo,
  generateFalMusic,
  generateFalSpeech,
  generateFalVideo,
  generateFalVoiceDesign,
  type GeneratedMedia,
} from "@/lib/media";
import {
  DEFAULT_PORTFOLIO_FORMAT,
  getPortfolioScaffoldUrl,
  portfolioPromptContract,
  PORTFOLIO_SCAFFOLD_INSTRUCTION,
} from "@/lib/portfolio-sheet";
import { detectShots, extractShotTiles, materializeVideo, probeVideoDuration } from "@/lib/video-shots";
import { rm } from "node:fs/promises";
import { buildLineageIndex, dominantAspectRatio, traceLineage } from "@/lib/canvas-lineage";
import { waitForUserAnswer } from "@/lib/pending-questions";
import { hostProjectBytes, signedWorkspaceMediaUrl } from "@/lib/workspace";
import { appendArtifactVersion } from "@/lib/canvas-revision";
import {
  billingEnabled,
  chargeForOp,
  getCreditBalance,
  quoteOp,
  refundCredits,
} from "@/lib/credits-service";
import type { BillableOp } from "@/lib/usage-pricing";
import { isAgentRunCancelled, setAgentRunStatus } from "@/lib/agent-runs";
import { autonameProjectFromQuery } from "@/lib/project-autoname";
import { writeRunTimingLocal, type RunTiming, type ToolTiming } from "@/lib/run-log";
import {
  mediaVersionState,
  mediaVersionWriteState,
} from "@/lib/media-versions";
import {
  imageHashDistance,
  imagePerceptualHash,
  isNearDuplicateDistance,
} from "@/lib/image-similarity";
import {
  ASPECT_RATIOS,
  blockingFrameDeltas,
  buildBuiltAgainst,
  CAMERA_MOVES,
  characterRegion,
  composeClipPrompt,
  composeConditionedPrompt,
  composeModelReferenceLegend,
  composeStagingDirection,
  DIALOGUE_MODES,
  FACINGS,
  FRAME_DELTA_CHANGES,
  IDENTITY_VERIFICATION_STATUSES,
  KEYFRAME_COMPOSITION_MODES,
  MOTION_RATES,
  resolveGenerationAnchors,
  SCREEN_POSITIONS,
  type CameraMove,
  type FrameDeltaEntry,
  type MotionRate,
} from "@/lib/generation-contract";
import { imageSize } from "@/lib/image-size";
import {
  buildSourceGraph,
  CLIP_PLAN_HASH_SUFFIX,
  clipPlanHashValue,
  lookupIdentityHash,
  orderedClips,
  SHOT_SIZES,
  TRANSITION_TYPES,
  VOICE_HASH_SUFFIX,
  type KeyframeNode,
  type SourceGraph,
} from "@/lib/source-graph";
import { reviewKeyframes, type ReviewPair } from "@/lib/keyframe-review";
import { rasterizeRegionMaskPng } from "@/lib/region-mask";
import { listSkillSummaries, readSkill, type SkillSummary } from "@/lib/skills";
import { listWorkflowSummaries, readWorkflow, type WorkflowSummary } from "@/lib/workflows";
import { OPEN_INTENT_ORCHESTRATION } from "@/lib/open-intent-orchestration";
import { createHash } from "node:crypto";

type Params = {
  params: Promise<{ id: string }>;
};

const transitionTypeSchema = z.enum(
  TRANSITION_TYPES as unknown as [string, ...string[]],
);

const dialogueLineSchema = z.object({
  speaker: z
    .string()
    .min(1)
    .describe(
      "A characters reference id (e.g. char_nova), never a prose name — voices resolve speaker -> reference -> voice_id. Narrators/voiceover speakers are also characters references (no portfolio needed).",
    ),
  line: z.string().min(1),
  start_s: z.number().min(0).describe("Second the line starts, within the clip."),
  end_s: z.number().positive().describe("Second the line ends; must fit inside the clip duration."),
  delivery: z.string().nullable().default(null).describe("Optional read: whispered, shouted over wind, deadpan…"),
});

const dialogueSchema = z.object({
  mode: z
    .enum(DIALOGUE_MODES)
    .describe(
      "Always declare. Video models invent mumbling unless silence is explicit: no_audible_speech (default for most clips), nonverbal_only (acting but no speech), exact_dialogue (on-camera lines), voiceover_exact (narration).",
    ),
  lines: z.array(dialogueLineSchema).max(12).default([]),
});

const clipPlanInputSchema = z.object({
  add_to_timeline: z
    .boolean()
    .default(true)
    .describe(
      "Whether this clip is part of the final cut (persisted as in_timeline). The timeline's ORDER is always derived from scene/clip index — set false only for an outtake you don't want played.",
    ),
  aspect_ratio: z
    .enum(ASPECT_RATIOS)
    .describe("Required. Match the project's chosen keyframe ratio exactly: 16:9 landscape, 9:16 portrait/vertical, or 1:1 square."),
  camera_move: z
    .enum(CAMERA_MOVES as unknown as [string, ...string[]])
    .default("fixed")
    .describe(
      "Exactly ONE camera move (Separation Rule): fixed|push_in|pull_out|pan|tracking|orbit|aerial|handheld. Never blend moves; never fold subject motion into the camera.",
    ),
  camera_note: z
    .string()
    .nullable()
    .default(null)
    .describe("Optional modifier for the move: speed/distance, e.g. 'slow, 1-2 feet' or 'follows her exit right'."),
  action_beats: z
    .array(z.string())
    .min(1)
    .describe(
      "The subject action as ordered short beats (one event each), bridging start_state to end_state. Use stable proper nouns, not pronouns. Keep camera OUT of these — that's camera_move. For action, use at most two beats and add more keyframes/clips for additional moves.",
    ),
  action_intent: z
    .string()
    .min(1)
    .max(180)
    .describe(
      "Short model-facing Seedance prompt line in simple guide style: broad subject + dynamic physical motion intent only, not detailed choreography, endpoint wording, or frame-delta bookkeeping. Use energetic body/action verbs (lunges, drives forward, dodges, vaults, recoils) over static states or VFX-only words. Example: 'Anime fight scene; animate committed attacks, counters, parries, and footwork between the two characters.'",
    ),
  environment: z
    .string()
    .nullable()
    .default(null)
    .describe("The setting as seen in the frames (place, atmosphere, key elements)."),
  lighting: z
    .string()
    .nullable()
    .default(null)
    .describe("Named-source lighting (highest-leverage keyword): 'hard top-down', 'neon glow from left', 'golden hour backlight'."),
  frame_delta: z
    .array(
      z.object({
        element: z.string().min(1).describe("The thing that differs, e.g. 'red ball', 'blast door'."),
        change: z
          .enum(FRAME_DELTA_CHANGES as unknown as [string, ...string[]])
          .describe("appeared | vanished | moved | changed_state"),
        classification: z
          .enum(["intended", "continuity_error"])
          .describe(
            "intended = the action explains it (provide narration). continuity_error = a flaw in the end keyframe; clip generation will refuse until you repair it with generateKeyframe(revises=...).",
          ),
        narration: z
          .string()
          .nullable()
          .default(null)
          .describe("For intended changes, how it appears/moves on screen. Put visually important motion in action_beats; frame_delta is validation/accounting."),
      }),
    )
    .default([])
    .describe("Every element that differs between the two observed frames."),
  dialogue: dialogueSchema
    .default({ mode: "no_audible_speech", lines: [] })
    .describe("Spoken-audio contract for this clip, with per-line timing in seconds."),
  duration_seconds: z
    .number()
    .positive()
    .default(5)
    .describe(
      "Actual video duration to request from generation and play back. This is NOT an editorial trim target; duration_seconds and generated_seconds must match unless the user explicitly asks to trim existing media. Provider-supported range is clamped to 4-15s; action clips should normally stay 4-5s.",
    ),
  end_state: z
    .string()
    .nullable()
    .default(null)
    .describe("What is ACTUALLY visible in the to-keyframe, written after viewImage. Required when to_keyframe is set."),
  from_keyframe: z.string().min(1),
  id: z.string().min(1),
  index: z.number().int().positive().default(1).describe("Order within the scene."),
  motion_rate: z
    .enum(Object.keys(MOTION_RATES) as [MotionRate, ...MotionRate[]])
    .default("real_time")
    .describe("slow_motion | real_time | accelerated | frenetic. This is motion feel, not playback trimming."),
  scene: z.string().min(1).describe("Scene id this clip belongs to."),
  shot_size: z
    .enum(SHOT_SIZES as unknown as [string, ...string[]])
    .nullable()
    .default(null)
    .describe("ELS|LS|MLS|MS|MCU|CU|ECU — the dominant framing of this shot."),
  cut_motivation: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "Why the cut INTO this clip exists (advance story, reaction, reveal detail, compress time, rhythm…). If you can't name it, the cut shouldn't exist.",
    ),
  start_state: z
    .string()
    .min(1)
    .describe("What is ACTUALLY visible in the from-keyframe, written after viewImage."),
  title: z.string().min(1),
  to_keyframe: z.string().nullable().default(null),
  transition_from_previous: transitionTypeSchema.nullable().default(null),
});

const MODEL_ID =
  process.env.VIDEO_FS_AGENT_MODEL ||
  process.env.OPENROUTER_MODEL ||
  "openai/gpt-5.3-codex";
const STOPPED_AGENT_MARKER = "[[impractical-agent-stopped]]";

// Curated ElevenLabs premade voices reachable by name through fal.
const ELEVENLABS_VOICES = [
  "Rachel", // calm, warm female — narration default
  "Adam", // deep male — trailers, authority
  "Antoni", // well-rounded male
  "Bella", // soft female
  "Josh", // young male — energetic
  "Elli", // youthful female
  "Charlotte", // seductive female accent
  "Daniel", // deep British male — broadcast
  "Lily", // warm British female
  "George", // raspy British male
];

const MAX_TOOL_STEPS = 40;
// A run may span several model segments; each refreshes the step budget so a
// multi-scene job survives instead of dying silently at the first cap.
const MAX_SEGMENTS = 3;

// Long-running streamed agent loop. `next dev` ignores this (no timeout); in
// production it raises the serverless function ceiling so the loop (reached over
// HTTP by the Trigger task) isn't cut off mid-run.
export const maxDuration = 800;
export const dynamic = "force-dynamic";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY || "missing",
});

/**
 * One agent run per project at a time. Concurrent runs race on the timeline
 * and double-generate; a second message while one is active gets a 409.
 * (Module-scoped: resets on dev hot-reload, which is acceptable.)
 */
const activeRuns = new Set<string>();

type IncomingChatAttachment = {
  data: string;
  name: string;
  type: string;
};

type SavedChatAttachment = {
  name: string;
  path: string;
  size: number;
  /** Canvas tile id when the attachment is media (image/video/audio). */
  tileId?: string | null;
  type: string;
};

function parseIncomingAttachments(value: unknown): IncomingChatAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((attachment): IncomingChatAttachment[] => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return [];
    const record = attachment as Record<string, unknown>;
    const data = typeof record.data === "string" ? record.data.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const type = typeof record.type === "string" ? record.type.trim() : "application/octet-stream";
    if (!data || !name) return [];
    return [{ data, name, type }];
  });
}

function uploadExtension(type: string, name: string) {
  const existing = /\.[a-z0-9]{1,8}$/i.exec(name)?.[0];
  if (existing) return existing.toLowerCase();
  const lower = type.toLowerCase();
  if (lower.includes("pdf")) return ".pdf";
  if (lower.includes("png")) return ".png";
  if (lower.includes("webp")) return ".webp";
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
  if (lower.includes("mp4")) return ".mp4";
  return ".bin";
}

function safeUploadBaseName(name: string) {
  return name
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "attachment";
}

async function saveChatAttachments(
  projectId: string,
  attachments: IncomingChatAttachment[],
): Promise<SavedChatAttachment[]> {
  const saved: SavedChatAttachment[] = [];
  for (const [index, attachment] of attachments.slice(0, 10).entries()) {
    const base64 = attachment.data.includes(",")
      ? attachment.data.split(",").pop() ?? ""
      : attachment.data;
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.byteLength || buffer.byteLength > 25 * 1024 * 1024) continue;
    const digest = createHash("sha1").update(buffer).digest("hex").slice(0, 10);
    const extension = uploadExtension(attachment.type, attachment.name);
    const fileName = `${Date.now()}-${index}-${safeUploadBaseName(attachment.name)}-${digest}${extension}`;
    // Binaries live under media/** (the convention every tile/UI path assumes);
    // uploads/*.md is the tile-record namespace, not a binary store.
    const result = await writeWorkspaceBinaryFile(
      projectId,
      `media/uploads/chat/${fileName}`,
      buffer,
    );
    // Media attachments become first-class canvas tiles immediately — both
    // agents (and the user) address them by id, no manual tile creation.
    const mediaKind = attachment.type.startsWith("image/")
      ? "image"
      : attachment.type.startsWith("video/")
        ? "video"
        : attachment.type.startsWith("audio/")
          ? "audio"
          : null;
    let tileId: string | null = null;
    if (mediaKind) {
      tileId = `chat_${safeUploadBaseName(attachment.name).slice(0, 36)}_${digest.slice(0, 6)}`;
      await writeWorkspaceFile(
        projectId,
        `uploads/${tileId}.md`,
        withJsonFrontmatter(
          {
            content_type: attachment.type,
            id: tileId,
            kind: mediaKind,
            local_path: result.path,
            original_name: attachment.name,
            status: "active",
            type: "upload",
          },
          `# ${attachment.name}

Attached in chat.
`,
        ),
      ).catch(() => {});
    }
    saved.push({
      name: attachment.name,
      path: result.path,
      size: result.size,
      tileId,
      type: attachment.type,
    });
  }
  return saved;
}

function messageWithAttachmentContext(message: string, attachments: SavedChatAttachment[]) {
  if (!attachments.length) return message;
  return [
    message,
    "",
    "Attached files saved in the workspace:",
    ...attachments.map(
      (attachment) =>
        `- ${attachment.name} -> ${attachment.path} (${attachment.type || "file"}, ${attachment.size} bytes)${attachment.tileId ? ` — canvas tile "${attachment.tileId}" (use this id directly in source_ids/conditioning_image_ids/reference ids)` : ""}`,
    ),
  ].join("\n");
}

type UserContentPart = Exclude<Extract<ModelMessage, { role: "user" }>["content"], string>[number];

const INLINE_TEXT_FILE = /\.(txt|md|markdown|json|jsonl|csv|tsv|ya?ml|toml|env|js|ts|jsx|tsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|html|css|scss|sql|sh|bash)$/i;

/**
 * Turn chat attachments into model content parts so the agent actually SEES them
 * (not just a path reference): images -> image parts, PDFs/binaries -> file parts
 * (OpenRouter parses PDFs for non-native models), text/code -> inlined as text.
 */
function attachmentContentParts(attachments: IncomingChatAttachment[]): UserContentPart[] {
  const parts: UserContentPart[] = [];
  for (const attachment of attachments.slice(0, 10)) {
    const base64 = attachment.data.includes(",")
      ? attachment.data.split(",").pop() ?? ""
      : attachment.data;
    if (!base64) continue;
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.byteLength || buffer.byteLength > 25 * 1024 * 1024) continue;
    const type = attachment.type.toLowerCase();
    const dataUrl = attachment.data.startsWith("data:")
      ? attachment.data
      : `data:${attachment.type || "application/octet-stream"};base64,${base64}`;

    if (type.startsWith("image/")) {
      parts.push({ type: "image", image: dataUrl });
    } else if (type.includes("pdf")) {
      parts.push({ type: "file", data: base64, mediaType: "application/pdf", filename: attachment.name });
    } else if (type.startsWith("text/") || type.includes("json") || INLINE_TEXT_FILE.test(attachment.name)) {
      const text = buffer.toString("utf8").slice(0, 200_000);
      parts.push({ type: "text", text: `Attached file "${attachment.name}":\n\n\`\`\`\n${text}\n\`\`\`` });
    } else {
      parts.push({
        type: "file",
        data: base64,
        mediaType: attachment.type || "application/octet-stream",
        filename: attachment.name,
      });
    }
  }
  return parts;
}

function toolSummaryFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["path", "id", "asset_id", "keyframe_id", "clip_id", "reference_id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function toolSucceeded(output: unknown): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return true;
  const ok = (output as Record<string, unknown>).ok;
  return ok === false ? false : true;
}

/**
 * Per-turn context is an INDEX, not a content dump: file tree, one line of
 * frontmatter facts per node, lint state, timeline, and the brief. The agent
 * reads file bodies on demand with readFile. This keeps long projects inside
 * the context budget instead of inlining the whole tree every turn.
 */
function workspaceIndex(snapshot: Awaited<ReturnType<typeof getProjectSnapshot>>) {
  const graph = buildSourceGraph(
    snapshot.files
      .filter((file) => typeof file.content === "string")
      .map((file) => ({ path: file.path, content: file.content! })),
  );
  const nodeLines: string[] = [];
  for (const reference of graph.references.values()) {
    const portfolio = graph.portfolioByReference.get(reference.id);
    nodeLines.push(
      `- reference ${reference.id} [${reference.category ?? "?"}, ${reference.status}] portfolio=${portfolio ? `${portfolio.status}${portfolio.urls.length ? "+media" : ""}` : "none"} (${reference.path})`,
    );
  }
  for (const keyframe of graph.keyframes.values()) {
    nodeLines.push(
      `- keyframe ${keyframe.id} [${keyframe.status}${keyframe.url ? ", media" : ""}] depicts=[${keyframe.depicts.join(",")}] anchors=[${keyframe.identityAnchors.join(",")}]${keyframe.stateAnchor ? ` state_anchor=${keyframe.stateAnchor}` : ""}${keyframe.capturedFrom ? ` captured_from=${keyframe.capturedFrom}` : ""} (${keyframe.path})`,
    );
  }
  for (const scene of graph.scenes.values()) {
    nodeLines.push(
      `- scene ${scene.id} [index ${scene.index ?? "?"}] references=[${scene.references.join(",")}] (${scene.path})`,
    );
  }
  for (const clip of graph.clips.values()) {
    nodeLines.push(
      `- clip ${clip.id} [${clip.status}${clip.url ? ", media" : ""}] ${clip.fromKeyframe ?? "?"} -> ${clip.toKeyframe ?? "?"} end_trust=${clip.endTrust} transition=${clip.transitionFromPrevious ?? "unset"}${clip.shotSize ? ` shot=${clip.shotSize}` : ""}${clip.durationSeconds !== null ? ` ${clip.durationSeconds}s` : ""} scene=${clip.sceneId ?? "?"} (${clip.path})`,
    );
  }
  for (const finding of graph.findings.values()) {
    if (finding.status !== "open") continue;
    nodeLines.push(
      `- finding ${finding.id} [open, ${finding.severity}] implicates=[${finding.implicates.join(",")}]: ${finding.summary} (${finding.path})`,
    );
  }
  const nodePaths = new Set(graph.nodePathById.values());
  const nonRunFiles = snapshot.files.filter(
    (file) => !file.path.startsWith("runs/") && !nodePaths.has(file.path),
  );
  const isUserUpload = (path: string) => path.startsWith("documents/") || path.startsWith("uploads/");
  const userMaterials = nonRunFiles
    .filter((file) => isUserUpload(file.path))
    .map((file) => `- ${file.path} (${file.kind}, ${file.size} bytes)`)
    .join("\n");
  const otherFiles = nonRunFiles
    .filter((file) => !isUserUpload(file.path))
    .map((file) => `- ${file.path} (${file.kind}, ${file.size} bytes)`)
    .join("\n");
  const issues = snapshot.check.issues
    .map((issue) => `- ${issue.level}: ${issue.path ? `${issue.path}: ` : ""}${issue.message}`)
    .join("\n");
  const brief = snapshot.files.find((file) => file.path === "brief.md");
  const timeline = snapshot.timeline
    .map((item, index) => `${index + 1}. ${item.clip_id ?? item.asset_id ?? item.id}${item.url ? "" : " (no media)"}`)
    .join("\n");
  // The canvas view: every visible tile with its provenance (what it was
  // derived from, which group/storyboard row it belongs to, how it was made).
  const canvasLines: string[] = [];
  for (const file of snapshot.files) {
    if (typeof file.content !== "string") continue;
    const isKeyframe = /^keyframes\/[^/]+\.md$/.test(file.path);
    const isClip = /^clips\/[^/]+\.md$/.test(file.path);
    const isUpload = /^uploads\/[^/]+\.md$/.test(file.path);
    if (!isKeyframe && !isClip && !isUpload) continue;
    const parsed = parseJsonFrontmatter(file.content);
    const meta = parsed.meta;
    if (typeof meta.id !== "string") continue;
    if (meta.status === "rejected" || meta.status === "superseded") continue;
    const title =
      parsed.body
        .split("\n")
        .find((line) => line.startsWith("# "))
        ?.slice(2)
        .trim() ?? meta.id;
    const kind = isUpload
      ? `upload(${meta.kind === "video" ? "video" : "image"})`
      : isClip
        ? "video"
        : "image";
    const bits: string[] = [];
    if (typeof meta.canvas_derived_from === "string" && meta.canvas_derived_from) {
      bits.push(`derived_from=${meta.canvas_derived_from}`);
    }
    if (Array.isArray(meta.depicts) && meta.depicts.length) {
      bits.push(`depicts=[${meta.depicts.join(",")}]`);
    }
    if (typeof meta.canvas_group === "string" && meta.canvas_group) {
      bits.push(
        `group=${meta.canvas_group}${typeof meta.canvas_group_index === "number" ? `#${meta.canvas_group_index}` : ""}`,
      );
    }
    if (meta.canvas_composed === true) bits.push("made_by=canvas-composer");
    canvasLines.push(
      `- ${kind} ${meta.id} "${title}"${bits.length ? ` ${bits.join(" ")}` : ""} (${file.path})`,
    );
  }
  let userGroupsText = "";
  const groupsFile = snapshot.files.find((file) => file.path === "canvas/groups.json");
  if (groupsFile && typeof groupsFile.content === "string") {
    try {
      const parsedGroups = JSON.parse(groupsFile.content) as {
        groups?: Array<{ cardIds?: string[]; id?: string; title?: string }>;
      };
      const entries = (parsedGroups.groups ?? []).filter(
        (group) => Array.isArray(group.cardIds) && group.cardIds.length,
      );
      if (entries.length) {
        userGroupsText = entries
          .map((group) => `- "${group.title ?? group.id}": ${group.cardIds!.join(", ")}`)
          .join("\n");
      }
    } catch {
      /* unreadable groups file — skip */
    }
  }
  const workingAspect = dominantAspectRatio(snapshot.files);
  return [
    `Project: ${snapshot.project.name} (${snapshot.project.id})`,
    workingAspect
      ? `WORKING ASPECT RATIO: ${workingAspect} — every clip and keyframe in this project uses it. Pass aspect_ratio: "${workingAspect}" on EVERY generation unless the user explicitly asks for a different ratio. Do not choose a ratio yourself.`
      : "",
    `Check: ${snapshot.check.ok ? "ok" : "FAILING"}${issues ? `\n${issues}` : ""}`,
    `Graph nodes:\n${nodeLines.length ? nodeLines.join("\n") : "(empty — fresh project)"}`,
    `Canvas — the surface the user is looking at. Every line below is a visible tile (uploads, generated images, video clips) with its provenance. A "storyboard" is NOT a separate view: it is simply a canvas GROUP — tiles sharing canvas_group frontmatter (canvas_group, canvas_group_index, canvas_group_title) are laid out together as a row. To build or reorganize a storyboard, set those fields on the tiles (writeFile/patchFile), or pass them when generating.\n${canvasLines.length ? canvasLines.join("\n") : "(no tiles yet)"}${userGroupsText ? `\nUser-made canvas groups (hand organization — treat membership as the user's intent about what belongs together). To place a NEW tile into one of these groups, pass the group's title as the canvas_group / group_id (e.g. "Main clips" → group_id "main_clips") — matching is by title. When output clearly belongs with an existing group (e.g. a new clip for a clips group), place it there instead of loose on the canvas:\n${userGroupsText}` : ""}`,
    `Timeline:\n${timeline || "(empty)"}`,
    `Video editor: the user assembles the final cut in the Editor view (OpenCut). Inspect it with readVideoEditor, assemble/append with addClipToEditorTimeline, and make arbitrary edits (reorder, trim, retime) with writeVideoEditor. Canvas clips/images enter its media bin automatically when the user opens the Editor view.`,
    userMaterials
      ? `User-provided materials — files the user uploaded as source/reference (brand guidelines, scripts, screenshots, etc.). Treat these as authoritative: review them before planning and use them. View images with viewWorkspaceImage; read a document's extracted text via its content.md with readFile; reference their paths in tool calls when relevant.\n${userMaterials}`
      : null,
    `Other files:\n${otherFiles || "(none)"}`,
    brief?.content ? `brief.md:\n${brief.content.slice(0, 2000)}` : "brief.md: (default)",
    "File bodies are not inlined; use readFile to read any file you need.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function skillInventoryText(skills: SkillSummary[]) {
  if (!skills.length) return "Available skills: none configured.";
  return [
    "Skill catalog (full method bodies; load with readSkill when the workflow below calls for them):",
    ...skills.map(
      (skill) =>
        `- ${skill.id}: ${skill.use_when_summary || skill.description || "No summary."}`,
    ),
  ].join("\n");
}

function workflowInventoryText(workflows: WorkflowSummary[]) {
  if (!workflows.length) return "";
  return [
    "Workflow recipes (end-to-end production processes; load with loadWorkflow):",
    ...workflows.map((workflow) => `- ${workflow.id}: ${workflow.use_when}`),
  ].join("\n");
}

function systemPrompt(skills: SkillSummary[], workflows: WorkflowSummary[]) {
  return `You are the project's video agent. The user's primary surface is the CANVAS — a spatial board of tiles (generated images, video clips, audio, uploads, references). Every artifact you create becomes a tile there; think in terms of what appears on the user's canvas, not in terms of files. The project is stored as a source tree underneath (you read it and write your understanding back into it), and checkProject is the compiler for the precision pipeline — but the tree is plumbing, the canvas is the product.

${OPEN_INTENT_ORCHESTRATION}

SURFACES:
- Canvas: where material is made and arranged. A "storyboard" is NOT a separate view or concept — it is simply a canvas GROUP: tiles sharing canvas_group/canvas_group_index/canvas_group_title frontmatter lay out together as a row. To make or reorganize a storyboard, set those fields.
- Editor: where the final video is assembled (the user's Editor view). The cut lives there — inspect with readVideoEditor, append/stack with addClipToEditorTimeline, fades with fadeElement, volume/opacity/speed with setElementProperties, music/VO/SFX (placed, looped, faded) with addAudioToTimeline, audio crossfades between music/VO with crossfadeAudio, smoothing ALL clip-bridge cuts with crossfadeClipBridges (use this when asked to crossfade the clips' own audio — never approximate with per-element fade chains), arbitrary structural edits with patchVideoEditor (JSON Patch ops against paths — readVideoEditor first, then patch; no need for a dedicated tool per operation), full-document rewrites with writeVideoEditor as last resort. Both are validated — invalid documents bounce with precise errors. Prefer: specific verb > patchVideoEditor > writeVideoEditor. timeline.json is legacy derived state; the editor document is the real edit.
- Chat: where you explain in plain visual language.

EXECUTION DEPTH — this is an internal implementation choice, not a choice to put in front of the user:
- CANVAS MODE (default): direct, fast creation onto the canvas. generateVideoFromImage is TRUE image-to-video — the exact image becomes the first frame; use it whenever the user says continue/extend/animate FROM an image or frame. generateVideoFromReferences puts existing subjects (references, keyframes) into new video via loose conditioning — for depicting subjects, NOT for continuing from an exact frame. No keyframe chain, no review gate for either. extractShots splits footage into shot tiles; captureFrame/extractFrames pull stills from video; generateImage makes loose stills. Use this mode for one-off asks, quick iterations, remixing what's on the canvas, and anything the user phrases casually. Do not drag the user through scenes/keyframes/reviews for a simple "make me a clip of X".
- PRODUCTION MODE (precision pipeline): the style-first → references → keyframes → review → clips machinery below. Reach for it when the requested outcome genuinely needs frame-locked continuity across multiple shots — a film, trailer, ad, or montage where shots must connect in pixels. Choose it without asking the user to select a mode, and still keep the user's canvas tidy (group related tiles).

When the user uploads files they appear in the workspace index under "User-provided materials" (brand guidelines, scripts, screenshots, reference photos) and as tiles on the canvas. Treat them as authoritative source/reference: review them up front before planning — viewWorkspaceImage to see an image, readFile to read a document's extracted content.md — honor any constraints they state (e.g. brand rules), and reference their file paths in tool calls when generating.

PRODUCTION MODE — the precision pipeline (only when frame-locked multi-shot continuity is required):
- STYLE FIRST (do this before any other generation): create a \`styles\` reference that captures the whole piece's art direction — medium/rendering, color palette, line and shading, lighting mood, era/genre — and generate its style portfolio FIRST, before generating any character/environment/prop portfolio, keyframe, or clip. Everything inherits that look: the style portfolio is automatically passed in as a conditioning reference when you generate other portfolios, and you MUST also list the style reference id among identity_anchors on every keyframe so frames share it. If the user names a clear look (anime, claymation, noir, watercolor, 3D Pixar-style, etc.), encode it in the style reference; if they don't, choose a coherent one and proceed. Treat a missing style portfolio as a blocker for downstream generation.
- Identity (timeless): anything recurring — a person, item, location, style — gets a reference and a generated portfolio BEFORE keyframes rely on it. Portfolios are ground truth; future frames copy them.
- State (temporal): keyframes are the visual state at an instant, stored top-level in keyframes/ and SHARED between clips. Clips are edges: from_keyframe → to_keyframe.
- A continuous shot = consecutive clips literally share a keyframe node. A jump cut = no shared node.
- generateKeyframe conditions on identity_anchors (portfolio images) plus state_anchor (the prior frame) for continuous progression. Across a cut, omit state_anchor so composition is not copied.
- ACTION DEFAULTS TO CUTS: for fights, chases, races, dances, stunts, or complex blocking, prefer short cut-separated shots. Use state_anchor continuity only for a short local motion where the same subjects, props, and set pieces can plausibly stay coherent. Never build a long action one-er by chaining many state_anchor keyframes; checkProject rejects continuous state_anchor chains longer than the project cap.
- SINGLE-AXIS ENDPOINTS: a first/last-frame video model interpolates ONE near-linear change well and morphs/smears when several things change at once or nothing changes but texture. For the rare same-shot endpoint B, author it as an EDIT of A: state_anchor=A and move exactly one declared delta axis — pose | position | camera | interaction | environment_state — while holding identity, world, style, aspect, and screen direction stable. Hold lighting and lens stable too UNLESS the declared axis is camera (lens/perspective may move) or environment_state (lighting/world state may change). If an action beat needs two axes (e.g. pose + camera, impact + aftermath, or obstacle change + body move), make a real cut/new shot setup unless a simple intermediate keyframe keeps the continuous chain short and local. Across a cut/camera reset/new shot setup, omit state_anchor — a new shot is supposed to recompose.
- RELATIONAL ACTION BEATS: never write vague endpoints like "the chase continues", "they fight", or "the tackle happens". State the before/after relationship in ordinary visual terms: who leads, who trails, the gap/distance, who owns the prop, what fixed set piece stays put, and whether the gap opens or closes. For pursuits, stage one subject clearly ahead and the other clearly behind (or use over-the-shoulder/depth framing); do not stage them side-by-side unless the story literally requires it. Prop transfers, impacts, standing-to-ground changes, and major location/set-piece changes are cut-worthy beats: usually show anticipation, CUT, then aftermath. If a prop owner changes or a major set anchor appears/vanishes/moves, omit state_anchor and make it a new shot, or add explicit intermediate keyframes that keep each continuous pair simple.
- IDENTITY-BOUND COMPOSITION: for any final keyframe with two or more visible named characters, do not generate all identities in one reference soup. Use the paper-faithful API clone: first generateKeyframe a plate/background (the staged scene WITHOUT the principals, or with them low-detail/absent), then call injectCharacter once per visible character with a normalized region box {x,y,w,h} for that character — it mask-edits ONE identity-bound character into that region using only that character's portfolio, holds the rest of the image unchanged, and records composition.mode="sequential_injection" + composition.injected_references for you. After all injections, run verifyKeyframeIdentity for every visible character. Do NOT hand-author composition or pass two character portfolios in one generation call. checkProject rejects multi-character generated keyframes that lack sequential injection or passed per-character identity verification.
- SPEND CONTROL / GIVE-UP PATH: generation tools enforce hard caps on per-keyframe media versions and per-character injection attempts. If a tool says a keyframe hit a version cap or injection-attempt cap, do NOT retry the same keyframe id. Treat it as evidence the beat is overconstrained: make a cut/new keyframe setup, simplify the staging, isolate one principal, remove the prop handoff from that frame, or ask for a deliberate override. A stalled frame should become a simpler shot, not another generation attempt.
- generateClip with both keyframes enforces first AND last frame (end_trust: pinned) — the shared node is then guaranteed in pixels. With only from_keyframe the end is unenforced (end_trust: unknown): before continuing from it, captureFrame the real final frame and chain from that.
- ASPECT RATIO: at the start of every video plan, explicitly choose ONE canvas from exactly {16:9 landscape, 9:16 portrait/vertical, 1:1 square}. Use 9:16 for portrait, vertical, phone, TikTok/Reels/Shorts/stories, selfie/vlog framing, or anything the user describes as vertical; use 16:9 for cinematic/wide/desktop/YouTube landscape; use 1:1 only when square/social-grid is requested. Write and pass that SAME aspect_ratio on every planned keyframe, generated keyframe, and clip. Never rely on tool defaults for keyframes/clips. Mismatched keyframe/clip aspect is a checkProject error.

Workspace layout (each directory has a _README.md with exact frontmatter fields):
references/<category>/<id>/{reference.md,portfolio.md} · keyframes/<id>.md · scenes/<idx>-<slug>/scene.md · clips/<id>.md · timeline.json · assets/ prompts/ operations/ media/

Working method:
- Author records with writeFile/patchFile using JSON frontmatter per the _README conventions. Generation tools write their own records and built_against hashes — never hand-author built_against.
- Use webSearch for current web context, product/place/company facts, news, and broad research that should come through OpenRouter's web search server tool.
- When the user needs actual internet image references, real products, logos, places, style examples, stock photos, or image inspiration with direct image files, call searchImages. Prefer source:"firecrawl" or source:"all" for broad internet image search, source:"pexels" for stock-photo style references, and Openverse/Wikimedia when public-license provenance matters. Use returned image_url values as visual references only when appropriate; keep attribution/license/landing_url in mind and do not imply ownership.
- In PRODUCTION MODE, for any multi-shot piece (trailer, film, montage, ad), write the scene and clip plan BEFORE generating keyframes. Planned clip records may include shot_size, transition_from_previous, and cut_motivation, but duration_seconds must represent the actual generated/requested video length, not a shorter editorial trim. Do not create sub-clip playback durations unless the user explicitly asks to trim existing media.
- In CANVAS MODE, skip scene planning entirely: generate directly (generateVideoFromImage / generateVideoFromReferences / generateImage / extractShots / captureFrame) and stop.
- GROUP DISCIPLINE: do NOT create a new group per artifact. Only set canvas_group when the user names a group, when adding to an existing user group (listed in the canvas index), or for an explicit multi-part sequence. One-off output gets NO group.
- CANVAS ORGANIZATION: whenever a working session leaves more than 4 NEW loose tiles (no canvas_group), you MUST call organizeCanvas before finishing to gather them into sensible named groups (cast portfolios, storyboard beats, clips) so frames don't pile up on the canvas. Re-running it on tiles already in the target group re-places strays — use that when the user says tiles look scattered. User-made groups are inviolable without their explicit ask. organizeCanvas is the ONLY layout lever: NEVER write canvas/groups.json (it mirrors the user's client state; your edits get overwritten and you'd be claiming a fix that changes nothing).
- CHARACTER VOICES: characters can be CAST with a voice — a "voice" field on their reference.md frontmatter (a premade ElevenLabs name from generateSpeech, or a designed voice id). Quick casting: pick from the premade list. Distinctive characters deserve a DESIGNED voice: designVoice with a description derived from the character (age, accent, texture, mood) and ideally a real line of their dialogue as preview_text → askUser with the returned preview tiles as asset_id options so the user LISTENS and picks → write the chosen voice_id into the reference frontmatter as "voice". From then on ALWAYS pass character_id to generateSpeech so lines stay in that character's voice — voice consistency is identity consistency.
- CLIP SECTION REQUESTS: a user message starting with [[canvas-request]] {"kind":"section",...} marks a time span INSIDE one editor clip — media_id is the canvas clip tile id, element_id the editor timeline element, in_seconds/out_seconds the span in the clip's SOURCE time. The instruction applies to that span only; the METHOD is entirely your call based on what they asked: pinned i2v between boundary frames (captureFrame at in/out) for a fix, reference-to-video with the section/portfolios as references for new action, a restyle pass, or pure editor ops (cut, retime) when no generation is needed. Whatever you do, splice the result back so the untouched parts play exactly as before: split the element at in/out via patchVideoEditor, replace only the middle, keep or crossfade audio at the seams. Never regenerate the whole clip when only the marked span needs work.
- PLAN DISCIPLINE (multi-step work): before starting any piece with more than ~2 steps, write the plan with updatePlan (short human step titles) and mark the first step active. The cursor rule: exactly ONE step is active; mark a step active BEFORE executing it and done THE MOMENT it finishes. The active step is re-shown to you every turn and in generation results (plan_cursor) — if what you're about to do is not the active step, updatePlan FIRST (changing the plan is always allowed, takes one call, and is the honest way to deviate; silent drift is not). When a user instruction conflicts with the plan, fold it in as a plan update — or askUser if the conflict is genuinely ambiguous. Single quick asks need no plan.
- ASKING THE USER: only when a missing answer truly blocks useful progress, use the askUser tool (the run pauses for their answer and then continues; attach tile asset_ids to options for visual side-by-sides). Infer reversible creative defaults and begin work instead of turning the request into a setup interview. NEVER end your reply with a clarifying question in prose — a question in text dead-ends the run, while askUser keeps it alive. Ask at most ONE askUser call per run — but that call can carry up to 6 genuinely blocking questions and questions can be multi_select. Concrete options always; never ask things the project already answers. When you need MATERIAL from the user (photos of a real person, a style frame, a logo, a product shot), set allow_upload on the question — their files arrive as upload tiles and the answer's uploaded_ids plug straight into conditioning_image_ids/style_image_ids/source_ids; prefer asking for the user's own photos over web-searching when the subject is personal to them. Questions at the very END of completed work ('want me to also…?') stay in prose — askUser is for decisions that BLOCK the current task.
- PROVENANCE HONESTY: when the user asks how an artifact was made or what you did, answer ONLY from records — traceLineage, the artifact's prompts/*.prompt.md and operations/*.operation.md files, its versions array, and the chat history. Read them first, then report. If the records don't say, say "the records don't show that" — NEVER reconstruct a plausible-sounding pipeline from memory; a confident wrong story is worse than an honest gap.
- REAL PEOPLE: if the user asks for a character based on a real-life person, use a real picture to make the reference — searchImages, saveImageToCanvas, pass the tile ids as conditioning_image_ids on generateReferencePortfolio. Never generate their likeness from the name alone. Imaginary characters: no pictures needed, invent freely. conditioning_image_ids carries SUBJECT images only (person photos, product/location shots); style examples go in style_image_ids.
- INTERNET IMAGES: when you find an image online (searchImages) that you plan to USE — as a generation reference, jersey/product/likeness source, style example — FIRST saveImageToCanvas (with the direct image_url, never the landing/article url), THEN condition on the saved tile's id via source_ids/reference_ids. Never pass raw internet URLs into image_urls of generation tools: article pages break generation (422s) and the user can't see what you chose.
- SEEDANCE PROMPT STYLE (all video generation prompts): write a declarative description of what is ON SCREEN over time — never meta-instructions (no 'use X as reference', 'create a', 'keep/maintain the style'; instead weave tags in naturally: 'In the style of @Image1, ...' / '@Video1 continues: ...'). Concrete subjects doing concrete actions with energetic physical verbs (bursts, whips, lunges) — never abstract energy words ('dynamic movement', 'sharp cuts') or unrenderable concepts ('broadcast geography', 'continuity'). Exactly ONE camera move per shot, stated plainly. If the clip has internal cuts, describe each shot separately ('Cut to: ...') with its own subject and action. State style constants as visual facts (gritty inked shading, desaturated storm palette), and put negatives at the end ('no on-screen text').
- SEEDANCE @ TAGS: generateVideoFromReferences prompts address their attachments as @Image1..@ImageN and @Video1..@VideoN (in reference_ids order). Use them explicitly to bind subjects and footage — '@Video1 continues seamlessly; the chicken from @Image1 walks into frame'. These are the ONLY tag forms Seedance understands; never invent bracket tags. For CHARACTERS, bind each name to its tag on first mention — 'Salah (@Image1) presses forward as Messi (@Image2) closes in' — then use the name alone; that is how named characters work with positional tags. To extend/match existing footage, pass the CLIP id itself (it attaches as @Video1) — that IS passing the video as a reference.
- EXPANDING AN EXISTING SHOT (new characters/action in a scene the user already has): anchor on the existing clip's PIXELS, not loose references. (1) captureFrame/extractShots a representative frame from the clip — that IS the scene; (2) any new subject (character, outfit, object) that doesn't exist in pixels yet gets composited into that frame with generateImage first; (3) generate video FROM those anchors (generateVideoFromImage or reference_ids = the frames); (4) as a NEW tile. Portfolios alone preserve identity, NOT the scene — scene drift reads as 'you didn't continue from my clip'.
- RETRY DISCIPLINE: if a generated image or clip is not what you hoped, you get at most ONE self-initiated retry — and a retry MUST pass revises: <the existing tile's id> so it becomes a new VERSION of the same tile, never a sibling tile. Then STOP and show the user what you produced and let them decide. New ids are only for genuinely new content. Reuse existing anchors — do not re-capture a frame that already exists.
- MAKING A SPECIFIC IMAGE APPEAR IN FOOTAGE- MAKING A SPECIFIC IMAGE APPEAR IN FOOTAGE (logo, ticket, product, poster): the video model can ONLY see the images you pass — describing the asset in the video prompt produces a hallucinated substitute. And do NOT composite it into the START frame: the shot would open with the asset already there, a continuity jump. Correct recipe: (1) keep the untouched anchor as start_image_id for continuity, (2) generateImage a TARGET frame with source_ids = [anchor frame, asset id] showing the asset where it should END UP ("this exact ticket centered, rest of frame unchanged"), (3) generateVideoFromImage with start_image_id = anchor AND end_image_id = the composited target — first/last interpolation makes the asset APPEAR during the shot.
- EDITOR PLACEMENT: when the user's request mentions the edit/timeline/cut ("add it to the timeline", "for the edit"), place the generated clip with addClipToEditorTimeline — APPEND to the end of the main track (at_seconds null) unless told where; never insert mid-cut uninvited. If the tool reports the placement was QUEUED, that is success — it applies when the editor ingests the media; do not retry. If the user did not mention the edit, leave the clip on the canvas and offer placement in one sentence. No review gates, no scene files, no timeline writes — offer the editor tools if the user wants the results assembled into the cut.
- The checkProject pacing report gives you the numbers (shot count, durations, transition mix, size runs); use it as diagnostics only. Do not shorten generated clips just to create faster pacing.
- Mutating tools return a "check" summary. Treat errors like compiler errors: fix them before generating further. Resolve staleness by regenerating, superseding, or marking intentionally_unchanged.
- User-facing chat is for plain visual summaries, not filesystem jargon. Do not expose raw file paths, raw media URLs, hashes, built_against, "frame_delta", "staleness", "interpolable", or similar pipeline terms unless the user explicitly asks for technical detail. Unless the user explicitly asks for links, never drop bare URLs into chat; refer to generated media by its human title and mention token instead. Refer to keyframes, clips, and references by their human title in prose. If mentioning a concrete node helps the user locate it, include its id as a compact mention token (for example @kf_intro or @clip_opening) so the UI can render it as a titled chip with preview; do not wrap mention tokens in backticks, bold, or parentheses, and do not use ids as the visible explanation.
- NAMING: every title you assign — tiles, references, clips, keyframes, scenes, assets, audio — is at most 5 words and NEVER embeds the object's type. Not "Character Cristiano Ronaldo", "Clip: stadium flyover", or "Location - Tokyo Street"; just "Cristiano Ronaldo", "Stadium flyover", "Tokyo street". The UI already labels what kind of thing each tile is.
- Reference edits update source text and pixels together: when the user asks to change a character/location/object/style reference, read and patch references/<category>/<id>/reference.md first so the written identity/details match, then regenerate its portfolio. Do not only regenerate the image; reference.md is the source of truth the UI shows and future prompts inherit. When a tile is focused (see CANVAS FOCUS) and the request is an edit of it, edit THAT tile in place (reference.md + portfolio for references; revises=<id> for keyframes/images/clips) rather than generating a new sibling tile.
- Plan scenes and planned keyframes as files first; generate the style portfolio FIRST, then the other portfolios; pause for portfolio approval; then generate keyframes (each anchored on the style).
- KEYFRAME REVIEW (after the keyframe pass, before clips): call reviewKeyframes. A SEPARATE critic model runs a rubric-blind adversarial pass plus a rubric pass over every clip's start/end pair and the portfolios, checking identity drift, camera/background coherence, geography/180-line/direction breaks, prop continuity, stray objects, too-similar endpoints, and too-large/uninterpolable endpoint jumps. Present the findings to the user. Open BLOCKER findings stop clips — fix those, resolveFinding, then re-run reviewKeyframes so the independent critic clears the fix before prepareClipPrompts/generateClip. Try at most three review/fix rounds before asking the user to decide. Choose the repair by blocker type: local defects (wardrobe, prop, hair, lighting, a stray object) use generateKeyframe(revises=...) for an in-place edit; camera/background-coherence, uninterpolable-jump, screen-direction/geography, shot-scale, or crowd-count blockers must NOT use revises — regenerate the end frame from the previous valid keyframe (state_anchor) or insert a bridge keyframe, because "keep it identical except…" cannot fix a whole-frame camera/scale problem. For any clip whose intent implies visible change, endpoints need a meaningful visual-state delta: subject pose/position, object placement, camera angle/background perspective, or environment state. A motivated perspective change is a strong valid delta for orbit, pan, tracking, push, pull, or reframe shots when the subjects and background imply the same camera path. FX/noise-only changes (sparks/glow/lighting pulse/facial intensity/blade angle/rain shape/lightning shape/repeated background pattern) count as too-similar. For action clips (fight/chase/race/dance/stunt/combat/complex blocking), treat too-similar endpoints AND too-large pose/crop/geography deltas as blockers because they produce static clips, smears, or jumps. Issue/note findings are advisory for low-motion shots only.
- CLIP PROMPT PLANNING (required after keyframe review, before clips): call prepareClipPrompts with the structured clip plans. It writes editable prompts in prompts/*.prompt.md and planned clip records with prompt_plan hashes. Let the user inspect or edit those prompts when appropriate. generateClip will refuse missing/stale planned prompts and sends the stored prompt verbatim — do not rely on ad hoc prompt composition at generation time.
- SKILLS BY STEP — readSkill loads the method. When the step below comes up, readSkill the named skill BEFORE doing that step:
	  - PLANNING ANY PRODUCTION-MODE video that tells a story or depicts a world — a film, trailer, ad, montage, "what if" concept, or anything with characters, a setting, or a sequence of shots → readSkill directors-notebook FIRST, before writing any scene, shot plan, cut map, or keyframe. Skip for CANVAS-MODE one-offs and single isolated clips.
	  - Writing the shot/cut map → cuts (where/why to cut, what part of action to show, cut motivation) + camera-narrator (shot_size, the single camera_move, reveal).
  - Designing each storyboard panel, shot frame, keyframe, pre-viz image, or per-shot visual → storyboard-image-direction FIRST, then direct-eyes (focal point via contrast/depth/framing + the named lighting source). For generated video keyframes, apply storyboard-image-direction's "anticipation frame, not apex frame" rule, including destination/end keyframes: use two different readable anticipation poses or staged states with a meaningful delta, not an impact/apex smear. This repo uses first/last keyframe interpolation, so adapt any reference-to-video continuation examples in the skill to the available keyframe/clip tools; do not invent @Video1 or continuation-only tools.
  - Shot design / coverage for a complex scene → prose-storyboard.
  - Reviewing keyframes → film-grammar (180-line, screen direction, geography checklist).
  Skills are for shot thinking, coverage, staging, camera, and cut motivation. Do not use any skill to create shorter editorial trim durations: duration_seconds must remain the actual generated/playback duration and match generated_seconds unless the user explicitly asks for a trim workflow.
- For a broad change ("change the character/style"), trace usages first (traceReferences), then update the reference and let staleness findings drive what regenerates.
- User-edited ## Prompt sections in keyframe files and planned prompt files are authoritative creative intent. Preserve them; only override when the user explicitly asks for a different prompt.
- Before prepareClipPrompts, viewImage BOTH endpoint keyframes and DIFF them. start_state/end_state describe the real pixels for review/UI. action_intent is the short model-facing Seedance line in the simple guide style: broad subject + dynamic physical motion intent in ordinary language, not detailed choreography, endpoint wording, or frame-delta bookkeeping (example: "Anime fight scene; animate committed attacks, counters, parries, and footwork between the two characters."). Prefer energetic body/action verbs (lunges, drives forward, dodges, vaults, recoils) over static states ("standoff", "holds", "faceoff", "blade lock") or VFX-only language ("explosive", "glowing slash trail"). action_beats are ordered short planning beats for review/lint only (stable proper nouns, no pronouns); keep camera OUT of these — that's camera_move. camera_move is exactly one move (never blended, never mixed with subject motion). Endpoint pairs must show a meaningful visual-state delta matched to the clip intent: subject pose/position, object placement, camera angle/background perspective, or environment state. Prefer a clearly changed camera angle or perspective when the clip's camera intent is an orbit, pan, tracking move, push, pull, or reframe. A pair that changes ONLY in sparks/FX/glow/lighting pulse/facial intensity/blade angle/rain shape/lightning shape/repeated background pattern has no real delta and is too-similar. For action clips, use dense keyframes and short spans: one clear interpolable full-body motion per clip, at most two action beats, and normally 4-5s; if the movement needs more beats, create more keyframes/clips instead of stretching one pair. Crucially, frame_delta must list EVERYTHING that differs between the two frames: classify each as "intended" (covered by the broad action_intent/action_beats if it matters visually) or "continuity_error" (a flaw — then fix the end keyframe with generateKeyframe(revises=...) before the clip will generate). An unaccounted object in the end frame is the top cause of "something's off" in the result. PAIR DIAGNOSIS before prepareClipPrompts — for each clip answer five questions from the two real images: (1) what is held constant (identity/world/style/lighting/lens/screen direction)? (2) which single axis changed (pose/position/camera/interaction/environment_state)? (3) is that change clearly visible, not just FX/noise? (4) is it reachable by one near-linear interpolation, not a cut or morph? (5) are there any UNPLANNED deltas? If nothing meaningful changed, the clip is too-similar; if two-plus axes changed or the path needs a cut, it is too-far — fix the end keyframe with generateKeyframe(revises=...) or split into more keyframes/clips before planning the prompt.
- Every clip declares a dialogue mode; most clips are no_audible_speech or nonverbal_only — video models invent mumbling unless silence is explicit. Spoken lines carry start_s/end_s inside the clip duration, and every speaker is a characters reference id (narrators included — create a portfolio-less characters reference for them).
- In PRODUCTION MODE, run checkProject before your final answer and state remaining errors/warnings plainly. In CANVAS MODE skip it unless you touched pipeline records (scenes, planned keyframes, timeline clips) — canvas tiles don't need the linter.
- NARRATE AS YOU WORK. The user watches your tool calls stream in live, so say what you are about to do and why in ONE short line before each batch of calls ("Locking the product from your photo so it stays identical in every shot."), and a short line after a batch that changed direction or returned something surprising. Plain language about intent, not a list of tool names or parameters — a person reading only your lines should understand the run. No line before trivial reads (listFiles/readFile) and never narrate every call individually; silence through a long batch is what makes this feel broken.
- Parallelize independent generation calls by emitting them together in one step: portfolios for different references, cut-separated keyframes that do not state_anchor each other, and clips whose endpoint keyframes already have urls. Keep dependent work sequential only for short continuous state_anchor runs; for action, cut to reset composition instead of extending the chain.

- WORKFLOWS: inspect the workflow inventory yourself. For a complex request with one strong semantic match, call loadWorkflow BEFORE planning, silently adapt its useful method to the user's actual outcome, infer its optional inputs, and continue executing. Do not make the user browse, select, or name a workflow; do not offer a list of recipes instead of starting. Skip workflows for direct asks and weak matches. A named workflow is still honored. Once loaded it is a strong aid, not a cage — omit irrelevant steps and record meaningful deviations in the plan. Users can save custom recipes as workspace files under workflows/<slug>.md (same format; readFile to load those); when a user asks to "save this as a workflow", write one there capturing inputs, plan template, and method.

${skillInventoryText(skills)}

${workflowInventoryText(workflows)}`;
}

async function writeOperation(projectId: string, input: {
  id: string;
  kind: string;
  title: string;
  prompt?: string;
  result?: unknown;
}) {
  const content = withJsonFrontmatter(
    {
      id: input.id,
      type: "operation",
      kind: input.kind,
      created_at: new Date().toISOString(),
    },
    `# ${input.title}\n\n${input.prompt ? `## Prompt\n\n${input.prompt}\n\n` : ""}## Result\n\n\`\`\`json\n${JSON.stringify(input.result ?? {}, null, 2).slice(0, 20_000)}\n\`\`\`\n`,
  );
  await writeWorkspaceFile(projectId, `operations/${input.id}.operation.md`, content);
}

async function writeAssetFromGeneration(projectId: string, input: {
  assetId: string;
  derivedFrom?: string[];
  depicts?: string[];
  generation: GeneratedMedia;
  kind: "image" | "video" | "audio";
  localPath?: string | null;
  prompt: string;
  title: string;
  usedIn?: string[];
}) {
  const content = withJsonFrontmatter(
    {
      id: input.assetId,
      type: "asset",
      kind: input.kind,
      status: input.generation.url ? "active" : "pending",
      url: input.generation.url ?? null,
      local_path: input.localPath ?? null,
      depicts: input.depicts ?? [],
      used_in: input.usedIn ?? [],
      derived_from: input.derivedFrom ?? [],
      generated_by: {
        provider: input.generation.provider,
        endpoint: input.generation.endpoint,
      },
    },
    `# ${input.title}\n\n## Prompt\n\n${input.prompt}\n\n## Media\n\n${input.generation.url ? input.generation.url : "Pending or failed generation; inspect operation file."}\n`,
  );
  await writeWorkspaceFile(projectId, `assets/${input.assetId}.asset.md`, content);
}

function extensionForContentType(contentType: string | null, fallbackUrl: string) {
  const lower = (contentType ?? "").toLowerCase();
  if (lower.includes("image/png")) return ".png";
  if (lower.includes("image/webp")) return ".webp";
  if (lower.includes("image/jpeg") || lower.includes("image/jpg")) return ".jpg";
  if (lower.includes("video/mp4")) return ".mp4";
  const urlExtension = /\.(png|webp|jpe?g|mp4|webm|mov)(?:\?|$)/i.exec(fallbackUrl)?.[0]?.replace("?", "");
  return urlExtension ?? ".bin";
}

type WebImageResult = {
  attribution?: string | null;
  height?: number | null;
  image_url: string;
  landing_url?: string | null;
  license?: string | null;
  provider: string;
  thumbnail_url?: string | null;
  title: string;
  width?: number | null;
};

type ImageSearchSource = "all" | "firecrawl" | "openverse" | "pexels" | "wikimedia";

function compactWebImageResults(results: WebImageResult[], limit: number) {
  const seen = new Set<string>();
  const compacted: WebImageResult[] = [];
  for (const result of results) {
    if (!result.image_url || seen.has(result.image_url)) continue;
    seen.add(result.image_url);
    compacted.push(result);
    if (compacted.length >= limit) break;
  }
  return compacted;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isLikelyImageUrl(value: string) {
  return (
    /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#]|$)/i.test(value) ||
    /\/(?:image|images|img|photo|photos)\//i.test(value)
  );
}

async function searchFirecrawlImages(query: string, limit: number): Promise<WebImageResult[]> {
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not configured.");
  const response = await fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: `${query} larger:1920x1080`,
      limit: Math.min(Math.max(limit, 1), 20),
      sources: ["images"],
      country: "US",
      timeout: 30_000,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Firecrawl image search failed (${response.status}).`);
  }
  const payload = (await response.json()) as { data?: { images?: unknown[] }; images?: unknown[] };
  const images = Array.isArray(payload.data?.images)
    ? payload.data.images
    : Array.isArray(payload.images)
      ? payload.images
      : [];
  return images.flatMap((entry): WebImageResult[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const imageUrl =
      optionalString(item.imageUrl) ??
      optionalString(item.image) ??
      optionalString(item.src) ??
      optionalString(item.contentUrl);
    if (!imageUrl || imageUrl.includes(".html") || !isLikelyImageUrl(imageUrl)) return [];
    return [{
      height: optionalNumber(item.imageHeight),
      image_url: imageUrl,
      landing_url: optionalString(item.url),
      provider: "Firecrawl Images",
      thumbnail_url: optionalString(item.thumbnailUrl) ?? optionalString(item.thumbnail),
      title: optionalString(item.title) ?? optionalString(item.alt) ?? query,
      width: optionalNumber(item.imageWidth),
    }];
  });
}

function getPexelsPhotoImageUrl(photo: Record<string, unknown>) {
  const src = photo.src && typeof photo.src === "object" && !Array.isArray(photo.src)
    ? (photo.src as Record<string, unknown>)
    : {};
  return (
    optionalString(src.large2x) ??
    optionalString(src.large) ??
    optionalString(src.landscape) ??
    optionalString(src.original) ??
    optionalString(src.medium)
  );
}

async function searchPexelsImages(query: string, limit: number): Promise<WebImageResult[]> {
  const apiKey = process.env.PEXELS_API_KEY?.trim();
  if (!apiKey) throw new Error("PEXELS_API_KEY is not configured.");
  const url = new URL("https://api.pexels.com/v1/search");
  url.searchParams.set("query", query);
  url.searchParams.set("page", "1");
  url.searchParams.set("per_page", String(Math.min(Math.max(limit, 1), 20)));
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: apiKey,
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Pexels image search failed (${response.status}).`);
  }
  const payload = (await response.json()) as { photos?: unknown[] };
  return (payload.photos ?? []).flatMap((entry): WebImageResult[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const imageUrl = getPexelsPhotoImageUrl(item);
    if (!imageUrl) return [];
    const photographer = optionalString(item.photographer);
    return [{
      attribution: photographer,
      height: optionalNumber(item.height),
      image_url: imageUrl,
      landing_url: optionalString(item.url),
      license: "Pexels License",
      provider: "Pexels",
      thumbnail_url: optionalString(
        item.src && typeof item.src === "object" && !Array.isArray(item.src)
          ? (item.src as Record<string, unknown>).medium
          : null,
      ),
      title: optionalString(item.alt) ?? photographer ?? query,
      width: optionalNumber(item.width),
    }];
  });
}

async function searchOpenverseImages(query: string, limit: number): Promise<WebImageResult[]> {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", query);
  url.searchParams.set("page_size", String(Math.min(Math.max(limit, 1), 20)));
  url.searchParams.set("mature", "false");
  const response = await fetch(url, {
    headers: { "user-agent": "video-fs-agent/1.0 image-search" },
  });
  if (!response.ok) throw new Error(`Openverse image search failed (${response.status}).`);
  const payload = (await response.json()) as { results?: unknown[] };
  return (payload.results ?? []).flatMap((entry): WebImageResult[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const imageUrl = typeof item.url === "string" ? item.url : "";
    if (!imageUrl) return [];
    const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : query;
    const creator = typeof item.creator === "string" ? item.creator : null;
    const license = [item.license, item.license_version].filter((value) => typeof value === "string").join(" ");
    return [{
      attribution: creator,
      image_url: imageUrl,
      landing_url: typeof item.foreign_landing_url === "string" ? item.foreign_landing_url : null,
      license: license || null,
      provider: typeof item.provider === "string" ? `Openverse/${item.provider}` : "Openverse",
      thumbnail_url: typeof item.thumbnail === "string" ? item.thumbnail : null,
      title,
    }];
  });
}

async function searchWikimediaImages(query: string, limit: number): Promise<WebImageResult[]> {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrsearch", query);
  url.searchParams.set("gsrlimit", String(Math.min(Math.max(limit, 1), 20)));
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|extmetadata");
  url.searchParams.set("iiurlwidth", "800");
  const response = await fetch(url, {
    headers: { "user-agent": "video-fs-agent/1.0 image-search" },
  });
  if (!response.ok) throw new Error(`Wikimedia image search failed (${response.status}).`);
  const payload = (await response.json()) as { query?: { pages?: Record<string, unknown> } };
  const pages = Object.values(payload.query?.pages ?? {});
  return pages.flatMap((page): WebImageResult[] => {
    if (!page || typeof page !== "object" || Array.isArray(page)) return [];
    const record = page as Record<string, unknown>;
    const imageInfo = Array.isArray(record.imageinfo) ? record.imageinfo[0] : null;
    if (!imageInfo || typeof imageInfo !== "object" || Array.isArray(imageInfo)) return [];
    const info = imageInfo as Record<string, unknown>;
    const imageUrl = typeof info.url === "string" ? info.url : "";
    if (!imageUrl) return [];
    const extmetadata =
      info.extmetadata && typeof info.extmetadata === "object" && !Array.isArray(info.extmetadata)
        ? (info.extmetadata as Record<string, { value?: unknown }>)
        : {};
    const rawTitle = typeof record.title === "string" ? record.title.replace(/^File:/, "") : query;
    return [{
      attribution: typeof extmetadata.Artist?.value === "string" ? extmetadata.Artist.value.replace(/<[^>]+>/g, "") : null,
      image_url: imageUrl,
      landing_url: typeof info.descriptionurl === "string" ? info.descriptionurl : null,
      license: typeof extmetadata.LicenseShortName?.value === "string" ? extmetadata.LicenseShortName.value : null,
      provider: "Wikimedia Commons",
      thumbnail_url: typeof info.thumburl === "string" ? info.thumburl : null,
      title: rawTitle,
    }];
  });
}

async function readExistingFrontmatter(projectId: string, path: string) {
  const existing = await readWorkspaceFile(projectId, path).catch(() => null);
  return existing ? parseJsonFrontmatter(existing).meta : {};
}

async function saveRemoteMedia(projectId: string, url: string | null | undefined, relativeBasePath: string) {
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type");
    const extension = extensionForContentType(contentType, url);
    const path = `${safeRelativePath(relativeBasePath)}${extension}`;
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeWorkspaceBinaryFile(projectId, path, buffer);
    return path;
  } catch {
    return null;
  }
}

async function saveVersionedRemoteMedia(
  projectId: string,
  url: string | null | undefined,
  kind: "clips" | "keyframes",
  id: string,
  version: number,
) {
  return saveRemoteMedia(projectId, url, `media/${kind}/${id}.v${version}`);
}

/** Fetchable URL for workspace media: a time-limited Supabase signed URL
 * (same pattern as the rest of the app). Falls back to fal storage only in
 * local dev, where there is no bucket to sign. */
async function fetchableUrlForWorkspaceMedia(
  projectId: string,
  media: string,
  refId: string,
): Promise<{ ok: true; url: string } | { error: string; ok: false }> {
  if (/^https?:\/\//i.test(media)) return { ok: true, url: media };
  const signed = await signedWorkspaceMediaUrl(projectId, safeRelativePath(media));
  if (signed) return { ok: true, url: signed };
  // Our storage or nothing: generation inputs are never re-hosted on
  // third-party (fal) storage.
  return {
    error: `Workspace media "${media}" (${refId}) could not be signed — media must be hosted in Supabase storage.`,
    ok: false,
  };
}

// loadGraph re-downloads EVERY project file with content — it is called by
// nearly every tool, often twice per tool, and dominates per-call latency on
// mature projects. A short TTL cache absorbs the duplicate loads inside one
// tool step while staying far below the gap between dependent tool calls
// (generation writes are seconds apart, never sub-1.5s).
const GRAPH_CACHE_TTL_MS = 1_500;
const graphCache = new Map<string, { at: number; graph: Promise<ReturnType<typeof buildSourceGraph>> }>();

async function loadGraph(projectId: string) {
  const cached = graphCache.get(projectId);
  if (cached && Date.now() - cached.at < GRAPH_CACHE_TTL_MS) return cached.graph;
  const graph = (async () => {
    const files = await listProjectFiles(projectId, true);
    return buildSourceGraph(
      files
        .filter((file) => typeof file.content === "string")
        .map((file) => ({ path: file.path, content: file.content! })),
    );
  })();
  graphCache.set(projectId, { at: Date.now(), graph });
  if (graphCache.size > 40) {
    const oldest = graphCache.keys().next().value;
    if (oldest) graphCache.delete(oldest);
  }
  return graph;
}

/** Resolve a keyframe to a fal-fetchable URL: its remote url when present,
 * otherwise its local media signed (or uploaded to fal storage). Local paths
 * must NEVER reach fal — captured/extracted frames only have local media. */
async function hostedKeyframeUrl(
  projectId: string,
  graph: Awaited<ReturnType<typeof loadGraph>>,
  rawId: string,
): Promise<string | null> {
  const media = await keyframeMediaById(projectId, graph, rawId);
  if (!media) return null;
  const hosted = await fetchableUrlForWorkspaceMedia(projectId, media, rawId.replace(/^@/, ""));
  return hosted.ok ? hosted.url : null;
}

/** Resolve a keyframe id to its image media (url or workspace path), falling
 * back to reading the record file directly when the graph misses it. */
async function keyframeMediaById(
  projectId: string,
  graph: Awaited<ReturnType<typeof loadGraph>>,
  rawId: string,
): Promise<string | null> {
  const id = rawId.replace(/^@/, "");
  const keyframe = graph.keyframes.get(id);
  const local = keyframe?.versions?.length
    ? keyframe.versions[keyframe.versions.length - 1]?.localPath ?? null
    : null;
  const fromGraph = keyframe?.url ?? local;
  if (fromGraph) return fromGraph;
  try {
    const raw = await readWorkspaceFile(projectId, `keyframes/${id}.md`);
    const parsed = parseJsonFrontmatter(raw);
    if (typeof parsed.meta.local_path === "string" && parsed.meta.local_path) {
      return parsed.meta.local_path;
    }
    if (typeof parsed.meta.url === "string" && parsed.meta.url) return parsed.meta.url;
    if (typeof parsed.meta.source_url === "string" && parsed.meta.source_url) {
      return parsed.meta.source_url;
    }
  } catch {
    /* no direct record either */
  }
  return null;
}

type EditorDocShape = {
  mediaMap?: Record<
    string,
    { durationSeconds?: number | null; kind?: string; mediaId: string; name: string }
  >;
  pendingPlacements?: Array<Record<string, unknown>>;
  project?: {
    currentSceneId?: string;
    metadata?: { duration?: number; updatedAt?: string };
    scenes?: Array<{
      id: string;
      isMain?: boolean;
      tracks?: {
        audio?: Array<{
          elements?: Array<Record<string, unknown>>;
          id?: string;
          muted?: boolean;
          name?: string;
          type?: string;
        }>;
        main?: { elements?: Array<Record<string, unknown>> };
        overlay?: Array<{ elements?: Array<Record<string, unknown>> }>;
      };
    }>;
  };
  revision?: number;
};

const EDITOR_TICKS = 120_000;

async function readEditorDoc(projectId: string): Promise<EditorDocShape | null> {
  try {
    return JSON.parse(
      await readWorkspaceFile(projectId, "editor/opencut-project.json"),
    ) as EditorDocShape;
  } catch {
    return null;
  }
}

function activeEditorScene(doc: EditorDocShape) {
  const scenes = doc.project?.scenes ?? [];
  return (
    scenes.find((entry) => entry.id === doc.project?.currentSceneId) ??
    scenes.find((entry) => entry.isMain) ??
    scenes[0] ??
    null
  );
}

function allEditorElements(scene: NonNullable<ReturnType<typeof activeEditorScene>>) {
  const found: Array<{ element: Record<string, unknown>; track: string }> = [];
  for (const element of scene.tracks?.main?.elements ?? []) {
    found.push({ element, track: "main" });
  }
  (scene.tracks?.overlay ?? []).forEach((lane, index) => {
    for (const element of lane.elements ?? []) {
      found.push({ element, track: `overlay[${index}]` });
    }
  });
  (scene.tracks?.audio ?? []).forEach((lane, index) => {
    for (const element of lane.elements ?? []) {
      found.push({ element, track: `audio[${index}]` });
    }
  });
  return found;
}

async function saveEditorDoc(projectId: string, doc: EditorDocShape) {
  if (doc.project?.metadata) doc.project.metadata.updatedAt = new Date().toISOString();
  await writeWorkspaceFile(
    projectId,
    "editor/opencut-project.json",
    JSON.stringify({
      ...doc,
      revision: (doc.revision ?? 0) + 1,
      source: "agent",
      updatedAt: new Date().toISOString(),
    }),
  );
}

/** Linear scalar keyframes for a fade channel (times relative to element start). */
function fadeChannel(keys: Array<{ atTicks: number; value: number }>) {
  return {
    keys: keys.map((key) => ({
      id: crypto.randomUUID(),
      segmentToNext: "linear",
      tangentMode: "auto",
      time: key.atTicks,
      value: key.value,
    })),
  };
}

/** Validate + store an internet image as a canvas tile; the returned id is
 * usable anywhere tile ids condition generations. */
async function importWebImageToCanvas(
  projectId: string,
  imageUrl: string,
  title: string,
): Promise<{ id: string; ok: true } | { error: string; ok: false }> {
  try {
    const download = await fetch(imageUrl, {
      headers: { accept: "image/*" },
      redirect: "follow",
    });
    if (!download.ok) return { error: `Fetch failed (${download.status}) for ${imageUrl}.`, ok: false };
    const contentType = download.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      return {
        error: `"${imageUrl}" is not an image (content-type: ${contentType || "unknown"}) — likely a landing/article PAGE url; pass the direct image file url.`,
        ok: false,
      };
    }
    const bytes = Buffer.from(await download.arrayBuffer());
    if (bytes.byteLength > 25_000_000) return { error: "Image exceeds 25MB.", ok: false };
    const extension = contentType.includes("png")
      ? "png"
      : contentType.includes("webp")
        ? "webp"
        : contentType.includes("gif")
          ? "gif"
          : "jpg";
    const imageId = `web_${title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40)}_${Date.now().toString(36)}`;
    const localPath = `media/uploads/${imageId}.${extension}`;
    await writeWorkspaceBinaryFile(projectId, localPath, bytes);
    await writeWorkspaceFile(
      projectId,
      `uploads/${imageId}.md`,
      withJsonFrontmatter(
        {
          canvas_composed: true,
          id: imageId,
          kind: "image",
          local_path: localPath,
          source_url: imageUrl,
          status: "active",
          type: "upload",
        },
        `# ${title}\n\nSaved from the internet.\n\nSource: ${imageUrl}\n`,
      ),
    );
    return { id: imageId, ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Image save failed.", ok: false };
  }
}

/** Resolve any image-bearing tile id (keyframe, upload) to media. */
async function tileImageMediaById(
  projectId: string,
  graph: Awaited<ReturnType<typeof loadGraph>>,
  rawId: string,
): Promise<string | null> {
  const id = rawId.replace(/^@/, "");
  const fromKeyframe = await keyframeMediaById(projectId, graph, id);
  if (fromKeyframe) return fromKeyframe;
  try {
    const raw = await readWorkspaceFile(projectId, `uploads/${id}.md`);
    const meta = parseJsonFrontmatter(raw).meta;
    if (typeof meta.local_path === "string" && meta.local_path) return meta.local_path;
    if (typeof meta.url === "string" && meta.url) return meta.url;
  } catch {
    /* not an upload */
  }
  return null;
}

/** Structural sanity for an editor project about to be saved: catches the
 * silent-corruption class (missing ids, negative ticks, elements without
 * media) so bad writes bounce back to the model instead of bricking the
 * editor. */
function validateEditorProject(project: unknown): string[] {
  const errors: string[] = [];
  const proj = project as EditorDocShape["project"];
  if (!proj || typeof proj !== "object") return ["project is not an object"];
  const scenes = proj.scenes;
  if (!Array.isArray(scenes) || !scenes.length) return ["project.scenes must be a non-empty array"];
  const seenIds = new Set<string>();
  const checkElements = (
    elements: Array<Record<string, unknown>> | undefined,
    where: string,
    kinds: string[],
  ) => {
    for (const [index, element] of (elements ?? []).entries()) {
      const at = `${where}[${index}]`;
      if (typeof element.id !== "string" || !element.id) errors.push(`${at}: missing id`);
      else if (seenIds.has(element.id)) errors.push(`${at}: duplicate element id ${element.id}`);
      else seenIds.add(element.id);
      if (typeof element.type !== "string" || !kinds.includes(element.type)) {
        errors.push(`${at}: type must be one of ${kinds.join("/")}`);
      }
      for (const key of ["startTime", "duration", "trimStart", "trimEnd"]) {
        const value = element[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          errors.push(`${at}: ${key} must be a non-negative number of ticks`);
        }
      }
      if (typeof element.duration === "number" && element.duration <= 0) {
        errors.push(`${at}: duration must be > 0`);
      }
      if (
        (element.type === "video" || element.type === "image" || element.type === "audio") &&
        element.sourceType !== "library" &&
        (typeof element.mediaId !== "string" || !element.mediaId)
      ) {
        errors.push(`${at}: mediaId required for ${element.type} elements`);
      }
    }
  };
  for (const [sceneIndex, scene] of scenes.entries()) {
    const where = `scenes[${sceneIndex}]`;
    if (typeof scene.id !== "string") errors.push(`${where}: missing scene id`);
    if (!scene.tracks || typeof scene.tracks !== "object") {
      errors.push(`${where}: missing tracks`);
      continue;
    }
    if (!scene.tracks.main || !Array.isArray(scene.tracks.main.elements)) {
      errors.push(`${where}: tracks.main.elements must be an array`);
    } else {
      checkElements(scene.tracks.main.elements as never, `${where}.main`, ["video", "image"]);
    }
    (scene.tracks.overlay ?? []).forEach((lane, laneIndex) =>
      checkElements(lane.elements as never, `${where}.overlay[${laneIndex}]`, [
        "video",
        "image",
        "text",
        "sticker",
        "graphic",
        "effect",
      ]),
    );
    (scene.tracks.audio ?? []).forEach((lane, laneIndex) =>
      checkElements(lane.elements as never, `${where}.audio[${laneIndex}]`, ["audio"]),
    );
  }
  return errors;
}

/** Minimal RFC 6902 apply (add/replace/remove) against a plain JSON tree. */
function applyJsonPatch(
  root: Record<string, unknown>,
  ops: Array<{ op: string; path: string; value?: unknown }>,
): string | null {
  for (const [index, operation] of ops.entries()) {
    const parts = operation.path.split("/").slice(1).map((part) =>
      part.replace(/~1/g, "/").replace(/~0/g, "~"),
    );
    if (!parts.length) return `op ${index}: empty path`;
    let parent: unknown = root;
    for (const key of parts.slice(0, -1)) {
      if (Array.isArray(parent)) parent = parent[Number(key)];
      else if (parent && typeof parent === "object") {
        parent = (parent as Record<string, unknown>)[key];
      } else return `op ${index}: path segment "${key}" not found`;
      if (parent === undefined) return `op ${index}: path segment "${key}" not found`;
    }
    const last = parts[parts.length - 1]!;
    if (Array.isArray(parent)) {
      const position = last === "-" ? parent.length : Number(last);
      if (Number.isNaN(position) || position < 0 || position > parent.length) {
        return `op ${index}: bad array index "${last}"`;
      }
      if (operation.op === "add") parent.splice(position, 0, operation.value);
      else if (operation.op === "replace") {
        if (position >= parent.length) return `op ${index}: replace index out of range`;
        parent[position] = operation.value;
      } else if (operation.op === "remove") {
        if (position >= parent.length) return `op ${index}: remove index out of range`;
        parent.splice(position, 1);
      } else return `op ${index}: unsupported op "${operation.op}"`;
    } else if (parent && typeof parent === "object") {
      const record = parent as Record<string, unknown>;
      if (operation.op === "add" || operation.op === "replace") record[last] = operation.value;
      else if (operation.op === "remove") delete record[last];
      else return `op ${index}: unsupported op "${operation.op}"`;
    } else {
      return `op ${index}: parent is not an object or array`;
    }
  }
  return null;
}

const PLAN_PATH = "plan/plan.md";

type PlanStep = { id: string; note?: string; status: string; title: string };

async function readPlanSteps(projectId: string): Promise<PlanStep[]> {
  try {
    const raw = await readWorkspaceFile(projectId, PLAN_PATH);
    const meta = parseJsonFrontmatter(raw).meta;
    if (!Array.isArray(meta.steps)) return [];
    return (meta.steps as PlanStep[]).filter(
      (step) => step && typeof step.title === "string" && typeof step.status === "string",
    );
  } catch {
    return [];
  }
}

/** One-line cursor state, re-injected everywhere the model looks. */
function planCursorLine(steps: PlanStep[]): string | null {
  if (!steps.length) return null;
  const active = steps.find((step) => step.status === "active");
  const nextPending = steps.find((step) => step.status === "pending");
  const done = steps.filter((step) => step.status === "done").length;
  const parts = [
    active ? `NOW: "${active.title}"` : "no active step — set one with updatePlan",
    nextPending ? `next: "${nextPending.title}"` : null,
    `${done}/${steps.length} done`,
  ].filter(Boolean);
  return parts.join(" · ");
}

const REVIEW_MARKER_PATH = "findings/_review.json";

/** Hash of the current generated keyframe set (id:url) — review covers a hash. */
function keyframeSetHash(graph: SourceGraph): string {
  const entries = [...graph.keyframes.values()]
    .filter((kf) => kf.url && (kf.status === "generated" || kf.status === "captured" || kf.status === "approved"))
    .map((kf) => `${kf.id}:${kf.url}`)
    .sort();
  return createHash("sha256").update(entries.join("|")).digest("hex").slice(0, 16);
}

/** Clip start/end pairs whose endpoint keyframes are both generated. */
function reviewPairs(graph: SourceGraph): ReviewPair[] {
  const pairs: ReviewPair[] = [];
  for (const clip of orderedClips(graph)) {
    const from = clip.fromKeyframe ? graph.keyframes.get(clip.fromKeyframe) : null;
    const to = clip.toKeyframe ? graph.keyframes.get(clip.toKeyframe) : null;
    if (!from?.url) continue;
    pairs.push({
      clipId: clip.id,
      transition: clip.transitionFromPrevious,
      fromId: from.id,
      fromUrl: from.url,
      fromSceneState: from.sceneState,
      toId: to?.url ? to.id : null,
      toUrl: to?.url ?? null,
      toSceneState: to?.url ? to.sceneState : null,
      intent:
        [clip.shotSize ? `${clip.shotSize} shot` : null, clip.cutMotivation]
          .filter(Boolean)
          .join(" — ") || "shot",
    });
  }
  return pairs;
}

async function readReviewMarker(projectId: string): Promise<{ hash: string } | null> {
  const raw = await readWorkspaceFile(projectId, REVIEW_MARKER_PATH).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { hash?: unknown };
    return typeof parsed.hash === "string" ? { hash: parsed.hash } : null;
  } catch {
    return null;
  }
}

function summarizeCheck(check: ProjectCheck, cap = 12) {
  const ranked = [...check.issues].sort((a, b) => {
    const weight = { error: 0, warning: 1, info: 2 } as const;
    return weight[a.level] - weight[b.level];
  });
  return {
    ok: check.ok,
    errors: check.issues.filter((issue) => issue.level === "error").length,
    warnings: check.issues.filter((issue) => issue.level === "warning").length,
    issues: ranked.slice(0, cap).map((issue) => ({
      level: issue.level,
      rule: issue.rule,
      path: issue.path,
      message: issue.message,
    })),
  };
}

/** Append the post-mutation lint summary so the agent gets compiler-style feedback. */
async function withCheck<T extends Record<string, unknown>>(
  projectId: string,
  result: T,
): Promise<T & { check: ReturnType<typeof summarizeCheck> }> {
  return { ...result, check: summarizeCheck(await checkProject(projectId)) };
}

const CLIP_PROMPT_COMPILER = "composeClipPrompt:v3";

function sha16(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" && item.trim()) out[key] = item.trim();
  }
  return out;
}

function assetIdForClip(clipId: string) {
  return `asset_${clipId}`;
}

function promptIdForClip(clipId: string) {
  return `prompt_${assetIdForClip(clipId)}`;
}

function promptPathForClip(clipId: string) {
  return `prompts/${assetIdForClip(clipId)}.prompt.md`;
}

function clipPlanDependencyId(clipId: string) {
  return `${clipId}${CLIP_PLAN_HASH_SUFFIX}`;
}

function clipPromptPlan(input: {
  action_beats: string[];
  action_intent: string;
  camera_move: string;
  camera_note?: string | null;
  dialogue: unknown;
  duration_seconds: number;
  end_state?: string | null;
  environment?: string | null;
  frame_delta: unknown;
  from_keyframe: string;
  lighting?: string | null;
  motion_rate: string;
  start_state: string;
  to_keyframe?: string | null;
}) {
  return {
    action_beats: input.action_beats.map((beat) => beat.trim()).filter(Boolean),
    action_intent: input.action_intent.trim(),
    camera_move: input.camera_move,
    camera_note: input.camera_note ?? null,
    dialogue: input.dialogue,
    duration_seconds: Math.min(15, Math.max(4, Math.ceil(input.duration_seconds))),
    end_state: input.end_state?.trim() || null,
    environment: input.environment?.trim() || null,
    frame_delta: input.frame_delta,
    from_keyframe: input.from_keyframe,
    lighting: input.lighting?.trim() || null,
    motion_rate: input.motion_rate,
    start_state: input.start_state.trim(),
    to_keyframe: input.to_keyframe ?? null,
  };
}

function plannedClipBody(input: {
  action_beats: string[];
  action_intent: string;
  end_state?: string | null;
  start_state: string;
  title: string;
}, prompt: string) {
  return `# ${input.title}\n\n## Start state (as observed)\n\n${input.start_state}\n\n## Action intent\n\n${input.action_intent}\n\n## Action plan\n\n${input.action_beats.map((beat, i) => `${i + 1}. ${beat}`).join("\n")}\n\n${input.end_state?.trim() ? `## End state (as observed)\n\n${input.end_state}\n\n` : ""}## Prompt\n\n${prompt}\n`;
}

async function assertPromptWritable(projectId: string, clipId: string, force: boolean) {
  const raw = await readWorkspaceFile(projectId, promptPathForClip(clipId)).catch(() => null);
  if (!raw) return;
  const parsed = parseJsonFrontmatter(raw);
  if (parsed.meta.type !== "prompt") return;
  const compilerHash = typeof parsed.meta.compiler_hash === "string" ? parsed.meta.compiler_hash : null;
  if (!compilerHash || compilerHash === sha16(parsed.body.trim())) return;
  if (force) return;
  throw new Error(
    `Prompt ${promptPathForClip(clipId)} appears user-edited. Re-run prepareClipPrompts with force=true only if you intend to overwrite it.`,
  );
}

function assertPromptDependenciesCurrent(
  graph: SourceGraph,
  input: { id: string },
  builtAgainst: Record<string, string>,
  currentPlanHash: string,
) {
  const planDepId = clipPlanDependencyId(input.id);
  if (builtAgainst[planDepId] !== currentPlanHash) {
    throw new Error(
      `Planned prompt for clip "${input.id}" is stale or was built from different clip fields. Re-run prepareClipPrompts before generateClip.`,
    );
  }
  for (const [depId, recordedHash] of Object.entries(builtAgainst)) {
    const currentHash =
      depId === planDepId ? currentPlanHash : lookupIdentityHash(graph, depId);
    if (currentHash === null) {
      throw new Error(
        `Planned prompt for clip "${input.id}" depends on missing "${depId}". Re-run prepareClipPrompts.`,
      );
    }
    if (currentHash !== recordedHash) {
      throw new Error(
        `Planned prompt for clip "${input.id}" is stale: dependency "${depId}" changed since planning. Re-run prepareClipPrompts.`,
      );
    }
  }
}

async function readPlannedPrompt(projectId: string, graph: SourceGraph, input: {
  action_beats: string[];
  action_intent: string;
  camera_move: string;
  camera_note?: string | null;
  dialogue: unknown;
  duration_seconds: number;
  end_state?: string | null;
  environment?: string | null;
  frame_delta: unknown;
  from_keyframe: string;
  id: string;
  lighting?: string | null;
  motion_rate: string;
  start_state: string;
  to_keyframe?: string | null;
}) {
  const path = promptPathForClip(input.id);
  const raw = await readWorkspaceFile(projectId, path).catch(() => null);
  if (!raw) {
    throw new Error(
      `Missing planned prompt ${path}. Run prepareClipPrompts after keyframe review and before generateClip.`,
    );
  }
  const parsed = parseJsonFrontmatter(raw);
  if (parsed.meta.type !== "prompt" || parsed.meta.clip_id !== input.id) {
    throw new Error(`${path} is not a planned prompt for clip "${input.id}".`);
  }
  const prompt = parsed.body.trim();
  if (!prompt) throw new Error(`${path} has an empty prompt body.`);
  const plan = clipPromptPlan(input);
  const planHash = clipPlanHashValue(plan);
  assertPromptDependenciesCurrent(graph, input, asStringMap(parsed.meta.built_against), planHash);
  return prompt;
}

function modelPromptForClip(
  graph: SourceGraph,
  from: KeyframeNode,
  to: KeyframeNode | null,
  prompt: string,
) {
  const referenceIds = [
    ...new Set([...from.depicts, ...(to?.depicts ?? [])]),
  ];
  const characterReferences: Array<{ id: string; body: string }> = [];
  for (const id of referenceIds) {
    const reference = graph.references.get(id);
    if (reference?.category !== "characters") continue;
    characterReferences.push({ id: reference.id, body: reference.body });
  }
  const legend = composeModelReferenceLegend(characterReferences);
  return legend ? `${legend}\n\n${prompt}` : prompt;
}

type BillingContext = { userId: string } | null;

const DEFAULT_MAX_KEYFRAME_MEDIA_VERSIONS = 5;
const DEFAULT_MAX_CHARACTER_INJECTION_ATTEMPTS = 2;

function positiveIntegerEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function maxKeyframeMediaVersions() {
  return positiveIntegerEnv(
    "KEYFRAME_MAX_MEDIA_VERSIONS",
    DEFAULT_MAX_KEYFRAME_MEDIA_VERSIONS,
  );
}

function maxCharacterInjectionAttempts() {
  return positiveIntegerEnv(
    "KEYFRAME_MAX_CHARACTER_INJECTION_ATTEMPTS",
    DEFAULT_MAX_CHARACTER_INJECTION_ATTEMPTS,
  );
}

function assertKeyframeVersionBudget(keyframeId: string, nextVersion: number) {
  const maxVersions = maxKeyframeMediaVersions();
  if (nextVersion > maxVersions) {
    throw new Error(
      `Keyframe "${keyframeId}" already has ${nextVersion - 1} media versions; stopping before v${nextVersion}. ` +
        `Do not retry this keyframe id. Inspect the current frame and simplify the staging, convert the beat to a cut/new keyframe setup, or raise KEYFRAME_MAX_MEDIA_VERSIONS only if the user explicitly wants more spend.`,
    );
  }
}

function injectionAttemptCount(
  composition: Record<string, unknown>,
  referenceId: string,
) {
  const attempts = Array.isArray(composition.injection_attempts)
    ? composition.injection_attempts
    : [];
  for (const item of attempts) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.reference_id !== referenceId) continue;
    return typeof record.attempts === "number" && Number.isInteger(record.attempts)
      ? record.attempts
      : 0;
  }
  return 0;
}

function injectionAttemptsWithIncrement(
  composition: Record<string, unknown>,
  referenceId: string,
) {
  const attempts = Array.isArray(composition.injection_attempts)
    ? composition.injection_attempts.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];
  const previous = injectionAttemptCount(composition, referenceId);
  return [
    ...attempts.filter((item) => item.reference_id !== referenceId),
    { reference_id: referenceId, attempts: previous + 1 },
  ];
}

function identityVerificationStatus(
  composition: Record<string, unknown>,
  referenceId: string,
) {
  const verifications = Array.isArray(composition.identity_verifications)
    ? composition.identity_verifications
    : [];
  for (const item of verifications) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.reference_id === referenceId && typeof record.status === "string") {
      return record.status;
    }
  }
  return null;
}

/**
 * Pre-flight a billable generation: returns an error string to short-circuit the
 * tool (insufficient credits) or null to proceed. No-op when billing is off.
 */
async function preflightCharge(billing: BillingContext, op: BillableOp): Promise<string | null> {
  if (!billing || !billingEnabled()) return null;
  const required = quoteOp(op);
  const balance = await getCreditBalance(billing.userId);
  if (balance.total < required) {
    return `Insufficient credits: ${op.tool} needs ${required} credits but the account has ${balance.total}. Tell the user to buy credits and stop — do not retry generation.`;
  }
  return null;
}

/** Charge for a generation that succeeded (idempotent, fire-and-forget). */
async function settleCharge(
  billing: BillingContext,
  op: BillableOp,
  projectId: string,
  artifact?: { path?: string | null; title?: string | null; url?: string | null },
): Promise<void> {
  if (!billing || !billingEnabled()) return;
  // A generation URL/path is unique per generation, so a stable key derived
  // from it dedups retries (same artifact → same key → no double-charge)
  // while still allowing distinct generations to each charge once.
  const key =
    artifact?.url || artifact?.path
      ? `${op.tool}:${artifact.url ?? artifact.path}`
      : crypto.randomUUID();
  await chargeForOp({
    userId: billing.userId,
    op,
    projectId,
    idempotencyKey: key,
    description: `${op.tool} (${projectId})`,
    artifact,
  }).catch(() => {});
}

function buildTools(projectId: string, billing: BillingContext) {
  // Parallel tool calling can emit duplicate generation calls in one step;
  // generating the same artifact twice concurrently burns money and floods
  // the canvas. A short claim window rejects duplicates while still
  // allowing the deliberate retry loops that come minutes later.
  const recentGenerationClaims = new Map<string, number>();
  const claimGeneration = (key: string) => {
    const now = Date.now();
    const last = recentGenerationClaims.get(key);
    if (last !== undefined && now - last < 20_000) return false;
    recentGenerationClaims.set(key, now);
    return true;
  };
  const duplicateGenerationError = {
    error:
      "Duplicate generation call for this exact target suppressed (another call for it started seconds ago, likely a parallel duplicate). Use the result of the first call instead of re-calling.",
    ok: false,
  };
  // Per-run generation budget guard removed — no cap on media generations.
  const spendGeneration = () => true;
  const generationBudgetError = {
    error:
      "GENERATION BUDGET REACHED for this run (6 media generations). Stop generating: report what you produced, show the user the attempts, and ask how to proceed. Do not work around this by renaming artifacts.",
    ok: false,
  };
  return {
    webSearch: openrouter.tools.webSearch({
      engine: "auto",
      maxResults: 5,
      searchPrompt:
        "Search for current, relevant web context. Prefer authoritative pages and include enough context for grounded decisions.",
    }),
    listSkills: tool({
      description: "List available craft skills (shot planning, story structure, coverage).",
      inputSchema: z.object({}),
      execute: async () => ({ skills: await listSkillSummaries() }),
    }),
    readSkill: tool({
      description: "Load one skill body into context as a thinking aid for this run.",
      inputSchema: z.object({ skill_id: z.string().min(1) }),
      execute: async ({ skill_id }) => ({ skill: await readSkill(skill_id) }),
    }),
    loadWorkflow: tool({
      description:
        "Load a workflow recipe (inputs, plan template, method) as an internal execution aid. For a complex request with one strong inventory match, call this BEFORE planning even when the user did not name a workflow; adapt it to the requested outcome rather than forcing an exact template.",
      inputSchema: z.object({ workflow_id: z.string().min(1) }),
      execute: async ({ workflow_id }) => ({ workflow: await readWorkflow(workflow_id) }),
    }),
    listFiles: tool({
      description: "List all source and media files in the project workspace.",
      inputSchema: z.object({ include_content: z.boolean().default(false) }),
      execute: async ({ include_content }) => ({
        files: await listProjectFiles(projectId, include_content),
      }),
    }),
    readFile: tool({
      description: "Read a workspace source file by path.",
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async ({ path }) => ({
        path: safeRelativePath(path),
        content: await readWorkspaceFile(projectId, path),
      }),
    }),
    viewWorkspaceImage: tool({
      description:
        "View an image in the project workspace (screenshot, reference photo, imported asset) — returns the actual image so you can SEE its contents. Use the file path from the workspace index / listFiles. Use this instead of readFile for images.",
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async ({ path }) => {
        const safe = safeRelativePath(path);
        try {
          const file = await readWorkspaceBinaryFile(projectId, path);
          const mediaType = file.contentType || "image/png";
          if (!mediaType.startsWith("image/")) {
            return { ok: false as const, path: safe, error: `Not an image (${mediaType}). Use readFile for text files.` };
          }
          if (file.size > 8 * 1024 * 1024) {
            return { ok: false as const, path: safe, error: "Image is too large to view (>8 MB)." };
          }
          return { ok: true as const, path: safe, mediaType, base64: file.content.toString("base64") };
        } catch (caught) {
          return { ok: false as const, path: safe, error: caught instanceof Error ? caught.message : "Failed to read image." };
        }
      },
      toModelOutput: ({ output }) => {
        if (!output.ok) {
          return { type: "text", value: output.error };
        }
        return {
          type: "content",
          value: [
            { type: "text", text: `Image: ${output.path}` },
            { type: "file-data", data: output.base64, mediaType: output.mediaType },
          ],
        };
      },
    }),
    writeFile: tool({
      description:
        "Write a complete workspace source file (JSON frontmatter per the directory _README). The result includes a post-write check; fix reported errors before moving on.",
      inputSchema: z.object({
        content: z.string().min(1),
        path: z.string().min(1),
      }),
      execute: async ({ path, content }) => {
        const safe = safeRelativePath(path);
        if (safe === "timeline.json") {
          // The timeline is derived from clip order (scene index, clip index) —
          // it can't be authored by hand. To change order, set scene/clip
          // index; to drop a clip, set in_timeline:false on its clip record.
          const timeline = await refreshTimeline(projectId);
          return withCheck(projectId, {
            path: safe,
            derived: true,
            note: "timeline.json is derived from clip order; edit scene/clip index instead.",
            items: timeline.length,
          });
        }
        const written = await writeWorkspaceFile(projectId, path, content);
        return withCheck(projectId, { ...written });
      },
    }),
    patchFile: tool({
      description: "Patch a file by exact text replacement. Result includes a post-patch check.",
      inputSchema: z.object({
        path: z.string().min(1),
        replace: z.string(),
        search: z.string().min(1),
      }),
      execute: async ({ path, search, replace }) => {
        const patched = await patchWorkspaceFile(projectId, path, search, replace);
        return withCheck(projectId, { ...patched });
      },
    }),
    traceReferences: tool({
      description: "Search every source file for an id or phrase before changing it.",
      inputSchema: z.object({ query: z.string().min(1) }),
      execute: async ({ query }) => {
        const files = await listProjectFiles(projectId, true);
        const matches = files
          .filter((file) => file.content?.toLowerCase().includes(query.toLowerCase()))
          .map((file) => ({ path: file.path, preview: file.content?.slice(0, 1000) }));
        return { query, matches };
      },
    }),
    searchImages: tool({
      description:
        "Search the web for image references and return direct image URLs, thumbnails, landing pages, license, and attribution. Uses Firecrawl image search and Pexels when configured, with Openverse/Wikimedia fallback. Use when the user asks for real-world visual references, logos, products, places, design inspiration, stock photos, or image examples from the internet. Returned image_url values can be passed into image_urls on generation tools.",
      inputSchema: z.object({
        query: z.string().min(1),
        count: z.number().int().min(1).max(12).default(8),
        source: z.enum(["all", "firecrawl", "openverse", "pexels", "wikimedia"]).default("all"),
      }),
      execute: async ({ count, query, source }) => {
        const providerMap = {
          firecrawl: searchFirecrawlImages,
          openverse: searchOpenverseImages,
          pexels: searchPexelsImages,
          wikimedia: searchWikimediaImages,
        } satisfies Record<
          Exclude<ImageSearchSource, "all">,
          (query: string, limit: number) => Promise<WebImageResult[]>
        >;
        const providerNames =
          source === "all"
            ? (Object.keys(providerMap) as Array<Exclude<ImageSearchSource, "all">>)
            : [source];
        const settled = await Promise.allSettled(
          providerNames.map(async (name) => ({
            name,
            results: await providerMap[name](query, count),
          })),
        );
        const results = compactWebImageResults(
          settled.flatMap((entry) => (entry.status === "fulfilled" ? entry.value.results : [])),
          count,
        );
        return {
          ok: results.length > 0,
          providers: providerNames,
          query,
          results,
          errors: settled.flatMap((entry) =>
            entry.status === "rejected"
              ? [entry.reason instanceof Error ? entry.reason.message : "Image search failed."]
              : [],
          ),
        };
      },
    }),
    inspectFrontmatter: tool({
      description: "Parse JSON frontmatter from a markdown file.",
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async ({ path }) => {
        const content = await readWorkspaceFile(projectId, path);
        return { path, ...parseJsonFrontmatter(content) };
      },
    }),
    checkProject: tool({
      description:
        "Run the project linter: continuity structure, identity anchoring, staleness, timeline hygiene. Run before your final answer.",
      inputSchema: z.object({}),
      execute: async () => checkProject(projectId),
    }),
    recordFinding: tool({
      description:
        "Record an issue found during keyframe self-review (a stray object, wrong placement, identity drift, screen-direction or geography break across frames). Findings implicate specific keyframes and stay open until you present them to the user and they accept or dismiss. Use after viewImage-ing frames in chain context.",
      inputSchema: z.object({
        id: z.string().min(1),
        severity: z
          .enum(["blocker", "issue", "note"])
          .default("issue")
          .describe("blocker = must fix before clips; issue = should fix; note = minor."),
        implicates: z
          .array(z.string())
          .min(1)
          .describe("Keyframe (or other node) ids this finding is about."),
        summary: z.string().min(1).describe("One-line description of what's wrong."),
        detail: z.string().default("").describe("Optional longer explanation and suggested fix."),
      }),
      execute: async ({ id, severity, implicates, summary, detail }) => {
        const result = await writeWorkspaceFile(
          projectId,
          `findings/${id}.md`,
          withJsonFrontmatter(
            { id, type: "finding", status: "open", severity, implicates, summary },
            `# ${summary}\n\n${detail || "(no further detail)"}\n`,
          ),
        );
        return withCheck(projectId, { ...result, finding_id: id });
      },
    }),
    resolveFinding: tool({
      description:
        "Set a finding's status after the user weighs in: accepted (they agree, you'll fix it — then regenerate the keyframe), dismissed (they're fine with it), or resolved (already fixed).",
      inputSchema: z.object({
        id: z.string().min(1),
        status: z.enum(["accepted", "dismissed", "resolved"]),
        note: z.string().default(""),
      }),
      execute: async ({ id, status, note }) => {
        const existing = await readWorkspaceFile(projectId, `findings/${id}.md`).catch(() => null);
        if (!existing) throw new Error(`Finding "${id}" does not exist.`);
        const parsed = parseJsonFrontmatter(existing);
        const result = await writeWorkspaceFile(
          projectId,
          `findings/${id}.md`,
          withJsonFrontmatter(
            { ...parsed.meta, status },
            `${parsed.body}${note ? `\n\n## Resolution\n\n${note}\n` : ""}`,
          ),
        );
        return withCheck(projectId, { ...result, finding_id: id, status });
      },
    }),
    reviewKeyframes: tool({
      description:
        "Run the INDEPENDENT keyframe review: a separate critic model (fresh context, not the generator) looks at every clip's start/end keyframe pair plus the portfolios and reports continuity/quality problems as findings. Required after the keyframe pass and before the first clip — clips are gated until this runs for the current keyframes. After it returns, present the findings to the user and resolveFinding once they weigh in.",
      inputSchema: z.object({}),
      execute: async () => {
        const graph = await loadGraph(projectId);
        const pairs = reviewPairs(graph);
        if (!pairs.length) {
          throw new Error("No generated keyframes to review yet.");
        }
        const portfolios = [...graph.portfolios.values()]
          .filter((p) => p.urls[0] && p.referenceId)
          .map((p) => ({ referenceId: p.referenceId!, url: p.urls[0] }));
        const chain = [...graph.keyframes.values()]
          .filter((kf) => kf.url)
          .map((kf) => ({ id: kf.id, url: kf.url! }));

        let findings;
        try {
          findings = await reviewKeyframes({
            model: openrouter.chat(MODEL_ID),
            pairs,
            chain,
            portfolios,
          });
        } catch (error) {
          // Don't deadlock clip generation on a reviewer infra failure: mark
          // the set reviewed but record a note so the user knows to eyeball it.
          findings = [
            {
              severity: "note" as const,
              implicates: pairs.map((p) => p.fromId),
              summary: "Automated review could not run; manual review recommended.",
              detail: error instanceof Error ? error.message : "reviewer failed",
            },
          ];
        }

        const writtenIds: string[] = [];
        for (let i = 0; i < findings.length; i += 1) {
          const finding = findings[i];
          const fid = `find_review_${Date.now().toString(36)}_${i}`;
          await writeWorkspaceFile(
            projectId,
            `findings/${fid}.md`,
            withJsonFrontmatter(
              {
                id: fid,
                type: "finding",
                status: "open",
                severity: finding.severity,
                implicates: finding.implicates,
                summary: finding.summary,
                origin: "independent_review",
              },
              `# ${finding.summary}\n\n${finding.detail || "(no further detail)"}\n`,
            ),
          );
          writtenIds.push(fid);
        }
        await writeWorkspaceFile(
          projectId,
          REVIEW_MARKER_PATH,
          JSON.stringify(
            { hash: keyframeSetHash(graph), reviewed_at: new Date().toISOString(), findings: writtenIds },
            null,
            2,
          ),
        );
        return withCheck(projectId, {
          reviewed_pairs: pairs.length,
          findings: findings.map((f) => ({ severity: f.severity, implicates: f.implicates, summary: f.summary })),
        });
      },
    }),
    verifyKeyframeIdentity: tool({
      description:
        "Verify that a generated keyframe contains exactly one visible instance of a character matching that character's portfolio. Use after each sequential character-injection edit before accepting a multi-character final keyframe.",
      inputSchema: z.object({
        keyframe_id: z.string().min(1),
        reference_id: z.string().min(1).describe("Character reference id to verify, e.g. char_ava."),
        portfolio_id: z
          .string()
          .nullable()
          .default(null)
          .describe("Optional portfolio id; defaults to the portfolio for reference_id."),
      }),
      execute: async ({ keyframe_id, reference_id, portfolio_id }) => {
        const graph = await loadGraph(projectId);
        const keyframe = graph.keyframes.get(keyframe_id);
        if (!keyframe) throw new Error(`Keyframe "${keyframe_id}" does not exist.`);
        if (!keyframe.url) throw new Error(`Keyframe "${keyframe_id}" has no image to verify.`);
        const reference = graph.references.get(reference_id);
        if (!reference) throw new Error(`Reference "${reference_id}" does not exist.`);
        if (reference.category !== "characters") {
          throw new Error(`Reference "${reference_id}" is not a character reference.`);
        }
        const portfolio =
          (portfolio_id ? graph.portfolios.get(portfolio_id) : null) ??
          graph.portfolioByReference.get(reference_id);
        if (!portfolio?.urls[0]) {
          throw new Error(`Reference "${reference_id}" has no generated portfolio image to verify against.`);
        }
        if (keyframe.composition?.mode !== "sequential_injection") {
          throw new Error(
            `Keyframe "${keyframe_id}" must record composition.mode="sequential_injection" before identity verification.`,
          );
        }

        const otherVisibleCharacters = [
          ...new Set(
            (keyframe.sceneState?.characters.length
              ? keyframe.sceneState.characters
                  .filter((character) => character.screen_position !== "offscreen")
                  .map((character) => character.id)
              : keyframe.depicts
            ).filter((id) => id !== reference_id),
          ),
        ].filter((id) => graph.references.get(id)?.category === "characters");
        const otherPortfolios = otherVisibleCharacters.flatMap((id) => {
          const other = graph.portfolioByReference.get(id);
          return other?.urls[0] ? [{ id, url: other.urls[0] }] : [];
        });

        const schema = z.object({
          visible: z.boolean(),
          same_identity: z.boolean(),
          exactly_one_visible_instance: z.boolean(),
          no_principal_lookalikes: z.boolean(),
          no_identity_mixups: z.boolean(),
          evidence: z.string(),
        });
        const { object } = await generateObject({
          model: openrouter.chat(MODEL_ID),
          schema,
          system:
            "You are a strict whole-frame identity verifier. Compare the portfolio reference to the generated keyframe. Pass only if the named character is visible, clearly the same identity/wardrobe/body design as the reference, and appears exactly once in the whole frame. Also fail if any unnamed bystander resembles that character, if the same principal appears twice, or if any visible principal identity is mixed with another provided principal reference. Be literal and inspect the whole frame, not just the intended region.",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: `Portfolio/reference image for "${reference_id}":` },
                { type: "image", image: portfolio.urls[0] },
                ...otherPortfolios.flatMap((other) => [
                  { type: "text" as const, text: `Other visible principal reference "${other.id}" (must remain distinct from "${reference_id}"):` },
                  { type: "image" as const, image: other.url },
                ]),
                { type: "text", text: `Generated keyframe "${keyframe_id}" to verify:` },
                { type: "image", image: keyframe.url },
              ],
            },
          ],
        });
        const status =
          object.visible &&
          object.same_identity &&
          object.exactly_one_visible_instance &&
          object.no_principal_lookalikes &&
          object.no_identity_mixups
            ? "passed"
            : "failed";

        const raw = await readWorkspaceFile(projectId, keyframe.path);
        const parsed = parseJsonFrontmatter(raw);
        const existingComposition =
          parsed.meta.composition &&
          typeof parsed.meta.composition === "object" &&
          !Array.isArray(parsed.meta.composition)
            ? (parsed.meta.composition as Record<string, unknown>)
            : {};
        const existingVerifications = Array.isArray(
          existingComposition.identity_verifications,
        )
          ? existingComposition.identity_verifications
          : [];
        const composition = {
          ...existingComposition,
          mode: "sequential_injection",
          identity_verifications: [
            ...existingVerifications.filter((item) => {
              return !(
                item &&
                typeof item === "object" &&
                (item as Record<string, unknown>).reference_id === reference_id
              );
            }),
            {
              reference_id,
              portfolio_id: portfolio.id,
              status,
              summary: object.evidence,
            },
          ],
        };
        await writeWorkspaceFile(
          projectId,
          keyframe.path,
          withJsonFrontmatter({ ...parsed.meta, composition }, parsed.body),
        );
        await writeOperation(projectId, {
          id: `op_verify_${keyframe_id}_${reference_id}_${Date.now().toString(36)}`,
          kind: "verify_keyframe_identity",
          title: `Verify ${reference_id} in ${keyframe_id}`,
          result: {
            keyframe_id,
            reference_id,
            portfolio_id: portfolio.id,
            status,
            ...object,
          },
        });
        return withCheck(projectId, {
          keyframe_id,
          reference_id,
          portfolio_id: portfolio.id,
          status,
          ...object,
        });
      },
    }),
    injectCharacter: tool({
      description:
        "Sequentially inject ONE identity-bound character into an existing keyframe (the plate, or the result of a prior injection), using ONLY that character's portfolio as the identity reference. For visible characters, pass a normalized region box {x,y,w,h}; the edit is mask-bound to that region so the identity cannot spawn elsewhere. If region is omitted, the tool falls back to scene_state-derived regions, then legacy maskless editing only when no visible region exists. composition.mode becomes 'sequential_injection', the character is appended to composition.injected_references, and its identity verification is reset to pending. Call once per visible character for a multi-character frame — NEVER pass two character portfolios in one generation — then run verifyKeyframeIdentity for each.",
      inputSchema: z.object({
        keyframe_id: z
          .string()
          .min(1)
          .describe("Keyframe to edit: the plate for the first character, or the prior injection result for the next."),
        reference_id: z.string().min(1).describe("Character reference id to inject, e.g. char_ava."),
        portfolio_id: z
          .string()
          .nullable()
          .default(null)
          .describe("Optional portfolio id; defaults to the portfolio for reference_id."),
        placement: z
          .string()
          .min(1)
          .describe("Where/how to place the character in plain visual terms, e.g. 'in the left third, facing screen-right, mid-stride'."),
        region: z
          .object({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            w: z.number().min(0).max(1),
            h: z.number().min(0).max(1),
          })
          .nullable()
          .default(null)
          .describe(
            "Normalized image region reserved for this visible character. Required for reliable masked injection; use null only when the character is offscreen.",
          ),
      }),
      execute: async ({ keyframe_id, reference_id, portfolio_id, placement, region: requestedRegion }) => {
        const graph = await loadGraph(projectId);
        const keyframe = graph.keyframes.get(keyframe_id);
        if (!keyframe) throw new Error(`Keyframe "${keyframe_id}" does not exist.`);
        const keyframeUrl = await hostedKeyframeUrl(projectId, graph, keyframe_id);
        if (!keyframeUrl) throw new Error(`Keyframe "${keyframe_id}" has no image to edit; generate the plate first.`);
        const reference = graph.references.get(reference_id);
        if (!reference) throw new Error(`Reference "${reference_id}" does not exist.`);
        if (reference.category !== "characters") {
          throw new Error(`Reference "${reference_id}" is not a character reference.`);
        }
        const portfolio =
          (portfolio_id ? graph.portfolios.get(portfolio_id) : null) ??
          graph.portfolioByReference.get(reference_id);
        if (!portfolio?.urls[0]) {
          throw new Error(`Reference "${reference_id}" has no generated portfolio image to inject.`);
        }

        const raw = await readWorkspaceFile(projectId, keyframe.path);
        const parsed = parseJsonFrontmatter(raw);
        const aspectRatio = (typeof parsed.meta.aspect_ratio === "string"
          ? parsed.meta.aspect_ratio
          : "16:9") as (typeof ASPECT_RATIOS)[number];
        const versionState = mediaVersionState(parsed.meta);
        assertKeyframeVersionBudget(keyframe_id, versionState.nextVersion);
        const prevComposition =
          parsed.meta.composition &&
          typeof parsed.meta.composition === "object" &&
          !Array.isArray(parsed.meta.composition)
            ? (parsed.meta.composition as Record<string, unknown>)
            : {};
        const verificationStatus = identityVerificationStatus(prevComposition, reference_id);
        if (verificationStatus === "passed") {
          throw new Error(
            `Keyframe "${keyframe_id}" already has a passed identity verification for "${reference_id}". Do not reinject it.`,
          );
        }
        if (verificationStatus === "pending") {
          throw new Error(
            `Keyframe "${keyframe_id}" already has a pending identity verification for "${reference_id}". Run verifyKeyframeIdentity before retrying injection.`,
          );
        }
        const attempts = injectionAttemptCount(prevComposition, reference_id);
        const maxAttempts = maxCharacterInjectionAttempts();
        if (attempts >= maxAttempts) {
          throw new Error(
            `Keyframe "${keyframe_id}" has already tried ${attempts} injection attempt(s) for "${reference_id}" (cap ${maxAttempts}). ` +
              "Do not retry this same frame. Simplify the staging, isolate the character, move the prop handoff to a cut, or plan a new keyframe/region instead.",
          );
        }

        const prompt = [
          `Image 1: the current scene. Image 2: the identity reference for "${reference_id}".`,
          `Edit "${reference_id}" into the scene exactly matching Image 2 — same face, hair, wardrobe, and body design — placed ${placement}.`,
          `Keep EVERYTHING ELSE in Image 1 identical: background, set pieces, lighting, and any characters already placed must not change. Show exactly ONE instance of "${reference_id}"; background people must not resemble this character.`,
        ].join("\n");
        const characterState =
          keyframe.sceneState?.characters.find((character) => character.id === reference_id) ??
          null;
        const region = requestedRegion ?? (characterState ? characterRegion(characterState) : null);
        const hasVisibleRegion = Boolean(region && region.w > 0 && region.h > 0);

        const op: BillableOp = { kind: "image", tool: "generateKeyframe", resolution: "1K" };
        const denied = await preflightCharge(billing, op);
        if (denied) return { error: denied };
        let generation: GeneratedMedia;
        let maskUrl: string | null = null;
        let promptForRecord = prompt;
        if (hasVisibleRegion && region) {
          const imageResponse = await fetch(keyframeUrl);
          if (!imageResponse.ok) {
            throw new Error(
              `Could not fetch keyframe "${keyframe_id}" to size its injection mask (${imageResponse.status}).`,
            );
          }
          const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
          const dimensions = imageSize(imageBuffer);
          if (!dimensions) {
            throw new Error(`Could not read image dimensions for keyframe "${keyframe_id}".`);
          }
          const maskBuffer = await rasterizeRegionMaskPng(
            region,
            dimensions.width,
            dimensions.height,
          );
          const maskUpload = await hostProjectBytes(
            projectId,
            `${keyframe_id}_${reference_id}_mask.png`,
            maskBuffer,
          );
          if (!maskUpload.ok) throw new Error(maskUpload.error);
          maskUrl = maskUpload.url;
          promptForRecord = [
            prompt,
            "",
            "Masked-region constraint:",
            "Edit ONLY the white masked region. Preserve black/unmasked pixels as unchanged as possible.",
            `The white region is reserved for exactly one visible instance of "${reference_id}". Do not create or alter lookalikes outside the mask.`,
          ].join("\n");
          generation = await generateFalMaskedImageEdit({
            prompt: promptForRecord,
            imageUrls: [keyframeUrl, portfolio.urls[0]],
            maskUrl,
            imageSize: "auto",
          });
        } else {
          generation = await generateFalImage({
            prompt,
            imageUrls: [keyframeUrl, portfolio.urls[0]],
            aspectRatio,
          });
        }
        if (generation.ok) await settleCharge(billing, op, projectId, { url: generation.url });
        const imagePhash = generation.url
          ? await imagePerceptualHash(generation.url).catch(() => null)
          : null;

        const localPath = await saveVersionedRemoteMedia(
          projectId,
          generation.url,
          "keyframes",
          keyframe_id,
          versionState.nextVersion,
        );
        const writeState = mediaVersionWriteState(parsed.meta, {
          url: generation.url,
          localPath,
          successStatus: "generated",
          emptyStatus: "planned",
        });

        const prevDepicts = Array.isArray(parsed.meta.depicts)
          ? parsed.meta.depicts.filter((x): x is string => typeof x === "string")
          : keyframe.depicts;
        const depicts = prevDepicts.includes(reference_id)
          ? prevDepicts
          : [...prevDepicts, reference_id];

        const prevInjected = Array.isArray(prevComposition.injected_references)
          ? prevComposition.injected_references.filter((x): x is string => typeof x === "string")
          : [];
        const injectedReferences = prevInjected.includes(reference_id)
          ? prevInjected
          : [...prevInjected, reference_id];
        const prevVerifications = Array.isArray(prevComposition.identity_verifications)
          ? prevComposition.identity_verifications
          : [];
        const composition = {
          ...prevComposition,
          mode: "sequential_injection",
          injected_references: injectedReferences,
          injection_attempts: injectionAttemptsWithIncrement(prevComposition, reference_id),
          identity_verifications: [
            ...prevVerifications.filter((item) => {
              return !(
                item &&
                typeof item === "object" &&
                (item as Record<string, unknown>).reference_id === reference_id
              );
            }),
            { reference_id, portfolio_id: portfolio.id, status: "pending", summary: null },
          ],
        };

        const assetId = `asset_${keyframe_id}`;
        await writeAssetFromGeneration(projectId, {
          assetId,
          depicts,
          derivedFrom: [portfolio.id],
          generation,
          kind: "image",
          localPath,
          prompt: promptForRecord,
          title: `${keyframe_id} — inject ${reference_id}`,
          usedIn: [keyframe_id],
        });

        await writeWorkspaceFile(
          projectId,
          keyframe.path,
          withJsonFrontmatter(
            {
              ...parsed.meta,
              id: keyframe_id,
              type: "keyframe",
              status: writeState.status,
              url: writeState.active?.url ?? null,
              local_path: writeState.active?.local_path ?? null,
              versions: writeState.versions,
              image_phash: imagePhash,
              depicts,
              composition,
            },
            parsed.body,
          ),
        );
        await writeOperation(projectId, {
          id: `op_inject_${keyframe_id}_${reference_id}_${Date.now().toString(36)}`,
          kind: "inject_character",
          title: `Inject ${reference_id} into ${keyframe_id}`,
          prompt: promptForRecord,
          result: { ...generation, mask_url: maskUrl, masked_region: region },
        });
        return withCheck(projectId, {
          keyframe_id,
          ok: generation.ok,
          injected: reference_id,
          injected_references: injectedReferences,
          masked_region: region,
          mask_url: maskUrl,
          url: generation.url ?? null,
          error: generation.error ?? null,
          note: "Run verifyKeyframeIdentity for each injected character before clips.",
        });
      },
    }),
    viewImage: tool({
      description:
        "Look at a generated image (keyframe, portfolio, or asset id) — the actual pixels are returned to you. WHY: generated frames always drift from what was planned (pose, composition, lighting, subject placement land differently). View BOTH endpoint keyframes before generateClip so start_state, end_state, and motion describe what is really in the frames; a motion prompt written from the plan fights the locked frames, one written from the real pixels cooperates with them.",
      inputSchema: z.object({
        id: z.string().min(1).describe("Keyframe, portfolio, reference, or asset id with media."),
      }),
      execute: async ({ id }) => {
        const graph = await loadGraph(projectId);
        const url =
          graph.keyframes.get(id)?.url ??
          graph.portfolios.get(id)?.urls[0] ??
          graph.portfolioByReference.get(id)?.urls[0] ??
          graph.assets.get(id)?.url ??
          null;
        if (!url) {
          throw new Error(
            `No media url found for "${id}". It must be a generated/captured keyframe, a portfolio with urls, or an asset.`,
          );
        }
        return { id, url };
      },
      toModelOutput: ({ output }) => ({
        type: "content",
        value: [
          { type: "text", text: `Actual generated pixels for "${output.id}":` },
          { type: "image-url", url: output.url },
        ],
      }),
    }),
    generateReferencePortfolio: tool({
      description:
        "Generate or regenerate the portfolio contact sheet for a reference (its identity ground truth) and write portfolio, prompt, operation, and asset records. The reference.md must exist first. When an existing portfolio image exists, it is passed into the image model as visual reference so edits preserve identity.",
      inputSchema: z.object({
        aspect_ratio: z
          .enum(ASPECT_RATIOS)
          .default("1:1")
          .describe("Portfolio contact sheet ratio — 1:1, 16:9, or 9:16."),
        category: z.enum(["characters", "environments", "props", "styles"]),
        conditioning_image_ids: z
          .array(z.string())
          .default([])
          .describe(
            "Tile ids of images whose PIXELS should condition this portfolio (uploads, keyframes, saved web images): real photos of a person (REQUIRED for real people), style example frames, product/location shots.",
          ),
        conditioning_image_urls: z
          .array(z.string())
          .default([])
          .describe(
            "Direct image file URLs to condition on — each is validated, saved to the canvas as a tile (so the user sees it), and then used. Equivalent to saveImageToCanvas + conditioning_image_ids in one step.",
          ),
        style_image_ids: z
          .array(z.string())
          .default([])
          .describe(
            "Tile ids of STYLE reference images (a saved style frame or screenshot). These set the rendering style and are attached separately from the subject images — never mix style anchors into conditioning_image_ids.",
          ),
        prompt: z.string().min(1),
        reference_id: z.string().min(1),
        title: z.string().min(1),
      }),
      execute: async ({ aspect_ratio, category, conditioning_image_ids, conditioning_image_urls, prompt, reference_id, style_image_ids, title }) => {
        if (!claimGeneration(`portfolio:${reference_id}`)) return duplicateGenerationError;
        const conditioningGraph = await loadGraph(projectId);
        const resolveTileUrl = async (rawId: string) => {
          const conditioningId = rawId.replace(/^@/, "");
          const media = await tileImageMediaById(projectId, conditioningGraph, conditioningId);
          if (!media) {
            return {
              error: `Conditioning image "${conditioningId}" not found — saveImageToCanvas first, or pass an existing image tile id.`,
              ok: false as const,
            };
          }
          return fetchableUrlForWorkspaceMedia(projectId, media, conditioningId);
        };
        const likenessImageUrls: string[] = [];
        const allConditioningIds = [...conditioning_image_ids];
        for (const rawUrl of conditioning_image_urls) {
          const imported = await importWebImageToCanvas(projectId, rawUrl, `${title} reference`);
          if (!imported.ok) return { error: imported.error, ok: false };
          allConditioningIds.push(imported.id);
        }
        for (const rawId of allConditioningIds) {
          const hosted = await resolveTileUrl(rawId);
          if (!hosted.ok) return { error: hosted.error, ok: false };
          likenessImageUrls.push(hosted.url);
        }
        const explicitStyleUrls: string[] = [];
        for (const rawId of style_image_ids) {
          const hosted = await resolveTileUrl(rawId);
          if (!hosted.ok) return { error: hosted.error, ok: false };
          explicitStyleUrls.push(hosted.url);
        }
        if (!spendGeneration()) return generationBudgetError;
        const graph = await loadGraph(projectId);
        if (!graph.references.has(reference_id)) {
          throw new Error(
            `Reference "${reference_id}" does not exist. Write references/${category}/${reference_id}/reference.md first.`,
          );
        }
        const assetId = `asset_${reference_id}_portfolio`;
        const existingPortfolio = graph.portfolioByReference.get(reference_id);
        const existingImageUrls = existingPortfolio?.urls[0] ? [existingPortfolio.urls[0]] : [];
        const scaffoldUrl = await getPortfolioScaffoldUrl(projectId);
        // STYLE FIRST: explicit style images win; otherwise every non-style
        // portfolio inherits the project's style portfolio so the whole piece
        // shares one visual language. (No-op until a styles portfolio exists.)
        const inheritedStyleUrls =
          category === "styles" || explicitStyleUrls.length
            ? []
            : [...graph.references.values()]
                .filter((ref) => ref.category === "styles" && ref.id !== reference_id)
                .map((ref) => graph.portfolioByReference.get(ref.id)?.urls?.[0])
                .filter((url): url is string => Boolean(url))
                .slice(0, 1);
        const styleImageUrls = [...explicitStyleUrls, ...inheritedStyleUrls];
        const conditioningImageUrls = [
          scaffoldUrl,
          ...likenessImageUrls,
          ...styleImageUrls,
          ...existingImageUrls,
        ].filter(
          (url): url is string => Boolean(url),
        );
        const likenessNote = likenessImageUrls.length
          ? `\n\nAttached after the grid scaffold: ${likenessImageUrls.length} reference image(s) of the subject. This is the subject of every cell.`
          : "";
        const styleNote = styleImageUrls.length
          ? `\n\nAttached next: ${styleImageUrls.length} style reference image(s). Render every cell in exactly this style.`
          : "";
        const continuityNote = existingImageUrls.length
          ? "\n\nAttached last: the previous version of this portfolio, for continuity."
          : "";
        const scaffoldNote = scaffoldUrl
          ? `\n\n${PORTFOLIO_SCAFFOLD_INSTRUCTION}`
          : "\n\nA blank 3x3 scaffold image could not be attached; still follow the written nine-cell grid exactly.";
        const assetPrompt = prompt;
        const finalPrompt = `${portfolioPromptContract(category)}${scaffoldNote}${likenessNote}${styleNote}\n\nAsset-specific brief:\n${assetPrompt}${continuityNote}`;
        await writeWorkspaceFile(projectId, `prompts/${assetId}.prompt.md`, `# ${title}\n\n${finalPrompt}\n`);
        const portfolioOp: BillableOp = {
          kind: "portfolio",
          tool: "generateReferencePortfolio",
          resolution: "2K",
        };
        const portfolioDenied = await preflightCharge(billing, portfolioOp);
        if (portfolioDenied) return { error: portfolioDenied };
        const generation = await generateFalImage({
          prompt: finalPrompt,
          aspectRatio: aspect_ratio,
          imageUrls: conditioningImageUrls,
        });
        if (generation.ok) await settleCharge(billing, portfolioOp, projectId, { title, url: generation.url });
        // Companion profile image: one polished square shot derived from the
        // sheet — the user-facing face of this reference on canvas tiles
        // (mirrors the explore/library "display" image).
        let displayUrl: string | null = null;
        if (generation.ok && generation.url) {
          const subject =
            category === "characters"
              ? "a single FULL-BODY shot of the character: standing head-to-toe, filling roughly 85% of the frame height, facing the camera in a relaxed neutral stance on simple clean ground. The face and outfit must be clearly readable. NOT an action pose, NOT running, NOT a distant/wide shot, NOT a close-up crop"
              : category === "environments"
                ? "a single establishing shot of the location"
                : category === "props"
                  ? "a single clean product-style shot of the object, large in frame"
                  : "a single cinematic frame that embodies the style";
          const display = await generateFalImage({
            aspectRatio: "1:1",
            imageUrls: [generation.url],
            prompt: `Using the attached 3x3 portfolio contact sheet as exact visual reference, create ${subject}. One image, not a grid. Identical identity, palette, and design language as the sheet. No text or labels.\n\nSubject: ${title}.`,
          });
          if (display.ok && display.url) displayUrl = display.url;
        }
        await writeAssetFromGeneration(projectId, {
          assetId,
          depicts: [reference_id],
          generation,
          kind: "image",
          prompt: finalPrompt,
          title,
          usedIn: [`references/${category}/${reference_id}/portfolio.md`],
        });
        await writeWorkspaceFile(
          projectId,
          `references/${category}/${reference_id}/portfolio.md`,
          withJsonFrontmatter(
            {
              id: `${reference_id}_portfolio`,
              type: "portfolio",
              reference_id,
              portfolio_format: DEFAULT_PORTFOLIO_FORMAT,
              status: generation.url ? "generated" : "planned",
              urls: generation.url ? [generation.url] : [],
              display_url: displayUrl,
              asset_id: assetId,
            },
            `# ${title}\n\n## Prompt\n\n${finalPrompt}\n\n## Media\n\n${generation.url ?? "Pending or failed generation; inspect operation file."}\n`,
          ),
        );
        await writeOperation(projectId, {
          id: `op_${assetId}`,
          kind: "generate_reference_portfolio",
          title,
          prompt: finalPrompt,
          result: {
            ...generation,
            conditioning_image_urls: conditioningImageUrls,
            portfolio_scaffold_url: scaffoldUrl,
            reference_image_urls: existingImageUrls,
          },
        });
        return withCheck(projectId, {
          reference_id,
          portfolio_id: `${reference_id}_portfolio`,
          conditioning_image_urls: conditioningImageUrls,
          portfolio_scaffold_url: scaffoldUrl,
          reference_image_urls: existingImageUrls,
          ok: generation.ok,
          url: generation.url ?? null,
          display_url: displayUrl,
          error: generation.error ?? null,
        });
      },
    }),
    generateKeyframe: tool({
      description:
        "Generate a keyframe conditioned on identity anchors (portfolio images) and, for continuous progression, the prior frame (state_anchor). The conditioning images are physically passed to the image model; built_against hashes are recorded automatically. Omit state_anchor across a cut. To FIX a flawed frame (stray object, wrong placement), set revises to its id and give a corrective instruction — the flawed frame is fed back in for an edit, and downstream clips automatically go stale.",
      inputSchema: z.object({
        aspect_ratio: z
          .enum(ASPECT_RATIOS)
          .describe("Required. Choose explicitly: 16:9 landscape, 9:16 portrait/vertical, or 1:1 square. Use ONE ratio for the whole video."),
        body: z.string().min(1).describe("What this frame shows, in prose."),
        depicts: z.array(z.string()).default([]).describe("Reference ids visible in the frame."),
        id: z.string().min(1),
        identity_anchors: z
          .array(z.string())
          .default([])
          .describe("Portfolio ids (or reference ids) whose images must be copied."),
        instruction: z.string().min(1).describe("The delta: what to generate, given the anchors. When revising, the correction (e.g. 'same frame, remove the red ball near the tree')."),
        state_anchor: z
          .string()
          .nullable()
          .default(null)
          .describe("Prior keyframe id for continuous shots; omit across cuts."),
        revises: z
          .string()
          .nullable()
          .default(null)
          .describe("Keyframe id this corrects. Its current image is fed in as the base to edit; usually equal to id (in-place fix)."),
        scene_state: z
          .object({
            characters: z
              .array(
                z.object({
                  id: z.string().min(1),
                  screen_position: z.enum(SCREEN_POSITIONS),
                  facing: z.enum(FACINGS),
                  bbox: z
                    .object({
                      x: z.number(),
                      y: z.number(),
                      w: z.number(),
                      h: z.number(),
                    })
                    .nullable()
                    .optional()
                    .describe(
                      "Optional normalized region box {x,y,w,h} for this character. Use it when precise masked injection should constrain where this identity can appear.",
                    ),
                }),
              )
              .default([]),
            props: z
              .array(
                z.object({
                  id: z.string().min(1),
                  owner: z.string().nullable().default(null),
                  location: z.enum(SCREEN_POSITIONS),
                }),
              )
              .default([]),
            set_anchors: z
              .array(z.object({ id: z.string().min(1), location: z.enum(SCREEN_POSITIONS) }))
              .default([]),
          })
          .nullable()
          .default(null)
          .describe(
            "Declarative state snapshot for this frame: character screen_position + facing, prop owner/location, fixed set-piece positions. Used by lint/critic to catch left/right order swaps, facing flips, and prop jumps across a continuous span. Use stable reference ids (match depicts). This is VALIDATION state, not a placement instruction to the image model.",
          ),
        composition: z
          .object({
            mode: z.enum(KEYFRAME_COMPOSITION_MODES),
            plate_keyframe: z.string().nullable().default(null),
            injected_references: z.array(z.string()).default([]),
            injection_attempts: z
              .array(
                z.object({
                  reference_id: z.string().min(1),
                  attempts: z.number().int().min(0),
                }),
              )
              .default([]),
            identity_verifications: z
              .array(
                z.object({
                  reference_id: z.string().min(1),
                  portfolio_id: z.string().nullable().default(null),
                  status: z.enum(IDENTITY_VERIFICATION_STATUSES),
                  summary: z.string().nullable().default(null),
                }),
              )
              .default([]),
          })
          .nullable()
          .default(null)
          .describe(
            "How this keyframe was composed. For multi-character final frames, use mode='sequential_injection', list each injected character reference id, and include passed identity verification for each visible character.",
          ),
        title: z.string().min(1),
      }),
      execute: async ({ aspect_ratio, body, depicts, id, identity_anchors, instruction, state_anchor, revises, scene_state, composition, title }) => {
        if (!claimGeneration(`keyframe:${id}`)) return duplicateGenerationError;
        if (!spendGeneration()) return generationBudgetError;
        const graph = await loadGraph(projectId);
        const keyframePath = `keyframes/${id}.md`;
        const existingMeta = await readExistingFrontmatter(projectId, keyframePath);
        const versionState = mediaVersionState(existingMeta);
        assertKeyframeVersionBudget(id, versionState.nextVersion);
        const resolution = resolveGenerationAnchors(graph, {
          identityAnchorIds: identity_anchors,
          stateAnchorId: state_anchor,
          stateAnchorUrlOverride: state_anchor
            ? await hostedKeyframeUrl(projectId, graph, state_anchor)
            : null,
        });
        if (!resolution.ok) throw new Error(resolution.error);
        // Repair mode: feed the flawed frame back in as the base image to edit.
        let reviseUrl: string | null = null;
        if (revises) {
          const source = graph.keyframes.get(revises);
          if (!source) throw new Error(`revises target "${revises}" does not exist.`);
          reviseUrl = await hostedKeyframeUrl(projectId, graph, revises);
          if (!reviseUrl) throw new Error(`revises target "${revises}" has no image to correct.`);
        }
        // Declared staging from scene_state, injected so the generator (not only
        // lint/critic) sees who/what stands where. Coarse aid, not a guarantee.
        const staging = scene_state ? composeStagingDirection(scene_state) : null;
        // In revise mode the flawed frame is prepended as Image 1, so the
        // reference-sheet labels must start at Image 2 (imageOffset: 1).
        let finalPrompt = reviseUrl
          ? `Image 1: the frame to correct — keep it identical except for the requested change.\n${composeConditionedPrompt(
              {
                anchors: resolution.anchors,
                stateAnchorUrl: resolution.stateAnchorUrl,
                instruction,
                imageOffset: 1,
                staging,
              },
            )}`
          : composeConditionedPrompt({
              anchors: resolution.anchors,
              stateAnchorUrl: resolution.stateAnchorUrl,
              instruction,
              staging,
            });
        const conditioningUrls = reviseUrl
          ? [reviseUrl, ...resolution.imageUrls]
          : resolution.imageUrls;
        const assetId = `asset_${id}`;
        await writeWorkspaceFile(projectId, `prompts/${assetId}.prompt.md`, `# ${title}\n\n${finalPrompt}\n`);
        const keyframeOp: BillableOp = { kind: "image", tool: "generateKeyframe", resolution: "1K" };
        const keyframeDenied = await preflightCharge(billing, keyframeOp);
        if (keyframeDenied) return { error: keyframeDenied };
        let generation: GeneratedMedia = await generateFalImage({
          prompt: finalPrompt,
          imageUrls: conditioningUrls,
          aspectRatio: aspect_ratio,
        });
        if (generation.ok) await settleCharge(billing, keyframeOp, projectId, { title, url: generation.url });
        let imagePhash = generation.url
          ? await imagePerceptualHash(generation.url).catch(() => null)
          : null;
        if (revises && reviseUrl && generation.url && imagePhash) {
          const source = graph.keyframes.get(revises);
          const sourceHash =
            source?.imagePhash ??
            (await imagePerceptualHash(reviseUrl).catch(() => null));
          const distance = sourceHash
            ? imageHashDistance(sourceHash, imagePhash)
            : null;
          if (distance !== null && isNearDuplicateDistance(distance)) {
            const retryPrompt = `${finalPrompt}\n\nRevision guard: the last generated fix was too visually similar to the frame it was supposed to change. Make the requested correction obvious in the image: alter the relevant pose, position, object state, camera perspective, or environment state while preserving identity and style. Do not return a near-duplicate of Image 1.`;
            const retryDenied = await preflightCharge(billing, keyframeOp);
            if (retryDenied) {
              return withCheck(projectId, {
                keyframe_id: id,
                ok: false,
                error: `${retryDenied} The first revision attempt was rejected because it was too visually similar to "${revises}" (pHash distance ${distance.toFixed(3)}).`,
                duplicate_of: revises,
                similarity_distance: distance,
                first_attempt_url: generation.url,
              });
            }
            const retryGeneration = await generateFalImage({
              prompt: retryPrompt,
              imageUrls: conditioningUrls,
              aspectRatio: aspect_ratio,
            });
            if (retryGeneration.ok) await settleCharge(billing, keyframeOp, projectId, { title, url: retryGeneration.url });
            const retryPhash = retryGeneration.url
              ? await imagePerceptualHash(retryGeneration.url).catch(() => null)
              : null;
            const retryDistance =
              sourceHash && retryPhash
                ? imageHashDistance(sourceHash, retryPhash)
                : null;
            if (
              retryGeneration.url &&
              retryDistance !== null &&
              isNearDuplicateDistance(retryDistance)
            ) {
              return withCheck(projectId, {
                keyframe_id: id,
                ok: false,
                error: `Revision "${id}" remained too visually similar to "${revises}" after an automatic retry (pHash distance ${retryDistance.toFixed(3)}). Regenerate with a stronger visual delta or inspect the keyframe manually.`,
                duplicate_of: revises,
                similarity_distance: retryDistance,
                first_attempt_url: generation.url,
                retry_url: retryGeneration.url,
              });
            }
            finalPrompt = retryPrompt;
            generation = retryGeneration;
            imagePhash = retryPhash;
            await writeWorkspaceFile(projectId, `prompts/${assetId}.prompt.md`, `# ${title}\n\n${finalPrompt}\n`);
          }
        }
        const localPath = await saveVersionedRemoteMedia(
          projectId,
          generation.url,
          "keyframes",
          id,
          versionState.nextVersion,
        );
        const writeState = mediaVersionWriteState(existingMeta, {
          url: generation.url,
          localPath,
          successStatus: "generated",
          emptyStatus: "planned",
        });
        const builtAgainst = buildBuiltAgainst(graph, [
          ...depicts,
          ...resolution.anchors.map((anchor) => anchor.portfolioId),
          ...(state_anchor ? [state_anchor] : []),
        ]);
        try {
          await writeAssetFromGeneration(projectId, {
            assetId,
            depicts,
            derivedFrom: resolution.anchors.map((anchor) => anchor.portfolioId),
            generation,
            kind: "image",
            localPath,
            prompt: finalPrompt,
            title,
            usedIn: [id],
          });
        } catch (persistError) {
          // Charged on success above but the asset failed to persist — refund
          // so the user isn't billed for an artifact that never landed.
          if (billing && generation.ok) {
            await refundCredits({
              userId: billing.userId,
              credits: quoteOp(keyframeOp),
              projectId,
              idempotencyKey: `refund:${keyframeOp.tool}:${generation.url}`,
              description: "Refund: artifact save failed",
            }).catch(() => {});
          }
          throw persistError;
        }
        await writeWorkspaceFile(
          projectId,
          keyframePath,
          withJsonFrontmatter(
            {
              id,
              type: "keyframe",
              status: writeState.status,
              url: writeState.active?.url ?? null,
              local_path: writeState.active?.local_path ?? null,
              versions: writeState.versions,
              image_phash: imagePhash,
              asset_id: assetId,
              aspect_ratio: aspect_ratio,
              depicts,
              identity_anchors: resolution.anchors.map((anchor) => anchor.portfolioId),
              state_anchor,
              ...(scene_state ? { scene_state } : {}),
              ...(composition ? { composition } : {}),
              ...(revises && revises !== id ? { revises } : {}),
              built_against: builtAgainst,
            },
            `# ${title}\n\n${body}\n\n## Prompt\n\n${finalPrompt}\n\n## Media\n\n${writeState.active?.url ?? "Pending or failed generation; inspect operation file."}\n`,
          ),
        );
        await writeOperation(projectId, {
          id: `op_${assetId}`,
          kind: "generate_keyframe",
          title,
          prompt: finalPrompt,
          result: generation,
        });
        return withCheck(projectId, {
          keyframe_id: id,
          ok: generation.ok,
          url: generation.url ?? null,
          conditioned_on: resolution.imageUrls,
          error: generation.error ?? null,
        });
      },
    }),
    prepareClipPrompts: tool({
      description:
        "Prepare editable Seedance-ready prompts for clips AFTER reviewKeyframes and BEFORE generateClip. This compiles the structured clip plans into prompt artifacts, records dependency hashes, and lets users inspect or edit prompts before spending video generation.",
      inputSchema: z.object({
        clips: z.array(clipPlanInputSchema).min(1).max(24),
        force: z
          .boolean()
          .default(false)
          .describe("Overwrite existing user-edited prompt files only when the user explicitly asked to replan/replace them."),
      }),
      execute: async ({ clips, force }) => {
        const graph = await loadGraph(projectId);
        const marker = await readReviewMarker(projectId);
        if (!marker) {
          throw new Error(
            "Run reviewKeyframes before preparing clip prompts — a separate critic reviews the start/end keyframe pairs.",
          );
        }
        const openBlocker = [...graph.findings.values()].find(
          (f) => f.status === "open" && f.severity === "blocker",
        );
        if (openBlocker) {
          throw new Error(
            `Open blocker finding "${openBlocker.id}" must be resolved before preparing clip prompts: ${openBlocker.summary}.`,
          );
        }

        const planned: Array<{ clip_id: string; prompt_path: string }> = [];
        for (const input of clips) {
          const existingClip = graph.clips.get(input.id);
          if (existingClip?.url && !force) {
            throw new Error(
              `Clip "${input.id}" already has generated media. Re-run prepareClipPrompts with force=true only if you intend to replace/replan it.`,
            );
          }
          const from = graph.keyframes.get(input.from_keyframe);
          if (!from) throw new Error(`from_keyframe "${input.from_keyframe}" does not exist.`);
          if (!(await keyframeMediaById(projectId, graph, input.from_keyframe))) {
            throw new Error(
              `from_keyframe "${input.from_keyframe}" has no media; generate or capture it first.`,
            );
          }
          const to = input.to_keyframe ? graph.keyframes.get(input.to_keyframe) : null;
          if (input.to_keyframe && !to) {
            throw new Error(`to_keyframe "${input.to_keyframe}" does not exist.`);
          }
          if (to && !(await keyframeMediaById(projectId, graph, to.id))) {
            throw new Error(
              `to_keyframe "${to.id}" has no media; generate it first so the end can be enforced.`,
            );
          }
          if (to && !input.end_state?.trim()) {
            throw new Error(
              `end_state is required for clip "${input.id}" when to_keyframe is set — viewImage the to-keyframe and describe what is actually in it.`,
            );
          }
          if (!graph.scenes.has(input.scene)) {
            throw new Error(`Scene "${input.scene}" does not exist. Write scenes/<idx>-<slug>/scene.md first.`);
          }
          const blocking = blockingFrameDeltas(input.frame_delta as FrameDeltaEntry[]);
          if (blocking.length > 0) {
            throw new Error(
              `Frame continuity errors must be fixed before planning clip "${input.id}": ${blocking
                .map((delta) => `${delta.element} (${delta.change})`)
                .join(", ")}.`,
            );
          }
          for (const speaker of new Set(input.dialogue.lines.map((line) => line.speaker))) {
            const reference = graph.references.get(speaker);
            if (!reference) {
              throw new Error(
                `Dialogue speaker "${speaker}" is not a reference id. Create a characters reference for them and use its id.`,
              );
            }
            if (reference.category !== "characters") {
              throw new Error(
                `Dialogue speaker "${speaker}" is a ${reference.category ?? "uncategorized"} reference; speaking roles must be characters references.`,
              );
            }
          }

          await assertPromptWritable(projectId, input.id, force);
          const prompt = composeClipPrompt({
            actionIntent: input.action_intent,
            startState: input.start_state,
            endState: to ? input.end_state : null,
            actionBeats: input.action_beats,
            environment: input.environment,
            cameraMove: input.camera_move as CameraMove,
            cameraNote: input.camera_note,
            lighting: input.lighting,
            motionRate: input.motion_rate,
            frameDeltas: input.frame_delta as FrameDeltaEntry[],
            dialogue: input.dialogue,
          });
          const plan = clipPromptPlan(input);
          const planDepId = clipPlanDependencyId(input.id);
          const builtAgainst = {
            ...buildBuiltAgainst(graph, [from.id, ...(to ? [to.id] : [])]),
            [planDepId]: clipPlanHashValue(plan),
          };
          const assetId = assetIdForClip(input.id);
          const clipPath = `clips/${input.id}.md`;
          const existingMeta = await readExistingFrontmatter(projectId, clipPath);
          const versionState = mediaVersionState(existingMeta);
          const activeMedia = versionState.active;
          const status = activeMedia ? versionState.activeStatus ?? "active" : "planned";
          const generatedSeconds =
            activeMedia && typeof existingMeta.generated_seconds === "number"
              ? existingMeta.generated_seconds
              : null;
          await writeWorkspaceFile(
            projectId,
            promptPathForClip(input.id),
            withJsonFrontmatter(
              {
                id: promptIdForClip(input.id),
                type: "prompt",
                status: "planned",
                clip_id: input.id,
                asset_id: assetId,
                compiler: CLIP_PROMPT_COMPILER,
                compiler_hash: sha16(prompt),
                built_against: builtAgainst,
              },
              prompt,
            ),
          );
          await writeWorkspaceFile(
            projectId,
            clipPath,
            withJsonFrontmatter(
              {
                id: input.id,
                type: "clip",
                scene: input.scene,
                index: input.index,
                status,
                url: activeMedia?.url ?? null,
                local_path: activeMedia?.local_path ?? null,
                versions: versionState.versions,
                asset_id: assetId,
                from_keyframe: from.id,
                to_keyframe: to?.id ?? null,
                end_trust: to ? "pinned" : "unknown",
                transition_from_previous: input.transition_from_previous,
                shot_size: input.shot_size,
                cut_motivation: input.cut_motivation,
                camera_move: input.camera_move,
                motion_rate: input.motion_rate,
                aspect_ratio: input.aspect_ratio,
                duration_seconds: Math.min(15, Math.max(4, Math.ceil(input.duration_seconds))),
                generated_seconds: generatedSeconds,
                in_timeline: input.add_to_timeline,
                frame_delta: input.frame_delta,
                dialogue: input.dialogue,
                prompt_plan: plan,
              },
              plannedClipBody(input, prompt),
            ),
          );
          planned.push({ clip_id: input.id, prompt_path: promptPathForClip(input.id) });
        }
        return withCheck(projectId, {
          ok: true,
          planned_count: planned.length,
          prompts: planned,
        });
      },
    }),
    generateClip: tool({
      description:
        "Generate a clip between keyframes using the stored prompt prepared by prepareClipPrompts. With from AND to keyframes, the first and last frames are enforced (end_trust: pinned) — use this for continuity chains. With only from_keyframe the end is unenforced (end_trust: unknown); captureFrame before continuing from it. The structured fields must match the planned prompt; stale or missing prompts are refused.",
      inputSchema: z.object({
        add_to_timeline: z
          .boolean()
          .default(true)
          .describe(
            "Whether this clip is part of the final cut (persisted as in_timeline). The timeline's ORDER is always derived from scene/clip index — set false only for an outtake you don't want played.",
          ),
        aspect_ratio: z
          .enum(ASPECT_RATIOS)
          .describe("Required. Match the project's chosen keyframe ratio exactly: 16:9 landscape, 9:16 portrait/vertical, or 1:1 square."),
        camera_move: z
          .enum(CAMERA_MOVES as unknown as [string, ...string[]])
          .default("fixed")
          .describe(
            "Exactly ONE camera move (Separation Rule): fixed|push_in|pull_out|pan|tracking|orbit|aerial|handheld. Never blend moves; never fold subject motion into the camera.",
          ),
        camera_note: z
          .string()
          .nullable()
          .default(null)
          .describe("Optional modifier for the move: distance/direction, e.g. '1-2 feet toward center' or 'follows her exit right'. Keep speed out of camera_note. Do NOT request jitter, shake, glitch, VHS/CRT, scan-line, or static looks — they read as the video-artifact noise we forbid; for an energetic feel use stronger subject motion or handheld."),
        action_beats: z
          .array(z.string())
          .min(1)
          .describe(
            "The subject action as ordered short beats (one event each), bridging start_state to end_state. Use stable proper nouns, not pronouns. Keep camera OUT of these — that's camera_move. For action, use at most two beats and add more keyframes/clips for additional moves.",
          ),
        action_intent: z
          .string()
          .min(1)
          .max(180)
          .describe(
            "Short model-facing Seedance prompt line in simple guide style: broad subject + dynamic physical motion intent only, not detailed choreography, endpoint wording, or frame-delta bookkeeping. Use energetic body/action verbs (lunges, drives forward, dodges, vaults, recoils) over static states or VFX-only words. Example: 'Anime fight scene; animate committed attacks, counters, parries, and footwork between the two characters.'",
          ),
        environment: z
          .string()
          .nullable()
          .default(null)
          .describe("The setting as seen in the frames (place, atmosphere, key elements)."),
        lighting: z
          .string()
          .nullable()
          .default(null)
          .describe("Named-source lighting (highest-leverage keyword): 'hard top-down', 'neon glow from left', 'golden hour backlight'."),
        frame_delta: z
          .array(
            z.object({
              element: z.string().min(1).describe("The thing that differs, e.g. 'red ball', 'blast door'."),
              change: z
                .enum(FRAME_DELTA_CHANGES as unknown as [string, ...string[]])
                .describe("appeared | vanished | moved | changed_state"),
              classification: z
                .enum(["intended", "continuity_error"])
                .describe(
                  "intended = the action explains it (provide narration). continuity_error = a flaw in the end keyframe; clip generation will refuse until you repair it with generateKeyframe(revises=...).",
                ),
              narration: z
                .string()
                .nullable()
                .default(null)
                .describe("For intended changes, how it appears/moves on screen. Put visually important motion in action_beats; frame_delta is validation/accounting."),
            }),
          )
          .default([])
          .describe(
            "Every element that differs between the two observed frames. Compare them honestly; an unaccounted object in the end frame is the #1 cause of 'something's off' in the result.",
          ),
        dialogue: dialogueSchema
          .default({ mode: "no_audible_speech", lines: [] })
          .describe("Spoken-audio contract for this clip, with per-line timing in seconds."),
        duration_seconds: z
          .number()
          .positive()
          .default(5)
          .describe(
            "Actual video duration to request from generation and play back. This is NOT an editorial trim target; duration_seconds and generated_seconds must match unless the user explicitly asks to trim existing media. Provider-supported range is clamped to 4-15s; action clips should normally stay 4-5s.",
          ),
        end_state: z
          .string()
          .nullable()
          .default(null)
          .describe(
            "What is ACTUALLY visible in the to-keyframe, written after viewImage. Required when to_keyframe is set.",
          ),
        from_keyframe: z.string().min(1),
        id: z.string().min(1),
        index: z.number().int().positive().default(1).describe("Order within the scene."),
        motion_rate: z
          .enum(Object.keys(MOTION_RATES) as [MotionRate, ...MotionRate[]])
          .default("real_time")
          .describe(
            "slow_motion | real_time | accelerated | frenetic. Note: slow_motion covers little story per second — budget duration accordingly.",
          ),
        scene: z.string().min(1).describe("Scene id this clip belongs to."),
        shot_size: z
          .enum(SHOT_SIZES as unknown as [string, ...string[]])
          .nullable()
          .default(null)
          .describe("ELS|LS|MLS|MS|MCU|CU|ECU — the dominant framing of this shot."),
        cut_motivation: z
          .string()
          .nullable()
          .default(null)
          .describe(
            "Why the cut INTO this clip exists (advance story, reaction, reveal detail, compress time, rhythm…). If you can't name it, the cut shouldn't exist.",
          ),
        start_state: z
          .string()
          .min(1)
          .describe(
            "What is ACTUALLY visible in the from-keyframe, written after viewImage — subject positions, framing, lighting, any drift from the plan.",
          ),
        title: z.string().min(1),
        to_keyframe: z.string().nullable().default(null),
        transition_from_previous: transitionTypeSchema.nullable().default(null),
      }),
      execute: async (input) => {
        if (!claimGeneration(`clip:${input.id}`)) return duplicateGenerationError;
        if (!spendGeneration()) return generationBudgetError;
        const graph = await loadGraph(projectId);
        // GATE (intentionally light, so it informs without trapping): a review
        // must have run AT LEAST ONCE, and no open BLOCKER may remain. We do NOT
        // require the review to cover the exact current keyframe hash — forcing
        // a full re-review on every regen creates a non-converging loop, and
        // "too similar" issue-findings are predictions best confirmed by
        // generating the clip, not gates. Only true blockers stop clips.
        const marker = await readReviewMarker(projectId);
        if (!marker) {
          throw new Error(
            "Run reviewKeyframes before clips — a separate critic reviews the start/end keyframe pairs.",
          );
        }
        const openBlocker = [...graph.findings.values()].find(
          (f) => f.status === "open" && f.severity === "blocker",
        );
        if (openBlocker) {
          throw new Error(
            `Open blocker finding "${openBlocker.id}" must be resolved before clips: ${openBlocker.summary}. Fix the keyframe (generateKeyframe revises=...) and resolveFinding, or have the user dismiss it.`,
          );
        }
        const from = graph.keyframes.get(input.from_keyframe);
        if (!from) throw new Error(`from_keyframe "${input.from_keyframe}" does not exist.`);
        const fromUrl = await hostedKeyframeUrl(projectId, graph, input.from_keyframe);
        if (!fromUrl) {
          throw new Error(
            `from_keyframe "${input.from_keyframe}" has no media url; generate or capture it first.`,
          );
        }
        const to = input.to_keyframe
          ? graph.keyframes.get(input.to_keyframe) ?? null
          : null;
        if (input.to_keyframe && !to) {
          throw new Error(`to_keyframe "${input.to_keyframe}" does not exist.`);
        }
        const toUrl = to ? await hostedKeyframeUrl(projectId, graph, to.id) : null;
        if (to && !toUrl) {
          throw new Error(
            `to_keyframe "${to.id}" has no media url; generate it first so the end can be enforced.`,
          );
        }
        if (to && !input.end_state?.trim()) {
          throw new Error(
            "end_state is required when to_keyframe is set — viewImage the to-keyframe and describe what is actually in it.",
          );
        }
        if (!graph.scenes.has(input.scene)) {
          throw new Error(`Scene "${input.scene}" does not exist. Write scenes/<idx>-<slug>/scene.md first.`);
        }
        // A continuity-error delta means the end keyframe itself is flawed —
        // refuse rather than generate motion toward a broken target frame.
        const blocking = blockingFrameDeltas(input.frame_delta as FrameDeltaEntry[]);
        if (blocking.length > 0) {
          throw new Error(
            `Frame continuity errors must be fixed before generating this clip: ${blocking
              .map((delta) => `${delta.element} (${delta.change})`)
              .join(
                ", ",
              )}. Repair the end keyframe with generateKeyframe(revises="${to?.id ?? input.to_keyframe}", ...), or if the change is actually fine, reclassify it as "intended" with narration.`,
          );
        }
        // No separate editorial trim: generated duration is the playback duration.
        const generationSeconds = Math.min(15, Math.max(4, Math.ceil(input.duration_seconds)));
        const speakers = [
          ...new Set(input.dialogue.lines.map((line) => line.speaker)),
        ];
        for (const speaker of speakers) {
          const reference = graph.references.get(speaker);
          if (!reference) {
            throw new Error(
              `Dialogue speaker "${speaker}" is not a reference id. Create a characters reference for them (narrators too — no portfolio needed) and use its id.`,
            );
          }
          if (reference.category !== "characters") {
            throw new Error(
              `Dialogue speaker "${speaker}" is a ${reference.category ?? "uncategorized"} reference; speaking roles must be characters references.`,
            );
          }
        }
        const prompt = await readPlannedPrompt(projectId, graph, input);
        const modelPrompt = modelPromptForClip(graph, from, to, prompt);
        const speaksAudibly =
          input.dialogue.mode === "exact_dialogue" ||
          input.dialogue.mode === "voiceover_exact";
        const assetId = assetIdForClip(input.id);
        const clipPath = `clips/${input.id}.md`;
        const existingMeta = await readExistingFrontmatter(projectId, clipPath);
        const versionState = mediaVersionState(existingMeta);
        const clipOp: BillableOp = {
          kind: "clip",
          tool: "generateClip",
          pinned: Boolean(fromUrl && toUrl), // first+last → standard tier
          resolution: "720p",
          seconds: generationSeconds,
        };
        const clipDenied = await preflightCharge(billing, clipOp);
        if (clipDenied) return { error: clipDenied };
        const generation = await generateFalVideo({
          prompt: modelPrompt,
          aspectRatio: input.aspect_ratio,
          duration: String(generationSeconds),
          generateAudio: speaksAudibly,
          imageUrl: fromUrl,
          endImageUrl: toUrl,
        });
        if (generation.ok) await settleCharge(billing, clipOp, projectId, { title: input.title, url: generation.url });
        const localPath = await saveVersionedRemoteMedia(
          projectId,
          generation.url,
          "clips",
          input.id,
          versionState.nextVersion,
        );
        const writeState = mediaVersionWriteState(existingMeta, {
          url: generation.url,
          localPath,
          successStatus: "active",
          emptyStatus: "pending",
        });
        const endTrust = to ? "pinned" : "unknown";
        // Speaking characters add a voice dependency (separate axis from
        // visual identity): a voice_id change dirties exactly these clips.
        const builtAgainst = buildBuiltAgainst(graph, [
          from.id,
          ...(to ? [to.id] : []),
          ...(speaksAudibly
            ? speakers.map((speaker) => `${speaker}${VOICE_HASH_SUFFIX}`)
            : []),
        ]);
        try {
          await writeAssetFromGeneration(projectId, {
            assetId,
            derivedFrom: [from.id, ...(to ? [to.id] : [])],
            generation,
            kind: "video",
            localPath,
            prompt: modelPrompt,
            title: input.title,
            usedIn: [input.id],
          });
        } catch (persistError) {
          // Charged on success above but the asset failed to persist — refund
          // so the user isn't billed for an artifact that never landed.
          if (billing && generation.ok) {
            await refundCredits({
              userId: billing.userId,
              credits: quoteOp(clipOp),
              projectId,
              idempotencyKey: `refund:${clipOp.tool}:${generation.url}`,
              description: "Refund: artifact save failed",
            }).catch(() => {});
          }
          throw persistError;
        }
        await writeWorkspaceFile(
          projectId,
          clipPath,
          withJsonFrontmatter(
            {
              id: input.id,
              type: "clip",
              scene: input.scene,
              index: input.index,
              status: writeState.status,
              url: writeState.active?.url ?? null,
              local_path: writeState.active?.local_path ?? null,
              versions: writeState.versions,
              asset_id: assetId,
              from_keyframe: from.id,
              to_keyframe: to?.id ?? null,
              end_trust: endTrust,
              transition_from_previous: input.transition_from_previous,
              shot_size: input.shot_size,
              cut_motivation: input.cut_motivation,
              camera_move: input.camera_move,
              motion_rate: input.motion_rate,
              aspect_ratio: input.aspect_ratio,
              duration_seconds: generationSeconds,
              generated_seconds: generationSeconds,
              in_timeline: input.add_to_timeline,
              frame_delta: input.frame_delta,
              dialogue: input.dialogue,
              prompt_plan: clipPromptPlan(input),
              built_against: builtAgainst,
            },
            `# ${input.title}\n\n## Start state (as observed)\n\n${input.start_state}\n\n## Action\n\n${input.action_beats.map((beat, i) => `${i + 1}. ${beat}`).join("\n")}\n\n${to ? `## End state (as observed)\n\n${input.end_state}\n\n` : ""}## Prompt\n\n${prompt}\n\n## Media\n\n${writeState.active?.url ?? "Pending or failed generation; inspect operation file."}\n`,
          ),
        );
        // Timeline is derived from clip order; just recompute it now that this
        // clip is active. add_to_timeline is persisted as in_timeline above.
        if (generation.url) await refreshTimeline(projectId);
        await writeOperation(projectId, {
          id: `op_${assetId}`,
          kind: "generate_clip",
          title: input.title,
          prompt: modelPrompt,
          result: generation,
        });
        return withCheck(projectId, {
          clip_id: input.id,
          ok: generation.ok,
          url: generation.url ?? null,
          local_path: localPath,
          end_trust: endTrust,
          error: generation.error ?? null,
        });
      },
    }),
    captureFrame: tool({
      description:
        "Extract a real frame from a rendered clip and register it as a captured keyframe (hosted for reuse as a generation anchor). Default seconds=-0.1 grabs the final frame. If the clip's end was unpinned, the captured final frame becomes its trusted end node.",
      inputSchema: z.object({
        body: z.string().default("").describe("What the captured frame shows."),
        clip_id: z.string().min(1),
        keyframe_id: z.string().min(1),
        seconds: z
          .number()
          .default(-0.1)
          .describe("Timestamp; negative seeks from the end of the clip."),
        title: z.string().min(1),
      }),
      execute: async ({ body, clip_id, keyframe_id, seconds, title }) => {
        const graph = await loadGraph(projectId);
        const clip = graph.clips.get(clip_id);
        if (!clip) throw new Error(`Clip "${clip_id}" does not exist.`);
        if (!clip.url) throw new Error(`Clip "${clip_id}" has no rendered media url.`);
        const frame = await extractVideoFrame({ videoUrl: clip.url, seconds });
        if (!frame.ok) throw new Error(frame.error);
        // The frame lives in OUR storage only (local_path); consumers sign it
        // on demand. No third-party hosting, no expiring url baked into records.
        const keyframePath = `keyframes/${keyframe_id}.md`;
        const existingMeta = await readExistingFrontmatter(projectId, keyframePath);
        const versionState = mediaVersionState(existingMeta);
        const localPath = await writeWorkspaceBinaryFile(
          projectId,
          `media/keyframes/${keyframe_id}.v${versionState.nextVersion}.png`,
          frame.buffer,
        );
        const writeState = mediaVersionWriteState(existingMeta, {
          url: null,
          localPath: localPath.path,
          successStatus: "captured",
          emptyStatus: "planned",
        });
        await writeWorkspaceFile(
          projectId,
          keyframePath,
          withJsonFrontmatter(
            {
              id: keyframe_id,
              type: "keyframe",
              status: "captured",
              url: null,
              local_path: localPath.path,
              versions: writeState.versions,
              aspect_ratio: clip.aspectRatio,
              depicts: [],
              identity_anchors: [],
              state_anchor: null,
              captured_from: clip_id,
            },
            `# ${title}\n\n${body || `Frame captured from ${clip_id} at ${seconds}s.`}\n\n## Media\n\n${localPath.path}\n`,
          ),
        );
        // A final-frame capture from an unpinned clip becomes its trusted end.
        const isEndCapture = seconds < 0;
        if (isEndCapture && !clip.toKeyframe && clip.endTrust === "unknown") {
          const clipContent = await readWorkspaceFile(projectId, clip.path);
          const parsed = parseJsonFrontmatter(clipContent);
          await writeWorkspaceFile(
            projectId,
            clip.path,
            withJsonFrontmatter(
              { ...parsed.meta, to_keyframe: keyframe_id, end_trust: "captured" },
              parsed.body,
            ),
          );
        }
        await writeOperation(projectId, {
          id: `op_capture_${keyframe_id}`,
          kind: "capture_frame",
          title,
          result: { clip_id, seconds, local_path: localPath.path },
        });
        return withCheck(projectId, {
          keyframe_id,
          clip_id,
          local_path: localPath.path,
        });
      },
    }),
    designVoice: tool({
      description:
        "Design a UNIQUE synthetic voice from a text description (ElevenLabs Voice Design) — for casting a character whose voice should be as specific as their look. Returns ~3 preview variants saved as canvas audio tiles; follow up with askUser attaching those tile ids as options so the user LISTENS and picks, then write the winner's voice id into the character's reference.md frontmatter (\"voice\" field) and use it via generateSpeech character_id from then on. For quick casting the premade voice list on generateSpeech is fine — designVoice is for voices that matter.",
      inputSchema: z.object({
        character_id: z
          .string()
          .nullable()
          .default(null)
          .describe("Character reference id this voice is being designed for (names the preview tiles)."),
        preview_text: z
          .string()
          .nullable()
          .default(null)
          .describe("Optional line for the previews to speak — ideally a real line of this character's dialogue. Omitted → auto-generated."),
        voice_description: z
          .string()
          .min(10)
          .describe("The voice itself: gender, age, accent, texture, pace, mood (e.g. 'gravelly middle-aged Spanish football commentator, warm but explosive')."),
      }),
      execute: async ({ character_id, preview_text, voice_description }) => {
        if (!claimGeneration(`voice:${character_id ?? voice_description.slice(0, 24)}`)) {
          return duplicateGenerationError;
        }
        // Voice design bills like TTS: the preview text's characters (×3 previews).
        const designOp: BillableOp = {
          kind: "speech",
          tool: "designVoice",
          characters: (preview_text?.length ?? 150) * 3,
        };
        const denied = await preflightCharge(billing, designOp);
        if (denied) return { error: denied, ok: false };
        const designed = await generateFalVoiceDesign({
          prompt: voice_description,
          text: preview_text,
        });
        if (!designed.ok) return { error: designed.error, ok: false };
        await settleCharge(billing, designOp, projectId);
        const characterSlug = (character_id ?? "voice").replace(/^@/, "").slice(0, 32);
        const stamp = Date.now().toString(36);
        const previewTiles: Array<{ tile_id: string; voice_id: string }> = [];
        for (const [index, preview] of designed.previews.slice(0, 3).entries()) {
          let bytes: Buffer | null = null;
          if (preview.url) {
            const download = await fetch(preview.url).catch(() => null);
            if (download?.ok) bytes = Buffer.from(await download.arrayBuffer());
          } else if (preview.audioBase64) {
            bytes = Buffer.from(preview.audioBase64, "base64");
          }
          if (!bytes) continue;
          const tileId = `voice_${characterSlug}_${stamp}_${index + 1}`;
          const localPath = `media/uploads/${tileId}.mp3`;
          await writeWorkspaceBinaryFile(projectId, localPath, bytes);
          await writeWorkspaceFile(
            projectId,
            `uploads/${tileId}.md`,
            withJsonFrontmatter(
              {
                canvas_composed: true,
                id: tileId,
                kind: "audio",
                local_path: localPath,
                status: "active",
                type: "upload",
                voice_id: preview.voiceId,
              },
              `# Voice option ${index + 1}${character_id ? ` — @${character_id.replace(/^@/, "")}` : ""}\n\nDesigned voice preview.\n\n> ${voice_description.slice(0, 300)}\n`,
            ),
          );
          previewTiles.push({ tile_id: tileId, voice_id: preview.voiceId });
        }
        if (!previewTiles.length) {
          return { error: "Voice previews could not be saved.", ok: false };
        }
        return {
          ok: true,
          previews: previewTiles,
          note: "Now askUser with ONE question whose options attach these tile ids as asset_id (the user hover-plays them). When they pick, write that option's voice_id into the character reference frontmatter as \"voice\" and confirm the casting.",
        };
      },
    }),
    generateSpeech: tool({
      description:
        "Generate spoken audio (ElevenLabs TTS). Pass character_id to speak in that character's cast voice (the reference's `voice` frontmatter); otherwise pass a voice name. The result lands on the canvas as an audio tile and can be placed in the editor with addAudioToTimeline.",
      inputSchema: z.object({
        character_id: z
          .string()
          .nullable()
          .default(null)
          .describe("Character reference id — uses that character's cast voice."),
        text: z.string().min(1).describe("Exactly what should be spoken."),
        title: z.string().min(1).describe("Short human title for the audio tile."),
        voice: z
          .string()
          .nullable()
          .default(null)
          .describe(`Voice name override. Available: ${ELEVENLABS_VOICES.join(", ")}.`),
      }),
      execute: async ({ character_id, text, title, voice }) => {
        let resolvedVoice = voice;
        if (character_id) {
          try {
            const raw = await readWorkspaceFile(
              projectId,
              `references/characters/${character_id.replace(/^@/, "")}/reference.md`,
            );
            const meta = parseJsonFrontmatter(raw).meta;
            if (typeof meta.voice === "string" && meta.voice) resolvedVoice = meta.voice;
          } catch {
            /* character without a record — fall through to explicit/default voice */
          }
        }
        const speechOp: BillableOp = {
          kind: "speech",
          tool: "generateSpeech",
          characters: text.length,
        };
        const denied = await preflightCharge(billing, speechOp);
        if (denied) return { error: denied, ok: false };
        const generated = await generateFalSpeech({ text, voice: resolvedVoice ?? undefined });
        if (!generated.ok || !generated.url) {
          return { error: generated.error || "Speech generation failed.", ok: false };
        }
        await settleCharge(billing, speechOp, projectId, { title, url: generated.url });
        const audioId = `speech_${title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "audio"}_${Date.now().toString(36)}`;
        const download = await fetch(generated.url);
        if (!download.ok) return { error: "Failed to download generated audio.", ok: false };
        const localPath = `media/uploads/${audioId}.mp3`;
        await writeWorkspaceBinaryFile(projectId, localPath, Buffer.from(await download.arrayBuffer()));
        await writeWorkspaceFile(
          projectId,
          `uploads/${audioId}.md`,
          withJsonFrontmatter(
            {
              canvas_composed: true,
              id: audioId,
              kind: "audio",
              local_path: localPath,
              status: "active",
              type: "upload",
              voice: resolvedVoice ?? null,
            },
            `# ${title}\n\nGenerated speech${resolvedVoice ? ` (voice: ${resolvedVoice})` : ""}${character_id ? ` for @${character_id.replace(/^@/, "")}` : ""}.\n\n> ${text.slice(0, 400)}\n`,
          ),
        );
        return {
          id: audioId,
          ok: true,
          voice: resolvedVoice ?? "default",
          note: `Audio tile "${audioId}" is on the canvas — place it with addAudioToTimeline.`,
        };
      },
    }),
    generateMusic: tool({
      description:
        "Generate music (ElevenLabs) from a text brief; the result lands on the canvas as an audio tile and can be placed with addAudioToTimeline.",
      inputSchema: z.object({
        duration_seconds: z.number().min(5).max(120).nullable().default(null),
        prompt: z.string().min(1).describe("Genre, mood, instrumentation, tempo."),
        title: z.string().min(1).describe("Short human title for the audio tile."),
      }),
      execute: async ({ duration_seconds, prompt, title }) => {
        const musicOp: BillableOp = {
          kind: "music",
          tool: "generateMusic",
          seconds: duration_seconds ?? 30,
        };
        const denied = await preflightCharge(billing, musicOp);
        if (denied) return { error: denied, ok: false };
        const generated = await generateFalMusic({
          durationSeconds: duration_seconds ?? undefined,
          prompt,
        });
        if (!generated.ok || !generated.url) {
          return { error: generated.error || "Music generation failed.", ok: false };
        }
        await settleCharge(billing, musicOp, projectId, { title, url: generated.url });
        const audioId = `music_${title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "audio"}_${Date.now().toString(36)}`;
        const download = await fetch(generated.url);
        if (!download.ok) return { error: "Failed to download generated audio.", ok: false };
        const localPath = `media/uploads/${audioId}.mp3`;
        await writeWorkspaceBinaryFile(projectId, localPath, Buffer.from(await download.arrayBuffer()));
        await writeWorkspaceFile(
          projectId,
          `uploads/${audioId}.md`,
          withJsonFrontmatter(
            {
              canvas_composed: true,
              id: audioId,
              kind: "audio",
              local_path: localPath,
              status: "active",
              type: "upload",
            },
            `# ${title}\n\nGenerated music.\n\n> ${prompt.slice(0, 400)}\n`,
          ),
        );
        return {
          id: audioId,
          ok: true,
          note: `Audio tile "${audioId}" is on the canvas — place it with addAudioToTimeline.`,
        };
      },
    }),
    organizeCanvas: tool({
      description:
        "Organize canvas tiles into named groups (rows) so the canvas stays tidy — run this after a burst of generation leaves several ungrouped tiles, or when the user asks to organize. Loose tiles are grouped; tiles already assigned to the SAME group are re-placed into its row (fixes strays the user reports); tiles in an agent-made group can be moved to a new group. SAFETY: tiles in a USER-made group are never touched — skipped and reported. Group semantically (cast portfolios, storyboard beats, generated clips), reusing an existing group title when tiles belong with it. This is the ONLY lever for canvas layout — never write canvas/groups.json yourself; it mirrors the user's client-side state and your edits get overwritten.",
      inputSchema: z.object({
        groups: z
          .array(
            z.object({
              layout: z
                .enum(["row", "grid"])
                .default("row")
                .describe("Row for sequences (storyboards, clips in order); grid for large unordered sets (reference photos, variations)."),
              tile_ids: z
                .array(z.string().min(1))
                .min(1)
                .describe("Loose tile ids to gather into this group, in display order."),
              title: z.string().min(1).describe("Human group title (e.g. 'Cast portfolios')."),
            }),
          )
          .min(1)
          .max(12),
      }),
      execute: async ({ groups }) => {
        // Membership in a user-made group is the user's hand organization —
        // inviolable without their say-so.
        const userGrouped = new Set<string>();
        try {
          const rawGroups = await readWorkspaceFile(projectId, "canvas/groups.json");
          const parsedGroups = JSON.parse(rawGroups) as { groups?: Array<{ cardIds?: string[] }> };
          for (const group of parsedGroups.groups ?? []) {
            for (const cardId of group.cardIds ?? []) userGrouped.add(cardId);
          }
        } catch {
          /* no user groups file */
        }
        const tileDirs = ["keyframes", "clips", "uploads"] as const;
        const allFiles = await listProjectFiles(projectId, true);
        const groupMaxIndex = new Map<string, number>();
        for (const file of allFiles) {
          if (!/^(keyframes|clips|uploads)\/[^/]+\.md$/.test(file.path) || !file.content) continue;
          try {
            const meta = parseJsonFrontmatter(file.content).meta;
            if (typeof meta.canvas_group === "string" && meta.canvas_group) {
              const current = groupMaxIndex.get(meta.canvas_group) ?? -1;
              const index = typeof meta.canvas_group_index === "number" ? meta.canvas_group_index : 0;
              groupMaxIndex.set(meta.canvas_group, Math.max(current, index));
            }
          } catch {
            /* unparsable record */
          }
        }
        const organized: Array<{ group: string; id: string }> = [];
        const skipped: Array<{ id: string; reason: string }> = [];
        for (const group of groups) {
          const groupId = group.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "");
          if (!groupId) continue;
          // Append after any existing members instead of colliding with them.
          let nextIndex = (groupMaxIndex.get(groupId) ?? -1) + 1;
          for (const rawId of group.tile_ids) {
            const tileId = rawId.replace(/^@/, "");
            if (userGrouped.has(tileId)) {
              skipped.push({ id: tileId, reason: "in a user-made group — ask before regrouping" });
              continue;
            }
            let recordPath: string | null = null;
            let raw: string | null = null;
            for (const dir of tileDirs) {
              try {
                raw = await readWorkspaceFile(projectId, `${dir}/${tileId}.md`);
                recordPath = `${dir}/${tileId}.md`;
                break;
              } catch {
                /* try next dir */
              }
            }
            if (!recordPath || raw === null) {
              skipped.push({ id: tileId, reason: "no tile record found" });
              continue;
            }
            const parsed = parseJsonFrontmatter(raw);
            const currentGroup =
              typeof parsed.meta.canvas_group === "string" ? parsed.meta.canvas_group : null;
            if (currentGroup === groupId) {
              // Restate membership: bump the organize stamp so the client
              // re-places the tile into the group row even if the user's
              // canvas had it floating elsewhere.
              await writeWorkspaceFile(
                projectId,
                recordPath,
                withJsonFrontmatter(
                  {
                    ...parsed.meta,
                    canvas_group_layout: group.layout,
                    canvas_group_organized_at: new Date().toISOString(),
                  },
                  parsed.body,
                ),
              );
              organized.push({ group: groupId, id: tileId });
              continue;
            }
            await writeWorkspaceFile(
              projectId,
              recordPath,
              withJsonFrontmatter(
                {
                  ...parsed.meta,
                  canvas_group: groupId,
                  canvas_group_index: nextIndex,
                  canvas_group_layout: group.layout,
                  canvas_group_organized_at: new Date().toISOString(),
                  canvas_group_title: group.title,
                },
                parsed.body,
              ),
            );
            organized.push({ group: groupId, id: tileId });
            nextIndex += 1;
          }
          groupMaxIndex.set(groupId, nextIndex - 1);
        }
        return withCheck(projectId, {
          ok: true,
          organized,
          skipped,
        });
      },
    }),
    generateImage: tool({
      description:
        "Image generation AND editing/compositing. Pass source_ids (keyframe ids, upload ids, reference ids) to condition on their PIXELS — this is how you edit a frame or composite a specific asset (logo, ticket, product, character) into it: pass the frame AND the asset, describe the merge. The result is a canvas tile and a valid start frame for generateVideoFromImage. In PRODUCTION MODE use generateKeyframe for pipeline keyframes instead.",
      inputSchema: z.object({
        aspect_ratio: z
          .enum(ASPECT_RATIOS)
          .default("16:9")
          .describe("Only 16:9 (landscape), 9:16 (vertical), or 1:1 (square). Use ONE ratio for the whole video."),
        asset_id: z.string().min(1),
        image_urls: z.array(z.string()).default([]).describe("External image URLs only."),
        prompt: z.string().min(1),
        revises: z
          .string()
          .nullable()
          .default(null)
          .describe("Existing tile id to REDO: appends a new version to that tile (same id, same canvas position) instead of creating a sibling tile. ONLY for re-attempting the SAME creative intent (redo/fix/try-again of this exact artifact). NEVER for new content the user wants to keep alongside — another shot, a sequel, a continuation, a variation — those get a NEW tile even when an existing tile is focused; the focused tile is context, not the revision target."),
        source_ids: z
          .array(z.string())
          .default([])
          .describe("Workspace ids to condition on: keyframes, uploads, references."),
        title: z.string().min(1),
      }),
      execute: async ({ aspect_ratio, asset_id, image_urls, prompt, revises, source_ids, title }) => {
        if (!claimGeneration(`image:${revises ?? asset_id}`)) return duplicateGenerationError;
        // External URLs must be actual image files — article/landing pages
        // reach fal as HTML and fail the whole generation with a vague 422.
        for (const url of image_urls) {
          try {
            const head = await fetch(url, { method: "HEAD", redirect: "follow" });
            const contentType = head.headers.get("content-type") ?? "";
            if (head.ok && contentType && !contentType.startsWith("image/")) {
              return {
                error: `"${url}" is not an image file (content-type ${contentType}) — it looks like a landing/article PAGE. Use saveImageToCanvas with the direct image url (searchImages' image_url field), then pass the saved tile id in source_ids.`,
                ok: false,
              };
            }
          } catch {
            /* HEAD unsupported/unreachable — let fal try */
          }
        }
        if (!spendGeneration()) return generationBudgetError;
        const conditioningUrls: string[] = [...image_urls];
        if (source_ids.length) {
          const graph = await loadGraph(projectId);
          for (const rawId of source_ids) {
            const sourceId = rawId.replace(/^@/, "");
            const portfolio = graph.portfolioByReference.get(sourceId);
            const keyframe = graph.keyframes.get(sourceId);
            const keyframeLocal = keyframe?.versions?.length
              ? keyframe.versions[keyframe.versions.length - 1]?.localPath ?? null
              : null;
            let media: string | null = portfolio?.urls?.[0] ?? keyframe?.url ?? keyframeLocal;
            if (!media) {
              try {
                const raw = await readWorkspaceFile(projectId, `uploads/${sourceId}.md`);
                const parsed = parseJsonFrontmatter(raw);
                media =
                  typeof parsed.meta.local_path === "string" && parsed.meta.local_path
                    ? parsed.meta.local_path
                    : typeof parsed.meta.url === "string"
                      ? parsed.meta.url
                      : null;
              } catch {
                /* not an upload either */
              }
            }
            if (!media) {
              return { error: `"${sourceId}" has no usable image media.`, ok: false };
            }
            const hosted = await fetchableUrlForWorkspaceMedia(projectId, media, sourceId);
            if (!hosted.ok) return { error: hosted.error, ok: false };
            conditioningUrls.push(hosted.url);
          }
        }
        await writeWorkspaceFile(projectId, `prompts/${asset_id}.prompt.md`, `# ${title}\n\n${prompt}\n`);
        const imageOp: BillableOp = { kind: "image", tool: "generateImage", resolution: "1K" };
        const imageDenied = await preflightCharge(billing, imageOp);
        if (imageDenied) return { error: imageDenied };
        const generation = await generateFalImage({
          prompt,
          imageUrls: conditioningUrls,
          aspectRatio: aspect_ratio,
        });
        if (generation.ok) await settleCharge(billing, imageOp, projectId, { title, url: generation.url });
        await writeAssetFromGeneration(projectId, {
          assetId: asset_id,
          generation,
          kind: "image",
          prompt,
          title,
        });
        await writeOperation(projectId, {
          id: `op_${asset_id}`,
          kind: "generate_image",
          title,
          prompt,
          result: generation,
        });
        if (generation.ok && generation.url && revises) {
          const revision = await appendArtifactVersion(projectId, {
            exactAspect: aspect_ratio,
            id: revises.replace(/^@/, ""),
            kind: "keyframe",
            note: `Image revision.\n\nPrompt: ${prompt}\n\nSources: ${source_ids.map((r) => `@${r.replace(/^@/, "")}`).join(", ") || "(none)"}`,
            url: generation.url,
          });
          if (!revision.ok) return revision;
          return withCheck(projectId, {
            canvas_keyframe_id: revises.replace(/^@/, ""),
            note: `Tile "${revises.replace(/^@/, "")}" updated in place to version ${revision.version}.`,
            ok: true,
            url: generation.url,
            version: revision.version,
          });
        }
        // Canvas-first: every generated image is a visible canvas tile, not
        // just an asset record buried in the tree. The stored copy is
        // center-cropped to the EXACT aspect — image models' "16:9" is often
        // approximate, and an off-ratio frame used as a pinned video endpoint
        // makes the clip drift through a subtle squeeze.
        let canvasTileOk = false;
        if (generation.ok && generation.url) {
          let localPath: string | null = null;
          try {
            const download = await fetch(generation.url);
            if (download.ok) {
              const exact = await cropImageToAspect(
                Buffer.from(await download.arrayBuffer()),
                aspect_ratio,
              );
              localPath = `media/keyframes/${asset_id}_tile.v1.png`;
              await writeWorkspaceBinaryFile(projectId, localPath, exact);
            }
          } catch {
            localPath = null;
          }
          await writeWorkspaceFile(
            projectId,
            `keyframes/${asset_id}_tile.md`,
            withJsonFrontmatter(
              {
                aspect_ratio,
                asset_id,
                canvas_composed: true,
                id: `${asset_id}_tile`,
                status: "generated",
                type: "keyframe",
                ...(localPath
                  ? {
                      local_path: localPath,
                      source_url: generation.url,
                      versions: [{ local_path: localPath, url: null, version: 1 }],
                    }
                  : { url: generation.url }),
              },
              `# ${title}\n\n## Prompt\n\n${prompt}\n\n## Media\n\n${generation.url}\n`,
            ),
          );
          canvasTileOk = true;
        }
        return withCheck(projectId, {
          asset_id,
          canvas_keyframe_id: canvasTileOk ? `${asset_id}_tile` : null,
          note: canvasTileOk
            ? `Canvas tile written — use "${asset_id}_tile" as start_image_id/end_image_id/source_ids.`
            : generation.ok
              ? "WARNING: canvas tile write failed — the image exists at the url but has no keyframe record; do not pass its id as a video endpoint."
              : null,
          ok: generation.ok,
          url: generation.url ?? null,
          error: generation.error ?? null,
        });
      },
    }),
    updatePlan: tool({
      description:
        "Create or update the project plan — the ordered steps you are following, with EXACTLY ONE step active at a time (the cursor). Call this: (a) when starting any multi-step piece of work, (b) BEFORE executing a step (mark it active), (c) the moment a step finishes (mark it done, activate the next), and (d) whenever you deviate — changing the plan is always allowed and takes one call, but it must be recorded, never silent. Full-replacement: send the complete step list each time.",
      inputSchema: z.object({
        steps: z
          .array(
            z.object({
              id: z.string().min(1),
              note: z.string().nullable().default(null).describe("Optional: why this step changed/dropped."),
              status: z.enum(["pending", "active", "done", "dropped"]),
              title: z.string().min(1).describe("Short human step description."),
            }),
          )
          .min(1)
          .max(20),
        title: z
          .string()
          .nullable()
          .default(null)
          .describe("Short name for the whole plan (e.g. 'Desert Thunder — 14-shot parody'). Keep it stable across updates of the same plan."),
      }),
      execute: async ({ steps, title }) => {
        const active = steps.filter((step) => step.status === "active");
        if (active.length > 1) {
          return {
            error: `Exactly one step may be active (got ${active.length}). The cursor is a single pointer.`,
            ok: false,
          };
        }
        const existingSteps = await readPlanSteps(projectId);
        if (existingSteps.length >= 2) {
          const incomingIds = new Set(steps.map((step) => step.id));
          const overlap = existingSteps.filter((step) => incomingIds.has(step.id)).length;
          if (overlap / existingSteps.length < 0.5) {
            let existingTitle: string | null = null;
            try {
              const rawPlan = await readWorkspaceFile(projectId, PLAN_PATH);
              const meta = parseJsonFrontmatter(rawPlan).meta;
              existingTitle = typeof meta.title === "string" ? meta.title : null;
            } catch {
              /* no previous plan file */
            }
            const stamp = new Date().toISOString();
            await writeWorkspaceFile(
              projectId,
              `plan/history/plan_${stamp.replace(/[:.]/g, "-")}.md`,
              withJsonFrontmatter(
                {
                  archived_at: stamp,
                  steps: existingSteps,
                  title: existingTitle,
                  type: "plan_archive",
                },
                `# ${existingTitle ?? "Plan"} (archived ${stamp.slice(0, 16).replace("T", " ")})\n`,
              ),
            ).catch(() => {});
          }
        }
        await writeWorkspaceFile(
          projectId,
          PLAN_PATH,
          withJsonFrontmatter(
            { steps, title, type: "plan", updated_at: new Date().toISOString() },
            `# Plan\n\n${steps
              .map(
                (step) =>
                  `- [${step.status === "done" ? "x" : " "}] ${step.title}${step.status === "active" ? " ← now" : step.status === "dropped" ? " (dropped)" : ""}`,
              )
              .join("\n")}\n`,
          ),
        );
        return {
          cursor: planCursorLine(steps as PlanStep[]),
          ok: true,
          steps: steps.length,
        };
      },
    }),
    askUser: tool({
      description:
        "Ask the user one or more questions and WAIT for their answer — the run pauses until they respond (or 15 minutes pass). Use when a decision genuinely needs their taste or intent (which take to keep, which direction to explore, ambiguous scope) instead of assuming. Options can attach a workspace asset (asset_id of a tile) to show side-by-side visual choices. Set allow_upload to ask the user to PROVIDE material (photos of a person, a style frame, a logo) — their files land as canvas upload tiles and the answer carries uploaded_ids you can use directly (conditioning_image_ids, source_ids, style_image_ids). Do not ask what you can determine from the project yourself. Keep each question minimal: default to a plain text question or simple text options. Only set allow_upload=true when the answer literally requires a file FROM the user (their photo, their logo, their style frame) — never on a plain preference or choice question. Only give an option an asset_id when that option IS a visual choice backed by a real image tile that already exists on the canvas — never attach asset_id to abstract text choices. When unsure, ask plainly: no uploads, no images.",
      inputSchema: z.object({
        questions: z
          .array(
            z.object({
              allow_custom: z
                .boolean()
                .default(true)
                .describe("Offer a free-text 'type something else' field."),
              allow_upload: z
                .boolean()
                .default(false)
                .describe("Ask the user to upload file(s) as (part of) their answer — e.g. 'upload 1-2 photos of the subject'. Uploads become canvas tiles; their ids arrive in the answer's uploaded_ids."),
              multi_select: z
                .boolean()
                .default(false)
                .describe("Allow choosing several options (answers arrive as an array)."),
              options: z
                .array(
                  z.object({
                    asset_id: z
                      .string()
                      .nullable()
                      .default(null)
                      .describe("Optional tile id (image/clip/audio) shown as a hoverable preview card."),
                    label: z.string().min(1),
                  }),
                )
                .max(6)
                .default([])
                .describe("2-6 choices for a pick-one/pick-many question. May be EMPTY when the question only asks for an upload or free text."),
              question: z.string().min(1),
            }),
          )
          .min(1)
          .max(6),
      }),
      execute: async ({ questions }, { toolCallId }) => {
        const answer = await waitForUserAnswer(projectId, toolCallId);
        if ("timed_out" in answer) {
          return {
            note: "The user did not answer within 15 minutes. Proceed with your best judgment and say what you assumed.",
            ok: false,
            timed_out: true,
          };
        }
        if (answer.dismissed) {
          return {
            note: "The user chose 'figure it out' — decide yourself and state your choice plainly.",
            ok: true,
            user_delegated: true,
          };
        }
        return { answers: answer.answers, ok: true, questions_asked: questions.length };
      },
    }),
    saveImageToCanvas: tool({
      description:
        "Save an image from the internet (or any direct image URL) into the project as a canvas tile. REQUIRED before using an internet image as a generation reference: the user sees exactly what was chosen, it gets provenance (source_url), and generations condition on our stored copy instead of a flaky external link. Pass the DIRECT image file URL (searchImages' image_url field) — landing/article page URLs are rejected.",
      inputSchema: z.object({
        image_url: z.string().url().describe("Direct image file URL (from searchImages image_url — NEVER landing_url)."),
        title: z.string().min(1).describe("Short human title for the tile."),
      }),
      execute: async ({ image_url, title }) => {
        const imported = await importWebImageToCanvas(projectId, image_url, title);
        if (!imported.ok) return imported;
        return {
          id: imported.id,
          note: `Saved to the canvas — use "${imported.id}" in source_ids/reference_ids/conditioning_image_ids.`,
          ok: true,
          path: `uploads/${imported.id}.md`,
        };
      },
    }),
    traceLineage: tool({
      description:
        "Trace a canvas artifact's provenance DAG: ancestors (what it was derived from — source uploads, frames, references it depicts), descendants (what was made from it), and canvas-group siblings. Use before building on, continuing, or modifying anything whose history matters, and to find everything affected by a reference change.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const files = await listProjectFiles(projectId, true);
        const index = buildLineageIndex(files);
        const trace = traceLineage(index, id.replace(/^@/, ""));
        return trace ?? { error: `Unknown id "${id}".`, ok: false };
      },
    }),
    generateVideoFromImage: tool({
      description:
        "TRUE image-to-video (Seedance i2v): animate forward FROM a specific image — the video's first frame IS that image, pixel-locked. Use this whenever the user says to continue/extend/animate from an image, a captured frame, or a clip's end frame. Optionally pass end_image_id to ALSO pin the final frame (first/last interpolation) — the way to make something APPEAR during the shot: start = untouched anchor frame, end = a composited target frame containing the asset. Do NOT substitute generateVideoFromReferences (that conditions loosely on subjects and will not start on the exact image). Result is a canvas clip tile.",
      inputSchema: z.object({
        aspect_ratio: z.enum(ASPECT_RATIOS).default("16:9"),
        duration_seconds: z
          .number()
          .min(4)
          .max(15)
          .default(5)
          .describe("Whole seconds, MINIMUM 4, maximum 15 (hard model constraint — values under 4 are invalid and will be rejected). If the user asks for a shorter beat, generate 4-5s and trim in the editor."),
        group_id: z.string().nullable().default(null),
        group_index: z.number().int().min(0).default(0),
        group_title: z.string().nullable().default(null),
        prompt: z.string().min(1).describe("Motion + visual description of the clip."),
        end_image_id: z
          .string()
          .nullable()
          .default(null)
          .describe("Optional keyframe id to pin as the FINAL frame (first/last interpolation)."),
        revises: z
          .string()
          .nullable()
          .default(null)
          .describe("Existing tile id to REDO: appends a new version to that tile (same id, same canvas position) instead of creating a sibling tile. ONLY for re-attempting the SAME creative intent (redo/fix/try-again of this exact artifact). NEVER for new content the user wants to keep alongside — another shot, a sequel, a continuation, a variation — those get a NEW tile even when an existing tile is focused; the focused tile is context, not the revision target."),
        start_image_id: z
          .string()
          .describe("Keyframe id (captured frame, generated image) to start from."),
        title: z.string().min(1),
      }),
      execute: async ({
        aspect_ratio,
        duration_seconds,
        end_image_id,
        group_id,
        group_index,
        group_title,
        prompt,
        revises,
        start_image_id,
        title,
      }) => {
        if (!claimGeneration(`i2v:${revises ?? title}`)) return duplicateGenerationError;
        if (!spendGeneration()) return generationBudgetError;
        try {
          const graph = await loadGraph(projectId);
          const media = await keyframeMediaById(projectId, graph, start_image_id);
          if (!media) {
            return {
              error: `"${start_image_id}" has no image media to start from.`,
              ok: false,
            };
          }
          const hosted = await fetchableUrlForWorkspaceMedia(projectId, media, start_image_id);
          if (!hosted.ok) return { error: hosted.error, ok: false };
          const imageUrl = hosted.url;
          let endImageUrl: string | null = null;
          if (end_image_id) {
            const endId = end_image_id.replace(/^@/, "");
            const endMedia = await keyframeMediaById(projectId, graph, endId);
            if (!endMedia) {
              return { error: `"${end_image_id}" has no image media for the end frame.`, ok: false };
            }
            const endHosted = await fetchableUrlForWorkspaceMedia(projectId, endMedia, endId);
            if (!endHosted.ok) return { error: endHosted.error, ok: false };
            endImageUrl = endHosted.url;
          }
          const i2vOp: BillableOp = {
            kind: "clip",
            tool: "generateVideoFromImage",
            pinned: Boolean(endImageUrl),
            resolution: "720p",
            seconds: Math.round(duration_seconds),
          };
          const i2vDenied = await preflightCharge(billing, i2vOp);
          if (i2vDenied) return { error: i2vDenied, ok: false };
          const generated = await generateFalVideo({
            aspectRatio: aspect_ratio,
            duration: String(Math.round(duration_seconds)),
            endImageUrl,
            imageUrl,
            prompt,
          });
          if (!generated.ok || !generated.url) {
            return { error: generated.error || "Image-to-video failed.", ok: false };
          }
          await settleCharge(billing, i2vOp, projectId, { title, url: generated.url });
          if (revises) {
            const revision = await appendArtifactVersion(projectId, {
              id: revises.replace(/^@/, ""),
              kind: "clip",
              metaPatch: {
                duration_seconds: Math.round(duration_seconds),
                generated_seconds: Math.round(duration_seconds),
              },
              note: `Image-to-video revision.\n\nPrompt: ${prompt}\n\nStart: @${start_image_id.replace(/^@/, "")}${end_image_id ? ` · End: @${end_image_id.replace(/^@/, "")}` : ""}`,
              url: generated.url,
            });
            if (!revision.ok) return revision;
            return {
              clip_id: revises.replace(/^@/, ""),
              ok: true,
              path: revision.path,
              url: generated.url,
              version: revision.version,
            };
          }
          const clipId = `canvas_${title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 42)}_${Date.now().toString(36)}`;
          const localPath = `media/clips/${clipId}.v1.mp4`;
          const download = await fetch(generated.url);
          if (!download.ok) return { error: "Failed to download generated video.", ok: false };
          await writeWorkspaceBinaryFile(
            projectId,
            localPath,
            Buffer.from(await download.arrayBuffer()),
          );
          await writeWorkspaceFile(
            projectId,
            `clips/${clipId}.md`,
            withJsonFrontmatter(
              {
                aspect_ratio,
                canvas_composed: true,
                canvas_derived_from: start_image_id.replace(/^@/, ""),
                canvas_group: group_id,
                canvas_group_index: group_index,
                canvas_group_title: group_title ?? group_id,
                duration_seconds: Math.round(duration_seconds),
                generated_seconds: Math.round(duration_seconds),
                id: clipId,
                in_timeline: false,
                index: Date.now(),
                local_path: localPath,
                status: "active",
                type: "clip",
                url: generated.url,
                versions: [{ local_path: localPath, url: generated.url, version: 1 }],
              },
              `# ${title}\n\n## Prompt\n\n${prompt}\n\n## Start frame\n\n@${start_image_id.replace(/^@/, "")}\n`,
            ),
          );
          return {
            clip_id: clipId,
            ok: true,
            path: `clips/${clipId}.md`,
            plan_cursor: planCursorLine(await readPlanSteps(projectId)),
            url: generated.url,
          };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : "Image-to-video failed.",
            ok: false,
          };
        }
      },
    }),
    generateVideoFromReferences: tool({
      description:
        "Generate a video DIRECTLY from reference images (Seedance reference-to-video): pass 1-4 reference ids (their portfolio images are used) and/or keyframe ids, and the subjects appear in the generated video — no keyframe chain or review gate. The result is a canvas clip tile (not in the timeline). Prefer this for quick canvas work; use the keyframe pipeline only for precision continuity chains.",
      inputSchema: z.object({
        aspect_ratio: z.enum(ASPECT_RATIOS).default("16:9"),
        duration_seconds: z
          .number()
          .min(4)
          .max(15)
          .default(5)
          .describe("Whole seconds, MINIMUM 4, maximum 15 (hard model constraint — values under 4 are invalid and will be rejected). If the user asks for a shorter beat, generate 4-5s and trim in the editor."),
        group_id: z
          .string()
          .nullable()
          .default(null)
          .describe("Optional canvas group slug — tiles sharing it lay out as a row."),
        group_index: z.number().int().min(0).default(0),
        group_title: z.string().nullable().default(null),
        prompt: z.string().min(1),
        reference_ids: z
          .array(z.string())
          .min(1)
          .max(4)
          .describe("Reference ids and/or keyframe ids to condition on."),
        revises: z
          .string()
          .nullable()
          .default(null)
          .describe("Existing tile id to REDO: appends a new version to that tile (same id, same canvas position) instead of creating a sibling tile. ONLY for re-attempting the SAME creative intent (redo/fix/try-again of this exact artifact). NEVER for new content the user wants to keep alongside — another shot, a sequel, a continuation, a variation — those get a NEW tile even when an existing tile is focused; the focused tile is context, not the revision target."),
        title: z.string().min(1),
      }),
      execute: async ({
        aspect_ratio,
        duration_seconds,
        group_id,
        group_index,
        group_title,
        prompt,
        reference_ids,
        revises,
        title,
      }) => {
        if (!claimGeneration(`refvideo:${revises ?? title}`)) return duplicateGenerationError;
        if (!spendGeneration()) return generationBudgetError;
        try {
          const graph = await loadGraph(projectId);
          const referenceImageUrls: string[] = [];
          const referenceVideoUrls: string[] = [];
          for (const rawRef of reference_ids) {
            const refId = rawRef.replace(/^@/, "");
            let clipMedia: string | null = null;
            try {
              const clipRaw = await readWorkspaceFile(projectId, `clips/${refId}.md`);
              const clipMeta = parseJsonFrontmatter(clipRaw).meta;
              clipMedia =
                typeof clipMeta.local_path === "string" && clipMeta.local_path
                  ? clipMeta.local_path
                  : typeof clipMeta.url === "string"
                    ? clipMeta.url
                    : null;
            } catch {
              /* not a clip */
            }
            if (clipMedia) {
              const hosted = await fetchableUrlForWorkspaceMedia(projectId, clipMedia, refId);
              if (!hosted.ok) return { error: hosted.error, ok: false };
              referenceVideoUrls.push(hosted.url);
              continue;
            }
            const portfolio = graph.portfolioByReference.get(refId);
            const media =
              portfolio?.urls?.[0] ?? (await tileImageMediaById(projectId, graph, refId));
            if (!media) {
              return {
                error: `"${refId}" has no usable media (not a clip, portfolio, keyframe, or upload).`,
                ok: false,
              };
            }
            if (/^https?:\/\//i.test(media)) {
              referenceImageUrls.push(media);
            } else {
              const hosted = await fetchableUrlForWorkspaceMedia(projectId, media, refId);
              if (!hosted.ok) return { error: hosted.error, ok: false };
              referenceImageUrls.push(hosted.url);
            }
          }
          if (referenceVideoUrls.length > 3) {
            return { error: "At most 3 clip (video) references are supported.", ok: false };
          }
          const r2vOp: BillableOp = {
            kind: "clip",
            tool: "generateVideoFromReferences",
            pinned: true, // reference-to-video runs the standard tier
            resolution: "720p",
            seconds: Math.round(duration_seconds),
          };
          const r2vDenied = await preflightCharge(billing, r2vOp);
          if (r2vDenied) return { error: r2vDenied, ok: false };
          const generated = await generateFalReferenceVideo({
            aspectRatio: aspect_ratio,
            duration: String(Math.round(duration_seconds)),
            prompt,
            referenceImageUrls,
            referenceVideoUrls,
          });
          if (!generated.ok || !generated.url) {
            return { error: generated.error || "Reference-to-video failed.", ok: false };
          }
          await settleCharge(billing, r2vOp, projectId, { title, url: generated.url });
          if (revises) {
            const revision = await appendArtifactVersion(projectId, {
              id: revises.replace(/^@/, ""),
              kind: "clip",
              metaPatch: {
                duration_seconds: Math.round(duration_seconds),
                generated_seconds: Math.round(duration_seconds),
              },
              note: `Reference-to-video revision.\n\nPrompt: ${prompt}\n\nReferences: ${reference_ids.map((r) => `@${r.replace(/^@/, "")}`).join(", ")}`,
              url: generated.url,
            });
            if (!revision.ok) return revision;
            return {
              clip_id: revises.replace(/^@/, ""),
              ok: true,
              path: revision.path,
              url: generated.url,
              version: revision.version,
            };
          }
          const clipId = `canvas_${title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 42)}_${Date.now().toString(36)}`;
          const localPath = `media/clips/${clipId}.v1.mp4`;
          const download = await fetch(generated.url);
          if (!download.ok) return { error: "Failed to download generated video.", ok: false };
          await writeWorkspaceBinaryFile(
            projectId,
            localPath,
            Buffer.from(await download.arrayBuffer()),
          );
          await writeWorkspaceFile(
            projectId,
            `clips/${clipId}.md`,
            withJsonFrontmatter(
              {
                aspect_ratio,
                canvas_composed: true,
                canvas_group: group_id,
                canvas_group_index: group_index,
                canvas_group_title: group_title ?? group_id,
                depicts: reference_ids,
                duration_seconds: Math.round(duration_seconds),
                generated_seconds: Math.round(duration_seconds),
                id: clipId,
                in_timeline: false,
                index: Date.now(),
                local_path: localPath,
                status: "active",
                type: "clip",
                url: generated.url,
                versions: [{ local_path: localPath, url: generated.url, version: 1 }],
              },
              `# ${title}\n\n## Prompt\n\n${prompt}\n\n## References\n\n${reference_ids.map((r) => `@${r}`).join(", ")}\n`,
            ),
          );
          return {
            clip_id: clipId,
            ok: true,
            path: `clips/${clipId}.md`,
            plan_cursor: planCursorLine(await readPlanSteps(projectId)),
            url: generated.url,
          };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : "Reference-to-video failed.",
            ok: false,
          };
        }
      },
    }),
    splitClipsByShots: tool({
      description:
        "Split editor TIMELINE video element(s) at detected hard cuts (the ffmpeg scene-detection technique) — each shot becomes its own timeline element trimmed from the SAME media: non-destructive, frame-exact, no re-encode, no new files. Use when the user wants a timeline clip (or all clips) broken into shots to rework, reorder, or regenerate them individually. Element params and audio settings carry over to every piece; element-relative animations do not (they would misalign) and are dropped with a note. For splitting a CANVAS clip into shot tiles, use extractShots instead.",
      inputSchema: z.object({
        element_ids: z
          .array(z.string())
          .default([])
          .describe("Editor element ids to split (from readVideoEditor). Empty = every video element on the timeline."),
        threshold: z
          .number()
          .min(0.05)
          .max(0.9)
          .default(0.22)
          .describe("Scene-change sensitivity — lower detects more cuts."),
      }),
      execute: async ({ element_ids, threshold }) => {
        const doc = await readEditorDoc(projectId);
        const scene = doc ? activeEditorScene(doc) : null;
        if (!doc || !scene?.tracks) return { error: "No edit document yet.", ok: false };
        type El = Record<string, unknown>;
        const lanes: Array<{ elements?: El[] }> = [];
        if (scene.tracks.main) lanes.push(scene.tracks.main);
        for (const lane of scene.tracks.overlay ?? []) lanes.push(lane);
        const wanted = new Set(element_ids.map((id) => id.trim()).filter(Boolean));
        const results: Array<Record<string, unknown>> = [];
        const MIN_PIECE_SECONDS = 0.4;
        let splitsMade = 0;
        for (const lane of lanes) {
          const nextElements: El[] = [];
          for (const element of lane.elements ?? []) {
            const el = element as El;
            const elementId = typeof el.id === "string" ? el.id : "";
            if (el.type !== "video" || (wanted.size > 0 && !wanted.has(elementId))) {
              nextElements.push(el);
              continue;
            }
            if (el.retime) {
              results.push({ element_id: elementId, skipped: "element is retimed — split it manually" });
              nextElements.push(el);
              continue;
            }
            const mediaId = typeof el.mediaId === "string" ? el.mediaId : null;
            let media: string | null = null;
            if (mediaId) {
              for (const dir of ["clips", "uploads"]) {
                try {
                  const parsed = parseJsonFrontmatter(
                    await readWorkspaceFile(projectId, `${dir}/${mediaId}.md`),
                  );
                  media =
                    (typeof parsed.meta.local_path === "string" && parsed.meta.local_path) ||
                    (typeof parsed.meta.url === "string" ? parsed.meta.url : null);
                  if (media) break;
                } catch {
                  /* try next dir */
                }
              }
            }
            if (!media) {
              results.push({ element_id: elementId, skipped: "could not resolve source media" });
              nextElements.push(el);
              continue;
            }
            const { sourcePath, workDir } = await materializeVideo(projectId, media);
            try {
              const sourceDuration = await probeVideoDuration(sourcePath);
              // Pure scene cuts: no forced max-length subdivision.
              const shots = await detectShots(sourcePath, sourceDuration, {
                maxSceneSeconds: 0,
                minSceneSeconds: MIN_PIECE_SECONDS,
                threshold,
              });
              const durationTicks =
                typeof el.duration === "number" && el.duration > 0
                  ? el.duration
                  : Math.round(sourceDuration * EDITOR_TICKS);
              const trimStartTicks = typeof el.trimStart === "number" ? el.trimStart : 0;
              const trimEndTicks = typeof el.trimEnd === "number" ? el.trimEnd : 0;
              const visibleStart = trimStartTicks / EDITOR_TICKS;
              const visibleEnd = (durationTicks - trimEndTicks) / EDITOR_TICKS;
              const cuts = shots
                .map((shot) => shot.start)
                .filter(
                  (time) =>
                    time > visibleStart + MIN_PIECE_SECONDS &&
                    time < visibleEnd - MIN_PIECE_SECONDS,
                );
              if (!cuts.length) {
                results.push({
                  element_id: elementId,
                  note: "no internal cuts detected — element left as one shot",
                  pieces: 1,
                });
                nextElements.push(el);
                continue;
              }
              const bounds = [visibleStart, ...cuts, visibleEnd];
              const startTimeTicks = typeof el.startTime === "number" ? el.startTime : 0;
              const baseName = typeof el.name === "string" && el.name ? el.name : "Clip";
              const newIds: string[] = [];
              for (let piece = 0; piece < bounds.length - 1; piece += 1) {
                const from = bounds[piece]!;
                const to = bounds[piece + 1]!;
                const id = crypto.randomUUID();
                newIds.push(id);
                const pieceElement: El = {
                  ...el,
                  id,
                  name: `${baseName} · shot ${piece + 1}`,
                  startTime: Math.round(startTimeTicks + (from - visibleStart) * EDITOR_TICKS),
                  trimEnd: Math.max(0, Math.round(durationTicks - to * EDITOR_TICKS)),
                  trimStart: Math.max(0, Math.round(from * EDITOR_TICKS)),
                };
                // Element-relative animation keys would misalign on pieces.
                delete pieceElement.animations;
                nextElements.push(pieceElement);
              }
              splitsMade += 1;
              results.push({
                cut_times_seconds: cuts.map((time) => Number(time.toFixed(2))),
                element_id: elementId,
                new_element_ids: newIds,
                pieces: newIds.length,
              });
            } finally {
              await rm(workDir, { recursive: true, force: true });
            }
          }
          lane.elements = nextElements;
        }
        if (!splitsMade) {
          return { note: "No elements were split.", ok: true, results };
        }
        await saveEditorDoc(projectId, doc);
        return { elements_split: splitsMade, ok: true, results };
      },
    }),
    extractShots: tool({
      description:
        "Split a workspace video (a clip or an uploaded video) into its individual shots via ffmpeg scene detection — the same analyzer the YouTube import uses. Each shot becomes its own clip tile on the canvas, grouped as a row. Shots are NOT added to the timeline.",
      inputSchema: z.object({
        max_shots: z.number().int().min(1).max(40).default(20),
        source_id: z.string().describe("Clip or upload id."),
      }),
      execute: async ({ max_shots, source_id }) => {
        try {
          let raw: string;
          try {
            raw = await readWorkspaceFile(projectId, `clips/${source_id}.md`);
          } catch {
            raw = await readWorkspaceFile(projectId, `uploads/${source_id}.md`);
          }
          const parsed = parseJsonFrontmatter(raw);
          const media =
            typeof parsed.meta.local_path === "string" && parsed.meta.local_path
              ? parsed.meta.local_path
              : typeof parsed.meta.url === "string"
                ? parsed.meta.url
                : null;
          if (!media) return { error: `"${source_id}" has no media.`, ok: false };
          const title =
            parsed.body
              .split("\n")
              .find((line) => line.startsWith("# "))
              ?.slice(2)
              .trim() ?? source_id;
          const result = await extractShotTiles({
            maxShots: max_shots,
            media,
            projectId,
            sourceId: source_id,
            sourceTitle: title,
          });
          return {
            group_id: result.groupId,
            ok: true,
            shots: result.count,
            tile_paths: result.paths,
            total_detected: result.totalDetected,
          };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : "Shot extraction failed.",
            ok: false,
          };
        }
      },
    }),
    fadeElement: tool({
      description:
        "Apply a fade to a timeline element: fade-in from the start and/or fade-out to the end. property 'opacity' = visual fade (to black/underlying layer), 'volume' = audio fade, 'both' = both. Find element ids with readVideoEditor. Replaces any existing fade on those properties.",
      inputSchema: z.object({
        element_id: z.string().min(1),
        fade_in_seconds: z.number().min(0).max(10).default(0),
        fade_out_seconds: z.number().min(0).max(10).default(0),
        property: z.enum(["opacity", "volume", "both"]).default("both"),
      }),
      execute: async ({ element_id, fade_in_seconds, fade_out_seconds, property }) => {
        if (!fade_in_seconds && !fade_out_seconds) {
          return { error: "Provide fade_in_seconds and/or fade_out_seconds.", ok: false };
        }
        const doc = await readEditorDoc(projectId);
        const scene = doc ? activeEditorScene(doc) : null;
        if (!doc || !scene) return { error: "No edit document yet.", ok: false };
        const hit = allEditorElements(scene).find(
          (entry) => entry.element.id === element_id,
        );
        if (!hit) return { error: `No element "${element_id}" on the timeline.`, ok: false };
        const durationTicks =
          typeof hit.element.duration === "number" ? hit.element.duration : 0;
        if (!durationTicks) return { error: "Element has no duration.", ok: false };
        const inTicks = Math.min(Math.round(fade_in_seconds * EDITOR_TICKS), durationTicks);
        const outTicks = Math.min(Math.round(fade_out_seconds * EDITOR_TICKS), durationTicks);
        const keys: Array<{ atTicks: number; value: number }> = [];
        if (inTicks > 0) keys.push({ atTicks: 0, value: 0 }, { atTicks: inTicks, value: 1 });
        else keys.push({ atTicks: 0, value: 1 });
        if (outTicks > 0) {
          keys.push(
            { atTicks: Math.max(0, durationTicks - outTicks), value: 1 },
            { atTicks: durationTicks, value: 0 },
          );
        }
        const animations =
          hit.element.animations && typeof hit.element.animations === "object"
            ? (hit.element.animations as Record<string, unknown>)
            : {};
        const channel = fadeChannel(keys);
        if (property === "opacity" || property === "both") animations.opacity = channel;
        if (property === "volume" || property === "both") animations.volume = fadeChannel(keys);
        hit.element.animations = animations;
        await saveEditorDoc(projectId, doc);
        return {
          element_id,
          fades: { in_seconds: fade_in_seconds, out_seconds: fade_out_seconds },
          ok: true,
          property,
          track: hit.track,
        };
      },
    }),
    setElementProperties: tool({
      description:
        "Set a timeline element's static properties: volume (0-2, 1 = unity), muted, opacity (0-1), and/or playback rate (0.25-4, retimed with pitch preserved). Only provided fields change. Find element ids with readVideoEditor.",
      inputSchema: z.object({
        element_id: z.string().min(1),
        muted: z.boolean().nullable().default(null),
        opacity: z.number().min(0).max(1).nullable().default(null),
        rate: z.number().min(0.25).max(4).nullable().default(null),
        volume: z.number().min(0).max(2).nullable().default(null),
      }),
      execute: async ({ element_id, muted, opacity, rate, volume }) => {
        const doc = await readEditorDoc(projectId);
        const scene = doc ? activeEditorScene(doc) : null;
        if (!doc || !scene) return { error: "No edit document yet.", ok: false };
        const hit = allEditorElements(scene).find(
          (entry) => entry.element.id === element_id,
        );
        if (!hit) return { error: `No element "${element_id}" on the timeline.`, ok: false };
        const params =
          hit.element.params && typeof hit.element.params === "object"
            ? (hit.element.params as Record<string, unknown>)
            : {};
        if (volume !== null) params.volume = volume;
        if (muted !== null) params.muted = muted;
        if (opacity !== null) params.opacity = opacity;
        hit.element.params = params;
        if (rate !== null) {
          hit.element.retime = { maintainPitch: true, rate };
        }
        await saveEditorDoc(projectId, doc);
        return { element_id, ok: true, track: hit.track };
      },
    }),
    addAudioToTimeline: tool({
      description:
        "Place audio (music, voice-over, SFX already in the editor media bin — a mediaMap key of kind audio) on an audio track. at_seconds positions it; loop_until_seconds tiles it end-to-end (last copy trimmed) to cover a span — the way to extend/loop music under a whole cut. Optional fades apply to the placed audio.",
      inputSchema: z.object({
        at_seconds: z.number().min(0).default(0),
        fade_in_seconds: z.number().min(0).max(10).default(0),
        fade_out_seconds: z.number().min(0).max(10).default(0),
        host_media_id: z.string().min(1).describe("Host artifact id (mediaMap key)."),
        loop_until_seconds: z
          .number()
          .min(0)
          .nullable()
          .default(null)
          .describe("Tile copies until this timeline second (null = single placement)."),
        track_index: z.number().int().min(0).default(0),
        volume: z.number().min(0).max(2).default(1),
      }),
      execute: async ({
        at_seconds,
        fade_in_seconds,
        fade_out_seconds,
        host_media_id,
        loop_until_seconds,
        track_index,
        volume,
      }) => {
        const doc = await readEditorDoc(projectId);
        const scene = doc ? activeEditorScene(doc) : null;
        if (!doc || !scene?.tracks) return { error: "No edit document yet.", ok: false };
        const mapped = doc.mediaMap?.[host_media_id];
        if (!mapped) {
          return {
            error: `"${host_media_id}" is not in the editor media bin yet (open the Editor view once to sync). Audio mediaMap keys: ${Object.keys(
              doc.mediaMap ?? {},
            )
              .filter((key) => doc.mediaMap?.[key]?.kind === "audio")
              .join(", ") || "none"}.`,
            ok: false,
          };
        }
        const sourceSeconds = mapped.durationSeconds ?? 0;
        if (!sourceSeconds) return { error: "Audio has no known duration.", ok: false };
        scene.tracks.audio = Array.isArray(scene.tracks.audio) ? scene.tracks.audio : [];
        while (scene.tracks.audio.length <= track_index) {
          scene.tracks.audio.push({
            elements: [],
            id: crypto.randomUUID(),
            muted: false,
            name: `Audio ${scene.tracks.audio.length + 1}`,
            type: "audio",
          });
        }
        const lane = scene.tracks.audio[track_index]!;
        lane.elements = Array.isArray(lane.elements) ? lane.elements : [];
        const sourceTicks = Math.round(sourceSeconds * EDITOR_TICKS);
        const placements: Array<{ durationTicks: number; startTicks: number }> = [];
        if (loop_until_seconds && loop_until_seconds > at_seconds) {
          let cursor = Math.round(at_seconds * EDITOR_TICKS);
          const endTicks = Math.round(loop_until_seconds * EDITOR_TICKS);
          while (cursor < endTicks - 1) {
            const remaining = endTicks - cursor;
            placements.push({
              durationTicks: Math.min(sourceTicks, remaining),
              startTicks: cursor,
            });
            cursor += sourceTicks;
          }
        } else {
          placements.push({
            durationTicks: sourceTicks,
            startTicks: Math.round(at_seconds * EDITOR_TICKS),
          });
        }
        const created: string[] = [];
        placements.forEach((placement, index) => {
          const elementId = crypto.randomUUID();
          const isLast = index === placements.length - 1;
          const element: Record<string, unknown> = {
            duration: placement.durationTicks,
            id: elementId,
            mediaId: mapped.mediaId,
            name: mapped.name || host_media_id,
            params: { volume },
            sourceType: "upload",
            startTime: placement.startTicks,
            trimEnd: Math.max(0, sourceTicks - placement.durationTicks),
            trimStart: 0,
            type: "audio",
          };
          const fadeKeys: Array<{ atTicks: number; value: number }> = [];
          if (index === 0 && fade_in_seconds > 0) {
            fadeKeys.push(
              { atTicks: 0, value: 0 },
              {
                atTicks: Math.min(
                  Math.round(fade_in_seconds * EDITOR_TICKS),
                  placement.durationTicks,
                ),
                value: 1,
              },
            );
          }
          if (isLast && fade_out_seconds > 0) {
            if (!fadeKeys.length) fadeKeys.push({ atTicks: 0, value: 1 });
            fadeKeys.push(
              {
                atTicks: Math.max(
                  0,
                  placement.durationTicks - Math.round(fade_out_seconds * EDITOR_TICKS),
                ),
                value: 1,
              },
              { atTicks: placement.durationTicks, value: 0 },
            );
          }
          if (fadeKeys.length) element.animations = { volume: fadeChannel(fadeKeys) };
          lane.elements!.push(element);
          created.push(elementId);
        });
        if (doc.project?.metadata) {
          const last = placements[placements.length - 1]!;
          doc.project.metadata.duration = Math.max(
            typeof doc.project.metadata.duration === "number" ? doc.project.metadata.duration : 0,
            last.startTicks + last.durationTicks,
          );
        }
        await saveEditorDoc(projectId, doc);
        return {
          copies_placed: placements.length,
          element_ids: created,
          ok: true,
          track_index,
        };
      },
    }),
    crossfadeAudio: tool({
      description:
        "Crossfade two audio elements already on the timeline: the second element is moved to overlap the first's tail by overlap_seconds (on its own lane if needed), the first fades OUT and the second fades IN across the overlap. Find element ids with readVideoEditor.",
      inputSchema: z.object({
        first_element_id: z.string().min(1).describe("The element that fades out."),
        overlap_seconds: z.number().min(0.2).max(10).default(1.5),
        second_element_id: z.string().min(1).describe("The element that fades in."),
      }),
      execute: async ({ first_element_id, overlap_seconds, second_element_id }) => {
        const doc = await readEditorDoc(projectId);
        const scene = doc ? activeEditorScene(doc) : null;
        if (!doc || !scene?.tracks) return { error: "No edit document yet.", ok: false };
        const lanes = Array.isArray(scene.tracks.audio) ? scene.tracks.audio : [];
        const locate = (elementId: string) => {
          for (let index = 0; index < lanes.length; index += 1) {
            const element = (lanes[index]!.elements ?? []).find(
              (entry) => entry.id === elementId,
            );
            if (element) return { element, laneIndex: index };
          }
          return null;
        };
        const first = locate(first_element_id);
        const second = locate(second_element_id);
        if (!first || !second) {
          return {
            error: `Could not find ${!first ? first_element_id : second_element_id} on the audio tracks (crossfade works on audio lane elements).`,
            ok: false,
          };
        }
        const overlapTicks = Math.round(overlap_seconds * EDITOR_TICKS);
        const firstStart =
          typeof first.element.startTime === "number" ? first.element.startTime : 0;
        const firstDuration =
          typeof first.element.duration === "number" ? first.element.duration : 0;
        const secondDuration =
          typeof second.element.duration === "number" ? second.element.duration : 0;
        if (!firstDuration || !secondDuration) {
          return { error: "Both elements need a duration.", ok: false };
        }
        const clampedOverlap = Math.min(overlapTicks, firstDuration, secondDuration);
        const firstEnd = firstStart + firstDuration;
        // The fading-in element starts inside the first's tail.
        second.element.startTime = Math.max(0, firstEnd - clampedOverlap);
        // Overlapping elements cannot share a lane.
        if (first.laneIndex === second.laneIndex) {
          const fromLane = lanes[second.laneIndex]!;
          fromLane.elements = (fromLane.elements ?? []).filter(
            (entry) => entry.id !== second_element_id,
          );
          let targetIndex = lanes.findIndex(
            (lane, index) =>
              index !== first.laneIndex &&
              !(lane.elements ?? []).some((entry) => {
                const start = typeof entry.startTime === "number" ? entry.startTime : 0;
                const length = typeof entry.duration === "number" ? entry.duration : 0;
                const secondStart = second.element.startTime as number;
                return secondStart < start + length && secondStart + secondDuration > start;
              }),
          );
          if (targetIndex < 0) {
            lanes.push({
              elements: [],
              id: crypto.randomUUID(),
              muted: false,
              name: `Audio ${lanes.length + 1}`,
              type: "audio",
            });
            targetIndex = lanes.length - 1;
          }
          lanes[targetIndex]!.elements = [
            ...(lanes[targetIndex]!.elements ?? []),
            second.element,
          ];
          scene.tracks.audio = lanes;
        }
        // Complementary volume ramps across the overlap window.
        first.element.animations = {
          ...(first.element.animations && typeof first.element.animations === "object"
            ? (first.element.animations as Record<string, unknown>)
            : {}),
          volume: fadeChannel([
            { atTicks: Math.max(0, firstDuration - clampedOverlap), value: 1 },
            { atTicks: firstDuration, value: 0 },
          ]),
        };
        second.element.animations = {
          ...(second.element.animations && typeof second.element.animations === "object"
            ? (second.element.animations as Record<string, unknown>)
            : {}),
          volume: fadeChannel([
            { atTicks: 0, value: 0 },
            { atTicks: clampedOverlap, value: 1 },
          ]),
        };
        await saveEditorDoc(projectId, doc);
        return {
          ok: true,
          overlap_seconds: clampedOverlap / EDITOR_TICKS,
          second_element_new_start_seconds:
            (second.element.startTime as number) / EDITOR_TICKS,
        };
      },
    }),
    crossfadeClipBridges: tool({
      description:
        "Smooth the AUDIO across every hard cut in the clip chain: separates each video's source audio onto audio lanes (OpenCut's extract-audio, video keeps a hard visual cut), slides each incoming clip's audio slightly early, and writes complementary volume ramps — a contiguous audio dissolve at every bridge (generated clips have no spare media, so a literal overlap is impossible; this is the editorial equivalent). Videos' embedded audio is disabled in favor of the separated elements. Idempotent per run; overlap_seconds is the ramp length.",
      inputSchema: z.object({
        overlap_seconds: z.number().min(0.1).max(3).default(0.3),
      }),
      execute: async ({ overlap_seconds }) => {
        const doc = await readEditorDoc(projectId);
        const scene = doc ? activeEditorScene(doc) : null;
        if (!doc || !scene?.tracks) return { error: "No edit document yet.", ok: false };
        type El = Record<string, unknown>;
        const chain: El[] = [];
        for (const element of scene.tracks.main?.elements ?? []) {
          if (element.type === "video") chain.push(element);
        }
        for (const lane of scene.tracks.overlay ?? []) {
          for (const element of lane.elements ?? []) {
            if (element.type === "video") chain.push(element);
          }
        }
        chain.sort(
          (a, b) =>
            ((a.startTime as number) ?? 0) - ((b.startTime as number) ?? 0),
        );
        if (chain.length < 2) {
          return { error: "Need at least two video clips on the timeline.", ok: false };
        }
        const overlapTicks = Math.round(overlap_seconds * EDITOR_TICKS);
        const tracks = scene.tracks;
        tracks.audio = Array.isArray(tracks.audio) ? tracks.audio : [];
        // Two alternating lanes so adjacent audio elements never share one.
        while (tracks.audio.length < 2) {
          tracks.audio.push({
            elements: [],
            id: crypto.randomUUID(),
            muted: false,
            name: `Audio ${tracks.audio.length + 1}`,
            type: "audio",
          });
        }
        const created: string[] = [];
        chain.forEach((video, index) => {
          const start = (video.startTime as number) ?? 0;
          const duration = (video.duration as number) ?? 0;
          if (!duration) return;
          const leadShift = index > 0 ? overlapTicks : 0;
          const audioId = crypto.randomUUID();
          const videoParams =
            video.params && typeof video.params === "object"
              ? (video.params as Record<string, unknown>)
              : {};
          const fadeKeys: Array<{ atTicks: number; value: number }> = [];
          if (index > 0) fadeKeys.push({ atTicks: 0, value: 0 }, { atTicks: overlapTicks, value: 1 });
          else fadeKeys.push({ atTicks: 0, value: 1 });
          if (index < chain.length - 1) {
            fadeKeys.push(
              { atTicks: Math.max(0, duration - overlapTicks), value: 1 },
              { atTicks: duration, value: 0 },
            );
          }
          const audioElement: El = {
            animations: { volume: fadeChannel(fadeKeys) },
            duration,
            id: audioId,
            mediaId: video.mediaId,
            name: `${typeof video.name === "string" ? video.name : "Clip"} (audio)`,
            params: {
              muted: false,
              volume: typeof videoParams.volume === "number" ? videoParams.volume : 1,
            },
            sourceDuration: video.sourceDuration,
            sourceType: "upload",
            startTime: Math.max(0, start - leadShift),
            trimEnd: video.trimEnd ?? 0,
            trimStart: video.trimStart ?? 0,
            type: "audio",
          };
          tracks.audio![index % 2]!.elements = [
            ...(tracks.audio![index % 2]!.elements ?? []),
            audioElement,
          ];
          created.push(audioId);
          // The video keeps a hard visual cut; its embedded audio is replaced
          // by the separated element (OpenCut's audio-separation convention).
          (video as El).isSourceAudioEnabled = false;
        });
        await saveEditorDoc(projectId, doc);
        return {
          bridges_smoothed: chain.length - 1,
          created_audio_element_ids: created,
          note: "Each clip's audio now leads its video by the ramp length at bridges — a contiguous audio dissolve with hard visual cuts.",
          ok: true,
          overlap_seconds,
        };
      },
    }),
    patchVideoEditor: tool({
      description:
        "General-purpose editor surgery: apply RFC 6902 JSON Patch operations (add/replace/remove) to the edit document's project tree — any modification the specific verbs don't cover (reorder, retime, restructure lanes, tweak params/animations), without echoing the whole document. Paths are relative to project (e.g. /scenes/0/tracks/main/elements/2/startTime). ALWAYS readVideoEditor first to get current paths/indices. The result is structurally validated — invalid documents are rejected with precise errors and nothing is saved.",
      inputSchema: z.object({
        operations: z
          .array(
            z.object({
              op: z.enum(["add", "remove", "replace"]),
              path: z.string().min(1).describe("JSON Pointer relative to project, e.g. /scenes/0/tracks/main/elements/0/params/volume"),
              value: z.unknown().optional(),
            }),
          )
          .min(1)
          .max(40),
      }),
      execute: async ({ operations }) => {
        const doc = await readEditorDoc(projectId);
        if (!doc?.project) return { error: "No edit document yet.", ok: false };
        const working = JSON.parse(JSON.stringify(doc.project)) as Record<string, unknown>;
        const patchError = applyJsonPatch(working, operations as never);
        if (patchError) return { error: `Patch failed: ${patchError}. Nothing saved.`, ok: false };
        const validationErrors = validateEditorProject(working);
        if (validationErrors.length) {
          return {
            error: `Patched document is invalid — nothing saved. Fix and retry: ${validationErrors.slice(0, 8).join("; ")}`,
            ok: false,
          };
        }
        doc.project = working as EditorDocShape["project"];
        await saveEditorDoc(projectId, doc);
        return { ok: true, operations_applied: operations.length };
      },
    }),
    readVideoEditor: tool({
      description:
        "Read the video editor's edit document (the OpenCut project the user sees in the Editor view). Returns the full serialized project JSON plus mediaMap (host artifact id → editor media id, with durations). Times are integer ticks at 1/120000 s. Scenes hold tracks: { overlay: [], main: <video track>, audio: [] }; elements carry startTime/duration/trimStart/trimEnd. ALWAYS read before editing.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const raw = await readWorkspaceFile(projectId, "editor/opencut-project.json");
          return { exists: true, doc: JSON.parse(raw) };
        } catch {
          return {
            exists: false,
            note: "No edit document yet — the user has not opened the Editor view for this project (opening it creates and syncs one).",
          };
        }
      },
    }),
    writeVideoEditor: tool({
      description:
        "Overwrite the video editor's project with edited JSON (the `project` value from readVideoEditor, modified). The open editor picks the change up within seconds. Preserve the document structure exactly: tick times (1/120000 s), element ids, mediaId references from mediaMap. Use for reordering, trimming (trimStart/trimEnd + duration), retiming, adding/removing elements. Prefer addClipToEditorTimeline for simple appends.",
      inputSchema: z.object({
        project_json: z.string().min(2).describe("The full modified project object, as JSON."),
      }),
      execute: async ({ project_json }) => {
        let project: unknown;
        try {
          project = JSON.parse(project_json);
        } catch (error) {
          return { error: `Invalid JSON: ${error instanceof Error ? error.message : "parse failed"}`, ok: false };
        }
        const validationErrors = validateEditorProject(project);
        if (validationErrors.length) {
          return {
            error: `Document is structurally invalid — nothing saved. Fix and retry: ${validationErrors.slice(0, 8).join("; ")}`,
            ok: false,
          };
        }
        let revision = 1;
        let mediaMap: unknown = {};
        try {
          const existing = JSON.parse(
            await readWorkspaceFile(projectId, "editor/opencut-project.json"),
          );
          if (typeof existing?.revision === "number") revision = existing.revision + 1;
          if (existing?.mediaMap) mediaMap = existing.mediaMap;
        } catch {
          /* first write */
        }
        await writeWorkspaceFile(
          projectId,
          "editor/opencut-project.json",
          JSON.stringify({
            mediaMap,
            project,
            revision,
            source: "agent",
            updatedAt: new Date().toISOString(),
          }),
        );
        return { ok: true, revision };
      },
    }),
    addClipToEditorTimeline: tool({
      description:
        "Place a host artifact (clip or image already in the editor's media bin — see readVideoEditor's mediaMap keys) on the editor timeline. track='main' appends to the base video track; track='overlay' STACKS it above the main track (picture-in-picture / compositing lanes, same as dragging onto an upper timeline lane) — overlay_index picks the lane, creating it if needed. For anything fancier, edit the document via writeVideoEditor.",
      inputSchema: z.object({
        at_seconds: z
          .number()
          .min(0)
          .nullable()
          .default(null)
          .describe("Timeline position; null appends after the last element of the target track."),
        duration_seconds: z
          .number()
          .min(0.1)
          .nullable()
          .default(null)
          .describe("Override length; defaults to the media's own duration (images: 5s)."),
        host_media_id: z.string().describe("Host artifact id (a mediaMap key)."),
        overlay_index: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Which overlay lane (0 = closest above main); only used when track='overlay'."),
        track: z.enum(["main", "overlay"]).default("main"),
      }),
      execute: async ({ at_seconds, duration_seconds, host_media_id, overlay_index, track }) => {
        const TICKS = 120_000;
        let doc: {
          mediaMap?: Record<string, { durationSeconds?: number | null; kind?: string; mediaId: string; name: string }>;
          project?: {
            currentSceneId?: string;
            metadata?: { duration?: number; updatedAt?: string };
            scenes?: Array<{
              id: string;
              isMain?: boolean;
              tracks?: {
                main?: { elements?: Array<Record<string, unknown>> };
                overlay?: Array<{
                  elements?: Array<Record<string, unknown>>;
                  hidden?: boolean;
                  id?: string;
                  muted?: boolean;
                  name?: string;
                  type?: string;
                }>;
              };
            }>;
          };
          revision?: number;
        };
        try {
          doc = JSON.parse(await readWorkspaceFile(projectId, "editor/opencut-project.json"));
        } catch {
          return { error: "No edit document yet — the user must open the Editor view once first.", ok: false };
        }
        const mapped = doc.mediaMap?.[host_media_id];
        if (!mapped) {
          // Not ingested by the editor client yet — queue the placement; the
          // editor drains the queue as soon as the media lands in its bin.
          const docWithQueue = doc as typeof doc & {
            pendingPlacements?: Array<Record<string, unknown>>;
          };
          docWithQueue.pendingPlacements = [
            ...(Array.isArray(docWithQueue.pendingPlacements)
              ? docWithQueue.pendingPlacements
              : []),
            {
              atSeconds: at_seconds,
              durationSeconds: duration_seconds,
              hostMediaId: host_media_id,
              overlayIndex: overlay_index,
              track,
            },
          ];
          await writeWorkspaceFile(
            projectId,
            "editor/opencut-project.json",
            JSON.stringify({
              ...docWithQueue,
              revision: (doc.revision ?? 0) + 1,
              source: "agent",
              updatedAt: new Date().toISOString(),
            }),
          );
          return {
            note: `"${host_media_id}" is not in the editor media bin yet — the placement is QUEUED and will apply automatically when the editor ingests it (next time the Editor view is open). Do not retry.`,
            ok: true,
            queued: true,
          };
        }
        const scenes = doc.project?.scenes ?? [];
        const scene =
          scenes.find((entry) => entry.id === doc.project?.currentSceneId) ??
          scenes.find((entry) => entry.isMain) ??
          scenes[0];
        if (!scene?.tracks || !Array.isArray(scene.tracks.main?.elements)) {
          return { error: "Edit document has no main track.", ok: false };
        }
        let elements: Array<Record<string, unknown>>;
        if (track === "overlay") {
          // Stacking: overlay lanes composite above the main track in array
          // order. Create missing lanes up to the requested index.
          scene.tracks.overlay = Array.isArray(scene.tracks.overlay)
            ? scene.tracks.overlay
            : [];
          while (scene.tracks.overlay.length <= overlay_index) {
            scene.tracks.overlay.push({
              elements: [],
              hidden: false,
              id: crypto.randomUUID(),
              muted: false,
              name: `Overlay ${scene.tracks.overlay.length + 1}`,
              type: "video",
            });
          }
          const lane = scene.tracks.overlay[overlay_index]!;
          lane.elements = Array.isArray(lane.elements) ? lane.elements : [];
          elements = lane.elements;
        } else {
          elements = scene.tracks.main.elements!;
        }
        const isVideo = mapped.kind !== "image";
        const naturalSeconds =
          duration_seconds ?? (isVideo ? mapped.durationSeconds ?? 5 : 5);
        const durationTicks = Math.max(1, Math.round(naturalSeconds * TICKS));
        const trackEnd = elements.reduce((max, element) => {
          const start = typeof element.startTime === "number" ? element.startTime : 0;
          const length = typeof element.duration === "number" ? element.duration : 0;
          return Math.max(max, start + length);
        }, 0);
        const startTime =
          at_seconds !== null ? Math.round(at_seconds * TICKS) : trackEnd;
        elements.push({
          duration: durationTicks,
          id: crypto.randomUUID(),
          mediaId: mapped.mediaId,
          name: mapped.name || host_media_id,
          params: {},
          startTime,
          trimEnd: 0,
          trimStart: 0,
          type: isVideo ? "video" : "image",
        });
        if (doc.project?.metadata) {
          doc.project.metadata.duration = Math.max(
            typeof doc.project.metadata.duration === "number" ? doc.project.metadata.duration : 0,
            startTime + durationTicks,
          );
          doc.project.metadata.updatedAt = new Date().toISOString();
        }
        await writeWorkspaceFile(
          projectId,
          "editor/opencut-project.json",
          JSON.stringify({
            ...doc,
            revision: (doc.revision ?? 0) + 1,
            source: "agent",
            updatedAt: new Date().toISOString(),
          }),
        );
        return {
          ok: true,
          placed_at_seconds: startTime / TICKS,
          duration_seconds: durationTicks / TICKS,
        };
      },
    }),
    generateAudio: tool({
      description: "Generate an audio artifact when FAL_AUDIO_ENDPOINT is configured.",
      inputSchema: z.object({
        asset_id: z.string().min(1),
        prompt: z.string().min(1),
        title: z.string().min(1),
      }),
      execute: async ({ asset_id, prompt, title }) => {
        const audioOp: BillableOp = { kind: "music", tool: "generateAudio", seconds: 30 };
        const denied = await preflightCharge(billing, audioOp);
        if (denied) return { error: denied, ok: false };
        await writeWorkspaceFile(projectId, `prompts/${asset_id}.prompt.md`, `# ${title}\n\n${prompt}\n`);
        const generation = await generateFalAudio({ prompt });
        if (generation.ok) {
          await settleCharge(billing, audioOp, projectId, { title, url: generation.url });
        }
        await writeAssetFromGeneration(projectId, {
          assetId: asset_id,
          generation,
          kind: "audio",
          prompt,
          title,
        });
        await writeOperation(projectId, {
          id: `op_${asset_id}`,
          kind: "generate_audio",
          title,
          prompt,
          result: generation,
        });
        return withCheck(projectId, {
          asset_id,
          ok: generation.ok,
          url: generation.url ?? null,
          error: generation.error ?? null,
        });
      },
    }),
  };
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  // Internal call from the Trigger task carries the trusted user + run ids; a
  // direct browser call (back-compat) still authenticates via Clerk.
  // The internal Trigger runner passes triggerUserId as the trusted identity;
  // honor it ONLY when the caller proves it's the runner via a shared secret.
  // Without this check, anyone could POST triggerUserId to impersonate a user.
  const internalSecret = process.env.INTERNAL_API_SECRET?.trim();
  const providedSecret = request.headers.get("x-internal-secret")?.trim() || null;
  const isTrustedInternal = Boolean(
    internalSecret && providedSecret && providedSecret === internalSecret,
  );
  const triggerUserId =
    isTrustedInternal && typeof body.triggerUserId === "string" && body.triggerUserId.trim()
      ? body.triggerUserId.trim()
      : null;
  const triggerRunId =
    typeof body.triggerRunId === "string" && body.triggerRunId.trim() ? body.triggerRunId.trim() : null;
  const user = triggerUserId
    ? { email: null, name: null, userId: triggerUserId }
    : await ensureCurrentAppUser();
  if (!user) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const preSnapshot = await getProjectSnapshot(id, user.userId);
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    return Response.json({ error: "OPENROUTER_API_KEY is not configured." }, { status: 500 });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const incomingAttachments = parseIncomingAttachments(body.attachments);
  // The tile the user has focused on the canvas — the edit-vs-create target
  // hint. A modification instruction with a tile focused edits THAT tile.
  const focusedTile =
    body.focusedTile && typeof body.focusedTile === "object" && !Array.isArray(body.focusedTile)
      ? {
          id: String((body.focusedTile as Record<string, unknown>).id ?? ""),
          kind: String((body.focusedTile as Record<string, unknown>).kind ?? ""),
          title: String((body.focusedTile as Record<string, unknown>).title ?? ""),
        }
      : null;
  const focusBlock =
    focusedTile && focusedTile.id
      ? `

CANVAS FOCUS: the user currently has the tile @${focusedTile.id} ("${focusedTile.title}", kind: ${focusedTile.kind}) selected on the canvas. Treat this as the DEFAULT TARGET for modification-intent requests. If the user's instruction is about changing/adjusting/fixing/adding-to/animating "this" (or is otherwise an edit of what they're looking at rather than a request for a brand-new subject), operate on @${focusedTile.id}: for a character/location/object/style reference, patch its references/<category>/<id>/reference.md then regenerate its portfolio; for a keyframe/image/clip, call the matching generator with revises=${focusedTile.id} so it becomes a new VERSION of this tile. Only mint a NEW tile when the user clearly asks for new/additional content (a different subject, "also make…", "a new…"). When the instruction reads as an edit of the focused tile, do NOT create a sibling.`
      : "";

  if (!message && incomingAttachments.length === 0) {
    return Response.json({ error: "Message required." }, { status: 400 });
  }
  if (activeRuns.has(id)) {
    return Response.json(
      {
        error:
          "A run is already active for this project. Wait for it to finish (progress streams into the files pane), then send your message.",
      },
      { status: 409 },
    );
  }
  const savedAttachments = await saveChatAttachments(id, incomingAttachments);
  const runMessage = messageWithAttachmentContext(
    message || "Please review the attached files.",
    savedAttachments,
  );
  await appendChat(id, { role: "user", text: runMessage });
  // First message on a still-untitled project → name it after the query.
  if (preSnapshot.chat.length === 0 && message) {
    void autonameProjectFromQuery({
      projectId: id,
      query: message,
      currentName: preSnapshot.project.name,
      userId: user.userId,
    }).catch(() => {});
  }
  const snapshot = await getProjectSnapshot(id, user.userId);
  const skillSummaries = await listSkillSummaries();
  const workflowSummaries = await listWorkflowSummaries();
  // Full conversation context — no message window. A character budget (far
  // above any real conversation) only guards against blowing the provider's
  // context limit on pathological projects: if exceeded, the OLDEST messages
  // drop first and the model is told history was truncated.
  const HISTORY_CHAR_BUDGET = 600_000;
  const historyEntries: Array<{ content: string; role: "assistant" | "user" }> = [];
  let historyChars = 0;
  let historyTruncated = false;
  for (let index = snapshot.chat.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.chat[index]!;
    historyChars += entry.text.length;
    if (historyChars > HISTORY_CHAR_BUDGET) {
      historyTruncated = true;
      break;
    }
    historyEntries.push({ content: entry.text, role: entry.role });
  }
  historyEntries.reverse();
  const recentMessages: Array<{ content: string; role: "assistant" | "user" }> =
    historyTruncated
      ? [
          {
            content:
              "[Note: earlier messages in this long conversation were truncated for length — the workspace files remain the complete record.]",
            role: "assistant",
          },
          ...historyEntries,
        ]
      : historyEntries;
  activeRuns.add(id);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // No-throw: long runs outlive the HTTP stream (client disconnect, proxy
      // timeout). The run must keep executing and persist its reply to chat
      // even when nobody is listening; the filesystem is the source of truth.
      const emit = (event: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // Stream closed; keep running.
        }
      };
      // Heartbeat: long silent tool waits (askUser blocks for minutes) let
      // idle connection reaping abort the request signal and kill the run.
      // A status ping every 15s keeps every hop of the stream alive.
      const heartbeat = setInterval(() => {
        emit({ message: "working", type: "status" });
      }, 15_000);

      const closeStream = () => {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed by disconnect.
        }
      };

      void (async () => {
        const runId = `run_${new Date().toISOString().replace(/[:.]/g, "-")}`;
        const runStartedAt = Date.now();
        let firstTextAt: number | null = null;
        let segmentsRun = 0;
        let runStatus: "completed" | "paused" = "completed";
        const toolTimings: ToolTiming[] = [];
        const finalizeTiming = async (status: RunTiming["status"], error?: string) => {
          await writeRunTimingLocal({
            runId,
            projectId: id,
            model: MODEL_ID,
            startedAt: new Date(runStartedAt).toISOString(),
            endedAt: new Date().toISOString(),
            totalMs: Date.now() - runStartedAt,
            timeToFirstTextMs: firstTextAt ? firstTextAt - runStartedAt : null,
            segments: segmentsRun,
            status,
            toolCount: toolTimings.length,
            tools: toolTimings,
            ...(error ? { error } : {}),
          });
        };
        const runLog: Array<Record<string, unknown>> = [];
        const log = (event: Record<string, unknown>) => {
          runLog.push({ at: new Date().toISOString(), ...event });
        };
        const throwIfCancelled = async () => {
          if (request.signal.aborted || (await isAgentRunCancelled(triggerRunId))) {
            throw new DOMException("Run cancelled.", "AbortError");
          }
        };
        const persistRunLog = async () => {
          try {
            // Oversized events are replaced with a parseable stub — slicing a
            // JSON string mid-escape produces unparseable lines.
            const lines = runLog.map((entry) => {
              const serialized = JSON.stringify(entry);
              if (serialized.length <= 8_000) return serialized;
              return JSON.stringify({
                at: entry.at,
                type: entry.type,
                toolName: entry.toolName ?? null,
                truncated: true,
                preview: serialized.slice(0, 2_000),
              });
            });
            await writeWorkspaceFile(id, `runs/${runId}.jsonl`, lines.join("\n") + "\n");
          } catch {
            // Run logs are best-effort diagnostics.
          }
        };
        const chatTools: ChatToolCall[] = [];
        const toolIndexById = new Map<string, number>();
        const toolStartedAtById = new Map<string, number>();
        let firstModelSignalLogged = false;
        let reply = "";
        let streamedReply = "";

        try {
          emit({ type: "status", message: "Starting agent run." });
          const requestedAt =
            typeof (body as Record<string, unknown>).requestedAt === "number"
              ? ((body as Record<string, unknown>).requestedAt as number)
              : null;
          log({
            type: "run_start",
            message: runMessage,
            // Queue latency: user hit send → this run actually started.
            ...(requestedAt ? { queue_delay_ms: Date.now() - requestedAt } : {}),
          });
          if (triggerRunId) void setAgentRunStatus(triggerRunId, "running").catch(() => {});

          const planSteps = await readPlanSteps(id);
          const planLine = planCursorLine(planSteps);
          const planCursorText = planLine
            ? `PLAN (follow it; move the cursor with updatePlan before/after each step; deviating requires updating it first):\n${planLine}\nSteps: ${planSteps
                .map((step) => `[${step.status}] ${step.title}`)
                .join(" · ")}`
            : "";
          const attachmentParts = attachmentContentParts(incomingAttachments);
          const hasFilePart = attachmentParts.some((part) => part.type === "file");
          let conversation: ModelMessage[] = [
            ...recentMessages,
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: [
                    `Current workspace index:\n\n${workspaceIndex(snapshot)}`,
                    planCursorText,
                    `User request:\n${runMessage}`,
                  ]
                    .filter(Boolean)
                    .join("\n\n---\n\n"),
                },
                ...attachmentParts,
              ],
            },
          ];

          for (let segment = 0; segment < MAX_SEGMENTS; segment += 1) {
            const result = streamText({
              model: openrouter.chat(MODEL_ID, {
                parallelToolCalls: true,
                ...(hasFilePart
                  ? { plugins: [{ id: "file-parser" as const, pdf: { engine: "cloudflare-ai" } }] }
                  : {}),
              }),
              system: systemPrompt(skillSummaries, workflowSummaries) + focusBlock,
              messages: conversation,
              tools: buildTools(id, { userId: user.userId }),
              stopWhen: stepCountIs(MAX_TOOL_STEPS),
              // Abort propagates from runs.cancel() → task signal → this request.
              // A normal browser disconnect does NOT reach here (the task keeps
              // the loop alive), so only a real cancel stops the model.
              abortSignal: request.signal,
              onChunk: ({ chunk }) => {
                if (!firstModelSignalLogged) {
                  firstModelSignalLogged = true;
                  // Time-to-first-model-output: prompt assembly + provider latency.
                  log({ type: "timing", first_model_signal_ms: Date.now() - runStartedAt });
                }
                const streamed = chunk as {
                  input?: unknown;
                  output?: unknown;
                  text?: string;
                  toolCallId?: string;
                  toolName?: string;
                  type?: string;
                };
                if (streamed.type === "text-delta" && streamed.text) {
                  if (firstTextAt === null) {
                    firstTextAt = Date.now();
                    log({ type: "first_text", elapsedMs: firstTextAt - runStartedAt });
                  }
                  streamedReply += streamed.text;
                  emit({ type: "text_delta", text: streamed.text });
                } else if (streamed.type === "tool-input-start") {
                  if (streamed.toolCallId) {
                    toolStartedAtById.set(streamed.toolCallId, Date.now());
                  }
                  emit({
                    type: "tool_start",
                    toolName: streamed.toolName ?? "tool",
                  });
                } else if (streamed.type === "tool-call") {
                  const name = streamed.toolName ?? "tool";
                  const callId = streamed.toolCallId ?? `${name}-${chatTools.length}`;
                  if (!toolStartedAtById.has(callId)) {
                    toolStartedAtById.set(callId, Date.now());
                  }
                  const chatTool: ChatToolCall = {
                    name,
                    summary: toolSummaryFromInput(streamed.input),
                  };
                  toolIndexById.set(callId, chatTools.length);
                  chatTools.push(chatTool);
                  emit({
                    type: "tool_call",
                    input: streamed.input ?? null,
                    toolCallId: callId,
                    toolName: name,
                  });
                  log({
                    type: "tool_call",
                    segment,
                    toolName: name,
                    input: streamed.input ?? null,
                  });
                } else if (streamed.type === "tool-result") {
                  const name = streamed.toolName ?? "tool";
                  const pendingIndex = chatTools.findIndex(
                    (tool) => tool.name === name && tool.ok === undefined,
                  );
                  const callId =
                    streamed.toolCallId ??
                    (pendingIndex >= 0 ? `${name}-${pendingIndex}` : `${name}-${chatTools.length}`);
                  const existingIndex = toolIndexById.get(callId);
                  const startedAt = toolStartedAtById.get(callId);
                  const durationMs = startedAt ? Math.max(1, Date.now() - startedAt) : undefined;
                  if (existingIndex !== undefined) {
                    chatTools[existingIndex] = {
                      ...chatTools[existingIndex],
                      ok: toolSucceeded(streamed.output),
                      ...(durationMs !== undefined ? { durationMs } : {}),
                    };
                  } else {
                    toolIndexById.set(callId, chatTools.length);
                    chatTools.push({
                      name,
                      ok: toolSucceeded(streamed.output),
                      ...(durationMs !== undefined ? { durationMs } : {}),
                    });
                  }
                  toolStartedAtById.delete(callId);
                  toolTimings.push({
                    name,
                    durationMs: durationMs ?? 0,
                    ok: toolSucceeded(streamed.output) ?? null,
                    segment,
                  });
                  emit({
                    type: "tool_result",
                    ...(durationMs !== undefined ? { durationMs } : {}),
                    output: streamed.output ?? null,
                    toolCallId: callId,
                    toolName: name,
                  });
                  log({
                    type: "tool_result",
                    segment,
                    toolName: name,
                    ...(durationMs !== undefined ? { durationMs } : {}),
                    output: streamed.output ?? null,
                  });
                }
              },
            });

            await result.consumeStream();
            await throwIfCancelled();
            const text = (await result.text).trim();
            const finishReason = await result.finishReason;
            const response = await result.response;
            await throwIfCancelled();
            conversation = [...conversation, ...response.messages];
            segmentsRun = segment + 1;
            log({ type: "segment_end", segment, finishReason, hasText: Boolean(text) });

            // "tool-calls" here means the step budget cut the run mid-work;
            // refresh the budget and continue instead of dying silently.
            if (finishReason !== "tool-calls") {
              reply = text || "I updated the workspace.";
              break;
            }
            if (segment < MAX_SEGMENTS - 1) {
              emit({
                type: "status",
                message: `Step budget reached; continuing (segment ${segment + 2}/${MAX_SEGMENTS}).`,
              });
              conversation = [
                ...conversation,
                {
                  role: "user" as const,
                  content:
                    "Step budget refreshed. Continue the same task from the current workspace state — progress so far is saved in the files. Run checkProject before your final answer.",
                },
              ];
            } else {
              reply =
                text ||
                'Run paused: the step budget was exhausted before the task finished. All progress is saved in the workspace files; say "continue" to resume from the current state.';
              runStatus = "paused";
              log({ type: "run_paused" });
            }
          }

          await throwIfCancelled();
          log({ type: "run_end", reply });
          activeRuns.delete(id);
          // The end-of-run writes are independent of each other; run them
          // concurrently so the stream closes promptly instead of after a chain
          // of sequential Supabase round-trips. appendChat must finish before the
          // final snapshot read so the assistant message is included.
          await Promise.all([
            appendChat(id, {
              role: "assistant",
              text: reply,
              ...(chatTools.length ? { tools: chatTools } : {}),
            }),
            persistRunLog(),
            finalizeTiming(runStatus),
            triggerRunId ? setAgentRunStatus(triggerRunId, "completed") : Promise.resolve(),
          ]);
          // `final` no longer ships the full snapshot: a large snapshot made one
          // ndjson line exceed stream-chunk size (corruption) and added a slow
          // read to the close path. The client reconciles from /api/projects/[id]
          // instead — everything is already persisted by the time we get here.
          emit({ type: "final", reply });
          closeStream();
        } catch (error) {
          const aborted = request.signal.aborted || (error instanceof Error && error.name === "AbortError");
          log({
            type: "run_error",
            error: error instanceof Error ? error.message : "Chat request failed.",
          });
          if (aborted && (reply.trim() || streamedReply.trim() || chatTools.length)) {
            await appendChat(id, {
              role: "assistant",
              text: reply.trim() || streamedReply.trim() || "Stopped.",
              ...(chatTools.length ? { tools: chatTools } : {}),
            }).catch(() => {});
          }
          await persistRunLog();
          await finalizeTiming(
            aborted ? "cancelled" : "failed",
            error instanceof Error ? error.message : "Chat request failed.",
          );
          activeRuns.delete(id);
          if (triggerRunId) {
            await setAgentRunStatus(triggerRunId, aborted ? "cancelled" : "failed", {
              error: error instanceof Error ? error.message : "Chat request failed.",
            });
          }
          if (!aborted) {
            emit({
              type: "error",
              error: error instanceof Error ? error.message : "Chat request failed.",
            });
          }
          closeStream();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  });
}
