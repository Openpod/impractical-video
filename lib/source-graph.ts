import { createHash } from "node:crypto";
import {
  FACINGS,
  IDENTITY_VERIFICATION_STATUSES,
  KEYFRAME_COMPOSITION_MODES,
  SCREEN_POSITIONS,
  type Facing,
  type IdentityVerificationStatus,
  type KeyframeComposition,
  type KeyframeCompositionMode,
  type RegionBox,
  type ScreenPosition,
  type SceneState,
} from "@/lib/generation-contract";
import { isProjectSupportMetadataPath } from "@/lib/project-file-classification";

/**
 * Source graph for a video project workspace.
 *
 * The workspace is a tree of markdown files with JSON frontmatter plus
 * timeline.json. This module parses those files into a typed graph:
 *
 *   reference  --(portfolio_of)--   portfolio          identity anchors
 *   keyframe   --(depicts)-->       reference          what is in the frame
 *   keyframe   --(identity_anchors)--> portfolio       pixels conditioned on
 *   keyframe   --(state_anchor)-->  keyframe           prior-frame conditioning
 *   keyframe   --(captured_from)--> clip               frame extracted from render
 *   clip       --(from/to_keyframe)--> keyframe        clips are edges between frames
 *   clip       --(scene)-->         scene              narrative grouping
 *   timeline   --(clip_id)-->       clip               player order
 *
 * Continuity is structural, not declared: two clips form a continuous shot
 * iff they share a keyframe node (A.to_keyframe === B.from_keyframe).
 * `built_against` records the identity hash of each dependency at generation
 * time so the linter can detect staleness, Make-style.
 */

export type SourceFile = { path: string; content: string };

export type NodeStatus =
  | "planned"
  | "pending"
  | "generated"
  | "captured"
  | "active"
  | "approved"
  | "superseded"
  | "rejected";

export const TRANSITION_TYPES = [
  "continuous",
  "cut",
  "hard_cut_same_assets",
  "time_jump",
  "camera_reset",
  "stylized_transition",
] as const;

export type TransitionType = (typeof TRANSITION_TYPES)[number];

export const REFERENCE_CATEGORIES = [
  "characters",
  "environments",
  "props",
  "styles",
] as const;

export type ReferenceCategory = (typeof REFERENCE_CATEGORIES)[number];

export type EndTrust = "pinned" | "captured" | "unknown";

/** Proferes shot-size vocabulary, wide to tight. */
export const SHOT_SIZES = ["ELS", "LS", "MLS", "MS", "MCU", "CU", "ECU"] as const;

export type ShotSize = (typeof SHOT_SIZES)[number];

export type ReferenceNode = {
  id: string;
  path: string;
  category: ReferenceCategory | null;
  status: NodeStatus;
  voiceId: string | null;
  body: string;
};

export type PortfolioNode = {
  id: string;
  path: string;
  referenceId: string | null;
  status: NodeStatus;
  urls: string[];
};

export type MediaVersion = {
  version: number;
  url: string | null;
  localPath: string | null;
};

export type KeyframeNode = {
  id: string;
  path: string;
  status: NodeStatus;
  url: string | null;
  versions: MediaVersion[];
  imagePhash: string | null;
  aspectRatio: string | null;
  depicts: string[];
  identityAnchors: string[];
  stateAnchor: string | null;
  sceneState: SceneState | null;
  composition: KeyframeComposition | null;
  capturedFrom: string | null;
  builtAgainst: Record<string, string>;
  intentionallyUnchanged: string[];
  prompt: string | null;
  body: string;
};

export type SceneNode = {
  id: string;
  path: string;
  index: number | null;
  references: string[];
  body: string;
};

export type ClipDialogueLine = {
  speaker: string;
  line: string;
  startS: number | null;
  endS: number | null;
  delivery: string | null;
};

export type ClipNode = {
  id: string;
  path: string;
  sceneId: string | null;
  index: number | null;
  status: NodeStatus;
  url: string | null;
  versions: MediaVersion[];
  fromKeyframe: string | null;
  toKeyframe: string | null;
  endTrust: EndTrust;
  transitionFromPrevious: TransitionType | null;
  shotSize: ShotSize | null;
  cutMotivation: string | null;
  aspectRatio: string | null;
  inTimeline: boolean;
  durationSeconds: number | null;
  generatedSeconds: number | null;
  dialogueMode: string | null;
  dialogueLines: ClipDialogueLine[];
  promptPlan: Record<string, unknown> | null;
  builtAgainst: Record<string, string>;
  intentionallyUnchanged: string[];
};

export type PromptNode = {
  id: string;
  path: string;
  status: NodeStatus;
  clipId: string | null;
  compiler: string | null;
  compilerHash: string | null;
  builtAgainst: Record<string, string>;
  intentionallyUnchanged: string[];
  body: string;
};

export type AssetNode = {
  id: string;
  path: string;
  kind: string;
  status: NodeStatus;
  url: string | null;
  depicts: string[];
  derivedFrom: string[];
};

export const FINDING_STATUSES = ["open", "accepted", "dismissed", "resolved"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export type FindingNode = {
  id: string;
  path: string;
  status: FindingStatus;
  severity: "blocker" | "issue" | "note";
  implicates: string[];
  summary: string;
};

export type TimelineEntry = {
  id: string;
  clipId: string | null;
  url: string | null;
};

export type GraphIssue = {
  level: "error" | "warning" | "info";
  rule: string;
  path: string | null;
  nodeId: string | null;
  message: string;
};

export type SourceGraph = {
  references: Map<string, ReferenceNode>;
  portfolios: Map<string, PortfolioNode>;
  portfolioByReference: Map<string, PortfolioNode>;
  keyframes: Map<string, KeyframeNode>;
  scenes: Map<string, SceneNode>;
  clips: Map<string, ClipNode>;
  prompts: Map<string, PromptNode>;
  assets: Map<string, AssetNode>;
  findings: Map<string, FindingNode>;
  timeline: TimelineEntry[];
  nodePathById: Map<string, string>;
  parseIssues: GraphIssue[];
};

const NODE_STATUSES = new Set<string>([
  "planned",
  "pending",
  "generated",
  "captured",
  "active",
  "approved",
  "superseded",
  "rejected",
]);

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asHashMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" && item.trim()) out[key] = item.trim();
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStatus(value: unknown, fallback: NodeStatus): NodeStatus {
  const raw = asString(value);
  return raw && NODE_STATUSES.has(raw) ? (raw as NodeStatus) : fallback;
}

/** Defensive parse of the keyframe `scene_state` frontmatter snapshot; drops
 * malformed entries rather than throwing. Returns null when nothing valid. */
function asSceneState(value: unknown): SceneState | null {
  const v = asRecord(value);
  if (!v) return null;
  const pos = (p: unknown): ScreenPosition | null =>
    typeof p === "string" && (SCREEN_POSITIONS as readonly string[]).includes(p)
      ? (p as ScreenPosition)
      : null;
  const box = (b: unknown): RegionBox | null => {
    const o = asRecord(b);
    if (!o) return null;
    const x = typeof o.x === "number" ? o.x : null;
    const y = typeof o.y === "number" ? o.y : null;
    const w = typeof o.w === "number" ? o.w : null;
    const h = typeof o.h === "number" ? o.h : null;
    if (x === null || y === null || w === null || h === null) return null;
    return { x, y, w, h };
  };
  const characters = (Array.isArray(v.characters) ? v.characters : []).flatMap((c) => {
    const o = asRecord(c);
    const sp = pos(o?.screen_position);
    const facing =
      typeof o?.facing === "string" && (FACINGS as readonly string[]).includes(o.facing)
        ? (o.facing as Facing)
        : null;
    if (!o || typeof o.id !== "string" || !sp || !facing) return [];
    const bbox = box(o.bbox);
    return [{ id: o.id, screen_position: sp, facing, ...(bbox ? { bbox } : {}) }];
  });
  const props = (Array.isArray(v.props) ? v.props : []).flatMap((p) => {
    const o = asRecord(p);
    const loc = pos(o?.location);
    if (!o || typeof o.id !== "string" || !loc) return [];
    return [{ id: o.id, owner: typeof o.owner === "string" ? o.owner : null, location: loc }];
  });
  const setAnchors = (Array.isArray(v.set_anchors) ? v.set_anchors : []).flatMap((s) => {
    const o = asRecord(s);
    const loc = pos(o?.location);
    if (!o || typeof o.id !== "string" || !loc) return [];
    return [{ id: o.id, location: loc }];
  });
  if (!characters.length && !props.length && !setAnchors.length) return null;
  return { characters, props, set_anchors: setAnchors };
}

function asKeyframeComposition(value: unknown): KeyframeComposition | null {
  const v = asRecord(value);
  if (!v) return null;
  const mode =
    typeof v.mode === "string" &&
    (KEYFRAME_COMPOSITION_MODES as readonly string[]).includes(v.mode)
      ? (v.mode as KeyframeCompositionMode)
      : null;
  if (!mode) return null;
  const verifications = (Array.isArray(v.identity_verifications)
    ? v.identity_verifications
    : []
  ).flatMap((item) => {
    const o = asRecord(item);
    if (!o || typeof o.reference_id !== "string" || !o.reference_id.trim()) {
      return [];
    }
    const status =
      typeof o.status === "string" &&
      (IDENTITY_VERIFICATION_STATUSES as readonly string[]).includes(o.status)
        ? (o.status as IdentityVerificationStatus)
        : null;
    if (!status) return [];
    return [
      {
        reference_id: o.reference_id.trim(),
        portfolio_id:
          typeof o.portfolio_id === "string" && o.portfolio_id.trim()
            ? o.portfolio_id.trim()
            : null,
        status,
        summary:
          typeof o.summary === "string" && o.summary.trim()
            ? o.summary.trim()
            : null,
      },
    ];
  });
  const attempts = (Array.isArray(v.injection_attempts)
    ? v.injection_attempts
    : []
  ).flatMap((item) => {
    const o = asRecord(item);
    if (!o || typeof o.reference_id !== "string" || !o.reference_id.trim()) {
      return [];
    }
    if (
      typeof o.attempts !== "number" ||
      !Number.isInteger(o.attempts) ||
      o.attempts < 0
    ) {
      return [];
    }
    return [{ reference_id: o.reference_id.trim(), attempts: o.attempts }];
  });
  return {
    mode,
    plate_keyframe: asString(v.plate_keyframe),
    injected_references: asStringArray(v.injected_references),
    ...(attempts.length ? { injection_attempts: attempts } : {}),
    identity_verifications: verifications,
  };
}

function asMediaVersions(value: unknown): MediaVersion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): MediaVersion[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const version = asNumber(record.version);
    if (version === null || !Number.isInteger(version) || version < 1) return [];
    const url = asString(record.url);
    const localPath = asString(record.local_path);
    if (!url && !localPath) return [];
    return [{ version, url, localPath }];
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const CLIP_PLAN_HASH_SUFFIX = "@clip_plan";

export function clipPlanHashValue(value: unknown): string {
  return createHash("sha256")
    .update(`clip-plan:${canonicalJson(value ?? null)}`)
    .digest("hex")
    .slice(0, 16);
}

export function clipPlanHash(node: ClipNode): string | null {
  return node.promptPlan ? clipPlanHashValue(node.promptPlan) : null;
}

export type ParsedMarkdown =
  | { ok: true; meta: Record<string, unknown>; body: string }
  | { ok: false; error: string };

/** Strict frontmatter parse: malformed JSON is an error, not empty meta. */
export function parseStrictJsonFrontmatter(content: string): ParsedMarkdown {
  if (!content.startsWith("---\n")) {
    return { ok: false, error: "Missing JSON frontmatter block." };
  }
  const end = content.indexOf("\n---", 4);
  if (end < 0) {
    return { ok: false, error: "Unterminated frontmatter block." };
  }
  const raw = content.slice(4, end).trim();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Frontmatter must be a JSON object." };
    }
    return {
      ok: true,
      meta: parsed as Record<string, unknown>,
      body: content.slice(end + 5).trimStart(),
    };
  } catch (error) {
    return {
      ok: false,
      error: `Invalid frontmatter JSON: ${error instanceof Error ? error.message : "parse failed"}`,
    };
  }
}

/**
 * Identity hash per node type. Dependents record these in `built_against`;
 * a mismatch later means the dependency changed in an identity-bearing way.
 * Cosmetic edits (status flips, prose tweaks on media-backed nodes) do not
 * change the hash.
 */
export function identityHash(
  node:
    | { kind: "reference"; node: ReferenceNode }
    | { kind: "portfolio"; node: PortfolioNode }
    | { kind: "keyframe"; node: KeyframeNode }
    | { kind: "clip"; node: ClipNode }
    | { kind: "prompt"; node: PromptNode },
): string {
  const sha = (value: string) =>
    createHash("sha256").update(value).digest("hex").slice(0, 16);
  switch (node.kind) {
    case "reference":
      return sha(
        `reference:${node.node.category ?? ""}:${node.node.body.trim()}`,
      );
    case "portfolio":
      return sha(
        `portfolio:${node.node.referenceId ?? ""}:${[...node.node.urls].sort().join(",")}`,
      );
    case "keyframe":
      return node.node.url
        ? sha(`keyframe:${node.node.url}`)
        : sha(
            `keyframe:planned:${node.node.prompt ?? ""}:${node.node.body.trim()}`,
          );
    case "clip":
      return sha(`clip:${node.node.url ?? "pending"}`);
    case "prompt":
      return sha(
        `prompt:${node.node.clipId ?? ""}:${node.node.compiler ?? ""}:${node.node.body.trim()}`,
      );
  }
}

/**
 * Voice is a separate identity axis from visuals. It is hashed independently
 * so changing a character's voice dirties only audio-bearing dependents
 * (clips where they speak, via `built_against["<ref>@voice"]`), never the
 * keyframes/portfolios that record the visual identityHash.
 */
export const VOICE_HASH_SUFFIX = "@voice";

export function voiceHash(node: ReferenceNode): string {
  return createHash("sha256")
    .update(`voice:${node.voiceId ?? "unset"}`)
    .digest("hex")
    .slice(0, 16);
}

export function lookupIdentityHash(
  graph: SourceGraph,
  id: string,
): string | null {
  if (id.endsWith(CLIP_PLAN_HASH_SUFFIX)) {
    const clip = graph.clips.get(id.slice(0, -CLIP_PLAN_HASH_SUFFIX.length));
    return clip ? clipPlanHash(clip) : null;
  }
  if (id.endsWith(VOICE_HASH_SUFFIX)) {
    const base = graph.references.get(id.slice(0, -VOICE_HASH_SUFFIX.length));
    return base ? voiceHash(base) : null;
  }
  const reference = graph.references.get(id);
  if (reference) return identityHash({ kind: "reference", node: reference });
  const portfolio = graph.portfolios.get(id);
  if (portfolio) return identityHash({ kind: "portfolio", node: portfolio });
  const keyframe = graph.keyframes.get(id);
  if (keyframe) return identityHash({ kind: "keyframe", node: keyframe });
  const clip = graph.clips.get(id);
  if (clip) return identityHash({ kind: "clip", node: clip });
  const prompt = graph.prompts.get(id);
  if (prompt) return identityHash({ kind: "prompt", node: prompt });
  return null;
}

function inferType(meta: Record<string, unknown>, path: string): string | null {
  const declared = asString(meta.type);
  if (declared) return declared;
  if (path.endsWith("/reference.md")) return "reference";
  if (path.endsWith("/portfolio.md")) return "portfolio";
  if (path.startsWith("keyframes/")) return "keyframe";
  if (path.endsWith("/scene.md")) return "scene";
  if (path.startsWith("clips/")) return "clip";
  if (path.startsWith("prompts/")) return "prompt";
  if (path.startsWith("assets/")) return "asset";
  if (path.startsWith("findings/")) return "finding";
  return null;
}

export function buildSourceGraph(files: SourceFile[]): SourceGraph {
  const graph: SourceGraph = {
    references: new Map(),
    portfolios: new Map(),
    portfolioByReference: new Map(),
    keyframes: new Map(),
    scenes: new Map(),
    clips: new Map(),
    prompts: new Map(),
    assets: new Map(),
    findings: new Map(),
    timeline: [],
    nodePathById: new Map(),
    parseIssues: [],
  };

  const issue = (
    level: GraphIssue["level"],
    rule: string,
    path: string | null,
    nodeId: string | null,
    message: string,
  ) => {
    graph.parseIssues.push({ level, rule, path, nodeId, message });
  };

  const registerId = (id: string, path: string): boolean => {
    const existing = graph.nodePathById.get(id);
    if (existing) {
      issue(
        "error",
        "duplicate-id",
        path,
        id,
        `Duplicate node id "${id}" (already defined in ${existing}).`,
      );
      return false;
    }
    graph.nodePathById.set(id, path);
    return true;
  };

  for (const file of files) {
    if (isProjectSupportMetadataPath(file.path)) continue;
    if (file.path === "timeline.json") {
      try {
        const parsed = JSON.parse(file.content) as unknown;
        if (!Array.isArray(parsed)) {
          issue("error", "parse", file.path, null, "timeline.json must be a JSON array.");
          continue;
        }
        for (const item of parsed) {
          if (!item || typeof item !== "object") continue;
          const record = item as Record<string, unknown>;
          graph.timeline.push({
            id: asString(record.id) ?? `tl_${graph.timeline.length}`,
            clipId: asString(record.clip_id),
            url: asString(record.url),
          });
        }
      } catch (error) {
        issue(
          "error",
          "parse",
          file.path,
          null,
          `timeline.json is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`,
        );
      }
      continue;
    }

    if (!file.path.endsWith(".md")) continue;
    // Agent-tooling files (synced skills, agent configs, guides) are not
    // project records — linting their YAML frontmatter as JSON produced
    // noise errors in every check_project run.
    if (file.path.startsWith(".claude/") || file.path.startsWith(".codex/")) {
      continue;
    }
    const name = file.path.split("/").pop() ?? "";
    if (name.startsWith("_") || name === "brief.md") continue;
    // Legacy prompts without frontmatter remain pure records. Planned prompt
    // artifacts with type:"prompt" participate in staleness.
    if (file.path.startsWith("prompts/") && !file.content.startsWith("---\n")) {
      continue;
    }
    if (file.path.startsWith("operations/")) {
      continue;
    }

    const parsed = parseStrictJsonFrontmatter(file.content);
    if (!parsed.ok) {
      issue("error", "parse", file.path, null, parsed.error);
      continue;
    }
    const { meta, body } = parsed;
    const id = asString(meta.id);
    const type = inferType(meta, file.path);
    if (!id) {
      issue("error", "parse", file.path, null, "Frontmatter is missing required \"id\".");
      continue;
    }
    if (!type) {
      issue(
        "error",
        "parse",
        file.path,
        id,
        "Frontmatter is missing \"type\" and the path does not imply one.",
      );
      continue;
    }
    if (!registerId(id, file.path)) continue;

    switch (type) {
      case "reference": {
        const category = asString(meta.category);
        graph.references.set(id, {
          id,
          path: file.path,
          category: REFERENCE_CATEGORIES.includes(
            category as ReferenceCategory,
          )
            ? (category as ReferenceCategory)
            : null,
          status: asStatus(meta.status, "active"),
          voiceId: asString(meta.voice_id) ?? asString(meta.voice),
          body,
        });
        if (category && !REFERENCE_CATEGORIES.includes(category as ReferenceCategory)) {
          issue(
            "warning",
            "parse",
            file.path,
            id,
            `Unknown reference category "${category}".`,
          );
        }
        break;
      }
      case "portfolio": {
        const node: PortfolioNode = {
          id,
          path: file.path,
          referenceId: asString(meta.reference_id),
          status: asStatus(meta.status, "planned"),
          urls: asStringArray(meta.urls),
        };
        graph.portfolios.set(id, node);
        if (node.referenceId) {
          graph.portfolioByReference.set(node.referenceId, node);
        }
        break;
      }
      case "keyframe": {
        graph.keyframes.set(id, {
          id,
          path: file.path,
          status: asStatus(meta.status, "planned"),
          url: asString(meta.url),
          versions: asMediaVersions(meta.versions),
          imagePhash: asString(meta.image_phash),
          aspectRatio: asString(meta.aspect_ratio),
          depicts: asStringArray(meta.depicts),
          identityAnchors: asStringArray(meta.identity_anchors),
          stateAnchor: asString(meta.state_anchor),
          sceneState: asSceneState(meta.scene_state),
          composition: asKeyframeComposition(meta.composition),
          capturedFrom: asString(meta.captured_from),
          builtAgainst: asHashMap(meta.built_against),
          intentionallyUnchanged: asStringArray(meta.intentionally_unchanged),
          prompt: asString(meta.prompt),
          body,
        });
        break;
      }
      case "scene": {
        graph.scenes.set(id, {
          id,
          path: file.path,
          index: asNumber(meta.index),
          references: asStringArray(meta.references),
          body,
        });
        break;
      }
      case "clip": {
        const endTrust = asString(meta.end_trust);
        const transition = asString(meta.transition_from_previous);
        const dialogue =
          meta.dialogue && typeof meta.dialogue === "object" && !Array.isArray(meta.dialogue)
            ? (meta.dialogue as Record<string, unknown>)
            : {};
        const dialogueLines = Array.isArray(dialogue.lines)
          ? dialogue.lines
              .filter(
                (entry): entry is Record<string, unknown> =>
                  Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
              )
              .map((entry) => ({
                speaker: asString(entry.speaker) ?? "unknown",
                line: asString(entry.line) ?? "",
                startS: asNumber(entry.start_s),
                endS: asNumber(entry.end_s),
                delivery: asString(entry.delivery),
              }))
          : [];
        graph.clips.set(id, {
          id,
          path: file.path,
          sceneId: asString(meta.scene),
          index: asNumber(meta.index),
          status: asStatus(meta.status, "planned"),
          url: asString(meta.url),
          versions: asMediaVersions(meta.versions),
          fromKeyframe: asString(meta.from_keyframe),
          toKeyframe: asString(meta.to_keyframe),
          endTrust:
            endTrust === "pinned" || endTrust === "captured"
              ? endTrust
              : "unknown",
          transitionFromPrevious: TRANSITION_TYPES.includes(
            transition as TransitionType,
          )
            ? (transition as TransitionType)
            : null,
          shotSize: SHOT_SIZES.includes(asString(meta.shot_size) as ShotSize)
            ? (asString(meta.shot_size) as ShotSize)
            : null,
          cutMotivation: asString(meta.cut_motivation),
          aspectRatio: asString(meta.aspect_ratio),
          inTimeline: meta.in_timeline !== false,
          durationSeconds: asNumber(meta.duration_seconds),
          generatedSeconds: asNumber(meta.generated_seconds),
          dialogueMode: asString(dialogue.mode),
          dialogueLines,
          promptPlan: asRecord(meta.prompt_plan),
          builtAgainst: asHashMap(meta.built_against),
          intentionallyUnchanged: asStringArray(meta.intentionally_unchanged),
        });
        if (
          transition &&
          !TRANSITION_TYPES.includes(transition as TransitionType)
        ) {
          issue(
            "warning",
            "parse",
            file.path,
            id,
            `Unknown transition_from_previous "${transition}".`,
          );
        }
        break;
      }
      case "prompt": {
        graph.prompts.set(id, {
          id,
          path: file.path,
          status: asStatus(meta.status, "planned"),
          clipId: asString(meta.clip_id),
          compiler: asString(meta.compiler),
          compilerHash: asString(meta.compiler_hash),
          builtAgainst: asHashMap(meta.built_against),
          intentionallyUnchanged: asStringArray(meta.intentionally_unchanged),
          body,
        });
        break;
      }
      case "asset": {
        graph.assets.set(id, {
          id,
          path: file.path,
          kind: asString(meta.kind) ?? "other",
          status: asStatus(meta.status, "active"),
          url: asString(meta.url),
          depicts: asStringArray(meta.depicts),
          derivedFrom: asStringArray(meta.derived_from),
        });
        break;
      }
      case "finding": {
        const severity = asString(meta.severity);
        const status = asString(meta.status);
        graph.findings.set(id, {
          id,
          path: file.path,
          status: FINDING_STATUSES.includes(status as FindingStatus)
            ? (status as FindingStatus)
            : "open",
          severity:
            severity === "blocker" || severity === "note" ? severity : "issue",
          implicates: asStringArray(meta.implicates),
          summary: asString(meta.summary) ?? body.split("\n").find(Boolean) ?? id,
        });
        break;
      }
      default: {
        // Unknown node types are tolerated; they are simply not graph nodes.
        break;
      }
    }
  }

  return graph;
}

/**
 * Canonical clip order, derived purely from the filesystem: scene index, then
 * clip index within the scene, then id. The timeline is a projection of THIS —
 * stored order is never the authority, so parallel/out-of-completion-order
 * generation can never scramble the film.
 */
export function orderedClips(graph: SourceGraph): ClipNode[] {
  return [...graph.clips.values()].sort((a, b) => {
    const sceneA = a.sceneId ? (graph.scenes.get(a.sceneId)?.index ?? 0) : 0;
    const sceneB = b.sceneId ? (graph.scenes.get(b.sceneId)?.index ?? 0) : 0;
    if (sceneA !== sceneB) return sceneA - sceneB;
    const indexA = a.index ?? 0;
    const indexB = b.index ?? 0;
    if (indexA !== indexB) return indexA - indexB;
    return a.id.localeCompare(b.id);
  });
}
