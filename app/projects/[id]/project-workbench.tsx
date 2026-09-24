"use client";

import dynamic from "next/dynamic";
import { AudioLines } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowUp,
  ChevronDown,
  Compass,
  ImagePlus,
  Waves,
  ChevronRight,
  Coins,
  Copy,
  CornerDownRight,
  FileText,
  Clapperboard,
  Download,
  Folder,
  GalleryHorizontalEnd,
  Images,
  Infinity,
  Image as ImageIcon,
  Keyboard,
  Link2,
  ListChecks,
  Loader2,
  MessageSquare,
  PencilLine,
  Plus,
  Share2,
  Square,
  ThumbsDown,
  ThumbsUp,
  User,
  Check,
  Undo2,
  UserRound,
  Video,
  X,
  Zap,
} from "lucide-react";
import {
  Fragment as ReactFragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import TextareaAutosize from "react-textarea-autosize";
import { toast } from "sonner";
import { SidebarAuthBadge } from "@/app/app-shell";
import { ChromeTip, DesktopWindowChrome } from "@/app/desktop-window-chrome";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectTour } from "@/components/onboarding/project-tour";
import { OPEN_PROJECT_ACTIVITY_STORAGE_KEY } from "@/app/project-tab-activity";
import { LoadingCube } from "@/app/loading-cube";
import {
  AgentActivityOverlay,
} from "@/app/projects/[id]/agent-activity-overlay";
import { WorkbenchSidebar } from "@/app/projects/[id]/workbench-sidebar";
import {
  agentActivityFailureKey,
  agentActivityLifecycleEvent,
  activityFromEditorEvent,
  activityFromPaperEvent,
  activityFromToolReceipt,
  classifyActivityFailure,
  failedActivitiesFromOperationFiles,
  type AgentActivityItem,
  type EditorActivityEvent,
  type PaperActivityEvent,
} from "@/app/projects/[id]/agent-activity-state";
import type {
  AgentInputAnswer,
  AgentInteractionEvent,
  AgentInteractionRecord,
} from "@/lib/agent-interaction-types";
import { Markdown, type RefEntry, type RefResolver } from "@/app/markdown";
import { ToolCallRows } from "@/app/tool-call-row";
import { AttachmentTile } from "@/components/attachment-tile";
import { FloatingComposer } from "@/components/floating-composer";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import type {
  ChatToolCall,
  ProjectSnapshot,
  TimelineItem,
  WorkspaceFile,
} from "@/lib/workspace";
import type { VideoTrackingRecord } from "@/lib/video-object-tracking";
import {
  canvasChatRequestLabel,
  formatCanvasChatRequest,
  parseCanvasChatRequest,
} from "@/lib/canvas-chat";
import { CreditMenuSection } from "@/components/billing/credit-menu-section";
import { BuyCreditsModal } from "@/components/billing/buy-credits-modal";
import { refreshCredits, useCreditContext } from "@/lib/credit-context";
import { formatCredits } from "@/lib/format-credits";
import { useGenerationBilling } from "@/lib/use-generation-billing";
import {
  DEFAULT_CLIP_DURATION,
  type SequenceClip,
} from "./sequence-player";
import {
  StoryboardStrip,
  type StoryboardClipPrompt,
  type StoryboardFrame,
  type StoryboardItem,
  type StoryboardMediaVersion,
  type StoryboardPromptAttachment,
  type StoryboardPromptDraft,
} from "./storyboard-strip";
import {
  CanvasWorkspace,
  canvasAgentContextArtifact,
  type CanvasCard,
  type CanvasDeleteRequest,
  type CanvasDrawRequest,
  type CanvasEditClipRequest,
  type CanvasPromptRequest,
} from "./canvas-workspace";
import { canvasPieceKind, durableCanvasPieceStatus } from "./canvas-loading-piece";
import { ReferencesView } from "./references-view";
import {
  AgentContextIndicator,
  EMPTY_CANVAS_AGENT_CONTEXT_CANDIDATE,
  EMPTY_EDITOR_AGENT_CONTEXT,
  useAgentContextPublisher,
  useResolvedCanvasAgentContext,
  type CanvasAgentContextCandidate,
  type CanvasAgentContextCandidateArtifact,
  type AgentContextArtifact,
  type EditorAgentContext,
} from "./agent-context-publisher";
import type {
  ArtifactFocusIdentity,
  ArtifactFocusRequest,
  ArtifactFocusResult,
} from "@/opencut/host/artifact-focus-contract";
import {
  canonicalEditorPlacements,
  type CanonicalEditorPlacement,
} from "@/opencut/host/editor-placement-contract";

function parseFrontmatter(content: string | undefined) {
  if (!content?.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end < 0) return null;
  try {
    return {
      meta: JSON.parse(content.slice(4, end)) as Record<string, unknown>,
      body: content.slice(end + 5),
    };
  } catch {
    return null;
  }
}

function bodyAfterFrontmatter(content: string | undefined) {
  const parsed = parseFrontmatter(content);
  return parsed?.body.trim() ?? content?.trim() ?? "";
}

function artifactFocusIdentity(
  artifact: AgentContextArtifact,
): ArtifactFocusIdentity | null {
  if (
    !artifact.path ||
    !artifact.contentHash ||
    artifact.entityRevision === null
  ) {
    return null;
  }
  const versionHash = artifact.version?.sha256 ?? artifact.contentHash;
  if (!versionHash) return null;
  return {
    artifactId: artifact.artifactId,
    contentHash: artifact.contentHash,
    entityRevision: artifact.entityRevision,
    sourcePath: artifact.path,
    versionHash,
    versionId: artifact.version?.versionId ?? null,
    versionIndex: artifact.version?.index ?? null,
  };
}

function candidateMatchesResolvedArtifact(
  candidate: CanvasAgentContextCandidateArtifact,
  artifact: AgentContextArtifact,
) {
  return (
    candidate.artifactId === artifact.artifactId &&
    (candidate.version?.index ?? null) ===
      (artifact.version?.index ?? null) &&
    (candidate.version?.versionId ?? null) ===
      (artifact.version?.versionId ?? null)
  );
}

function firstHeading(body: string, fallback: string) {
  return body
    .split("\n")
    .find((line) => line.startsWith("# "))
    ?.slice(2)
    .trim() || fallback;
}

function stripPromptHeading(content: string) {
  return bodyAfterFrontmatter(content).replace(/^# .*(?:\r?\n){2}/, "").trim();
}

function attachmentFileTypeLabel(file: File) {
  if (file.type.includes("pdf")) return "PDF";
  if (file.type.startsWith("image/")) return file.type.split("/")[1]?.toUpperCase() || "Image";
  return file.type || "File";
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read attachment."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.includes(",") ? result.split(",").pop() ?? "" : result);
    };
    reader.readAsDataURL(file);
  });
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function chatAttachmentFromFile(file: File, index = 0): ChatLocalAttachment {
  const isImage = file.type.startsWith("image/");
  return {
    file,
    fileKind: isImage ? "image" : "file",
    fileType: attachmentFileTypeLabel(file),
    id: `${file.name}-${file.lastModified}-${file.size}-${Date.now()}-${index}`,
    label: file.name,
    src: isImage ? URL.createObjectURL(file) : null,
  };
}

function mediaPathSrc(projectId: string, value: string) {
  if (value.startsWith("media/")) {
    return `/api/projects/${projectId}/media/${value.replace(/^media\//, "")}`;
  }
  // Legacy chat attachments landed under uploads/**; the media route falls
  // back to that location for uploads-prefixed paths.
  if (value.startsWith("uploads/")) {
    return `/api/projects/${projectId}/media/${value}`;
  }
  return value;
}

function versionNumberFromPath(value: string | null) {
  if (!value) return null;
  const match = /\.v([1-9][0-9]*)\.[a-z0-9]+(?:[?#]|$)/i.exec(value);
  return match ? Number.parseInt(match[1], 10) : null;
}

function mediaSrcFromMeta(projectId: string, meta: Record<string, unknown>) {
  if (typeof meta.local_path === "string" && meta.local_path) {
    return mediaPathSrc(projectId, meta.local_path);
  }
  return typeof meta.url === "string" && meta.url ? meta.url : null;
}

function mediaVersionEntry(
  projectId: string,
  entry: Record<string, unknown>,
  order: number,
) {
  const localPath = typeof entry.local_path === "string" && entry.local_path ? entry.local_path : null;
  const url = typeof entry.url === "string" && entry.url ? entry.url : null;
  const src = localPath ? mediaPathSrc(projectId, localPath) : url;
  if (!src) return null;
  const explicitVersion =
    typeof entry.version === "number" && Number.isInteger(entry.version) && entry.version > 0
      ? entry.version
      : typeof entry.v === "number" && Number.isInteger(entry.v) && entry.v > 0
        ? entry.v
        : null;
  return {
    localPath,
    src,
    order,
    version: explicitVersion ?? versionNumberFromPath(localPath ?? url),
  };
}

function parseMediaVersions(
  projectId: string,
  meta: Record<string, unknown>,
  activeSrc: string | null,
): StoryboardMediaVersion[] {
  const raw = Array.isArray(meta.versions) ? meta.versions : [];
  const entries: Array<{
    localPath: string | null;
    src: string;
    order: number;
    version: number | null;
  }> = [];
  const seenSrc = new Set<string>();
  const seenVersion = new Set<number>();

  raw.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const entry = mediaVersionEntry(projectId, item as Record<string, unknown>, index);
    if (!entry || seenSrc.has(entry.src)) return;
    if (entry.version !== null && seenVersion.has(entry.version)) return;
    seenSrc.add(entry.src);
    if (entry.version !== null) seenVersion.add(entry.version);
    entries.push(entry);
  });

  const activeLocal =
    typeof meta.local_path === "string" && meta.local_path ? meta.local_path : null;
  const activeVersion = versionNumberFromPath(activeLocal ?? activeSrc);
  if (activeSrc && activeVersion !== null) {
    const sameVersion = entries.findIndex((entry) => entry.version === activeVersion);
    if (sameVersion >= 0 && entries[sameVersion]?.src !== activeSrc) {
      seenSrc.delete(entries[sameVersion]!.src);
      entries[sameVersion] = {
        ...entries[sameVersion]!,
        localPath: activeLocal,
        src: activeSrc,
      };
      seenSrc.add(activeSrc);
    }
  }
  if (
    activeSrc &&
    !seenSrc.has(activeSrc) &&
    (activeVersion === null || !seenVersion.has(activeVersion))
  ) {
    entries.push({
      localPath: activeLocal,
      src: activeSrc,
      order: entries.length,
      version: activeVersion,
    });
  }
  if (!entries.length) return [];

  entries.sort((a, b) => {
    if (a.version !== null && b.version !== null && a.version !== b.version) {
      return a.version - b.version;
    }
    return a.order - b.order;
  });
  const currentIndex =
    activeVersion !== null
      ? entries.findIndex((entry) => entry.version === activeVersion)
      : activeSrc
        ? entries.findIndex((entry) => entry.src === activeSrc)
        : -1;
  const fallbackCurrent = currentIndex >= 0 ? currentIndex : entries.length - 1;

  return entries.map((entry, index) => ({
    id: entry.src,
    src: entry.src,
    label: `v${entry.version ?? index + 1}`,
    isCurrent: index === fallbackCurrent,
    path: entry.localPath,
    revision: entry.version ?? index + 1,
  }));
}

function parseVideoTrackingRecords(files: WorkspaceFile[]) {
  const records: VideoTrackingRecord[] = [];
  for (const file of files) {
    if (!file.path.startsWith("tracking/") || !file.path.endsWith(".json") || !file.content) {
      continue;
    }
    try {
      const parsed = JSON.parse(file.content) as VideoTrackingRecord;
      if (
        parsed &&
        typeof parsed.id === "string" &&
        parsed.source &&
        typeof parsed.source.id === "string" &&
        (
          parsed.status === "queued" ||
          parsed.status === "running" ||
          parsed.status === "completed" ||
          parsed.status === "failed"
        )
      ) {
        records.push(parsed);
      }
    } catch {
      // Ignore malformed tracking records so one bad job cannot break the board.
    }
  }
  return records;
}

function sectionAfterHeading(body: string, heading: string) {
  const marker = `## ${heading}`;
  const start = body.indexOf(marker);
  if (start < 0) return "";
  const after = body.slice(start + marker.length).replace(/^\s+/, "");
  const next = after.search(/\n## /);
  return (next >= 0 ? after.slice(0, next) : after).trim();
}

function asStringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function firstUrl(value: unknown) {
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === "string" && item.trim().length > 0) ?? null;
  }
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function referencePortfolioHasMedia(files: WorkspaceFile[], referenceId: string) {
  return files.some((file) => {
    if (!file.path.endsWith("/portfolio.md")) return false;
    const parsed = parseFrontmatter(file.content);
    return parsed?.meta.reference_id === referenceId && Boolean(firstUrl(parsed.meta.urls));
  });
}

function promptSummary(prompt: string, fallback: string) {
  const firstUseful =
    prompt
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#") && !line.match(/^(Start frame|Action|Environment|Camera|Speed|Lighting|End frame|Dialogue)/i)) ??
    fallback;
  return firstUseful.length > 150 ? `${firstUseful.slice(0, 147).trim()}…` : firstUseful;
}

const REF_ID_PREFIXES = new Set([
  "aud",
  "audio",
  "char",
  "character",
  "env",
  "fx",
  "loc",
  "obj",
  "prop",
  "sfx",
  "style",
]);

function humanizeRefId(id: string) {
  const parts = id.split("_").filter(Boolean);
  if (parts.length > 1 && REF_ID_PREFIXES.has(parts[0]!.toLowerCase())) parts.shift();
  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .trim() || id;
}

function titleFromMeta(meta: Record<string, unknown>, body: string, fallback: string) {
  for (const key of ["title", "name", "display_name"]) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return firstHeading(body, fallback);
}

function buildRefResolver(snapshot: ProjectSnapshot): RefResolver {
  const refs = new Map<string, RefEntry>();
  const portfolioThumbs = new Map<string, string>();

  for (const file of snapshot.files) {
    if (!file.path.endsWith("/portfolio.md")) continue;
    const parsed = parseFrontmatter(file.content);
    if (!parsed) continue;
    const url = firstUrl(parsed.meta.urls);
    const referenceId =
      typeof parsed.meta.reference_id === "string"
        ? parsed.meta.reference_id
        : typeof parsed.meta.id === "string"
          ? parsed.meta.id.replace(/_portfolio$/, "")
          : null;
    if (referenceId && url) portfolioThumbs.set(referenceId, mediaPathSrc(snapshot.project.id, url));
  }

  for (const file of snapshot.files) {
    if (file.path.endsWith("_README.md")) continue;
    const parsed = parseFrontmatter(file.content);
    if (!parsed || typeof parsed.meta.id !== "string") continue;
    const body = parsed.body.trim();
    const id = parsed.meta.id;

    if (file.path.startsWith("keyframes/") && file.path.endsWith(".md")) {
      const localPath =
        typeof parsed.meta.local_path === "string" ? parsed.meta.local_path : null;
      const thumbUrl =
        typeof parsed.meta.url === "string" && parsed.meta.url
          ? parsed.meta.url
          : localPath
            ? mediaPathSrc(snapshot.project.id, localPath)
            : null;
      refs.set(id, {
        id,
        kind: "keyframe",
        path: file.path,
        thumbUrl,
        title: titleFromMeta(parsed.meta, body, id),
      });
      continue;
    }

    if (file.path.startsWith("clips/") && file.path.endsWith(".md")) {
      const mediaUrl =
        typeof parsed.meta.url === "string" && parsed.meta.url
          ? parsed.meta.url
          : typeof parsed.meta.local_path === "string" && parsed.meta.local_path
            ? mediaPathSrc(snapshot.project.id, parsed.meta.local_path)
            : null;
      const posterUrl =
        firstUrl(parsed.meta.poster_url) ??
        firstUrl(parsed.meta.posterUrl) ??
        firstUrl(parsed.meta.thumbnail_url) ??
        mediaUrl;
      refs.set(id, {
        id,
        kind: "clip",
        path: file.path,
        posterUrl,
        title: titleFromMeta(parsed.meta, body, id),
      });
      continue;
    }

    if (file.path.endsWith("/reference.md")) {
      refs.set(id, {
        id,
        kind: "reference",
        path: file.path,
        thumbUrl: portfolioThumbs.get(id) ?? null,
        title: titleFromMeta(parsed.meta, body, humanizeRefId(id)),
      });
      continue;
    }

    if (
      (file.path.startsWith("uploads/") || file.path.startsWith("assets/")) &&
      file.path.endsWith(".md")
    ) {
      const localPath =
        typeof parsed.meta.local_path === "string" ? parsed.meta.local_path : null;
      const url =
        typeof parsed.meta.url === "string" && parsed.meta.url
          ? parsed.meta.url
          : localPath
            ? mediaPathSrc(snapshot.project.id, localPath)
            : null;
      const metaKind = typeof parsed.meta.kind === "string" ? parsed.meta.kind : null;
      refs.set(id, {
        id,
        kind: metaKind ?? (file.path.startsWith("uploads/") ? "upload" : "asset"),
        path: file.path,
        posterUrl: url,
        thumbUrl: url,
        title: titleFromMeta(parsed.meta, body, id),
      });
    }
  }

  return (id: string) => refs.get(id);
}

const CUT_LABELS: Record<string, string> = {
  cut: "cut",
  hard_cut_same_assets: "hard cut",
  time_jump: "time jump",
  camera_reset: "cam reset",
  stylized_transition: "stylized",
};

/**
 * Storyboard in FILM order: walk clips (timeline order, then cut-map index),
 * emitting each clip's keyframes once — continuous chains share nodes so the
 * shared frame appears a single time with motion flowing through it — and a
 * cut connector wherever consecutive clips do not share a frame.
 */
function snapshotHasVideoGeneration(snapshot: ProjectSnapshot) {
  return snapshot.files.some((file) => {
    if (!file.path.startsWith("clips/") || !file.path.endsWith(".md")) return false;
    const parsed = parseFrontmatter(file.content);
    if (!parsed) return false;
    const status = typeof parsed.meta.status === "string" ? parsed.meta.status : "planned";
    return Boolean(
      status === "active" ||
        status === "pending" ||
        (typeof parsed.meta.url === "string" && parsed.meta.url) ||
        (typeof parsed.meta.local_path === "string" && parsed.meta.local_path) ||
        (Array.isArray(parsed.meta.versions) && parsed.meta.versions.length > 0),
    );
  });
}

function buildStoryboard(
  snapshot: ProjectSnapshot,
  options: { showClips?: boolean } = {},
): StoryboardItem[] {
  const showClips = options.showClips ?? true;
  const frames = new Map<string, StoryboardFrame>();
  const framePromptInputs = new Map<
    string,
    { identityAnchors: string[]; stateAnchor: string | null }
  >();
  const portfolioImages = new Map<string, { label: string; src: string | null }>();
  type ClipRow = {
    id: string;
    index: number;
    title: string;
    status: string;
    src: string | null;
    from: string | null;
    to: string | null;
    transition: string | null;
    duration: number | null;
    prompt: StoryboardClipPrompt;
    versions: StoryboardMediaVersion[];
  };
  const clips: ClipRow[] = [];
  const promptFiles = new Map(
    snapshot.files
      .filter((file) => file.path.startsWith("prompts/") && file.path.endsWith(".prompt.md"))
      .map((file) => [file.path, stripPromptHeading(file.content ?? "")] as const),
  );

  for (const file of snapshot.files) {
    if (!file.path.endsWith("portfolio.md")) continue;
    const parsed = parseFrontmatter(file.content);
    if (!parsed || typeof parsed.meta.id !== "string") continue;
    const url = firstUrl(parsed.meta.urls);
    const referenceId =
      typeof parsed.meta.reference_id === "string" ? parsed.meta.reference_id : parsed.meta.id;
    portfolioImages.set(parsed.meta.id, {
      label: referenceId,
      src: url ? mediaPathSrc(snapshot.project.id, url) : null,
    });
    portfolioImages.set(referenceId, {
      label: referenceId,
      src: url ? mediaPathSrc(snapshot.project.id, url) : null,
    });
  }

  for (const file of snapshot.files) {
    if (file.path.endsWith("_README.md")) continue;
    if (file.path.startsWith("keyframes/") && file.path.endsWith(".md")) {
      const parsed = parseFrontmatter(file.content);
      if (!parsed || typeof parsed.meta.id !== "string") continue;
      const localPath =
        typeof parsed.meta.local_path === "string" ? parsed.meta.local_path : null;
      const body = parsed.body.trim();
      const title =
        body
          .split("\n")
          .find((line) => line.startsWith("# "))
          ?.slice(2)
          .trim() ?? parsed.meta.id;
      const assetId =
        typeof parsed.meta.asset_id === "string" ? parsed.meta.asset_id : `asset_${parsed.meta.id}`;
      const exactPrompt = promptFiles.get(`prompts/${assetId}.prompt.md`) ?? "";
      const plannedPrompt =
        sectionAfterHeading(body, "Prompt") ||
        body.split(/\n## Media\b/)[0]?.trim() ||
        title;
      const displayPrompt = exactPrompt || plannedPrompt || "Prompt plan is not available yet.";
      const aspectRatio =
        typeof parsed.meta.aspect_ratio === "string" ? parsed.meta.aspect_ratio : null;
      const activeSrc = mediaSrcFromMeta(snapshot.project.id, parsed.meta);
      frames.set(parsed.meta.id, {
        aspectRatio,
        id: parsed.meta.id,
        title,
        status: typeof parsed.meta.status === "string" ? parsed.meta.status : "planned",
        src: activeSrc,
        versions: parseMediaVersions(snapshot.project.id, parsed.meta, activeSrc),
        path: file.path,
        prompt: {
          id: `keyframe:${parsed.meta.id}`,
          sourceId: parsed.meta.id,
          subject: "keyframe",
          title,
          status: typeof parsed.meta.status === "string" ? parsed.meta.status : "planned",
          aspectRatio,
          kind: exactPrompt ? "final" : "planned",
          summary: promptSummary(displayPrompt, title),
          text: displayPrompt,
          canCopy: Boolean(exactPrompt),
          sourcePath: exactPrompt ? `prompts/${assetId}.prompt.md` : file.path,
          attachments: [],
        },
      });
      framePromptInputs.set(parsed.meta.id, {
        identityAnchors: asStringList(parsed.meta.identity_anchors),
        stateAnchor:
          typeof parsed.meta.state_anchor === "string" ? parsed.meta.state_anchor : null,
      });
    }
    if (file.path.startsWith("clips/") && file.path.endsWith(".md")) {
      const parsed = parseFrontmatter(file.content);
      if (!parsed || typeof parsed.meta.id !== "string") continue;
      const status = typeof parsed.meta.status === "string" ? parsed.meta.status : "planned";
      if (status === "superseded" || status === "rejected") continue;
      const body = parsed.body.trim();
      const title = firstHeading(body, parsed.meta.id);
      const assetId =
        typeof parsed.meta.asset_id === "string" ? parsed.meta.asset_id : `asset_${parsed.meta.id}`;
      const exactPrompt = promptFiles.get(`prompts/${assetId}.prompt.md`) ?? "";
      const plannedPrompt =
        sectionAfterHeading(body, "Prompt") ||
        [
          typeof parsed.meta.start_state === "string" ? `Start: ${parsed.meta.start_state}` : "",
          asStringList(parsed.meta.action_beats).length
            ? `Action:\n${asStringList(parsed.meta.action_beats)
                .map((beat, index) => `${index + 1}. ${beat}`)
                .join("\n")}`
            : "",
          typeof parsed.meta.camera_move === "string" ? `Camera: ${parsed.meta.camera_move}` : "",
          typeof parsed.meta.end_state === "string" ? `End: ${parsed.meta.end_state}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
      const displayPrompt = exactPrompt || plannedPrompt || "Prompt plan is not available yet.";
      const activeClipSrc = mediaSrcFromMeta(snapshot.project.id, parsed.meta);
      clips.push({
        id: parsed.meta.id,
        index: typeof parsed.meta.index === "number" ? parsed.meta.index : 0,
        title,
        status,
        src: activeClipSrc,
        versions: parseMediaVersions(snapshot.project.id, parsed.meta, activeClipSrc),
        from: typeof parsed.meta.from_keyframe === "string" ? parsed.meta.from_keyframe : null,
        to: typeof parsed.meta.to_keyframe === "string" ? parsed.meta.to_keyframe : null,
        transition:
          typeof parsed.meta.transition_from_previous === "string"
            ? parsed.meta.transition_from_previous
            : null,
        duration:
          typeof parsed.meta.duration_seconds === "number" ? parsed.meta.duration_seconds : null,
        prompt: {
          id: `clip:${parsed.meta.id}`,
          sourceId: parsed.meta.id,
          subject: "clip",
          clipId: parsed.meta.id,
          title,
          status,
          duration:
            typeof parsed.meta.duration_seconds === "number" ? parsed.meta.duration_seconds : null,
          aspectRatio:
            typeof parsed.meta.aspect_ratio === "string" ? parsed.meta.aspect_ratio : null,
          kind: exactPrompt ? "final" : "planned",
          summary: promptSummary(displayPrompt, title),
          text: displayPrompt,
          canCopy: Boolean(exactPrompt),
          sourcePath: exactPrompt ? `prompts/${assetId}.prompt.md` : file.path,
          attachments: [],
        },
      });
    }
  }

  for (const frame of frames.values()) {
    const inputs = framePromptInputs.get(frame.id);
    const attachments: StoryboardPromptAttachment[] = [];
    for (const anchor of inputs?.identityAnchors ?? []) {
      const portfolio = portfolioImages.get(anchor);
      attachments.push({
        id: `ref:${anchor}`,
        kind: "reference",
        label: portfolio?.label ?? anchor,
        src: portfolio?.src ?? null,
      });
    }
    if (inputs?.stateAnchor) {
      const stateFrame = frames.get(inputs.stateAnchor);
      attachments.push({
        id: `state:${inputs.stateAnchor}`,
        kind: "keyframe",
        label: `state: ${inputs.stateAnchor}`,
        src: stateFrame?.src ?? null,
      });
    }
    frame.prompt.attachments = attachments;
  }

  for (const clip of clips) {
    const from = clip.from ? frames.get(clip.from) : null;
    const to = clip.to ? frames.get(clip.to) : null;
    clip.prompt.aspectRatio = clip.prompt.aspectRatio ?? from?.aspectRatio ?? to?.aspectRatio ?? null;
    clip.prompt.attachments = [
      ...(from
        ? [{
            id: `from:${from.id}`,
            kind: "keyframe" as const,
            label: `start: ${from.id}`,
            src: from.src,
          }]
        : []),
      ...(to
        ? [{
            id: `to:${to.id}`,
            kind: "keyframe" as const,
            label: `end: ${to.id}`,
            src: to.src,
          }]
        : []),
    ];
  }

  const timelineOrder = new Map(
    snapshot.timeline
      .map((item, position) => [item.clip_id, position] as const)
      .filter((entry): entry is [string, number] => typeof entry[0] === "string"),
  );
  clips.sort((a, b) => {
    const ta = timelineOrder.get(a.id);
    const tb = timelineOrder.get(b.id);
    if (ta !== undefined && tb !== undefined) return ta - tb;
    if (ta !== undefined) return -1;
    if (tb !== undefined) return 1;
    if (a.index !== b.index) return a.index - b.index;
    return a.id.localeCompare(b.id);
  });

  const items: StoryboardItem[] = [];
  const emitted = new Set<string>();
  let lastFrameId: string | null = null;
  for (const clip of clips) {
    const from = clip.from ? frames.get(clip.from) : null;
    const to = clip.to ? frames.get(clip.to) : null;
    if (from && clip.from !== lastFrameId) {
      if (showClips && lastFrameId !== null) {
        items.push({
          kind: "cut",
          label: CUT_LABELS[clip.transition ?? ""] ?? "cut",
        });
      }
      items.push({ kind: "frame", frame: from });
      emitted.add(from.id);
      lastFrameId = from.id;
    }
    if (to) {
      if (showClips && from?.src && to.src) {
        items.push({
          kind: "motion",
          label: clip.duration ? `${clip.duration}s` : "",
          src: clip.src,
          prompt: clip.prompt,
          versions: clip.versions,
        });
      }
      items.push({ kind: "frame", frame: to });
      emitted.add(to.id);
      lastFrameId = to.id;
    }
  }
  // Keyframes not yet placed in any clip (plans, captures) trail at the end.
  for (const frame of [...frames.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!emitted.has(frame.id)) items.push({ kind: "frame", frame });
  }
  return items;
}

/** Human phrasing for the live action ticker (composer + chat runs). */
const ACTION_TICKER_LABELS: Record<string, string> = {
  addClipToEditorTimeline: "Placing clip in the edit",
  askUser: "Waiting for your answer",
  captureFrame: "Capturing frame",
  checkProject: "Checking project",
  addAudioToTimeline: "Placing audio in the edit",
  crossfadeAudio: "Crossfading audio",
  crossfadeClipBridges: "Smoothing cuts",
  extractFrame: "Extracting frame",
  extractShots: "Splitting into shots",
  generateAudio: "Generating audio",
  generateClip: "Generating clip",
  generateImage: "Generating image",
  generateKeyframe: "Generating keyframe",
  fadeElement: "Applying fade",
  generateMusic: "Generating music",
  generateReferencePortfolio: "Building portfolio",
  generateSpeech: "Generating voice-over",
  generateVideo: "Generating clip",
  generateVideoFromImage: "Animating image into clip",
  generateVideoFromReferences: "Generating clip from references",
  injectCharacter: "Compositing character",
  inspectFrontmatter: "Reading project",
  listFiles: "Scanning workspace",
  listSkills: "Consulting craft skills",
  patchFile: "Updating project files",
  prepareClipPrompts: "Planning clips",
  readFile: "Reading project",
  readSkill: "Consulting craft skills",
  loadWorkflow: "Loading workflow",
  organizeCanvas: "Organizing the canvas",
  splitClipsByShots: "Splitting clips into shots",
  designVoice: "Designing a voice",
  patchVideoEditor: "Editing the cut",
  readVideoEditor: "Reading the edit",
  traceLineage: "Tracing lineage",
  updatePlan: "Updating the plan",
  recordFinding: "Noting an issue",
  resolveFinding: "Resolving an issue",
  reviewKeyframes: "Reviewing frames",
  saveImageToCanvas: "Saving image to canvas",
  searchImages: "Searching images",
  setElementProperties: "Adjusting the edit",
  traceReferences: "Tracing references",
  verifyKeyframeIdentity: "Verifying identity",
  viewImage: "Studying reference",
  viewWorkspaceImage: "Studying reference",
  webSearch: "Searching the web",
  writeFile: "Writing project files",
  writeVideoEditor: "Editing the cut",
};

function composerActionLabel(toolName: string, title: string | null) {
  const base = ACTION_TICKER_LABELS[toolName] ?? "Working";
  return title ? `${base} — ${title}` : `${base}…`;
}

const REFERENCE_GROUP_LABEL: Record<string, string> = {
  audio: "Audio",
  characters: "Characters",
  environments: "Locations",
  props: "Objects",
  styles: "Styles",
};

type ComposerPlaceholder = {
  aspectRatio: string | null;
  displayWidth?: number | null;
  id: string;
  kind: "audio" | "clip" | "image";
  remediation?: string | null;
  refs: { id: string; thumb: string | null }[];
  settled: boolean;
  sourceAspectRatio?: string | null;
  toolAspectRatio?: string | null;
  workflowAspectRatio?: string | null;
  state:
    | "awaiting-input"
    | "cancelled"
    | "failed"
    | "generating"
    | "preparing"
    | "processing"
    | "queued";
  title: string;
};

function buildCanvasCards(
  snapshot: ProjectSnapshot,
  storyboardItems: StoryboardItem[],
  trackingRecords: VideoTrackingRecord[],
  workingPaths: Set<string>,
  generatingReferences: { id: string; category: string | null; title: string | null }[],
  composerPlaceholders: ComposerPlaceholder[],
  composerSpawnOrigins: Record<string, string>,
  composerHiddenArtifacts: Record<string, true>,
): CanvasCard[] {
  const cards: CanvasCard[] = [];
  const seen = new Set<string>();
  const frames = new Map<string, CanvasCard>();
  const activePlaceholderIds = new Set(composerPlaceholders.map((entry) => entry.id));
  const activeComposerOrigins = new Map(
    Object.entries(composerSpawnOrigins).filter(([, placeholderId]) =>
      activePlaceholderIds.has(placeholderId),
    ),
  );
  const composerReplacementCards = new Map<string, CanvasCard>();
  const isHiddenComposerArtifact = (card: Pick<CanvasCard, "id" | "path">) =>
    Boolean(composerHiddenArtifacts[card.id] || composerHiddenArtifacts[card.path]);
  const holdComposerReplacement = (card: CanvasCard) => {
    if (isHiddenComposerArtifact(card)) return true;
    const placeholderId = activeComposerOrigins.get(card.id) ?? activeComposerOrigins.get(card.path);
    if (!placeholderId) return false;
    composerReplacementCards.set(placeholderId, card);
    return true;
  };
  const tracksBySourceId = new Map<string, VideoTrackingRecord[]>();
  const promptFiles = new Map(
    snapshot.files
      .filter((file) => file.path.startsWith("prompts/") && file.path.endsWith(".prompt.md"))
      .map((file) => [file.path, stripPromptHeading(file.content ?? "")] as const),
  );

  for (const record of trackingRecords) {
    const existing = tracksBySourceId.get(record.source.id) ?? [];
    existing.push(record);
    tracksBySourceId.set(record.source.id, existing);
  }
  for (const records of tracksBySourceId.values()) {
    records.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  const groupMetaByPath = new Map<string, CanvasCard["group"]>();
  for (const file of snapshot.files) {
    const parsed = parseFrontmatter(file.content);
    if (!parsed || typeof parsed.meta.canvas_group !== "string") continue;
    groupMetaByPath.set(file.path, {
      id: parsed.meta.canvas_group,
      index:
        typeof parsed.meta.canvas_group_index === "number" ? parsed.meta.canvas_group_index : 0,
      layout: parsed.meta.canvas_group_layout === "grid" ? ("grid" as const) : null,
      organizedAt:
        typeof parsed.meta.canvas_group_organized_at === "string"
          ? parsed.meta.canvas_group_organized_at
          : null,
      title:
        typeof parsed.meta.canvas_group_title === "string"
          ? parsed.meta.canvas_group_title
          : parsed.meta.canvas_group,
    });
  }

  for (const item of storyboardItems) {
    if (item.kind !== "frame") continue;
    const card: CanvasCard = {
      aspectRatio: item.frame.aspectRatio,
      generating: item.frame.generating,
      group: groupMetaByPath.get(item.frame.path) ?? null,
      id: item.frame.id,
      kind: "keyframe",
      path: item.frame.path,
      prompt: item.frame.prompt,
      src: item.frame.src,
      status: item.frame.status,
      title: item.frame.title,
      versions: item.frame.versions,
    };
    frames.set(card.id, card);
  }

  // Portfolio contact sheets double as keyframe records (generate_image
  // writes one), but their pixels already front the reference tile — showing
  // both reads as a duplicate. Hide keyframes whose media IS a portfolio's.
  const portfolioSourceUrls = new Set<string>();
  for (const file of snapshot.files) {
    if (!/^references\/[^/]+\/[^/]+\/portfolio\.md$/.test(file.path)) continue;
    const parsed = parseFrontmatter(file.content);
    if (!parsed) continue;
    for (const url of asStringList(parsed.meta.urls)) portfolioSourceUrls.add(url);
    if (typeof parsed.meta.display_url === "string") {
      portfolioSourceUrls.add(parsed.meta.display_url);
    }
  }
  const keyframeRecordUrl = new Map<string, string>();
  if (portfolioSourceUrls.size) {
    for (const file of snapshot.files) {
      const match = /^keyframes\/([^/]+)\.md$/.exec(file.path);
      if (!match) continue;
      const parsed = parseFrontmatter(file.content);
      const url = parsed && typeof parsed.meta.url === "string" ? parsed.meta.url : null;
      if (url) keyframeRecordUrl.set(match[1]!, url);
    }
  }

  // Keyframes are canvas tiles in their own right (the storyboard view is
  // gone); the frames map above also feeds clip attachment chips below.
  for (const frame of frames.values()) {
    if (seen.has(`keyframe:${frame.id}`)) continue;
    if (frame.status === "rejected" || frame.status === "superseded") continue;
    if (portfolioSourceUrls.has(keyframeRecordUrl.get(frame.id) ?? "")) {
      seen.add(`keyframe:${frame.id}`);
      continue;
    }
    if (isHiddenComposerArtifact(frame)) {
      seen.add(`keyframe:${frame.id}`);
      continue;
    }
    if (holdComposerReplacement(frame)) {
      seen.add(`keyframe:${frame.id}`);
      continue;
    }
    cards.push(frame);
    seen.add(`keyframe:${frame.id}`);
  }

  for (const file of snapshot.files) {
    if (!file.path.startsWith("clips/") || !file.path.endsWith(".md")) continue;
    const parsed = parseFrontmatter(file.content);
    if (!parsed || typeof parsed.meta.id !== "string") continue;
    if (parsed.meta.type !== "clip") continue;
    const id = parsed.meta.id;
    if (seen.has(`clip:${id}`)) continue;
    const status = typeof parsed.meta.status === "string" ? parsed.meta.status : "planned";
    if (status === "superseded" || status === "rejected") continue;
    if (composerHiddenArtifacts[id] || composerHiddenArtifacts[file.path]) {
      seen.add(`clip:${id}`);
      continue;
    }
    const body = parsed.body.trim();
    const title = firstHeading(body, id);
    const assetId =
      typeof parsed.meta.asset_id === "string" ? parsed.meta.asset_id : `asset_${id}`;
    const exactPrompt = promptFiles.get(`prompts/${assetId}.prompt.md`) ?? "";
    const plannedPrompt =
      sectionAfterHeading(body, "Prompt") ||
      [
        typeof parsed.meta.start_state === "string" ? `Start: ${parsed.meta.start_state}` : "",
        asStringList(parsed.meta.action_beats).length
          ? `Action:\n${asStringList(parsed.meta.action_beats)
              .map((beat, index) => `${index + 1}. ${beat}`)
              .join("\n")}`
          : "",
        typeof parsed.meta.camera_move === "string" ? `Camera: ${parsed.meta.camera_move}` : "",
        typeof parsed.meta.end_state === "string" ? `End: ${parsed.meta.end_state}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    const displayPrompt = exactPrompt || plannedPrompt || "Describe the change you want.";
    const fromId =
      typeof parsed.meta.from_keyframe === "string" ? parsed.meta.from_keyframe : null;
    const toId = typeof parsed.meta.to_keyframe === "string" ? parsed.meta.to_keyframe : null;
    const from = fromId ? frames.get(fromId) : null;
    const to = toId ? frames.get(toId) : null;
    const activeSrc = mediaSrcFromMeta(snapshot.project.id, parsed.meta);
    const prompt: StoryboardClipPrompt = {
      aspectRatio:
        typeof parsed.meta.aspect_ratio === "string"
          ? parsed.meta.aspect_ratio
          : from?.aspectRatio ?? to?.aspectRatio ?? null,
      attachments: [
        ...(from
          ? [{
              id: `from:${from.id}`,
              kind: "keyframe" as const,
              label: `start: ${from.id}`,
              src: from.src,
            }]
          : []),
        ...(to
          ? [{
              id: `to:${to.id}`,
              kind: "keyframe" as const,
              label: `end: ${to.id}`,
              src: to.src,
            }]
          : []),
      ],
      canCopy: Boolean(exactPrompt),
      clipId: id,
      duration:
        typeof parsed.meta.duration_seconds === "number" ? parsed.meta.duration_seconds : null,
      id: `clip:${id}`,
      kind: exactPrompt ? "final" : "planned",
      sourceId: id,
      sourcePath: exactPrompt ? `prompts/${assetId}.prompt.md` : file.path,
      status,
      subject: "clip",
      summary: promptSummary(displayPrompt, title),
      text: displayPrompt,
      title,
    };
    const card: CanvasCard = {
      aspectRatio: prompt.aspectRatio,
      duration: prompt.duration,
      generating: status === "generating" || workingPaths.has(file.path),
      group: groupMetaByPath.get(file.path) ?? null,
      id,
      kind: "clip",
      path: file.path,
      prompt,
      src: activeSrc,
      status,
      title,
      tracks: tracksBySourceId.get(id) ?? [],
      versions: parseMediaVersions(snapshot.project.id, parsed.meta, activeSrc),
    };
    if (holdComposerReplacement(card)) {
      seen.add(`clip:${id}`);
      continue;
    }
    cards.push(card);
    seen.add(`clip:${id}`);
  }

  for (const file of snapshot.files) {
    if (!file.path.startsWith("uploads/") || !file.path.endsWith(".md")) continue;
    const parsed = parseFrontmatter(file.content);
    if (!parsed || typeof parsed.meta.id !== "string") continue;
    if (parsed.meta.type !== "upload") continue;
    if (parsed.meta.status === "rejected") continue;
    const id = parsed.meta.id;
    if (seen.has(`upload:${id}`)) continue;
    if (composerHiddenArtifacts[id] || composerHiddenArtifacts[file.path]) {
      seen.add(`upload:${id}`);
      continue;
    }
    const pieceKind = canvasPieceKind(parsed.meta.kind);
    const kind =
      pieceKind === "video"
        ? ("video" as const)
        : pieceKind === "audio"
          ? ("audio" as const)
          : ("image" as const);
    const activeSrc = mediaSrcFromMeta(snapshot.project.id, parsed.meta);
    const card: CanvasCard = {
      aspectRatio:
        typeof parsed.meta.aspect_ratio === "string" ? parsed.meta.aspect_ratio : null,
      group: groupMetaByPath.get(file.path) ?? null,
      id,
      kind,
      path: file.path,
      pieceKind,
      src: activeSrc,
      status: durableCanvasPieceStatus(parsed.meta.status, Boolean(activeSrc)),
      toolAspectRatio:
        typeof parsed.meta.tool_aspect_ratio === "string"
          ? parsed.meta.tool_aspect_ratio
          : null,
      title:
        typeof parsed.meta.original_name === "string"
          ? parsed.meta.original_name
          : firstHeading(parsed.body.trim(), id),
      tracks: tracksBySourceId.get(id) ?? [],
      workflowAspectRatio:
        typeof parsed.meta.workflow_aspect_ratio === "string"
          ? parsed.meta.workflow_aspect_ratio
          : null,
    };
    if (holdComposerReplacement(card)) {
      seen.add(`upload:${id}`);
      continue;
    }
    cards.push(card);
    seen.add(`upload:${id}`);
  }

  // Reference assets (characters, locations, objects, styles) live on the
  // canvas too, auto-grouped per category. Tiles prefer the profile/display
  // image when one exists (library-designed refs), else the portfolio sheet.
  const portfolioByRef = new Map<
    string,
    { displayUrl: string | null; status: string; urls: string[] }
  >();
  for (const file of snapshot.files) {
    if (!file.path.endsWith("/portfolio.md")) continue;
    const parsed = parseFrontmatter(file.content);
    if (!parsed) continue;
    const refId =
      typeof parsed.meta.reference_id === "string"
        ? parsed.meta.reference_id
        : typeof parsed.meta.id === "string"
          ? parsed.meta.id.replace(/_portfolio$/, "")
          : null;
    if (!refId) continue;
    portfolioByRef.set(refId, {
      displayUrl:
        typeof parsed.meta.display_url === "string" ? parsed.meta.display_url : null,
      status: typeof parsed.meta.status === "string" ? parsed.meta.status : "",
      urls: asStringList(parsed.meta.urls),
    });
  }
  const generatingRefIds = new Set(generatingReferences.map((entry) => entry.id));
  const referenceGroupCounters = new Map<string, number>();
  const nextReferenceIndex = (category: string) => {
    const index = referenceGroupCounters.get(category) ?? 0;
    referenceGroupCounters.set(category, index + 1);
    return index;
  };
  for (const file of snapshot.files) {
    const match = /^references\/([^/]+)\/([^/]+)\/reference\.md$/.exec(file.path);
    if (!match) continue;
    const parsed = parseFrontmatter(file.content);
    if (!parsed || typeof parsed.meta.id !== "string") continue;
    const id = parsed.meta.id;
    if (seen.has(`reference:${id}`)) continue;
    const category = match[1]!;
    const portfolio = portfolioByRef.get(id);
    const mediaUrl = portfolio?.displayUrl ?? portfolio?.urls[0] ?? null;
    // Old references predate profile images — their tile falls back to the
    // 3x3 contact sheet, zoomed into the first cell so it reads as a profile.
    const sheetFallback = Boolean(!portfolio?.displayUrl && portfolio?.urls[0]);
    // Tile name resolution: frontmatter title (the actual NAME — "Lionel
    // Messi") wins; body headings are often just "Character Reference". Last
    // resort: humanize the id.
    const metaTitle = typeof parsed.meta.title === "string" ? parsed.meta.title.trim() : "";
    const strippedHeading = firstHeading(parsed.body.trim(), id)
      .replace(/^(character|style|location|environment|object|prop)s?\s+reference\s*[-–—:]?\s*/i, "")
      .trim();
    const humanizedId = id
      .replace(/^(char|character|env|loc|prop|obj|style)_/i, "")
      .replaceAll("_", " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
    const rawTitle = metaTitle || strippedHeading || humanizedId;
    // The drawer's prompt for a reference is the identity document itself —
    // the durable description of the character/place — not the contact
    // sheet's generation prompt.
    const referenceBody = parsed.body
      .trim()
      .replace(/^#\s+[^\n]*\n+/, "")
      .trim();
    const portfolioWorking = workingPaths.has(
      `references/${category}/${id}/portfolio.md`,
    );
    cards.push({
      prompt: referenceBody
        ? {
            attachments: [],
            canCopy: true,
            id: `reference:${id}`,
            kind: "final",
            sourceId: id,
            sourcePath: file.path,
            status: "active",
            subject: "reference",
            summary: referenceBody.slice(0, 160),
            text: referenceBody,
            title: rawTitle,
          }
        : undefined,
      aspectRatio: "1:1",
      generating:
        portfolioWorking ||
        (!mediaUrl && (generatingRefIds.has(id) || portfolio?.status === "generating")),
      group: {
        id: `refs-${category}`,
        index: nextReferenceIndex(category),
        title: REFERENCE_GROUP_LABEL[category] ?? category,
      },
      id,
      kind: "image",
      path: file.path,
      pieceKind: canvasPieceKind(category),
      refCategory: category,
      sheetFallback,
      src: mediaUrl ? mediaPathSrc(snapshot.project.id, mediaUrl) : null,
      status: portfolio?.status || "reference",
      title: rawTitle,
    });
    seen.add(`reference:${id}`);
  }
  // In-flight references with no file on disk yet: pulsing square placeholders.
  for (const entry of generatingReferences) {
    if (seen.has(`reference:${entry.id}`)) continue;
    const category = entry.category ?? "characters";
    cards.push({
      aspectRatio: "1:1",
      generating: true,
      group: {
        id: `refs-${category}`,
        index: nextReferenceIndex(category),
        title: REFERENCE_GROUP_LABEL[category] ?? category,
      },
      id: entry.id,
      kind: "image",
      path: `references/${category}/${entry.id}/reference.md`,
      pieceKind: canvasPieceKind(category),
      refCategory: category,
      src: null,
      status: "generating",
      title: entry.title ?? entry.id,
    });
    seen.add(`reference:${entry.id}`);
  }

  // Composer tasks appear instantly as amorphous blobs ("imagining"); they
  // settle into the real kind + aspect once the model commits to a generation.
  for (const placeholder of composerPlaceholders) {
    if (seen.has(`compose:${placeholder.id}`)) continue;
    const replacement = composerReplacementCards.get(placeholder.id) ?? null;
    cards.push({
      // The durable record owns an explicit ratio. Otherwise the tool-call
      // reservation remains authoritative over intrinsic media dimensions.
      aspectRatio: replacement?.aspectRatio ?? placeholder.aspectRatio,
      displayWidth: replacement || placeholder.settled ? null : placeholder.displayWidth,
      duration: replacement?.duration,
      generating: replacement ? false : true,
      group: replacement?.group,
      id: placeholder.id,
      kind: replacement?.kind ?? (placeholder.settled ? placeholder.kind : "image"),
      path: replacement?.path ?? "#",
      prompt: replacement?.prompt,
      refThumbs: replacement ? undefined : placeholder.refs,
      remediation: replacement ? undefined : placeholder.remediation,
      sourceAspectRatio: replacement ? undefined : placeholder.sourceAspectRatio,
      src: replacement?.src ?? null,
      status: replacement?.status ?? placeholder.state,
      title: replacement?.title ?? placeholder.title,
      toolAspectRatio: placeholder.toolAspectRatio ?? replacement?.toolAspectRatio,
      tracks: replacement?.tracks,
      versions: replacement?.versions,
      workflowAspectRatio:
        placeholder.workflowAspectRatio ?? replacement?.workflowAspectRatio,
    });
    seen.add(`compose:${placeholder.id}`);
  }

  for (const path of workingPaths) {
    const keyframeMatch = /^keyframes\/([^/]+)\.md$/.exec(path);
    if (keyframeMatch && !seen.has(`keyframe:${keyframeMatch[1]}`)) {
      const id = keyframeMatch[1]!;
      cards.push({
        generating: true,
        id,
        kind: "keyframe",
        path,
        src: null,
        status: "generating",
        title: id,
      });
      seen.add(`keyframe:${id}`);
      continue;
    }
    const match = /^clips\/([^/]+)\.md$/.exec(path);
    if (!match || seen.has(`clip:${match[1]}`)) continue;
    const id = match[1]!;
    const isPending = id.endsWith("__pending") || id.endsWith("__shots_pending");
    cards.push({
      aspectRatio: isPending ? "1:1" : undefined,
      displayWidth: isPending ? 430 : undefined,
      generating: true,
      id,
      kind: "clip",
      path,
      prompt: {
        attachments: [],
        canCopy: false,
        id: `clip:${id}`,
        kind: "planned",
        sourceId: id,
        sourcePath: path,
        status: "generating",
        subject: "clip",
        summary: "Prompt will appear once the clip source is written.",
        text: "Prompt will appear once the clip source is written.",
        title: id,
      },
      src: null,
      status: "generating",
      title: isPending
        ? id.replace(/__(shots_)?pending$/, "").replace(/_/g, " ")
        : id,
      tracks: tracksBySourceId.get(id) ?? [],
    });
  }


  // ONE tile lifecycle regardless of origin (chat run, composer, import):
  // every pre-media generating tile renders as the same 1:1 "imagining"
  // square (shimmer + ✦) and morphs to its target aspect when media lands.
  // Revisions (generating with existing media) keep their pixels and shimmer
  // in place.
  for (const card of cards) {
    if (!card.generating || card.src || card.kind === "audio" || card.refCategory) continue;
    if (card.status === "generating") card.status = "imagining";
    if (card.displayWidth == null) {
      const parts = (card.aspectRatio ?? "1:1").split(/[:/]/).map((part) => Number(part.trim()));
      const ratio = parts.length === 2 && parts[0]! > 0 && parts[1]! > 0 ? parts[0]! / parts[1]! : 1;
      card.displayWidth = Math.max(280, Math.min(760, Math.round(760 / ratio)));
    }
  }
  return cards;
}

type ChatStreamEvent =
  | { type: "status"; message: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolName: string }
  | { type: "tool_call"; input?: unknown; toolCallId?: string | null; toolName: string }
  | {
      type: "tool_result";
      durationMs?: number;
      output?: unknown;
      toolCallId?: string | null;
      toolName: string;
    }
  | { type: "final"; reply: string; snapshot?: ProjectSnapshot }
  | { type: "error"; error: string };

type StreamToolCall = ChatToolCall & { id: string; textOffset?: number };

type ChatFeedbackValue = "down" | "up";

/** Workspace paths a tool call is about to write, derived from its input. */
function pathsForToolCall(toolName: string, rawInput: unknown): string[] {
  const input =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {};
  const str = (key: string) =>
    typeof input[key] === "string" && (input[key] as string).trim()
      ? (input[key] as string).trim()
      : null;
  switch (toolName) {
    case "writeFile":
    case "patchFile":
      return str("path") ? [str("path")!] : [];
    case "generateKeyframe": {
      const id = str("id");
      return id ? [`keyframes/${id}.md`] : [];
    }
    case "captureFrame": {
      const id = str("keyframe_id");
      return id ? [`keyframes/${id}.md`] : [];
    }
    case "prepareClipPrompts": {
      const clips = Array.isArray(input.clips) ? input.clips : [];
      return clips.flatMap((clip) => {
        const record =
          clip && typeof clip === "object" && !Array.isArray(clip)
            ? (clip as Record<string, unknown>)
            : {};
        const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : null;
        return id ? [`clips/${id}.md`, `prompts/asset_${id}.prompt.md`] : [];
      });
    }
    case "generateVideoFromImage":
    case "generateVideoFromReferences": {
      // A revision regenerates an existing tile — shimmer it in place
      // instead of spawning a pending placeholder.
      const revises = str("revises");
      if (revises) return [`clips/${revises.replace(/^@/, "")}.md`];
      const title = str("title");
      const slug = title
        ? title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 42)
        : null;
      return slug ? [`clips/${slug}__pending.md`] : [];
    }
    case "extractShots": {
      const id = str("source_id");
      return id ? [`clips/${id}__shots_pending.md`] : [];
    }
    case "generateImage": {
      const revises = str("revises");
      if (revises) return [`keyframes/${revises.replace(/^@/, "")}.md`];
      const id = str("asset_id");
      return id ? [`keyframes/${id}.md`] : [];
    }
    case "generateClip": {
      const id = str("id");
      return id ? [`clips/${id}.md`] : [];
    }
    case "generateReferencePortfolio": {
      const category = str("category");
      const referenceId = str("reference_id");
      return category && referenceId
        ? [`references/${category}/${referenceId}/portfolio.md`]
        : [];
    }
    case "generateImage":
    case "generateAudio": {
      const id = str("asset_id");
      return id ? [`assets/${id}.asset.md`] : [];
    }
    default:
      return [];
  }
}

type ParsedChatAttachment = { name: string; path: string | null; type: string };

/** Splits the attachment block off a user message so attachments render as
 * chips beneath the text instead of as raw path lines. Handles both the
 * server-persisted format ("Attached files saved in the workspace:" with
 * `name -> path (type, N bytes)` lines) and the optimistic client format
 * ("Attached files:" with bare names) shown before the snapshot refreshes. */
function splitAttachmentBlock(text: string): {
  attachments: ParsedChatAttachment[];
  body: string;
} {
  const serverMarker = "\nAttached files saved in the workspace:\n";
  const optimisticMarker = "\nAttached files:\n";
  const serverStart = text.indexOf(serverMarker);
  const start = serverStart >= 0 ? serverStart : text.indexOf(optimisticMarker);
  if (start < 0) return { attachments: [], body: text };
  const marker = serverStart >= 0 ? serverMarker : optimisticMarker;
  const attachments: ParsedChatAttachment[] = [];
  for (const line of text.slice(start + marker.length).split("\n")) {
    const entry = line.trim();
    if (!entry.startsWith("- ")) continue;
    const match = /^- (.+?) -> (\S+) \((.*?), \d+ bytes\)/.exec(entry);
    if (match) attachments.push({ name: match[1]!, path: match[2]!, type: match[3]! });
    else attachments.push({ name: entry.slice(2), path: null, type: "" });
  }
  if (!attachments.length) return { attachments: [], body: text };
  return { attachments, body: text.slice(0, start).trimEnd() };
}

function chatActionText(text: string) {
  const canvasRequest = parseCanvasChatRequest(text);
  if (canvasRequest) return canvasRequest.instruction.trim() || canvasRequest.meta.title;
  return splitAttachmentBlock(text).body.trim() || text.trim();
}

function toolSummaryFromInput(toolName: string, rawInput: unknown) {
  const paths = pathsForToolCall(toolName, rawInput);
  if (paths[0]) return paths[0];
  const input =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {};
  for (const key of ["path", "id", "asset_id", "keyframe_id", "clip_id", "reference_id", "workflow_id", "skill_id", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function toolResultOk(rawOutput: unknown) {
  if (!rawOutput || typeof rawOutput !== "object" || Array.isArray(rawOutput)) return true;
  return (rawOutput as Record<string, unknown>).ok === false ? false : true;
}

function MentionChip({
  entry,
  onSelect,
}: {
  entry: RefEntry;
  onSelect?: (entry: RefEntry) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({
    left: 0,
    placement: "bottom" as "bottom" | "top",
    top: 0,
  });
  const mediaUrl =
    entry.kind === "clip"
      ? entry.posterUrl ?? entry.thumbUrl ?? null
      : entry.thumbUrl ?? entry.posterUrl ?? null;

  function clearCloseTimer() {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function scheduleClose() {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => setOpen(false), 100);
  }

  useLayoutEffect(() => {
    if (!open) return;

    function updatePosition() {
      const button = buttonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const chatPanel = button.closest(".chat-panel") ?? button.closest(".chat-list");
      const chatRect = chatPanel?.getBoundingClientRect();
      const popover = popoverRef.current;
      const width = popover?.offsetWidth || 268;
      const height = popover?.offsetHeight || 210;
      const gap = 8;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const canFitBelow = rect.bottom + gap + height <= viewportHeight - 8;
      const placement = canFitBelow || rect.top < height + gap ? "bottom" : "top";
      const top = placement === "bottom" ? rect.bottom + gap : rect.top - height - gap;
      const centerX = chatRect ? chatRect.left + chatRect.width / 2 : rect.left + rect.width / 2;
      const left = Math.min(
        Math.max(8, centerX - width / 2),
        Math.max(8, viewportWidth - width - 8),
      );
      setPosition({ left, placement, top: Math.max(8, top) });
    }

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(
    () => () => {
      clearCloseTimer();
    },
    [],
  );

  const popover =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={popoverRef}
            className={`mention-popover mention-popover-${position.placement}`}
            role="tooltip"
            style={{ left: position.left, top: position.top }}
            onMouseEnter={clearCloseTimer}
            onMouseLeave={scheduleClose}
          >
            {mediaUrl ? (
              <div className="mention-popover-media-wrap">
                {entry.kind === "clip" ? (
                  <video
                    className="mention-popover-media"
                    src={mediaUrl}
                    muted
                    playsInline
                    preload="metadata"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className="mention-popover-media"
                    src={mediaUrl}
                    alt=""
                    draggable={false}
                  />
                )}
              </div>
            ) : null}
            <div className="mention-popover-body">
              <strong>{entry.title}</strong>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={buttonRef}
        className="md-ref-chip"
        type="button"
        data-ref-id={entry.id}
        data-ref-kind={entry.kind}
        data-ref-path={entry.path}
        title={entry.id}
        onClick={() => onSelect?.(entry)}
        onFocus={() => setOpen(true)}
        onBlur={scheduleClose}
        onMouseEnter={() => {
          clearCloseTimer();
          setOpen(true);
        }}
        onMouseLeave={scheduleClose}
      >
        {entry.title}
      </button>
      {popover}
    </>
  );
}

function ChatMessageActions({
  align,
  canFeedback = false,
  feedback,
  onCopy,
  onFeedback,
}: {
  align: "assistant" | "user";
  canFeedback?: boolean;
  feedback?: ChatFeedbackValue | null;
  onCopy: () => void;
  onFeedback?: (value: ChatFeedbackValue) => void;
}) {
  return (
    <div className={`chat-message-actions is-${align}`} aria-label="Message actions">
      <button type="button" title="Copy" aria-label="Copy message" onClick={onCopy}>
        <Copy size={13.5} aria-hidden="true" />
      </button>
      {canFeedback ? (
        <>
          <button
            type="button"
            title="Good response"
            aria-label="Good response"
            aria-pressed={feedback === "up"}
            className={feedback === "up" ? "is-active" : ""}
            onClick={() => onFeedback?.("up")}
          >
            <ThumbsUp size={13.5} aria-hidden="true" />
          </button>
          <button
            type="button"
            title="Bad response"
            aria-label="Bad response"
            aria-pressed={feedback === "down"}
            className={feedback === "down" ? "is-active" : ""}
            onClick={() => onFeedback?.("down")}
          >
            <ThumbsDown size={13.5} aria-hidden="true" />
          </button>
        </>
      ) : null}
    </div>
  );
}

function AssistantTurn({
  onRefClick,
  refResolver,
  stopped,
  text,
  tools,
  fallback,
}: {
  onRefClick?: (entry: RefEntry) => void;
  refResolver?: RefResolver;
  stopped?: boolean;
  text: string;
  tools?: ChatToolCall[];
  fallback?: string;
}) {
  const stoppedHere = stopped || hasStoppedAgentMarker(text);
  const trimmed = stripStoppedAgentMarker(text);
  const renderText = (value: string, key?: string) => (
    <Markdown
      key={key}
      text={value}
      refResolver={refResolver}
      renderMention={(entry) => <MentionChip entry={entry} onSelect={onRefClick} />}
    />
  );

  // Interleave the narration with the tool calls it introduced, so the user
  // reads WHY each batch is running instead of watching a silent wall of rows.
  // Turns without offsets (older/persisted ones) keep the tools-first layout.
  const offsetTools = (tools ?? []).filter(
    (tool): tool is ChatToolCall & { textOffset: number } =>
      typeof (tool as { textOffset?: number }).textOffset === "number",
  );
  if (offsetTools.length === (tools ?? []).length && offsetTools.length > 0) {
    const groups = new Map<number, ChatToolCall[]>();
    for (const tool of offsetTools) {
      const at = Math.min(Math.max(0, tool.textOffset), trimmed.length);
      const existing = groups.get(at);
      if (existing) existing.push(tool);
      else groups.set(at, [tool]);
    }
    const blocks: ReactNode[] = [];
    let cursor = 0;
    for (const at of [...groups.keys()].sort((a, b) => a - b)) {
      const slice = trimmed.slice(cursor, at);
      if (slice.trim()) blocks.push(renderText(slice, `say-${at}`));
      blocks.push(<ToolCallRows key={`did-${at}`} tools={groups.get(at)} />);
      cursor = Math.max(cursor, at);
    }
    const tail = trimmed.slice(cursor);
    if (tail.trim()) blocks.push(renderText(tail, "say-tail"));
    else if (!trimmed && fallback && !stoppedHere) {
      blocks.push(<AssistantLoadingCube key="cube" label={fallback} />);
    }
    return (
      <div className="assistant-turn">
        {blocks}
        {stoppedHere ? <StoppedAgentDivider /> : null}
      </div>
    );
  }

  return (
    <div className="assistant-turn">
      <ToolCallRows tools={tools} />
      {trimmed ? (
        renderText(trimmed)
      ) : fallback && !stoppedHere ? (
        <AssistantLoadingCube label={fallback} />
      ) : null}
      {stoppedHere ? <StoppedAgentDivider /> : null}
    </div>
  );
}

function StoppedAgentDivider() {
  return (
    <div className="chat-stop-divider" role="note">
      <span>You stopped impractical</span>
    </div>
  );
}

function AssistantLoadingCube({ label }: { label: string }) {
  return (
    <div className="assistant-loading-cube">
      <LoadingCube label={label} />
    </div>
  );
}

function EmptyPreviewState({
  description,
  kind,
}: {
  description: string;
  kind: "player" | "storyboard" | "references";
}) {
  return (
    <div className={`preview-empty preview-empty-${kind}`}>
      <div className="preview-empty-diagram" aria-hidden="true">
        {kind === "player" ? (
          <div className="empty-player-frame">
            <span className="empty-player-play" />
            <span className="empty-player-bar" />
          </div>
        ) : kind === "references" ? (
          <div className="empty-ref-grid">
            {Array.from({ length: 9 }, (_, index) => (
              <span key={index}>
                {index === 4 ? <User size={18} strokeWidth={2.2} /> : null}
              </span>
            ))}
          </div>
        ) : (
          <div className="empty-storyboard-track">
            <div className="empty-storyboard-loop">
              {Array.from({ length: 8 }, (_, index) => (
                <span key={index} />
              ))}
            </div>
          </div>
        )}
      </div>
      <p>{description}</p>
    </div>
  );
}

function mediaSrc(projectId: string, item: TimelineItem) {
  if (item.url) return item.url;
  if (item.local_path) {
    const clean = item.local_path.replace(/^media\//, "");
    return `/api/projects/${projectId}/media/${clean}`;
  }
  return null;
}

function clipPathForTimelineItem(item: TimelineItem) {
  const id = item.clip_id ?? item.id.replace(/^tl_/, "");
  return `clips/${id}.md`;
}

function workspaceMediaSrc(projectId: string, file: WorkspaceFile | null) {
  if (!file || file.kind !== "media") return null;
  if (!file.path.startsWith("media/") && !file.path.startsWith("uploads/")) return null;
  return `/api/projects/${projectId}/media/${file.path.replace(/^media\//, "")}`;
}

function mediaKind(path: string) {
  const lower = path.toLowerCase();
  if (/\.(png|jpe?g|webp)$/.test(lower)) return "image";
  if (/\.(mp4|mov|webm)$/.test(lower)) return "video";
  if (/\.(mp3|wav|m4a)$/.test(lower)) return "audio";
  return "other";
}

const sourceMediaPattern = /https?:\/\/[^\s<>"']+|media\/[^\s<>"']+\.(?:png|jpe?g|webp|mp4|mov|webm|mp3|wav|m4a)/g;

function cleanMediaUrl(value: string) {
  return value.replace(/[),.;]+$/g, "");
}

function mediaKindFromSource(value: string) {
  const clean = cleanMediaUrl(value).toLowerCase();
  if (/\.(png|jpe?g|webp)(?:\?|$)/.test(clean)) return "image";
  if (/\.(mp4|mov|webm)(?:\?|$)/.test(clean)) return "video";
  if (/\.(mp3|wav|m4a)(?:\?|$)/.test(clean)) return "audio";
  return "other";
}

function sourceUrl(projectId: string, value: string) {
  const clean = cleanMediaUrl(value);
  if (/^https?:\/\//i.test(clean)) return clean;
  if (clean.startsWith("media/") || clean.startsWith("uploads/")) {
    return `/api/projects/${projectId}/media/${clean.replace(/^media\//, "")}`;
  }
  return clean;
}

function SourceTextWithMedia({ content, projectId }: { content: string; projectId: string }) {
  return (
    <div className="source-render">
      {content.split("\n").map((line, lineIndex) => {
        const matches = [...line.matchAll(sourceMediaPattern)];
        if (!matches.length) {
          return <div key={lineIndex}>{line || "\u00a0"}</div>;
        }

        let cursor = 0;
        const pieces: ReactNode[] = [];
        matches.forEach((match, matchIndex) => {
          const rawUrl = match[0];
          const start = match.index ?? 0;
          const url = sourceUrl(projectId, rawUrl);
          const kind = mediaKindFromSource(rawUrl);
          if (start > cursor) pieces.push(line.slice(cursor, start));
          if (kind === "image") {
            pieces.push(
              <a key={`${lineIndex}-${matchIndex}`} className="source-media" href={url} target="_blank">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt={url} src={url} />
              </a>,
            );
          } else if (kind === "video") {
            pieces.push(
              <video key={`${lineIndex}-${matchIndex}`} className="source-media" controls playsInline src={url} />,
            );
          } else if (kind === "audio") {
            pieces.push(
              <audio key={`${lineIndex}-${matchIndex}`} className="source-audio" controls src={url} />,
            );
          } else {
            pieces.push(
              <a key={`${lineIndex}-${matchIndex}`} className="source-link" href={url} target="_blank">
                {url}
              </a>,
            );
          }
          cursor = start + rawUrl.length;
        });
        if (cursor < line.length) pieces.push(line.slice(cursor));
        return <div key={lineIndex}>{pieces.length ? pieces : "\u00a0"}</div>;
      })}
    </div>
  );
}

function chooseInitialFile(files: WorkspaceFile[]) {
  return files.find((file) => file.path === "brief.md")?.path ?? files[0]?.path ?? null;
}

type FileTreeNode = {
  children: Map<string, FileTreeNode>;
  file?: WorkspaceFile;
  name: string;
  path: string;
};

type ChatLocalAttachment = {
  file: File;
  fileKind: "image" | "file";
  fileType: string;
  id: string;
  label: string;
  src: string | null;
};

type ChatAttachmentPayload = {
  data: string;
  name: string;
  type: string;
};

const MainChatComposer = memo(function MainChatComposer({
  aborting,
  attachments,
  empty,
  onAbort,
  onAddFiles,
  browseItems = [],
  mentions = [],
  onBrowsePick,
  onOpenBrowse,
  onOpenShortcuts,
  onOpenFlows,
  onRemoveAttachment,
  onShareProject,
  onSubmit,
  onSwitchView,
  onUnstageRef,
  prefill,
  sending,
  stagedRefs = [],
}: {
  aborting: boolean;
  attachments: ChatLocalAttachment[];
  empty: boolean;
  onAbort: () => void;
  onAddFiles: (files: File[]) => void;
  onSubmit: (text: string) => void;
  browseItems?: Array<{ id: string; kind?: string; src?: string | null; title: string }>;
  mentions?: Array<{ id: string; kind?: string; src?: string | null; title: string }>;
  onBrowsePick?: (item: { id: string; title: string }) => void;
  onOpenBrowse?: () => void;
  onOpenShortcuts?: () => void;
  onOpenFlows?: () => void;
  onRemoveAttachment: (id: string) => void;
  onShareProject?: () => void;
  onSwitchView?: (view: "canvas" | "editor" | "plan") => void;
  onUnstageRef?: (id: string) => void;
  prefill?: { nonce: number; text: string } | null;
  sending: boolean;
  stagedRefs?: Array<{ aspectRatio: string | null; id: string; kind: string; src: string | null; title: string }>;
}) {
  const [draft, setDraft] = useState("");
  const [appliedPrefillNonce, setAppliedPrefillNonce] = useState(0);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  // Adopt an incoming prefill during render (React's adjust-state-on-prop
  // pattern) — each pick bumps the nonce so repeats re-apply.
  if (prefill && prefill.nonce !== appliedPrefillNonce) {
    setAppliedPrefillNonce(prefill.nonce);
    setDraft(prefill.text);
  }

  function submitDraft() {
    if (sending || aborting) return;
    if (!draft.trim() && attachments.length === 0) return;
    const text = draft;
    setDraft("");
    onSubmit(text);
  }


  return (
    <div className={`chat-mounted-composer ${empty ? "chat-composer-empty" : ""}`}>
      <input
        ref={uploadInputRef}
        className="hidden"
        type="file"
        multiple
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          if (!files.length) return;
          onAddFiles(files);
          event.currentTarget.value = "";
        }}
      />
      <FloatingComposer
        value={draft}
        placeholder="Ask for anything—create, change, combine, or finish..."
        sending={sending}
        aborting={aborting}
        onAbort={onAbort}
        submitDisabled={!sending && !aborting && !draft.trim() && attachments.length === 0}
        browseItems={browseItems}
        mentions={mentions}
        onBrowsePick={onBrowsePick}
        slashItems={[
          ...(FLOWS_ENABLED
            ? [
                {
                  description: "Browse and run production workflows",
                  icon: <Waves size={15} />,
                  id: "workflows",
                  run: onOpenFlows,
                  title: "Flows",
                },
              ]
            : []),
          {
            description: "Upload from computer",
            icon: <ImagePlus size={15} />,
            id: "add-files",
            run: () => uploadInputRef.current?.click(),
            title: "Add photos & files",
          },
          {
            description: "Share this project",
            icon: <Share2 size={15} />,
            id: "share",
            run: onShareProject,
            title: "Share",
          },
          {
            description: "Switch to the editor",
            icon: <Clapperboard size={15} />,
            id: "editor",
            run: () => onSwitchView?.("editor"),
            title: "Editor",
          },
          {
            description: "Switch to the canvas",
            icon: <GalleryHorizontalEnd size={15} />,
            id: "canvas",
            run: () => onSwitchView?.("canvas"),
            title: "Canvas",
          },
          {
            description: "Switch to the plan",
            icon: <ListChecks size={15} />,
            id: "plan",
            run: () => onSwitchView?.("plan"),
            title: "Plan",
          },
          {
            description: "Trending public characters & references",
            icon: <Compass size={15} />,
            id: "browse",
            run: () => onOpenBrowse?.(),
            title: "Browse",
          },
          {
            description: "Keyboard shortcuts",
            icon: <Keyboard size={15} />,
            id: "shortcuts",
            run: () => onOpenShortcuts?.(),
            title: "Shortcuts",
          },
        ]}
        onChange={setDraft}
        onFiles={onAddFiles}
        onSubmit={submitDraft}
        tray={[
          ...stagedRefs.map((ref) => (
            <AttachmentTile
              key={`ref-${ref.id}`}
              aspectRatio={ref.aspectRatio}
              kind={ref.kind}
              name={ref.title}
              src={ref.src}
              onRemove={onUnstageRef ? () => onUnstageRef(ref.id) : null}
            />
          )),
          ...attachments.map((attachment) => (
            <AttachmentTile
              key={`att-${attachment.id}`}
              kind={
                attachment.fileKind === "image"
                  ? "image"
                  : attachment.file.type.startsWith("audio/")
                    ? "audio"
                    : attachment.file.type.startsWith("video/")
                      ? "video"
                      : "document"
              }
              name={attachment.label}
              src={attachment.src}
              onRemove={() => onRemoveAttachment(attachment.id)}
            />
          )),
        ]}
        controls={
          <>
            <button
              className="storyboard-floating-add"
              type="button"
              title="Add files"
              aria-label="Add files"
              onClick={() => uploadInputRef.current?.click()}
            >
              <Plus size={18} />
            </button>
            {FLOWS_ENABLED ? (
              <button
                type="button"
                className="canvas-dock-tool-button"
                onClick={() => onOpenFlows?.()}
              >
                Flows
              </button>
            ) : null}
          </>
        }
      />
    </div>
  );
});

const STARTER_REQUESTS = [
  "A dragon racing through clouds",
  "A cozy robot cooking breakfast",
  "A sneaker ad in outer space",
  "A tiny city inside a bottle",
];
const EMPTY_CHAT_TITLE = "What would you like to see?";

function seededUnit(seed: number) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

type EmptyChatParticleStyle = CSSProperties & {
  "--particle-alpha": string;
  "--particle-alpha-mid": string;
  "--particle-alpha-top": string;
  "--particle-blur": string;
  "--particle-delay": string;
  "--particle-drift": string;
  "--particle-drift-mid": string;
  "--particle-drift-top": string;
  "--particle-duration": string;
  "--particle-rise": string;
  "--particle-rise-mid": string;
  "--particle-rise-top": string;
  "--particle-scale": string;
  "--particle-scale-end": string;
  "--particle-size": string;
  "--particle-wobble": string;
  "--particle-x": string;
};

const EMPTY_CHAT_PARTICLES = Array.from({ length: 58 }, (_, index): EmptyChatParticleStyle => {
  const duration = 7.2 + seededUnit(index + 29) * 7.4;
  const alpha = 0.5 + seededUnit(index + 83) * 0.34;
  const drift = (seededUnit(index + 53) - 0.5) * 58;
  const rise = 340 + seededUnit(index + 67) * 150;
  const scale = 0.72 + seededUnit(index + 97) * 0.7;
  const wobble = (seededUnit(index + 71) - 0.5) * 34;
  return {
    "--particle-alpha": `${alpha}`,
    "--particle-alpha-mid": `${alpha * 0.64}`,
    "--particle-alpha-top": `${alpha * 0.2}`,
    "--particle-blur": `${seededUnit(index + 101) * 0.45}px`,
    "--particle-delay": `${-seededUnit(index + 41) * duration}s`,
    "--particle-drift": `${drift}px`,
    "--particle-drift-mid": `${drift * 0.44 + wobble * 0.3}px`,
    "--particle-drift-top": `${drift + wobble}px`,
    "--particle-duration": `${duration}s`,
    "--particle-rise": `${-rise}px`,
    "--particle-rise-mid": `${-rise * 0.45}px`,
    "--particle-rise-top": `${-rise * 0.76}px`,
    "--particle-scale": `${scale}`,
    "--particle-scale-end": `${scale * 1.18}`,
    "--particle-size": `${5 + seededUnit(index + 17) * 13}px`,
    "--particle-wobble": `${wobble}px`,
    "--particle-x": `${3 + seededUnit(index + 11) * 94}%`,
  };
});

function buildFileTree(files: WorkspaceFile[]) {
  const root: FileTreeNode = { children: new Map(), name: "", path: "" };
  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;
    parts.forEach((part, index) => {
      const childPath = parts.slice(0, index + 1).join("/");
      const existing = current.children.get(part);
      const next: FileTreeNode =
        existing ?? { children: new Map<string, FileTreeNode>(), name: part, path: childPath };
      if (index === parts.length - 1) next.file = file;
      current.children.set(part, next);
      current = next;
    });
  }
  return root;
}

function sortedNodes(node: FileTreeNode) {
  return [...node.children.values()].sort((a, b) => {
    if (a.file && !b.file) return 1;
    if (!a.file && b.file) return -1;
    return a.name.localeCompare(b.name);
  });
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function fileTypeLabel(file: WorkspaceFile) {
  if (file.kind === "media") return mediaKind(file.path);
  const parsed = parseFrontmatter(file.content);
  const type = parsed?.meta.type;
  return typeof type === "string" && type.trim() ? type : "source";
}

function SourceInspectorHeader({ file }: { file: WorkspaceFile }) {
  const parsed = parseFrontmatter(file.content);
  const status = parsed?.meta.status;
  const type = fileTypeLabel(file);
  const pathParts = file.path.split("/");
  const name = pathParts[pathParts.length - 1] ?? file.path;
  const folder = pathParts.length > 1 ? pathParts.slice(0, -1).join(" / ") : "root";
  const chips = [
    typeof status === "string" && status.trim() ? status : null,
    type,
    formatBytes(file.size),
  ].filter(Boolean);

  return (
    <div className="source-inspector-head">
      <div className="min-w-0">
        <div className="source-breadcrumb">{folder}</div>
        <div className="source-title-row">
          <FileText size={16} />
          <h3>{name}</h3>
        </div>
      </div>
      <div className="source-chips">
        {chips.map((chip) => (
          <span
            key={chip}
            className={`status-pill ${chip === status ? `status-${chip}` : ""}`}
          >
            {chip}
          </span>
        ))}
      </div>
    </div>
  );
}

function initialExpandedFolders(files: WorkspaceFile[]) {
  const expanded = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    if (parts.length > 1) expanded.add(parts[0]!);
  }
  return expanded;
}

type WorkspaceView = "canvas" | "editor" | "files" | "plan" | "references";
type CreditTransaction = {
  amount: number;
  at: string | null;
  detail: string;
  id: string;
  kind?: string;
  task: string;
  thumb?: string | null;
  type: string;
  when?: string;
};

/** The produced media as a square when we have it; kind icon otherwise
 * (or when the stored URL has expired — the media layer hides itself). */
function LedgerThumb({ kind, thumb }: { kind?: string; thumb?: string | null }) {
  return (
    <span className={`credit-tx-thumb is-${kind ?? "other"}`} aria-hidden="true">
      {thumb ? (
        kind === "clip" ? (
          <video
            className="credit-tx-thumb-media"
            src={thumb}
            muted
            playsInline
            preload="metadata"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="credit-tx-thumb-media"
            src={thumb}
            alt=""
            loading="lazy"
            draggable={false}
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        )
      ) : null}
      {kind === "clip" ? (
        <Video size={15} />
      ) : kind === "image" ? (
        <ImageIcon size={15} />
      ) : kind === "portfolio" ? (
        <UserRound size={15} />
      ) : kind === "speech" || kind === "music" ? (
        <AudioLines size={15} />
      ) : kind === "refund" ? (
        <Undo2 size={15} />
      ) : (
        <Coins size={15} />
      )}
    </span>
  );
}

function ledgerWhen(iso: string | null, nowMs: number) {
  if (!iso) return "";
  const seconds = Math.max(0, (nowMs - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 3 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Credits pill: the number counts down on a charge while a red -n flash
 * slips out between the icon and the number; clicking opens the project's
 * plain-words ledger (charges and refunds). */
function CreditCounter({ projectId }: { projectId: string }) {
  const { credits } = useCreditContext();
  const total = credits.total;
  const [displayTotal, setDisplayTotal] = useState(total);
  const [flashDelta, setFlashDelta] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [ledger, setLedger] = useState<
    { rows: CreditTransaction[]; status: "error" | "loading" | "ready" }
  >({ rows: [], status: "loading" });
  const prevTotalRef = useRef(total);
  const counterFrameRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const previous = prevTotalRef.current;
    prevTotalRef.current = total;
    if (total === previous) return;
    const frame = window.requestAnimationFrame(() => {
      if (total >= previous) {
        setDisplayTotal(total);
        return;
      }
      setFlashDelta(previous - total);
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = window.setTimeout(() => setFlashDelta(null), 1500);
      const startedAt = performance.now();
      const duration = 750;
      const step = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        setDisplayTotal(Math.round(previous + (total - previous) * eased));
        if (progress < 1) counterFrameRef.current = window.requestAnimationFrame(step);
      };
      if (counterFrameRef.current) window.cancelAnimationFrame(counterFrameRef.current);
      counterFrameRef.current = window.requestAnimationFrame(step);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [total]);

  useEffect(
    () => () => {
      if (counterFrameRef.current) window.cancelAnimationFrame(counterFrameRef.current);
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const frame = window.requestAnimationFrame(() =>
      setLedger((current) => ({ ...current, status: "loading" })),
    );
    void fetch(`/api/projects/${projectId}/credits`)
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((data: { transactions?: CreditTransaction[] }) => {
        if (cancelled) return;
        const nowMs = Date.now();
        setLedger({
          rows: (data.transactions ?? []).map((transaction) => ({
            ...transaction,
            when: ledgerWhen(transaction.at, nowMs),
          })),
          status: "ready",
        });
      })
      .catch(() => {
        if (!cancelled) setLedger({ rows: [], status: "error" });
      });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [open, projectId]);

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        <button
          type="button"
          className="workbench-credit-counter"
          aria-label={`${formatCredits(displayTotal)} credits`}
          title={`${formatCredits(displayTotal)} credits`}
        >
          <Coins size={15} aria-hidden="true" />
          {flashDelta ? (
            <span className="credit-flash" aria-hidden="true">
              -{formatCredits(flashDelta)}
            </span>
          ) : null}
          <span>{formatCredits(displayTotal)}</span>
        </button>
      </MenuTrigger>
      <MenuContent align="end" sideOffset={8} className="credit-menu">
        <CreditMenuSection showActions={false} />
        <MenuSeparator />
        <div className="credit-menu-list">
          {ledger.status === "loading" ? (
            <div className="credit-menu-empty">
              <Loader2 size={14} className="animate-spin" /> Loading activity
            </div>
          ) : ledger.status === "error" ? (
            <div className="credit-menu-empty">Couldn&apos;t load activity.</div>
          ) : !ledger.rows.length ? (
            <div className="credit-menu-empty">No credit activity in this project yet.</div>
          ) : (
            ledger.rows.map((transaction) => {
              const refund = transaction.type === "refund" || transaction.amount > 0;
              return (
                <div key={transaction.id} className="credit-tx">
                  <LedgerThumb kind={transaction.kind} thumb={transaction.thumb} />
                  <span className="credit-tx-desc">
                    {transaction.task}
                    {transaction.detail ? <em>{transaction.detail}</em> : null}
                    {transaction.when ? (
                      <em className="credit-tx-when">{transaction.when}</em>
                    ) : null}
                  </span>
                  <span className={`credit-tx-amount ${refund ? "is-refund" : ""}`}>
                    {refund ? "+" : "−"}
                    {formatCredits(Math.abs(transaction.amount))}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </MenuContent>
    </Menu>
  );
}

// Workflow recipes remain available to the agent, but they are not a user
// pathway. The user describes an outcome and the agent loads a recipe only
// when the request genuinely benefits from one.
const FLOWS_ENABLED = false;

let focusNonceCounter = 0;
const nextFocusNonce = () => ++focusNonceCounter;

const CANVAS_ARTIFACT_TOOLS = new Set([
  "captureFrame",
  "extractFrame",
  "extractShots",
  "generateClip",
  "generateImage",
  "generateKeyframe",
  "generateMusic",
  "generateSpeech",
  "generateVideo",
  "generateVideoFromImage",
  "generateVideoFromReferences",
]);

const STOPPED_AGENT_MARKER = "[[impractical-agent-stopped]]";
const LEGACY_STOPPED_AGENT_MARKER = "---- you stopped impractical ----";
const STOPPED_AGENT_MARKERS = [STOPPED_AGENT_MARKER, LEGACY_STOPPED_AGENT_MARKER];

function stripStoppedAgentMarker(text: string) {
  return STOPPED_AGENT_MARKERS.reduce(
    (next, marker) => next.replaceAll(marker, ""),
    text,
  ).trim();
}

function hasStoppedAgentMarker(text: string) {
  return STOPPED_AGENT_MARKERS.some((marker) => text.includes(marker));
}

type EditorExportStatus = {
  available: boolean;
  error: string | null;
  isExporting: boolean;
  progress: number;
};

/** The vendored opencut-classic editor, mounted in-process (client-only:
 * it needs WebGPU, OPFS, and WASM). */
const OpencutEditorMount = dynamic(() => import("@/opencut/host/editor-mount"), {
  ssr: false,
});

export function ProjectWorkbench({
  initialSnapshot,
}: {
  initialSnapshot: ProjectSnapshot;
}) {
  const billingUiEnabled = useGenerationBilling();
  // Shares the home shell's storage key so collapsing the sidebar anywhere
  // sticks across every page.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSidebarCollapsed(localStorage.getItem("app-sidebar-collapsed") === "true");
  }, []);
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem("app-sidebar-collapsed", next ? "true" : "false");
      } catch {
        // The sidebar still toggles for this page if storage is unavailable.
      }
      return next;
    });
  }, []);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [chatAttachments, setChatAttachments] = useState<ChatLocalAttachment[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(
    chooseInitialFile(initialSnapshot.files),
  );
  const [sending, setSending] = useState(false);
  /** Prefills the chat composer (e.g. picking a workflow from the canvas dock). */
  const [chatPrefill, setChatPrefill] = useState<{ nonce: number; text: string } | null>(null);
  // A prompt typed on the landing page arrives as ?prompt= — seed the chat
  // composer with it once, then strip it from the URL.
  const consumedPromptRef = useRef(false);
  useEffect(() => {
    if (consumedPromptRef.current) return;
    consumedPromptRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const seeded = params.get("prompt");
    if (!seeded || !seeded.trim()) return;
    params.delete("prompt");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
    const frame = window.requestAnimationFrame(() =>
      setChatPrefill({ nonce: Date.now(), text: seeded.trim() }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, []);
  /** Canvas staged-reference tray mirrored here so the main chat shows and
   * sends the same context (one attachment story across both composers). */
  const [selectedTile, setSelectedTile] = useState<
    { id: string; kind: string; title: string } | null
  >(null);
  const [stagedRefs, setStagedRefs] = useState<
    Array<{ aspectRatio: string | null; id: string; kind: string; src: string | null; title: string }>
  >([]);
  /** Unstage function registered by the canvas so the chat tray's ✕ works. */
  const unstageRefFnRef = useRef<((id: string) => void) | null>(null);
  /** The canvas registers its Flows-modal opener here so /workflows works
   * from the chat composer too. */
  const openFlowsFnRef = useRef<(() => void) | null>(null);
  const openBrowseFnRef = useRef<(() => void) | null>(null);
  /** Public references for the /browse search view (lazy, once). */
  const [browseItems, setBrowseItems] = useState<
    Array<{ id: string; kind?: string; src?: string | null; title: string }>
  >([]);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/explore/references")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { items?: Array<Record<string, unknown>> } | null) => {
        if (cancelled || !Array.isArray(data?.items)) return;
        setBrowseItems(
          data.items.map((item) => ({
            id: String(item.id ?? ""),
            kind: typeof item.kind === "string" ? item.kind : undefined,
            src: typeof item.posterUrl === "string" ? item.posterUrl : null,
            title: typeof item.title === "string" ? item.title : "Untitled",
          })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  function importBrowseItem(item: { id: string; title: string }) {
    void (async () => {
      const toastId = toast.loading(`Importing "${item.title}"...`);
      try {
        const response = await fetch(`/api/published-items/${item.id}/use`, {
          body: JSON.stringify({ projectId: snapshot.project.id }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok || data.error) {
          throw new Error(data.error || "Import failed.");
        }
        toast.success(`Imported "${item.title}" into this project.`, { id: toastId });
        refreshProjectSnapshot();
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : "Import failed.", {
          id: toastId,
        });
      }
    })();
  }
  const [canvasComposerBusy, setCanvasComposerBusy] = useState(false);
  /** Concurrent fire-and-forget composer runs share the busy flag. */
  const composerRunCountRef = useRef(0);
  /** Where finished composer artifacts should land: artifact id → the
   * placeholder id whose canvas position it inherits (no teleporting). */
  const [composerSpawnOrigins, setComposerSpawnOrigins] = useState<Record<string, string>>({});
  const [composerHiddenArtifacts, setComposerHiddenArtifacts] = useState<Record<string, true>>({});
  /** A pending askUser question from the running chat agent. */
  const [userQuestion, setUserQuestion] = useState<{
    activeIndex: number;
    answers: Array<{
      custom_text?: string | null;
      question: string;
      selected?: string | string[] | null;
      uploaded_ids?: string[] | null;
    }>;
    customText: string;
    questions: Array<{
      allow_custom?: boolean;
      allow_upload?: boolean;
      multi_select?: boolean;
      options: Array<{ asset_id?: string | null; label: string }>;
      question: string;
    }>;
    selected: string[];
    toolCallId: string;
    uploading: boolean;
    uploads: Array<{ id: string; name: string }>;
  } | null>(null);
  const [chatFeedback, setChatFeedback] = useState<Record<string, ChatFeedbackValue>>({});
  async function submitUserAnswer(payload: Record<string, unknown>) {
    const toolCallId = userQuestion?.toolCallId;
    setUserQuestion(null);
    if (!toolCallId) return;
    try {
      const response = await fetch(`/api/projects/${snapshot.project.id}/chat/answer`, {
        body: JSON.stringify({ tool_call_id: toolCallId, ...payload }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        setError(
          "The agent stopped before receiving your answer — send your request again.",
        );
      }
    } catch {
      setError("Could not deliver your answer — check the connection and resend.");
    }
  }

  /** Live action ticker entries: fade in on tool start, fade out on finish. */
  const [composerActions, setComposerActions] = useState<
    { key: string; label: string; leaving: boolean; tool: string; toolName: string }[]
  >([]);
  const [externalActivityItems, setExternalActivityItems] = useState<AgentActivityItem[]>(
    () => failedActivitiesFromOperationFiles(initialSnapshot.files),
  );
  const [toolReceiptActivities, setToolReceiptActivities] = useState<AgentActivityItem[]>([]);
  const [agentInteractions, setAgentInteractions] = useState<
    AgentInteractionRecord[]
  >([]);
  const [acknowledgedActivityFailures, setAcknowledgedActivityFailures] =
    useState<Set<string>>(() => new Set());
  const [agentActivityOpen, setAgentActivityOpen] = useState(false);
  const [agentActivityConnection, setAgentActivityConnection] = useState<
    "connected" | "disconnected"
  >("connected");
  const [agentActivityReconnectKey, setAgentActivityReconnectKey] = useState<
    string | null
  >(null);
  const agentActivityButtonRef = useRef<HTMLButtonElement | null>(null);
  const agentActivityConnectionRef = useRef<"connected" | "disconnected">(
    "connected",
  );
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/projects/${snapshot.project.id}/agent-requests`, {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Agent requests are unavailable.");
        return response.json() as Promise<{ requests?: AgentInteractionRecord[] }>;
      })
      .then((payload) => {
        if (!cancelled) setAgentInteractions(payload.requests ?? []);
      })
      .catch(() => {
        // Connection state is represented by the existing SSE adapter.
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot.project.id]);
  useEffect(() => {
    if (sending || canvasComposerBusy) return;
    // Safety sweep: no run is active, so anything still on the ticker is a
    // leak (e.g. a tool_result whose call id didn't match). Fade and drop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setComposerActions((current) =>
      current.length
        ? current.map((entry) => (entry.leaving ? entry : { ...entry, leaving: true }))
        : current,
    );
    const timer = window.setTimeout(() => setComposerActions([]), 650);
    return () => window.clearTimeout(timer);
  }, [sending, canvasComposerBusy]);
  /** Instant placeholder tiles for in-flight composer tasks: born as an
   * amorphous blob, settling into the real kind/aspect when the model commits
   * to a tool call. refs = minified thumbnails of the staged sources. */
  const [composerPlaceholders, setComposerPlaceholders] = useState<ComposerPlaceholder[]>([]);
  const [streamText, setStreamText] = useState("");
  const [streamTools, setStreamTools] = useState<StreamToolCall[]>([]);
  const [abortingRun, setAbortingRun] = useState(false);
  const [abortedAssistantTurn, setAbortedAssistantTurn] = useState<{
    stopped?: boolean;
    text: string;
    tools: StreamToolCall[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("canvas");
  const [canvasAgentContextCandidate, setCanvasAgentContextCandidate] =
    useState<CanvasAgentContextCandidate>(
      EMPTY_CANVAS_AGENT_CONTEXT_CANDIDATE,
    );
  const [editorAgentContext, setEditorAgentContext] =
    useState<EditorAgentContext>(EMPTY_EDITOR_AGENT_CONTEXT);
  const [editorPlacementDocument, setEditorPlacementDocument] =
    useState<unknown>(null);
  const refreshEditorPlacementDocument = useCallback(async () => {
    const response = await fetch(
      `/api/projects/${snapshot.project.id}/editor-doc`,
      { cache: "no-store" },
    );
    if (!response.ok) return;
    setEditorPlacementDocument(await response.json());
  }, [snapshot.project.id]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void refreshEditorPlacementDocument();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [refreshEditorPlacementDocument]);
  const editorPlacements = useMemo<CanonicalEditorPlacement[]>(
    () => canonicalEditorPlacements(editorPlacementDocument),
    [editorPlacementDocument],
  );
  const [agentContextClearSequence, setAgentContextClearSequence] = useState(0);
  const [canvasFocusRequest, setCanvasFocusRequest] = useState<{
    artifact?: ArtifactFocusIdentity;
    id: string;
    ids?: string[];
    kind: "card" | "clip" | "keyframe";
    nonce: number;
    openInspector?: boolean;
  } | null>(null);
  const [editorFocusRequest, setEditorFocusRequest] =
    useState<ArtifactFocusRequest | null>(null);
  /** Tiles with an in-flight revision (revises=...) — shimmer while editing. */
  const [editingTileIds, setEditingTileIds] = useState<Set<string>>(new Set());
  /** Canvas task rows the user expanded to read the full prompt. */
  const [expandedTaskKeys, setExpandedTaskKeys] = useState<Set<string>>(new Set());
  /** Task rows whose one-liner truncates — the only text-expandable ones. */
  const [overflowingTaskKeys, setOverflowingTaskKeys] = useState<Set<string>>(new Set());
  /** While a card expand/collapse animates, the bottom-pin stays out of it. */
  const chatScrollSuppressUntilRef = useRef(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [buyCreditsOpen, setBuyCreditsOpen] = useState(false);
  const editingByCallRef = useRef<Map<string, string>>(new Map());
  const [referenceFocusRequest, setReferenceFocusRequest] = useState<{
    id: string;
    nonce: number;
  } | null>(null);
  /** Paths the agent is writing right now (spinner + shimmer). */
  const [workingPaths, setWorkingPaths] = useState<Set<string>>(new Set());
  /** Files changed by the agent that the user has not opened since (activity dot). */
  const [unseenPaths, setUnseenPaths] = useState<Set<string>>(new Set());
  const [chatEdgeFade, setChatEdgeFade] = useState({ top: false, bottom: false });
  // The chat transcript stays mounted in state for API/run continuity, but its
  // former split-panel UI is intentionally not rendered in canvas-first mode.
  const [chatPanelWidth, setChatPanelWidth] = useState(420);
  const [shareCopied, setShareCopied] = useState(false);
  const [editorExportRequestId, setEditorExportRequestId] = useState(0);
  const [editorExportStatus, setEditorExportStatus] = useState<EditorExportStatus>({
    available: false,
    error: null,
    isExporting: false,
    progress: 0,
  });
  const updateCanvasAgentContext = useCallback(
    (next: CanvasAgentContextCandidate) => {
      setCanvasAgentContextCandidate((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    },
    [],
  );
  const resolvedCanvasAgentContext = useResolvedCanvasAgentContext({
    activeView:
      workspaceView === "editor" ? ("editor" as const) : ("canvas" as const),
    projectId: snapshot.project.id,
    projectRevision: snapshot.project.updatedAt ?? null,
    value: canvasAgentContextCandidate,
  });
  const updateEditorAgentContext = useCallback((next: EditorAgentContext) => {
    setEditorAgentContext((current) =>
      JSON.stringify(current) === JSON.stringify(next) ? current : next,
    );
  }, []);
  const publishedAgentContext = useMemo(
    () => ({
      activeView:
        workspaceView === "editor" ? ("editor" as const) : ("canvas" as const),
      canvas: resolvedCanvasAgentContext.value,
      editor: editorAgentContext,
      projectRevision: snapshot.project.updatedAt ?? null,
    }),
    [
      resolvedCanvasAgentContext.value,
      editorAgentContext,
      snapshot.project.updatedAt,
      workspaceView,
    ],
  );
  const agentContextState = useAgentContextPublisher({
    clearSequence: agentContextClearSequence,
    identityStaleCount: resolvedCanvasAgentContext.staleCount,
    identitySyncing: resolvedCanvasAgentContext.syncing,
    paused:
      resolvedCanvasAgentContext.syncing ||
      resolvedCanvasAgentContext.staleCount > 0,
    projectId: snapshot.project.id,
    value: publishedAgentContext,
  });
  const chatAttachmentsRef = useRef<ChatLocalAttachment[]>([]);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const chatContentRef = useRef<HTMLDivElement | null>(null);
  const chatScrollFrameRef = useRef<number | null>(null);
  const chatShouldAutoScrollRef = useRef(true);
  const chatDidInitialScrollRef = useRef(false);
  const toolCallPathsRef = useRef<Map<string, string[]>>(new Map());
  const currentRunIdRef = useRef<string | null>(null);
  const abortRequestedRef = useRef(false);
  const streamTextRef = useRef("");
  /** Live length of streamText, updated synchronously so tool calls can record
   * where in the narration they occurred (see AssistantTurn interleaving). */
  const streamTextLenRef = useRef(0);
  const streamToolsRef = useRef<StreamToolCall[]>([]);
  const streamAbortRef = useRef<AbortController | null>(null);
  const userStoppedRunRef = useRef(false);
  const reconnectAttemptedRef = useRef(false);
  const reconnectNowRef = useRef<() => void>(() => undefined);
  const sendingRef = useRef(false);
  /** Runs this session already reattached to that ended without a final —
   * never re-attach to them (guards against zombie rows the server missed). */
  const deadRunIdsRef = useRef(new Set<string>());
  const selectedPathRef = useRef<string | null>(selectedPath);
  /** Once the user picks a tab during a run, stop auto-flicking to the board. */
  const viewPinnedRef = useRef(false);
  useEffect(() => {
    streamTextRef.current = streamText;
  }, [streamText]);
  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);
  useEffect(() => {
    streamToolsRef.current = streamTools;
  }, [streamTools]);
  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  /** Keyframes the agent is generating right now: id/title from tool_call input. */
  const [generatingKeyframes, setGeneratingKeyframes] = useState<
    { id: string; title: string; callId: string; aspectRatio: string | null }[]
  >([]);
  /** References whose portfolio contact sheet is being generated right now. */
  const [generatingReferences, setGeneratingReferences] = useState<
    { id: string; callId: string; category: string | null; title: string | null }[]
  >([]);
  useEffect(() => {
    chatAttachmentsRef.current = chatAttachments;
  }, [chatAttachments]);
  useEffect(() => {
    return () => {
      for (const attachment of chatAttachmentsRef.current) {
        if (attachment.src) URL.revokeObjectURL(attachment.src);
      }
    };
  }, []);

  const updateChatEdgeFade = useCallback(() => {
    const element = chatListRef.current;
    if (!element) return;
    const scrollable = element.scrollHeight > element.clientHeight + 2;
    const top = scrollable && element.scrollTop > 2;
    const bottom =
      scrollable && element.scrollTop + element.clientHeight < element.scrollHeight - 2;
    setChatEdgeFade((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom },
    );
  }, []);

  const isChatNearBottom = useCallback((element: HTMLDivElement, threshold = 96) => (
    element.scrollTop + element.clientHeight >= element.scrollHeight - threshold
  ), []);

  const scheduleChatScrollToBottom = useCallback((options?: {
    behavior?: ScrollBehavior;
    force?: boolean;
  }) => {
    const behavior = options?.behavior ?? "auto";
    const force = options?.force ?? false;
    if (chatScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(chatScrollFrameRef.current);
    }
    chatScrollFrameRef.current = window.requestAnimationFrame(() => {
      chatScrollFrameRef.current = window.requestAnimationFrame(() => {
        chatScrollFrameRef.current = null;
        const element = chatListRef.current;
        if (!element) return;
        if (!force && !chatShouldAutoScrollRef.current && !isChatNearBottom(element)) {
          updateChatEdgeFade();
          return;
        }
        element.scrollTo({ top: element.scrollHeight, behavior });
        chatShouldAutoScrollRef.current = true;
        updateChatEdgeFade();
      });
    });
  }, [isChatNearBottom, updateChatEdgeFade]);

  const handleChatScroll = useCallback(() => {
    const element = chatListRef.current;
    if (!element) return;
    updateChatEdgeFade();
    chatShouldAutoScrollRef.current = isChatNearBottom(element);
  }, [isChatNearBottom, updateChatEdgeFade]);

  const shareProject = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(window.location.href).catch(() => undefined);
    }
    setShareCopied(true);
    window.setTimeout(() => setShareCopied(false), 1200);
  }, []);

  const requestEditorMp4Export = useCallback(() => {
    viewPinnedRef.current = true;
    setWorkspaceView("editor");
    setEditorExportStatus((current) => ({
      ...current,
      error: null,
      isExporting: true,
      progress: 0,
    }));
    setEditorExportRequestId((current) => current + 1);
  }, []);

  const resizeChatPanel = useCallback((nextWidth: number) => {
    setChatPanelWidth(Math.min(680, Math.max(320, nextWidth)));
  }, []);

  const startPanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = chatPanelWidth;
    const onPointerMove = (moveEvent: PointerEvent) => {
      resizeChatPanel(startWidth + moveEvent.clientX - startX);
    };
    const stopResize = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }, [chatPanelWidth, resizeChatPanel]);

  const resizePanelWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    resizeChatPanel(chatPanelWidth + (event.key === "ArrowRight" ? 24 : -24));
  }, [chatPanelWidth, resizeChatPanel]);

  useLayoutEffect(() => {
    if (chatDidInitialScrollRef.current) return;
    chatDidInitialScrollRef.current = true;
    chatShouldAutoScrollRef.current = true;
    const element = chatListRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    updateChatEdgeFade();
  }, [updateChatEdgeFade]);

  useEffect(() => {
    if (!chatDidInitialScrollRef.current) {
      chatDidInitialScrollRef.current = true;
      chatShouldAutoScrollRef.current = true;
      scheduleChatScrollToBottom({ force: true });
      return;
    }
    if (chatShouldAutoScrollRef.current) {
      scheduleChatScrollToBottom();
    } else {
      updateChatEdgeFade();
    }
  }, [
    abortedAssistantTurn,
    error,
    scheduleChatScrollToBottom,
    sending,
    snapshot.chat.length,
    streamText,
    streamTools,
    updateChatEdgeFade,
  ]);

  useEffect(() => {
    const element = chatContentRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (Date.now() < chatScrollSuppressUntilRef.current) {
        updateChatEdgeFade();
        return;
      }
      if (chatShouldAutoScrollRef.current) {
        scheduleChatScrollToBottom();
      } else {
        updateChatEdgeFade();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scheduleChatScrollToBottom, updateChatEdgeFade]);

  useEffect(() => {
    return () => {
      if (chatScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(chatScrollFrameRef.current);
      }
    };
  }, []);

  /** Replace the snapshot and dot-mark files that are new or changed. */
  function applySnapshot(next: ProjectSnapshot) {
    // A generating placeholder retires only once the refreshed snapshot
    // carries its media url — removing it at tool_result would flash the
    // stale "planned" card during the refresh gap.
    setGeneratingKeyframes((current) =>
      current.filter((entry) => {
        const file = next.files.find((f) => f.path === `keyframes/${entry.id}.md`);
        return !file?.content?.includes('"url": "http');
      }),
    );
    setGeneratingReferences((current) =>
      current.filter((entry) => !referencePortfolioHasMedia(next.files, entry.id)),
    );
    setSnapshot((current) => {
      const persistedAssistantArrived =
        next.chat.filter((entry) => entry.role === "assistant").length >
        current.chat.filter((entry) => entry.role === "assistant").length;
      // Only treat an arriving assistant message as run completion when no
      // chat run is actively streaming — composer completions mid-run were
      // wiping the live tool rows (the "vanishing tool call" bug). An active
      // run's own `final` event (or the reconnect loop) clears its UI.
      if (persistedAssistantArrived && !currentRunIdRef.current) {
        setAbortedAssistantTurn(null);
        setSending(false);
        setAbortingRun(false);
        setStreamText("");
    streamTextLenRef.current = 0;
        setStreamTools([]);
        setWorkingPaths(new Set());
        setGeneratingKeyframes([]);
        setGeneratingReferences([]);
        toolCallPathsRef.current.clear();
        currentRunIdRef.current = null;
      }
      const before = new Map(current.files.map((file) => [file.path, file.size]));
      const changed: string[] = [];
      for (const file of next.files) {
        if (before.get(file.path) !== file.size) changed.push(file.path);
      }
      if (changed.length) {
        setUnseenPaths((dots) => {
          const merged = new Set(dots);
          for (const path of changed) {
            if (path !== selectedPathRef.current) merged.add(path);
          }
          return merged;
        });
      }
      return next;
    });
  }

  function openFile(path: string) {
    setSelectedPath(path);
    setUnseenPaths((dots) => {
      if (!dots.has(path)) return dots;
      const next = new Set(dots);
      next.delete(path);
      return next;
    });
  }
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() =>
    initialExpandedFolders(initialSnapshot.files),
  );

  const selectedFile = useMemo(
    () => snapshot.files.find((file) => file.path === selectedPath) ?? null,
    [selectedPath, snapshot.files],
  );
  const selectedMediaSrc = workspaceMediaSrc(snapshot.project.id, selectedFile);
  const selectedMediaKind = selectedFile ? mediaKind(selectedFile.path) : "other";
  const refResolver = useMemo(() => buildRefResolver(snapshot), [snapshot]);
  // Measure which task one-liners truncate (rAF: post-layout, off the render
  // path). Expanded rows keep their membership — unwrapped text never
  // measures as overflowing.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setOverflowingTaskKeys((current) => {
        const next = new Set<string>();
        document
          .querySelectorAll<HTMLElement>(".canvas-task-text[data-task-key]")
          .forEach((span) => {
            const key = span.dataset.taskKey!;
            if (span.closest(".is-expanded")) {
              // Animate to the exact content height — a fixed far-away
              // max-height finishes the visible growth almost instantly.
              const target = `${span.scrollHeight}px`;
              if (span.style.maxHeight !== target) span.style.maxHeight = target;
              if (current.has(key)) next.add(key);
              return;
            }
            if (span.style.maxHeight) span.style.maxHeight = "";
            if (span.scrollWidth > span.clientWidth + 1) next.add(key);
          });
        if (next.size === current.size && [...next].every((key) => current.has(key))) {
          return current;
        }
        return next;
      });
    });
    return () => window.cancelAnimationFrame(frame);
  });

  type ChatEntry = ProjectSnapshot["chat"][number];
  const chatRows = useMemo(() => {
    const rows: Array<
      | {
          actionText: string;
          attachments: ParsedChatAttachment[];
          body: string;
          entry: ChatEntry;
          key: string;
          kind: "user";
        }
      | {
          canvasRequest: NonNullable<ReturnType<typeof parseCanvasChatRequest>>;
          entry: ChatEntry;
          key: string;
          kind: "canvas-task";
          response: ChatEntry | null;
          status: "done" | "error" | "running";
        }
      | { copyText: string; entry: ChatEntry; key: string; kind: "assistant" }
    > = [];
    const chat = snapshot.chat;
    for (let index = 0; index < chat.length; index += 1) {
      const entry = chat[index]!;
      const key = `${entry.at}-${index}`;
      if (entry.role === "user") {
        const canvasRequest = parseCanvasChatRequest(entry.text);
        if (canvasRequest) {
          // The task's reply is attached to the row (so failure reasons stay
          // visible to the user on hover and to the agent in the log) but is
          // never rendered as its own bubble.
          const next = chat[index + 1];
          const response = next && next.role === "assistant" ? next : null;
          if (response) index += 1;
          const failed = response
            ? /^canvas task failed:/i.test(response.text.trim()) ||
              /^i could not complete/i.test(response.text.trim()) ||
              STOPPED_AGENT_MARKERS.some((marker) => response.text.includes(marker))
            : index < chat.length - 1;
          rows.push({
            canvasRequest,
            entry,
            key,
            kind: "canvas-task",
            response,
            status: response ? (failed ? "error" : "done") : failed ? "error" : "running",
          });
          continue;
        }
        const actionText = chatActionText(entry.text);
        const { attachments, body } = splitAttachmentBlock(entry.text);
        rows.push({ actionText, attachments, body, entry, key, kind: "user" });
        continue;
      }
      rows.push({
        copyText: stripStoppedAgentMarker(entry.text),
        entry,
        key,
        kind: "assistant",
      });
    }
    return rows;
  }, [snapshot.chat]);

  const sequenceClips = useMemo<SequenceClip[]>(
    () => {
      const videoItems = snapshot.timeline.filter((item) => (item.kind ?? "video") === "video");
      return videoItems.flatMap((item, index, timeline) => {
        const src = mediaSrc(snapshot.project.id, item);
        const isGenerating = workingPaths.has(clipPathForTimelineItem(item));
        if (!src && !isGenerating) return [];
        const previous = timeline[index - 1];
        const continuousFromPrevious =
          Boolean(src) &&
          Boolean(previous?.to_keyframe) &&
          previous?.to_keyframe === item.from_keyframe;
        return {
          id: item.id,
          title: item.title,
          ...(src ? { src } : { placeholder: true, placeholderLabel: "Generating" }),
          playbackDuration:
            typeof item.duration === "number" ? item.duration : DEFAULT_CLIP_DURATION,
          skipFirstFrame: continuousFromPrevious,
        };
      });
    },
    [snapshot.project.id, snapshot.timeline, workingPaths],
  );
  const fileTree = useMemo(() => buildFileTree(snapshot.files), [snapshot.files]);
  function focusMention(entry: RefEntry) {
    viewPinnedRef.current = true;
    const kind =
      entry.kind === "keyframe" ? "keyframe" : entry.kind === "clip" ? "clip" : "card";
    setCanvasFocusRequest({ id: entry.id, kind, nonce: nextFocusNonce() });
    setWorkspaceView("canvas");
  }

  async function copyChatMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      await navigator.clipboard.writeText(trimmed);
      toast.success("Copied message.");
    } catch {
      toast.error("Couldn't copy message.");
    }
  }

  function setAssistantFeedback(key: string, value: ChatFeedbackValue) {
    setChatFeedback((current) => {
      const next = { ...current };
      if (next[key] === value) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  const showStoryboardClips =
    streamTools.some((tool) => tool.name === "generateClip") ||
    snapshotHasVideoGeneration(snapshot);

  const storyboardItems = useMemo(() => {
    const items = buildStoryboard(snapshot, { showClips: showStoryboardClips });
    if (!generatingKeyframes.length) return items;
    const generatingById = new Map(generatingKeyframes.map((entry) => [entry.id, entry]));
    const seen = new Set<string>();
    const merged: StoryboardItem[] = items.map((item) => {
      if (item.kind !== "frame") return item;
      seen.add(item.frame.id);
      return generatingById.has(item.frame.id)
        ? { kind: "frame", frame: { ...item.frame, generating: true } }
        : item;
    });
    // Generations with no record on disk yet appear as trailing shimmer cards
    // until the live refresh files them into film order.
    for (const entry of generatingKeyframes) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      merged.push({
        kind: "frame",
        frame: {
          id: entry.id,
          title: entry.title,
          status: "generating",
          src: null,
          aspectRatio: entry.aspectRatio,
          path: `keyframes/${entry.id}.md`,
          prompt: {
            id: `keyframe:${entry.id}`,
            sourceId: entry.id,
            subject: "keyframe",
            title: entry.title,
            status: "generating",
            kind: "planned",
            summary: "Prompt will appear once the keyframe source is written.",
            text: "Prompt will appear once the keyframe source is written.",
            canCopy: false,
            sourcePath: `keyframes/${entry.id}.md`,
            attachments: [],
          },
          generating: true,
        },
      });
    }
    return merged;
  }, [snapshot, showStoryboardClips, generatingKeyframes]);
  const trackingRecords = useMemo(
    () => parseVideoTrackingRecords(snapshot.files),
    [snapshot.files],
  );
  const trackingRunning = trackingRecords.some(
    (track) => track.status === "queued" || track.status === "running",
  );
  const planSteps = useMemo(() => {
    const file = snapshot.files.find((entry) => entry.path === "plan/plan.md");
    if (!file?.content) return [];
    const parsed = parseFrontmatter(file.content);
    if (!parsed || !Array.isArray(parsed.meta.steps)) return [];
    return (parsed.meta.steps as Array<Record<string, unknown>>)
      .filter((step) => typeof step.title === "string" && typeof step.status === "string")
      .map((step) => ({
        id: typeof step.id === "string" ? step.id : String(step.title),
        note: typeof step.note === "string" ? step.note : null,
        status: step.status as "active" | "done" | "dropped" | "pending",
        title: step.title as string,
      }));
  }, [snapshot.files]);
  const [expandedPlanPaths, setExpandedPlanPaths] = useState<string[]>([]);
  const planTitle = useMemo(() => {
    const file = snapshot.files.find((entry) => entry.path === "plan/plan.md");
    if (!file?.content) return null;
    const parsed = parseFrontmatter(file.content);
    return parsed && typeof parsed.meta.title === "string" ? parsed.meta.title : null;
  }, [snapshot.files]);
  const planHistory = useMemo(() => {
    return snapshot.files
      .filter((entry) => /^plan\/history\/plan_[^/]+\.md$/.test(entry.path))
      .map((entry) => {
        const parsed = entry.content ? parseFrontmatter(entry.content) : null;
        if (!parsed || !Array.isArray(parsed.meta.steps)) return null;
        return {
          archivedAt:
            typeof parsed.meta.archived_at === "string" ? parsed.meta.archived_at : "",
          path: entry.path,
          planTitle: typeof parsed.meta.title === "string" ? parsed.meta.title : null,
          steps: (parsed.meta.steps as Array<Record<string, unknown>>)
            .filter((step) => typeof step.title === "string")
            .map((step) => ({
              status: typeof step.status === "string" ? step.status : "pending",
              title: step.title as string,
            })),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  }, [snapshot.files]);
  const agentActivityItems = useMemo<AgentActivityItem[]>(() => {
    const active = composerActions
      .filter((entry) => !entry.leaving)
      .map((entry) => ({
        id: entry.key,
        label: entry.label,
        status: "running" as const,
      }));
    const activePlanStep = planSteps.find((step) => step.status === "active");
    if (activePlanStep && (sending || canvasComposerBusy)) {
      active.push({
        id: `plan:${activePlanStep.id}`,
        label: activePlanStep.title,
        status: "running",
      });
    }
    const recent = chatRows
      .filter((row) => row.kind === "canvas-task")
      .slice(-4)
      .reverse()
      .map((row) => ({
        id: row.key,
        label:
          row.canvasRequest.instruction ||
          `${canvasChatRequestLabel(row.canvasRequest.meta)} · ${row.canvasRequest.meta.title}`,
        status: row.status === "done" ? ("completed" as const) : row.status,
      }));
    const interactionActivities = agentInteractions
      .filter((request) => request.status !== "awaiting")
      .slice(0, 4)
      .map((request): AgentActivityItem => {
        if (request.status === "expired") {
          return {
            canReconnect: false,
            code: "AGENT_INTERACTION_EXPIRED",
            detail: "The request expired without a response.",
            id: `interaction:${request.id}`,
            label:
              request.kind === "approval"
                ? "Approval expired"
                : "Input request expired",
            remediation: "Ask the agent to create a new request.",
            status: "error",
          };
        }
        return {
          id: `interaction:${request.id}`,
          label:
            request.kind === "approval"
              ? request.decision?.approved
                ? "Approval granted"
                : "Approval denied"
              : "Input received",
          status: "completed",
        };
      });
    const seen = new Set<string>();
    return [
      ...active,
      ...interactionActivities,
      ...toolReceiptActivities,
      ...externalActivityItems,
      ...recent,
    ].filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [
    canvasComposerBusy,
    chatRows,
    composerActions,
    externalActivityItems,
    agentInteractions,
    planSteps,
    sending,
    toolReceiptActivities,
  ]);
  const agentActivityFailure = useMemo(
    () => (error ? classifyActivityFailure(error) : null),
    [error],
  );
  const unacknowledgedAgentActivityFailure =
    agentActivityFailure &&
    !acknowledgedActivityFailures.has(
      agentActivityFailureKey(agentActivityFailure),
    )
      ? agentActivityFailure
      : null;
  const lifecycleActivityItems = useMemo(
    () =>
      agentActivityItems.filter(
        (item) =>
          item.status !== "error" ||
          !acknowledgedActivityFailures.has(agentActivityFailureKey(item)),
      ),
    [acknowledgedActivityFailures, agentActivityItems],
  );
  const agentActivityRunning =
    sending ||
    canvasComposerBusy ||
    externalActivityItems.some((item) => item.status === "running");
  const currentAgentInteraction =
    agentInteractions.find((request) => request.status === "awaiting") ?? null;
  const currentAgentQuestion =
    currentAgentInteraction?.question ??
    userQuestion?.questions[userQuestion.activeIndex]?.question ??
    null;
  const agentActivityEvent = useMemo(
    () =>
      agentActivityLifecycleEvent({
        approvalRequired: currentAgentInteraction?.kind === "approval",
        connection: agentActivityConnection,
        error: unacknowledgedAgentActivityFailure,
        isRunning: agentActivityRunning,
        isStopping: abortingRun,
        items: lifecycleActivityItems,
        question: currentAgentQuestion,
        reconnectedKey: agentActivityReconnectKey,
        stopped: Boolean(abortedAssistantTurn?.stopped),
      }),
    [
      abortedAssistantTurn?.stopped,
      abortingRun,
      agentActivityConnection,
      currentAgentInteraction?.kind,
      lifecycleActivityItems,
      agentActivityReconnectKey,
      agentActivityRunning,
      currentAgentQuestion,
      unacknowledgedAgentActivityFailure,
    ],
  );
  const resolveAgentInteraction = useCallback(
    async (
      request: AgentInteractionRecord,
      resolution:
        | { answer: AgentInputAnswer; kind: "input" }
        | {
            decision: { approved: boolean; note?: string | null };
            kind: "approval";
          },
    ) => {
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/agent-requests/${request.id}`,
        {
          body: JSON.stringify(resolution),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        remediation?: string | null;
        request?: AgentInteractionRecord;
      };
      if (!response.ok || !payload.request) {
        setError(
          [payload.error || "Could not resolve the agent request.", payload.remediation]
            .filter(Boolean)
            .join(" "),
        );
        return;
      }
      setAgentInteractions((current) => [
        payload.request!,
        ...current.filter((item) => item.id !== payload.request!.id),
      ]);
      window.requestAnimationFrame(() =>
        document
          .querySelector<HTMLButtonElement>(".agent-activity-summary")
          ?.focus(),
      );
    },
    [snapshot.project.id],
  );
  const changeAgentActivityOpen = useCallback((open: boolean) => {
    setAgentActivityOpen(open);
    if (!open) {
      window.requestAnimationFrame(() => agentActivityButtonRef.current?.focus());
    }
  }, []);
  const canvasCards = useMemo(
    () =>
      buildCanvasCards(
        snapshot,
        storyboardItems,
        trackingRecords,
        workingPaths,
        generatingReferences,
        composerPlaceholders,
        composerSpawnOrigins,
        composerHiddenArtifacts,
      ),
    [
      snapshot,
      storyboardItems,
      trackingRecords,
      workingPaths,
      generatingReferences,
      composerPlaceholders,
      composerSpawnOrigins,
      composerHiddenArtifacts,
    ],
  );
  /** Host content the editor's media bin auto-populates with: finished clips
   * and generated/uploaded images (references stay in their own view). */
  const editorMediaAssets = useMemo(
    () => {
      const assetsBySource = new Map<
        string,
        {
          artifact: {
            artifactId: string;
            contentHash: string | null;
            entityRevision: number | null;
            sourcePath: string;
            versionHash: string | null;
            versionId: string | null;
            versionIndex: number | null;
          };
          id: string;
          kind: "audio" | "image" | "video";
          sourceKey: string;
          src: string;
          title: string;
        }
      >();
      for (const card of canvasCards) {
        if (
          !card.src ||
          card.path === "#" ||
          card.generating ||
          card.path.startsWith("references/")
        ) {
          continue;
        }
        if (
          card.kind !== "clip" &&
          card.kind !== "video" &&
          card.kind !== "image" &&
          card.kind !== "keyframe" &&
          card.kind !== "audio"
        ) {
          continue;
        }
        const versions = card.versions ?? [];
        const sources = versions.length
          ? versions.flatMap((version, index) => {
              if (!version.src || !version.path) return [];
              const candidate = canvasAgentContextArtifact(card, index);
              const isFocusedVersion =
                editorFocusRequest?.artifactId === card.id &&
                editorFocusRequest.versionIndex === index &&
                editorFocusRequest.versionId === candidate.version?.versionId &&
                editorFocusRequest.sourcePath === candidate.version?.path;
              return [
                {
                  artifact: {
                    artifactId: card.id,
                    contentHash: isFocusedVersion
                      ? editorFocusRequest.contentHash
                      : null,
                    entityRevision:
                      candidate.version?.revision ?? null,
                    sourcePath: version.path,
                    versionHash: isFocusedVersion
                      ? editorFocusRequest.versionHash
                      : null,
                    versionId: candidate.version?.versionId ?? null,
                    versionIndex: index,
                  },
                  id: version.isCurrent
                    ? card.id
                    : `${card.id}@${candidate.version?.versionId ?? index}`,
                  sourceKey: version.src,
                  src: version.src,
                },
              ];
            })
          : [
              {
                artifact: {
                  artifactId: card.id,
                  contentHash:
                    editorFocusRequest?.artifactId === card.id
                      ? editorFocusRequest.contentHash
                      : null,
                  entityRevision:
                    editorFocusRequest?.artifactId === card.id
                      ? editorFocusRequest.entityRevision
                      : null,
                  sourcePath: card.path,
                  versionHash:
                    editorFocusRequest?.artifactId === card.id
                      ? editorFocusRequest.versionHash
                      : null,
                  versionId: null,
                  versionIndex: null,
                },
                id: card.id,
                sourceKey: card.src,
                src: card.src,
              },
            ];
        for (const source of sources) {
          const asset = {
            ...source,
            kind:
              card.kind === "clip" || card.kind === "video"
                ? ("video" as const)
                : card.kind === "audio"
                  ? ("audio" as const)
                  : ("image" as const),
            title: card.title,
          };
          const existing = assetsBySource.get(source.sourceKey);
          if (
            !existing ||
            (existing.id.startsWith("compose_") &&
              !card.id.startsWith("compose_"))
          ) {
            assetsBySource.set(source.sourceKey, asset);
          }
        }
      }
      return [...assetsBySource.values()];
    },
    [canvasCards, editorFocusRequest],
  );
  const resolveCanvasFocusCandidate = useCallback(
    async (candidate: CanvasAgentContextCandidateArtifact) => {
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/canvas/context-identity`,
        {
          body: JSON.stringify({
            artifacts: [candidate],
            mode: "resolve",
          }),
          cache: "no-store",
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        artifacts?: AgentContextArtifact[];
        error?: string;
      };
      const resolved = payload.artifacts?.[0];
      if (!response.ok || !resolved) {
        throw new Error(
          payload.error || "The selected artifact version is unavailable.",
        );
      }
      const identity = artifactFocusIdentity(resolved);
      if (!identity) {
        throw new Error("The selected artifact is still syncing.");
      }
      return identity;
    },
    [snapshot.project.id],
  );
  const verifyArtifactFocusIdentity = useCallback(
    async (identity: ArtifactFocusIdentity) => {
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/canvas/context-identity`,
        {
          body: JSON.stringify({
            artifacts: [
              {
                artifactId: identity.artifactId,
                contentHash: identity.contentHash,
                entityRevision: identity.entityRevision,
                kind: "artifact",
                path: identity.sourcePath,
                title: null,
                version:
                  identity.versionId !== null &&
                  identity.versionIndex !== null
                    ? {
                        index: identity.versionIndex,
                        sha256: identity.versionHash,
                        versionId: identity.versionId,
                      }
                    : null,
              },
            ],
            mode: "verify",
          }),
          cache: "no-store",
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      return response.ok;
    },
    [snapshot.project.id],
  );
  const openCanvasArtifactInEditor = useCallback(
    async ({
      artifact,
      relink = false,
      timelineElementId = null,
    }: {
      artifact: CanvasAgentContextCandidateArtifact;
      relink?: boolean;
      timelineElementId?: string | null;
    }) => {
      try {
        let identity: ArtifactFocusIdentity | null = null;
        if (!relink) {
          const acknowledged = [
            ...resolvedCanvasAgentContext.value.selected,
            ...resolvedCanvasAgentContext.value.pinned,
            ...(resolvedCanvasAgentContext.value.focused
              ? [resolvedCanvasAgentContext.value.focused]
              : []),
          ].find((entry) =>
            candidateMatchesResolvedArtifact(artifact, entry),
          );
          identity = acknowledged
            ? artifactFocusIdentity(acknowledged)
            : null;
        }
        if (!identity) {
          if (!relink) {
            return {
              message: "This version is still syncing with agent context.",
              status: "stale" as const,
            };
          }
          identity = await resolveCanvasFocusCandidate(artifact);
        }
        if (!(await verifyArtifactFocusIdentity(identity))) {
          return {
            message: "This artifact version changed. Refresh or relink it.",
            status: "stale" as const,
          };
        }
        setEditorAgentContext((current) => ({
          ...current,
          focusedArtifact: {
            artifactId: identity.artifactId,
            contentHash: identity.contentHash,
            entityRevision: identity.entityRevision,
            kind: artifact.kind,
            path: identity.sourcePath,
            title: artifact.title,
            version:
              identity.versionId !== null && identity.versionIndex !== null
                ? {
                    index: identity.versionIndex,
                    sha256: identity.versionHash,
                    versionId: identity.versionId,
                  }
                : null,
          },
        }));
        setEditorFocusRequest({
          ...identity,
          nonce: nextFocusNonce(),
          timelineElementId,
        });
        viewPinnedRef.current = true;
        setWorkspaceView("editor");
        return { status: "media-bin" as const };
      } catch (error) {
        return {
          message:
            error instanceof Error
              ? error.message
              : "The selected artifact version is unavailable.",
          status: "stale" as const,
        };
      }
    },
    [
      resolveCanvasFocusCandidate,
      resolvedCanvasAgentContext.value,
      verifyArtifactFocusIdentity,
    ],
  );
  const showEditorSourceOnCanvas = useCallback(
    async ({
      artifact,
      relink = false,
    }: {
      artifact: ArtifactFocusIdentity;
      relink?: boolean;
    }): Promise<ArtifactFocusResult> => {
      const card = canvasCards.find(
        (entry) => entry.id === artifact.artifactId,
      );
      if (!card) {
        return {
          message: "The Canvas source is no longer available.",
          status: "stale",
        };
      }
      let identity = artifact;
      if (relink) {
        const versions = card.versions ?? [];
        const durableCurrentIndex = versions.findIndex(
          (version) => version.isCurrent,
        );
        const currentIndex = versions.length
          ? durableCurrentIndex >= 0
            ? durableCurrentIndex
            : versions.length - 1
          : null;
        try {
          identity = await resolveCanvasFocusCandidate(
            canvasAgentContextArtifact(card, currentIndex),
          );
        } catch {
          return {
            message: "The current Canvas version could not be relinked.",
            status: "stale",
          };
        }
      } else if (!(await verifyArtifactFocusIdentity(identity))) {
        return {
          message: "The Canvas source changed. Refresh or relink it.",
          status: "stale",
        };
      }
      const versions = card.versions ?? [];
      if (versions.length) {
        const matchingVersion = versions.findIndex((version, index) => {
          const candidate = canvasAgentContextArtifact(card, index);
          return (
            candidate.version?.index === identity.versionIndex &&
            candidate.version?.versionId === identity.versionId &&
            candidate.version?.path === identity.sourcePath
          );
        });
        if (matchingVersion < 0) {
          return {
            message: "That historical Canvas version is no longer linked.",
            status: "stale",
          };
        }
      } else if (card.path !== identity.sourcePath) {
        return {
          message: "The Canvas source record changed.",
          status: "stale",
        };
      }
      setCanvasFocusRequest({
        artifact: identity,
        id: card.id,
        kind: "card",
        nonce: nextFocusNonce(),
        openInspector: true,
      });
      viewPinnedRef.current = true;
      setWorkspaceView("canvas");
      return { status: "focused-source" };
    },
    [
      canvasCards,
      resolveCanvasFocusCandidate,
      verifyArtifactFocusIdentity,
    ],
  );
  /** Entities offered by the @ popover: every addressable canvas tile. */
  const mentionItems = useMemo(
    () =>
      canvasCards
        .filter((entry) => entry.path !== "#" && !entry.generating)
        .map((entry) => ({
          id: entry.id,
          kind: entry.refCategory ? `${entry.refCategory} reference` : entry.kind,
          src: entry.src ?? null,
          title: entry.title,
        })),
    [canvasCards],
  );
  const generatingReferenceIds = useMemo(
    () => new Set(generatingReferences.map((entry) => entry.id)),
    [generatingReferences],
  );

  function toggleFolder(path: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderTree(node: FileTreeNode, depth = 0): ReactNode {
    return sortedNodes(node).map((child) => {
      const isFolder = child.children.size > 0 && !child.file;
      const isOpen = expandedFolders.has(child.path);
      if (isFolder) {
        const childWorking = [...workingPaths].some((path) =>
          path.startsWith(`${child.path}/`),
        );
        return (
          <div key={child.path}>
            <button
              className={`tree-row folder-row ${childWorking ? "working" : ""}`}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => toggleFolder(child.path)}
            >
              {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Folder size={14} />
              <span>{child.name}</span>
              {childWorking ? <Loader2 size={12} className="tree-spinner" /> : null}
            </button>
            {isOpen ? renderTree(child, depth + 1) : null}
          </div>
        );
      }
      const file = child.file;
      if (!file) return null;
      const working = workingPaths.has(file.path);
      const unseen = !working && unseenPaths.has(file.path);
      return (
        <button
          key={file.path}
          className={`tree-row file-node ${selectedPath === file.path ? "active" : ""} ${working ? "working" : ""}`}
          title={file.path}
          style={{ paddingLeft: 26 + depth * 14 }}
          onClick={() => openFile(file.path)}
        >
          <FileText size={13} />
          <span>{child.name}</span>
          {working ? <Loader2 size={12} className="tree-spinner" /> : null}
          {unseen ? <span className="tree-dot" /> : null}
        </button>
      );
    });
  }

  async function refresh() {
    const response = await fetch(`/api/projects/${snapshot.project.id}`);
    applySnapshot(await response.json());
  }

  function removeChatAttachment(id: string) {
    setChatAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.src) URL.revokeObjectURL(removed.src);
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  function clearChatAttachments(attachments = chatAttachments) {
    for (const attachment of attachments) {
      if (attachment.src) URL.revokeObjectURL(attachment.src);
    }
    setChatAttachments([]);
  }

  function addChatAttachmentFiles(files: File[]) {
    if (!files.length) return;
    setChatAttachments((current) => [
      ...current,
      ...files.map((file, index) => chatAttachmentFromFile(file, index)),
    ]);
  }

  useEffect(() => {
    if (!trackingRunning) return;
    let cancelled = false;
    const refreshTracking = async () => {
      const response = await fetch(`/api/projects/${snapshot.project.id}`, {
        cache: "no-store",
      }).catch(() => null);
      if (!response?.ok || cancelled) return;
      applySnapshot(await response.json());
    };
    const interval = window.setInterval(() => {
      void refreshTracking();
    }, 1500);
    void refreshTracking();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [snapshot.project.id, trackingRunning]);

  async function serializeChatAttachments(
    attachments: ChatLocalAttachment[],
  ): Promise<ChatAttachmentPayload[]> {
    return Promise.all(
      attachments.map(async (attachment) => ({
        data: await readFileAsBase64(attachment.file),
        name: attachment.file.name,
        type: attachment.file.type || "application/octet-stream",
      })),
    );
  }

  async function importYoutubeToCanvas(url: string, brief?: string) {
    viewPinnedRef.current = true;
    setWorkspaceView("canvas");
    const response = await fetch(`/api/projects/${snapshot.project.id}/canvas/import-youtube`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief, url }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        typeof payload.error === "string" ? payload.error : "Failed to import YouTube URL.",
      );
    }
    applySnapshot((payload.snapshot ?? payload) as ProjectSnapshot);
    return { importId: typeof payload.importId === "string" ? payload.importId : undefined };
  }

  async function refreshProjectSnapshot() {
    const response = await fetch(`/api/projects/${snapshot.project.id}`);
    if (response.ok) applySnapshot(await response.json());
  }

  async function requestCanvasPromptChange({ card, text }: CanvasPromptRequest) {
    // Reference tiles aren't regenerate sources — hand them to the composer
    // agent, which resolves the reference and conditions on its portfolio.
    if (card.path.startsWith("references/")) {
      await requestCanvasComposer(text, [card]);
      return;
    }
    viewPinnedRef.current = true;
    setWorkspaceView("canvas");
    appendOptimisticCanvasRequest("edit", card.title, text);
    // Image sources produce an edited image; only video sources become clips.
    const isImageSource = card.kind === "keyframe" || card.kind === "image";
    const workingPath = isImageSource
      ? `keyframes/${card.id}_edit.md`
      : `clips/${card.id}_edit.md`;
    setWorkingPaths((current) => new Set(current).add(workingPath));
    setCanvasFocusRequest({ id: `${card.id}_edit`, kind: "card", nonce: nextFocusNonce() });
    try {
      const response = await fetch(`/api/projects/${snapshot.project.id}/canvas/regenerate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instruction: text,
          source: {
            id: card.id,
            kind: card.kind,
            path: card.path,
            title: card.title,
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string" ? payload.error : "Failed to generate canvas change.",
        );
      }
      applySnapshot(payload);
    } finally {
      setWorkingPaths((current) => {
        const next = new Set(current);
        next.delete(workingPath);
        return next;
      });
    }
  }

  async function requestCanvasComposer(
    text: string,
    focus?: CanvasCard[] | null,
    options?: { imageModel?: string | null },
  ) {
    const focusCards = focus ?? [];
    viewPinnedRef.current = true;
    setWorkspaceView("canvas");
    appendOptimisticCanvasRequest(
      "compose",
      focusCards.length > 1
        ? `${focusCards.length} references`
        : focusCards[0]?.title || "Canvas",
      text,
    );
    composerRunCountRef.current += 1;
    setCanvasComposerBusy(true);
    const requestKey = `compose_${composerRunCountRef.current.toString(36)}`;
    let placeholderCount = 1;
    const focusRefs = focusCards
      .slice(0, 8)
      .map((entry) => ({
        id: entry.id,
        thumb: entry.kind === "clip" || entry.kind === "video" ? null : entry.src,
      }));
    const sourceAspect = focusCards[0]?.aspectRatio ?? "16:9";
    const aspectParts = sourceAspect.split(/[:/]/).map((part) => Number(part.trim()));
    const sourceRatio =
      aspectParts.length === 2 && aspectParts[0]! > 0 && aspectParts[1]! > 0
        ? aspectParts[0]! / aspectParts[1]!
        : 16 / 9;
    // 760 is the canvas card width; the square placeholder matches the
    // reference tile's height so it reads as its sibling.
    const squareSide = Math.max(280, Math.min(760, Math.round(760 / sourceRatio)));
    setComposerPlaceholders((current) => [
      ...current,
      {
        aspectRatio: null,
        displayWidth: squareSide,
        id: `${requestKey}_0`,
        kind: "image",
        refs: focusRefs,
        settled: false,
        sourceAspectRatio: sourceAspect,
        state: "preparing",
        title: "Imagining…",
      },
    ]);
    setCanvasFocusRequest({ id: `${requestKey}_0`, kind: "card", nonce: nextFocusNonce() });
    const clearPlaceholders = () =>
      setComposerPlaceholders((current) =>
        current.filter((entry) => !entry.id.startsWith(requestKey)),
      );
    let createdArtifactPaths = false;
    let requestFailed = false;
    const revisedTileIds: string[] = [];
    const artifactPlaceholderIds: string[] = [];
    const placeholderIdByTitle = new Map<string, string>();
    try {
      const response = await fetch(`/api/projects/${snapshot.project.id}/canvas/composer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instruction: text,
          focus: focusCards.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            path: entry.path,
            title: entry.title,
          })),
          imageModel: options?.imageModel ?? null,
        }),
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          typeof payload.error === "string" ? payload.error : "Canvas task failed.",
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let sawPrimaryArtifactTool = false;
      let sawIntermediateArtifactTool = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
          if (!line) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (event.type === "tool_start") {
            const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
            const actionKey = `${requestKey}:${toolName}:${Date.now().toString(36)}:${Math.trunc(performance.now())}`;
            setComposerActions((current) => [
              // Single-slot ticker: the newest action supersedes the rest.
              ...current.map((entry) => ({ ...entry, leaving: true })),
              {
                key: actionKey,
                label: composerActionLabel(
                  toolName,
                  typeof event.title === "string" ? event.title : null,
                ),
                leaving: false,
                tool: toolName,
                toolName: `${requestKey}:${toolName}`,
              },
            ]);
            window.setTimeout(() => {
              setComposerActions((current) =>
                current.filter((entry) => !entry.leaving || entry.key === actionKey),
              );
            }, 450);
            const ARTIFACT_KINDS: Record<string, "audio" | "clip" | "image"> = {
              extractFrame: "image",
              extractShots: "clip",
              generateImage: "image",
              generateMusic: "audio",
              generateSpeech: "audio",
              generateVideo: "clip",
              generateVideoFromReferences: "clip",
            };
            const artifactKind = ARTIFACT_KINDS[toolName];
            if (!artifactKind) continue;
            if (typeof event.revises === "string" && event.revises) {
              // A redo updates an existing tile in place — retire the
              // request's unsettled placeholder and shimmer the tile being
              // revised instead.
              const revisedId = event.revises;
              revisedTileIds.push(revisedId);
              setEditingTileIds((current) => new Set(current).add(revisedId));
              setCanvasFocusRequest({ id: revisedId, kind: "card", nonce: Date.now() });
              setComposerPlaceholders((current) =>
                current.filter(
                  (entry) => !(entry.id.startsWith(requestKey) && !entry.settled),
                ),
              );
              continue;
            }
            const aspectRatio =
              typeof event.aspectRatio === "string" ? event.aspectRatio : "16:9";
            const kind = artifactKind;
            const title = typeof event.title === "string" ? event.title : "Generating…";
            if (toolName === "extractFrame") {
              sawIntermediateArtifactTool = true;
              setComposerPlaceholders((current) =>
                current.map((entry) =>
                  entry.id === `${requestKey}_0` && !entry.settled
                    ? {
                        ...entry,
                        toolAspectRatio: aspectRatio,
                        state: "processing",
                        title: title || "Extracting frame…",
                      }
                    : entry,
                ),
              );
              continue;
            }
            const shouldSettlePrimaryPlaceholder = !sawPrimaryArtifactTool;
            sawPrimaryArtifactTool = true;
            const existingPlaceholderId = placeholderIdByTitle.get(title);
            const placeholderId =
              existingPlaceholderId ??
              (shouldSettlePrimaryPlaceholder ? `${requestKey}_0` : `${requestKey}_${placeholderCount}`);
            if (!existingPlaceholderId && !shouldSettlePrimaryPlaceholder) placeholderCount += 1;
            placeholderIdByTitle.set(title, placeholderId);
            artifactPlaceholderIds.push(placeholderId);
            setComposerPlaceholders((current) => {
              const target = current.find((entry) => entry.id === placeholderId);
              if (target) {
                return current.map((entry) =>
                  entry.id === target.id
                    ? {
                        ...entry,
                        kind,
                        settled: true,
                        state: "generating",
                        title,
                        toolAspectRatio: aspectRatio,
                      }
                    : entry,
                );
              }
              return [
                ...current,
                {
                  aspectRatio: null,
                  id: placeholderId,
                  kind,
                  refs: [],
                  settled: true,
                  sourceAspectRatio: sourceAspect,
                  state: "generating",
                  title,
                  toolAspectRatio: aspectRatio,
                },
              ];
            });
          } else if (event.type === "tool_end") {
            const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
            const tag = `${requestKey}:${toolName}`;
            setComposerActions((current) => {
              const target = current.find((entry) => entry.toolName === tag && !entry.leaving);
              if (!target) return current;
              return current.map((entry) =>
                entry.key === target.key ? { ...entry, leaving: true } : entry,
              );
            });
            window.setTimeout(() => {
              setComposerActions((current) =>
                current.filter((entry) => !(entry.toolName === tag && entry.leaving)),
              );
            }, 420);
          } else if (event.type === "final") {
            const createdPaths = Array.isArray(event.createdPaths)
              ? (event.createdPaths as string[])
              : [];
            if (createdPaths.length) {
              createdArtifactPaths = true;
              const finalSnapshot = event.snapshot as ProjectSnapshot | undefined;
              const mappedCreatedPaths =
                sawIntermediateArtifactTool &&
                artifactPlaceholderIds.length > 0 &&
                createdPaths.length > artifactPlaceholderIds.length
                  ? createdPaths.slice(-artifactPlaceholderIds.length)
                  : createdPaths;
              const hiddenCreatedPaths =
                mappedCreatedPaths.length === createdPaths.length
                  ? []
                  : createdPaths.slice(0, createdPaths.length - mappedCreatedPaths.length);
              if (hiddenCreatedPaths.length) {
                setComposerHiddenArtifacts((current) => {
                  const next = { ...current };
                  hiddenCreatedPaths.forEach((createdPath) => {
                    next[createdPath] = true;
                    const fallbackId = createdPath.split("/").pop()?.replace(/\.md$/, "");
                    const file = finalSnapshot?.files.find((entry) => entry.path === createdPath);
                    const parsed = parseFrontmatter(file?.content);
                    const artifactId =
                      typeof parsed?.meta.id === "string" && parsed.meta.id.trim()
                        ? parsed.meta.id.trim()
                        : fallbackId;
                    if (artifactId) next[artifactId] = true;
                  });
                  return next;
                });
              }
              // Map each created artifact to the placeholder it replaces so
              // the finished tile appears exactly where the blob was.
              setComposerSpawnOrigins((current) => {
                const next = { ...current };
                mappedCreatedPaths.forEach((createdPath, index) => {
                  const placeholderId =
                    artifactPlaceholderIds[index] ?? (index === 0 ? `${requestKey}_0` : null);
                  if (!placeholderId) return;
                  next[createdPath] = placeholderId;
                  const fallbackId = createdPath.split("/").pop()?.replace(/\.md$/, "");
                  const file = finalSnapshot?.files.find((entry) => entry.path === createdPath);
                  const parsed = parseFrontmatter(file?.content);
                  const artifactId =
                    typeof parsed?.meta.id === "string" && parsed.meta.id.trim()
                      ? parsed.meta.id.trim()
                      : fallbackId;
                  if (artifactId) next[artifactId] = placeholderId;
                });
                return next;
              });
            }
            if (event.snapshot) applySnapshot(event.snapshot as ProjectSnapshot);
          } else if (event.type === "error") {
            throw new Error(
              typeof event.message === "string" ? event.message : "Canvas task failed.",
            );
          }
        }
      }
    } catch (caught) {
      requestFailed = true;
      // The canvas composer must not fail silently — surface it (this is also
      // where the insufficient-credits "Buy credits to continue." message lands).
      const message =
        caught instanceof Error ? caught.message : "Canvas task failed. Please try again.";
      setComposerPlaceholders((current) =>
        current.map((entry) =>
          entry.id.startsWith(requestKey)
            ? {
                ...entry,
                remediation: message,
                settled: true,
                state: "failed",
                title: entry.title === "Imagining…" ? "Generation failed" : entry.title,
              }
            : entry,
        ),
      );
      if (/insufficient credits/i.test(message)) {
        toast.error(message, {
          action: { label: "Buy credits", onClick: () => setBuyCreditsOpen(true) },
        });
      } else {
        toast.error(message);
      }
    } finally {
      if (createdArtifactPaths) {
        window.setTimeout(clearPlaceholders, 650);
      } else if (!requestFailed) {
        clearPlaceholders();
      }
      if (revisedTileIds.length) {
        setEditingTileIds((current) => {
          const next = new Set(current);
          for (const revisedId of revisedTileIds) next.delete(revisedId);
          return next;
        });
      }
      // Fade out anything the run left behind on the ticker.
      setComposerActions((current) =>
        current.map((entry) =>
          entry.key.startsWith(requestKey) ? { ...entry, leaving: true } : entry,
        ),
      );
      window.setTimeout(() => {
        setComposerActions((current) =>
          current.filter((entry) => !entry.key.startsWith(requestKey)),
        );
      }, 450);
      composerRunCountRef.current = Math.max(0, composerRunCountRef.current - 1);
      if (composerRunCountRef.current === 0) setCanvasComposerBusy(false);
      refreshCredits();
    }
  }

  async function uploadCanvasFiles(files: File[]) {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    const response = await fetch(`/api/projects/${snapshot.project.id}/canvas/upload`, {
      method: "POST",
      body: form,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(typeof payload.error === "string" ? payload.error : "Upload failed.");
    }
    if (payload.snapshot) applySnapshot(payload.snapshot);
  }

  function appendOptimisticCanvasRequest(
    kind: "compose" | "draw" | "edit" | "track",
    title: string,
    instruction: string,
  ) {
    // Mirror of the compact entry the API routes append server-side; the next
    // applySnapshot replaces it with the persisted copy.
    setSnapshot((current) => ({
      ...current,
      chat: [
        ...current.chat,
        {
          at: new Date().toISOString(),
          role: "user" as const,
          text: formatCanvasChatRequest({ kind, title }, instruction),
        },
      ],
    }));
  }

  async function requestCanvasDrawChange({ card, request }: CanvasDrawRequest) {
    viewPinnedRef.current = true;
    setWorkspaceView("canvas");
    appendOptimisticCanvasRequest(
      request.media.kind === "video" ? "track" : "draw",
      card.title,
      request.instruction || (request.media.kind === "video" ? "Track the marked object." : ""),
    );
    if (request.media.kind === "video") {
      const response = await fetch(`/api/projects/${snapshot.project.id}/tracks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          annotations: request.annotations,
          frame: request.frame,
          instruction: request.instruction,
          media: request.media,
          source: {
            id: card.id,
            kind: card.kind,
            path: card.path,
            title: card.title,
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string" ? payload.error : "Failed to start video tracking.",
        );
      }
      if (payload.snapshot) {
        applySnapshot(payload.snapshot as ProjectSnapshot);
      }
      return;
    }
    // Draw-over on an image edits the image in place (a new keyframe tile);
    // only video sources produce clips.
    const isImageSource = card.kind === "keyframe" || card.kind === "image";
    const workingPath = isImageSource
      ? `keyframes/${card.id}_draw.md`
      : `clips/${card.id}_draw.md`;
    setWorkingPaths((current) => new Set(current).add(workingPath));
    setCanvasFocusRequest({ id: `${card.id}_draw`, kind: "card", nonce: nextFocusNonce() });
    try {
      const response = await fetch(`/api/projects/${snapshot.project.id}/canvas/regenerate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          annotations: request.annotations,
          frame: request.frame,
          instruction: request.instruction,
          source: {
            id: card.id,
            kind: card.kind,
            path: card.path,
            title: card.title,
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string" ? payload.error : "Failed to generate canvas change.",
        );
      }
      applySnapshot(payload);
    } finally {
      setWorkingPaths((current) => {
        const next = new Set(current);
        next.delete(workingPath);
        return next;
      });
    }
  }

  async function requestCanvasDeleteCards({ cards }: CanvasDeleteRequest) {
    // Any workspace tile (clip, image, upload, audio) is deletable — the
    // route accepts all tile paths, only placeholders ("#") are skipped.
    const clipCards = cards.filter(
      (card) => card.path !== "#" && /^(clips|keyframes|uploads)\//.test(card.path),
    );
    if (!clipCards.length) return;
    viewPinnedRef.current = true;
    setWorkspaceView("canvas");
    const response = await fetch(`/api/projects/${snapshot.project.id}/canvas/delete-tiles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clips: clipCards.map((card) => ({
          id: card.id,
          path: card.path,
        })),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        typeof payload.error === "string" ? payload.error : "Failed to delete canvas tile.",
      );
    }
    applySnapshot(payload);
  }

  async function requestCanvasEditClip({ card, mode, trim }: CanvasEditClipRequest) {
    viewPinnedRef.current = true;
    setWorkspaceView("canvas");
    const previousClipPaths = new Set(snapshot.files.map((file) => file.path));
    const response = await fetch(`/api/projects/${snapshot.project.id}/canvas/edit-clip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clipId: card.id,
        mode,
        ops: {
          trim,
        },
        path: card.path,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        typeof payload.error === "string" ? payload.error : "Failed to edit canvas clip.",
      );
    }
    const nextSnapshot = payload as ProjectSnapshot;
    applySnapshot(nextSnapshot);
    if (mode === "new") {
      const created = nextSnapshot.files.find((file) => {
        if (previousClipPaths.has(file.path) || !file.path.startsWith("clips/")) return false;
        const parsed = parseFrontmatter(file.content);
        if (!parsed) return false;
        return parsed.meta.derived_from === card.id || parsed.meta.source_clip === card.id;
      });
      const parsed = parseFrontmatter(created?.content);
      const createdId = typeof parsed?.meta.id === "string" ? parsed.meta.id : null;
      if (createdId) {
        setCanvasFocusRequest({ id: createdId, kind: "clip", nonce: Date.now() });
      }
    }
  }

  // Live workspace updates while the agent runs: every tool result schedules a
  // debounced snapshot refetch, so files appear/update in the tree as they are
  // written instead of only when the run completes.
  const liveRefreshTimerRef = useRef<number | null>(null);
  const liveRefreshBusyRef = useRef(false);
  const hasActiveYoutubeImport = useMemo(
    () =>
      snapshot.files.some((file) => {
        if (!file.path.startsWith("imports/youtube/") || !file.path.endsWith(".json")) {
          return false;
        }
        try {
          const parsed = JSON.parse(file.content || "{}") as { status?: string };
          return parsed.status !== "completed" && parsed.status !== "failed" && parsed.status !== "needs_assets";
        } catch {
          return false;
        }
      }),
    [snapshot.files],
  );
  const youtubeImports = useMemo(
    () =>
      snapshot.files
        .filter((file) => file.path.startsWith("imports/youtube/") && file.path.endsWith(".json"))
        .map((file) => {
          try {
            const parsed = JSON.parse(file.content || "{}") as {
              error?: string | null;
              id?: string;
              slots?: Array<{ status?: string }>;
              status?: string;
              updatedAt?: string;
            };
            if (!parsed.id || !parsed.status) return null;
            return {
              error: parsed.error ?? null,
              id: parsed.id,
              slots: (parsed.slots ?? []).map((slot) => ({ status: String(slot.status ?? "") })),
              status: parsed.status,
              updatedAt: parsed.updatedAt,
            };
          } catch {
            return null;
          }
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? "")),
    [snapshot.files],
  );
  useEffect(() => {
    return () => {
      if (liveRefreshTimerRef.current !== null) {
        window.clearTimeout(liveRefreshTimerRef.current);
      }
    };
  }, []);
  useEffect(() => {
    if (!hasActiveYoutubeImport) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (cancelled || liveRefreshBusyRef.current) return;
      liveRefreshBusyRef.current = true;
      void fetch(`/api/projects/${snapshot.project.id}`)
        .then(async (response) => {
          if (!cancelled && response.ok) applySnapshot(await response.json());
        })
        .catch(() => {})
        .finally(() => {
          liveRefreshBusyRef.current = false;
        });
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hasActiveYoutubeImport, snapshot.project.id]);
  function scheduleLiveRefresh(projectId: string) {
    if (liveRefreshTimerRef.current !== null) return;
    liveRefreshTimerRef.current = window.setTimeout(() => {
      liveRefreshTimerRef.current = null;
      if (liveRefreshBusyRef.current) return;
      liveRefreshBusyRef.current = true;
      void fetch(`/api/projects/${projectId}`)
        .then(async (response) => {
          if (response.ok) applySnapshot(await response.json());
        })
        .catch(() => {})
        .finally(() => {
          liveRefreshBusyRef.current = false;
        });
    }, 400);
  }

  // Paper mode: an external Claude Code/Codex process writes project files and
  // invokes media tools through MCP. Subscribe to the local workspace watcher
  // so those edits become visible without a browser reload. Explicit Paper
  // events carry in-flight artifact identity; raw fs events cover direct edits.
  useEffect(() => {
    const projectId = snapshot.project.id;
    const events = new EventSource(`/api/projects/${projectId}/events`);
    let reconnectTimer: number | null = null;
    const refreshFromDisk = () => scheduleLiveRefresh(projectId);
    const onConnected = () => {
      if (agentActivityConnectionRef.current === "disconnected") {
        const reconnectKey = `${Date.now()}`;
        setError((current) =>
          current && classifyActivityFailure(current).canReconnect
            ? null
            : current,
        );
        setExternalActivityItems((current) =>
          current.filter(
            (item) => !(item.status === "error" && item.canReconnect),
          ),
        );
        setToolReceiptActivities((current) =>
          current.filter(
            (item) => !(item.status === "error" && item.canReconnect),
          ),
        );
        setAgentActivityReconnectKey(reconnectKey);
        if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          setAgentActivityReconnectKey((current) =>
            current === reconnectKey ? null : current,
          );
        }, 1300);
      }
      agentActivityConnectionRef.current = "connected";
      setAgentActivityConnection("connected");
    };
    const onDisconnected = () => {
      agentActivityConnectionRef.current = "disconnected";
      setAgentActivityConnection("disconnected");
    };
    const recordActivity = (item: AgentActivityItem) => {
      setExternalActivityItems((current) => [
        item,
        ...current.filter((currentItem) => currentItem.id !== item.id),
      ].slice(0, 6));
    };
    const onPaper = (message: MessageEvent<string>) => {
      let event: PaperActivityEvent & {
        aspectRatio?: string;
      };
      try {
        event = JSON.parse(message.data) as typeof event;
      } catch {
        return;
      }
      const paths = Array.isArray(event.paths) ? event.paths : [];
      if (event.kind === "working") {
        recordActivity(activityFromPaperEvent(event));
        setWorkingPaths((current) => new Set([...current, ...paths]));
        const referenceScoped =
          paths.length > 0 && paths.every((p) => p.startsWith("references/"));
        if (event.tool === "generate_image" && event.artifactId && !referenceScoped) {
          const callId = `paper:${event.artifactId}`;
          setGeneratingKeyframes((current) =>
            current.some((entry) => entry.callId === callId)
              ? current
              : [
                  ...current,
                  {
                    aspectRatio: event.aspectRatio ?? null,
                    callId,
                    id: event.artifactId!,
                    title: event.title ?? event.artifactId!,
                  },
                ],
          );
          setCanvasFocusRequest({
            id: event.artifactId,
            kind: "card",
            nonce: Date.now(),
          });
        }
        if (event.tool === "generate_clip" && event.artifactId) {
          setEditingTileIds((current) => new Set(current).add(event.artifactId!));
        }
        if (!viewPinnedRef.current) setWorkspaceView("canvas");
      } else if (event.kind === "settled") {
        setWorkingPaths((current) => {
          const next = new Set(current);
          for (const path of paths) next.delete(path);
          return next;
        });
        if (event.artifactId) {
          const artifactId = event.artifactId;
          setGeneratingKeyframes((current) =>
            current.filter((entry) => entry.callId !== `paper:${artifactId}`),
          );
          setEditingTileIds((current) => {
            const next = new Set(current);
            next.delete(artifactId);
            return next;
          });
        }
        void fetch(`/api/projects/${projectId}`)
          .then(async (response) => {
            if (!response.ok) {
              throw new Error(`Desktop connection failed (${response.status}).`);
            }
            return response.json() as Promise<ProjectSnapshot>;
          })
          .then((next) => {
            applySnapshot(next);
            recordActivity(activityFromPaperEvent(event, next.files));
          })
          .catch((caught) => {
            const failure = classifyActivityFailure(
              caught instanceof Error ? caught.message : "Desktop connection failed.",
            );
            const pending = activityFromPaperEvent({ ...event, ok: false, error: failure.message });
            recordActivity({
              ...pending,
              canReconnect: true,
              detail: failure.message,
              status: "error",
            });
          });
      } else if (event.kind === "changed") {
        recordActivity(activityFromPaperEvent(event));
      }
      refreshFromDisk();
    };
    const onEditorCommand = (message: MessageEvent<string>) => {
      let event: EditorActivityEvent;
      try {
        event = JSON.parse(message.data) as EditorActivityEvent;
      } catch {
        return;
      }
      const item = activityFromEditorEvent(event);
      if (item) recordActivity(item);
      if (
        event.kind === "editor.command.completed" ||
        event.kind === "editor.command.failed"
      ) {
        void refreshEditorPlacementDocument();
      }
    };
    const onWorkspace = () => {
      refreshFromDisk();
      void refreshEditorPlacementDocument();
    };
    const onUi = (message: MessageEvent<string>) => {
      let event: { kind?: string; view?: string };
      try {
        event = JSON.parse(message.data) as { kind?: string; view?: string };
      } catch {
        return;
      }
      if (event.kind !== "view.switch") return;
      viewPinnedRef.current = true;
      setWorkspaceView(event.view === "editor" ? "editor" : "canvas");
    };
    const onAgentInteraction = (message: MessageEvent<string>) => {
      let event: AgentInteractionEvent;
      try {
        event = JSON.parse(message.data) as AgentInteractionEvent;
      } catch {
        return;
      }
      if (!event.request?.id) return;
      setAgentInteractions((current) => [
        event.request,
        ...current.filter((item) => item.id !== event.request.id),
      ]);
    };
    events.addEventListener("open", onConnected);
    events.addEventListener("ready", onConnected);
    events.addEventListener("error", onDisconnected);
    events.addEventListener(
      "editor-command",
      onEditorCommand as EventListener,
    );
    events.addEventListener(
      "agent-interaction",
      onAgentInteraction as EventListener,
    );
    events.addEventListener("paper", onPaper as EventListener);
    events.addEventListener("workspace", onWorkspace);
    events.addEventListener("ui", onUi as EventListener);
    return () => {
      events.removeEventListener("open", onConnected);
      events.removeEventListener("ready", onConnected);
      events.removeEventListener("error", onDisconnected);
      events.removeEventListener(
        "editor-command",
        onEditorCommand as EventListener,
      );
      events.removeEventListener(
        "agent-interaction",
        onAgentInteraction as EventListener,
      );
      events.removeEventListener("paper", onPaper as EventListener);
      events.removeEventListener("workspace", onWorkspace);
      events.removeEventListener("ui", onUi as EventListener);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      events.close();
    };
  }, [refreshEditorPlacementDocument, snapshot.project.id]);

  async function isRunStillActive(runId: string): Promise<boolean> {
    const res = await fetch(`/api/projects/${snapshot.project.id}/chat/stream`).catch(() => null);
    if (!res?.ok) return false;
    const { activeRun } = (await res.json().catch(() => ({}))) as {
      activeRun?: { triggerRunId?: string } | null;
    };
    return activeRun?.triggerRunId === runId;
  }

  // Read (or resume) a run's resumable stream. Used by a fresh send AND by the
  // reconnect-on-mount effect — same parser, just a different startIndex.
  async function streamRun(runId: string, startIndex = 0): Promise<void> {
    currentRunIdRef.current = runId;
    if (abortRequestedRef.current) {
      await cancelRunOnServer(runId);
      return;
    }
    let nextStartIndex = startIndex;
    let replaying = false;

    while (!userStoppedRunRef.current) {
      const streamAbort = new AbortController();
      streamAbortRef.current?.abort();
      streamAbortRef.current = streamAbort;
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/chat/stream/${runId}?startIndex=${nextStartIndex}`,
        { signal: streamAbort.signal },
      );
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Stream failed.");
      }
      if (!response.body) throw new Error("Streaming response was empty.");

      // Keep the visible in-flight state while a dropped stream reconnects.
      // Replayed tool events are merged by call id, so clearing here only causes
      // rows and active canvas indicators to blink out until replay catches up.

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let receivedFinal = false;
      let replayText = replaying ? "" : null;

      const handleEvent = (event: ChatStreamEvent) => {
        if (event.type === "status") {
          return;
        } else if (event.type === "text_delta") {
          if (replayText === null) {
            streamTextLenRef.current += event.text.length;
            setStreamText((current) => current + event.text);
          } else {
            replayText += event.text;
            const nextReplayText = replayText;
            setStreamText((current) => {
              if (current.startsWith(nextReplayText)) return current;
              return nextReplayText.startsWith(current) ? nextReplayText : current;
            });
          }
        } else if (event.type === "tool_start") {
          return;
        } else if (event.type === "tool_call") {
          const callId = event.toolCallId ?? `${event.toolName}-${Date.now()}`;
          setToolReceiptActivities((current) => [
            {
              id: `chat:${callId}`,
              label: composerActionLabel(
                event.toolName,
                toolSummaryFromInput(event.toolName, event.input) ?? null,
              ),
              status: "running" as const,
            },
            ...current.filter((item) => item.id !== `chat:${callId}`),
          ].slice(0, 6));
          setStreamTools((current) =>
            current.some((tool) => tool.id === callId)
              ? current
              : [
                  ...current,
                  {
                    id: callId,
                    name: event.toolName,
                    summary: toolSummaryFromInput(event.toolName, event.input),
                    textOffset: streamTextLenRef.current,
                  },
                ],
          );
          // Feed the canvas action ticker: chat-run tools show there too.
          {
            const input =
              event.input && typeof event.input === "object" && !Array.isArray(event.input)
                ? (event.input as Record<string, unknown>)
                : {};
            const tickerKey = `chat:${callId}`;
            setComposerActions((current) =>
              current.some((entry) => entry.key === tickerKey)
                ? current
                : [
                    // Single-slot ticker: the newest action supersedes the rest.
                    ...current.map((entry) => ({ ...entry, leaving: true })),
                    {
                      key: tickerKey,
                      label: composerActionLabel(
                        event.toolName,
                        typeof input.title === "string" ? input.title : null,
                      ),
                      leaving: false,
                      tool: event.toolName,
                      toolName: tickerKey,
                    },
                  ],
            );
            window.setTimeout(() => {
              setComposerActions((current) =>
                current.filter((entry) => !entry.leaving || entry.key === tickerKey),
              );
            }, 450);
          }
          const paths = pathsForToolCall(event.toolName, event.input);
          if (paths.length) {
            if (event.toolCallId) toolCallPathsRef.current.set(event.toolCallId, paths);
            setWorkingPaths((current) => new Set([...current, ...paths]));
          }
          if (
            (event.toolName === "generateKeyframe" || event.toolName === "captureFrame") &&
            event.toolCallId
          ) {
            const input =
              event.input && typeof event.input === "object" && !Array.isArray(event.input)
                ? (event.input as Record<string, unknown>)
                : {};
            const id =
              typeof input.id === "string"
                ? input.id
                : typeof input.keyframe_id === "string"
                  ? input.keyframe_id
                  : null;
            if (id) {
              const title = typeof input.title === "string" ? input.title : id;
              const aspectRatio =
                typeof input.aspect_ratio === "string" ? input.aspect_ratio : null;
              const callId = event.toolCallId;
              setGeneratingKeyframes((current) =>
                current.some((entry) => entry.callId === callId || entry.id === id)
                  ? current
                  : [...current, { id, title, callId, aspectRatio }],
              );
              if (!viewPinnedRef.current) setWorkspaceView("canvas");
              setCanvasFocusRequest({ id, kind: "card", nonce: Date.now() });
            }
          }
          // Any artifact tool: zoom the canvas to the tile being made; a
          // revision instead shimmers the tile being edited.
          {
            const input =
              event.input && typeof event.input === "object" && !Array.isArray(event.input)
                ? (event.input as Record<string, unknown>)
                : {};
            const revises = typeof input.revises === "string" ? input.revises : null;
            // The existing tile this call is working on: a revision target, an
            // artifact id, or the reference whose portfolio is being rebuilt.
            // Whatever we auto-zoom to must also shimmer — otherwise the canvas
            // just jumps somewhere and the user has no idea why.
            const targetId =
              revises ??
              (CANVAS_ARTIFACT_TOOLS.has(event.toolName) && typeof input.id === "string" && input.id
                ? input.id
                : null) ??
              (event.toolName === "generateReferencePortfolio" &&
              typeof input.reference_id === "string" &&
              input.reference_id
                ? input.reference_id.replace(/^@/, "")
                : null);
            if (targetId) {
              if (event.toolCallId) {
                editingByCallRef.current.set(event.toolCallId, targetId);
                setEditingTileIds((current) => new Set(current).add(targetId));
              }
              if (!viewPinnedRef.current) setWorkspaceView("canvas");
              setCanvasFocusRequest({ id: targetId, kind: "card", nonce: Date.now() });
            }
          }
          if (event.toolName === "askUser" && event.toolCallId) {
            const input =
              event.input && typeof event.input === "object" && !Array.isArray(event.input)
                ? (event.input as Record<string, unknown>)
                : {};
            const questions = Array.isArray(input.questions) ? input.questions : [];
            if (questions.length) {
              setUserQuestion({
                activeIndex: 0,
                answers: [],
                customText: "",
                questions: questions as never,
                selected: [],
                toolCallId: event.toolCallId,
                uploading: false,
                uploads: [],
              });
            }
          }
          if (event.toolName === "generateReferencePortfolio" && event.toolCallId) {
            const input =
              event.input && typeof event.input === "object" && !Array.isArray(event.input)
                ? (event.input as Record<string, unknown>)
                : {};
            const id = typeof input.reference_id === "string" ? input.reference_id : null;
            if (id) {
              const callId = event.toolCallId;
              const category = typeof input.category === "string" ? input.category : null;
              const title = typeof input.title === "string" ? input.title : null;
              setGeneratingReferences((current) =>
                current.some((entry) => entry.callId === callId || entry.id === id)
                  ? current
                  : [...current, { id, callId, category, title }],
              );
              if (!viewPinnedRef.current) setWorkspaceView("canvas");
              setCanvasFocusRequest({ id, kind: "card", nonce: Date.now() });
            }
          }
        } else if (event.type === "tool_result") {
          if (event.toolName === "askUser") setUserQuestion(null);
          refreshCredits();
          if (event.toolCallId && editingByCallRef.current.has(event.toolCallId)) {
            const revisedId = editingByCallRef.current.get(event.toolCallId)!;
            editingByCallRef.current.delete(event.toolCallId);
            setEditingTileIds((current) => {
              const next = new Set(current);
              next.delete(revisedId);
              return next;
            });
          }
          const callId = event.toolCallId ?? `${event.toolName}-${Date.now()}`;
          const ok = toolResultOk(event.output);
          setToolReceiptActivities((current) => {
            const existing = current.find((item) => item.id === `chat:${callId}`);
            const receipt = activityFromToolReceipt({
              id: `chat:${callId}`,
              label: existing?.label ?? composerActionLabel(event.toolName, null),
              output: event.output,
            });
            return [
              receipt,
              ...current.filter((item) => item.id !== receipt.id),
            ].slice(0, 6);
          });
          {
            const tickerKey = `chat:${callId}`;
            setComposerActions((current) => {
              const exact = current.find((entry) => entry.key === tickerKey);
              const target =
                exact ??
                current.find((entry) => entry.tool === event.toolName && !entry.leaving);
              if (!target) return current;
              return current.map((entry) =>
                entry.key === target.key ? { ...entry, leaving: true } : entry,
              );
            });
            window.setTimeout(() => {
              setComposerActions((current) =>
                current.filter(
                  (entry) =>
                    !(entry.leaving && (entry.key === tickerKey || entry.tool === event.toolName)),
                ),
              );
            }, 420);
          }
          setStreamTools((current) => {
            const existing = current.find((tool) => tool.id === callId);
            if (!existing) {
              return [
                ...current,
                { id: callId, name: event.toolName, ok, durationMs: event.durationMs },
              ];
            }
            return current.map((tool) =>
              tool.id === callId ? { ...tool, ok, durationMs: event.durationMs } : tool,
            );
          });
          const paths = event.toolCallId
            ? (toolCallPathsRef.current.get(event.toolCallId) ?? [])
            : [];
          if (paths.length) {
            if (event.toolCallId) toolCallPathsRef.current.delete(event.toolCallId);
            setWorkingPaths((current) => {
              const next = new Set(current);
              for (const path of paths) next.delete(path);
              return next;
            });
          }
          if (event.toolCallId) {
            const output =
              event.output && typeof event.output === "object" && !Array.isArray(event.output)
                ? (event.output as Record<string, unknown>)
                : null;
            if (output && output.ok === false) {
              const callId = event.toolCallId;
              setGeneratingKeyframes((current) => current.filter((entry) => entry.callId !== callId));
              setGeneratingReferences((current) =>
                current.filter((entry) => entry.callId !== callId),
              );
            }
          }
          scheduleLiveRefresh(snapshot.project.id);
        } else if (event.type === "final") {
          receivedFinal = true;
          setStreamText(event.reply);
          toolCallPathsRef.current.clear();
          editingByCallRef.current.clear();
          setEditingTileIds(new Set());
          void refreshProjectSnapshot().finally(() => {
            setWorkingPaths(new Set());
            setGeneratingReferences([]);
          });
        } else if (event.type === "error") {
          throw new Error(event.error);
        }
      };

      while (!receivedFinal) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: ChatStreamEvent;
          try {
            event = JSON.parse(line) as ChatStreamEvent;
          } catch {
            continue; // skip a malformed line rather than aborting the whole run
          }
          handleEvent(event);
          if (receivedFinal) break; // terminal: the run is done from the agent's POV
        }
      }
      // The `final` event is the run's terminal signal — stop here rather than
      // waiting for the durable stream to finalize (Trigger's run-complete
      // propagation lags seconds behind, which kept the UI in "sending" too long).
      // Release the connection; the server-side run already persisted everything.
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
      if (!receivedFinal && buffer.trim()) {
        try {
          handleEvent(JSON.parse(buffer) as ChatStreamEvent);
        } catch {
          // trailing partial; the reconcile below covers it
        }
      }
      if (streamAbortRef.current === streamAbort) streamAbortRef.current = null;
      if (receivedFinal) {
        if (!userStoppedRunRef.current) await refresh().catch(() => {});
        return;
      }
      if (userStoppedRunRef.current) return;
      if (await isRunStillActive(runId)) {
        await delay(replaying ? 1500 : 750);
        nextStartIndex = 0;
        replaying = true;
        continue;
      }
      // No final event and no active run: reconcile once and let the caller's
      // finally block end the UI. This covers completed/cancelled runs whose
      // stream buffer expired or closed after the terminal write.
      await refresh().catch(() => {});
      return;
    }
  }

  function clearRunUi(options?: { clearAssistant?: boolean }) {
    const clearAssistant = options?.clearAssistant ?? true;
    setSending(false);
    if (clearAssistant) {
      setStreamText("");
    streamTextLenRef.current = 0;
      setStreamTools([]);
    }
    // Fade out any chat-run entries left on the canvas action ticker.
    setComposerActions((current) =>
      current.map((entry) =>
        entry.key.startsWith("chat:") ? { ...entry, leaving: true } : entry,
      ),
    );
    window.setTimeout(() => {
      setComposerActions((current) =>
        current.filter((entry) => !entry.key.startsWith("chat:")),
      );
    }, 450);
    setWorkingPaths(new Set());
    setGeneratingKeyframes([]);
    setGeneratingReferences([]);
    toolCallPathsRef.current.clear();
    currentRunIdRef.current = null;
    viewPinnedRef.current = false;
  }

  function retainVisibleAssistantTurn() {
    const text = streamTextRef.current;
    const tools = streamToolsRef.current;
    setAbortedAssistantTurn({ stopped: true, text, tools });
  }

  async function cancelRunOnServer(runId: string): Promise<void> {
    try {
      await fetch(`/api/projects/${snapshot.project.id}/chat/stream/${runId}`, { method: "DELETE" });
    } catch {
      // best-effort; the task also stops on its own signal
    } finally {
      await refresh().catch(() => {});
      abortRequestedRef.current = false;
      setAbortingRun(false);
      currentRunIdRef.current = null;
    }
  }

  function isAbortError(caught: unknown) {
    return caught instanceof DOMException
      ? caught.name === "AbortError"
      : caught instanceof Error && caught.name === "AbortError";
  }

  async function abortRun(): Promise<void> {
    const runId = currentRunIdRef.current;
    if (abortingRun || abortRequestedRef.current) return;
    abortRequestedRef.current = true;
    setAbortingRun(true);
    userStoppedRunRef.current = true;
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    retainVisibleAssistantTurn();
    clearRunUi();
    toast("Stopping Impractical.");
    if (!runId) {
      abortRequestedRef.current = false;
      setAbortingRun(false);
      return;
    }
    await cancelRunOnServer(runId);
  }

  // Self-healing reconnect: whenever this page is NOT watching a run, check
  // whether one is alive and reattach (full replay restores streamed text and
  // tool rows). Triggers: mount, tab becoming visible, window focus, and a
  // slow idle poll — so no refresh/HMR/navigation timing can permanently
  // orphan a live run.
  useEffect(() => {
    let cancelled = false;
    const attemptReconnect = async () => {
      if (cancelled || reconnectAttemptedRef.current) return;
      if (currentRunIdRef.current || sendingRef.current) return; // already watching
      reconnectAttemptedRef.current = true;
      try {
        let activeRun: { triggerRunId?: string } | null = null;
        try {
          const res = await fetch(`/api/projects/${snapshot.project.id}/chat/stream`);
          if (res.ok) {
            activeRun =
              ((await res.json()) as { activeRun?: { triggerRunId?: string } | null })
                .activeRun ?? null;
          } else {
            console.warn("[reconnect] discovery failed", res.status);
          }
        } catch (caught) {
          console.warn("[reconnect] discovery error", caught);
        }
        if (cancelled || !activeRun?.triggerRunId) return;
        if (deadRunIdsRef.current.has(activeRun.triggerRunId)) return;
        if (currentRunIdRef.current || sendingRef.current) return;
        setSending(true);
        setError(null);
        setStreamText("");
    streamTextLenRef.current = 0;
        setStreamTools([]);
        try {
          await streamRun(activeRun.triggerRunId, 0);
        } catch (caught) {
          deadRunIdsRef.current.add(activeRun.triggerRunId);
          if (!cancelled && !userStoppedRunRef.current && !isAbortError(caught)) {
            setError(caught instanceof Error ? caught.message : "Reconnect failed.");
          }
        } finally {
          if (!cancelled && !userStoppedRunRef.current) {
            setSending(false);
            setStreamTools([]);
            setWorkingPaths(new Set());
            setGeneratingKeyframes([]);
            setGeneratingReferences([]);
            toolCallPathsRef.current.clear();
            currentRunIdRef.current = null;
          }
        }
      } finally {
        // Re-arm: a failed or fruitless attempt must not burn the only shot.
        reconnectAttemptedRef.current = false;
      }
    };
    reconnectNowRef.current = () => {
      reconnectAttemptedRef.current = false;
      void attemptReconnect();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void attemptReconnect();
    };
    void attemptReconnect();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const interval = window.setInterval(() => void attemptReconnect(), 20_000);
    return () => {
      cancelled = true;
      reconnectNowRef.current = () => undefined;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send(
    textOverride?: string,
    options?: { includeAttachments?: boolean },
  ) {
    const includeAttachments = options?.includeAttachments ?? textOverride === undefined;
    const attachmentsForSend = includeAttachments ? chatAttachments : [];
    const trimmed = (textOverride ?? "").trim();
    if ((!trimmed && attachmentsForSend.length === 0) || sending || abortingRun) return;
    abortRequestedRef.current = false;
    userStoppedRunRef.current = false;
    chatShouldAutoScrollRef.current = true;
    const stagedBlock =
      includeAttachments && stagedRefs.length
        ? `\n\n[Staged canvas references — the user staged these tiles as context for this request: ${stagedRefs
            .map((ref) => `@${ref.id}`)
            .join(" ")}]`
        : "";
    const requestText = (trimmed || "Please review the attached files.") + stagedBlock;
    setSending(true);
    setAbortingRun(false);
    setAbortedAssistantTurn(null);
    setError(null);
    setStreamText("");
    streamTextLenRef.current = 0;
    setStreamTools([]);
    let attachmentPayloads: ChatAttachmentPayload[] = [];
    let startedRunId: string | null = null;
    if (includeAttachments) {
      setChatAttachments([]);
      try {
        attachmentPayloads = await serializeChatAttachments(attachmentsForSend);
      } catch (error) {
        setSending(false);
        setError(error instanceof Error ? error.message : "Failed to read attachments.");
        setChatAttachments(attachmentsForSend);
        return;
      }
      clearChatAttachments(attachmentsForSend);
    }
    const optimisticText =
      attachmentPayloads.length > 0
        ? [
            requestText,
            "",
            "Attached files:",
            ...attachmentPayloads.map((attachment) => `- ${attachment.name}`),
          ].join("\n")
        : requestText;
    const optimistic = {
      ...snapshot,
      chat: [
        ...snapshot.chat,
        { role: "user" as const, text: optimisticText, at: new Date().toISOString() },
      ],
    };
    setSnapshot(optimistic);
    try {
      const startRes = await fetch(`/api/projects/${snapshot.project.id}/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attachments: attachmentPayloads,
          focusedTile: selectedTile,
          message: requestText,
        }),
      });
      if (!startRes.ok) {
        const data = await startRes.json().catch(() => ({}));
        throw new Error(data.error || "Chat request failed.");
      }
      const { runId } = (await startRes.json()) as { runId?: string };
      if (!runId) throw new Error("Run did not start.");
      startedRunId = runId;
      currentRunIdRef.current = runId;
      if (abortRequestedRef.current) {
        await cancelRunOnServer(runId);
        return;
      }
      await streamRun(runId, 0);
    } catch (caught) {
      if (!userStoppedRunRef.current && !isAbortError(caught)) {
        setError(caught instanceof Error ? caught.message : "Chat failed.");
        await refresh().catch(() => {});
      }
    } finally {
      if (!userStoppedRunRef.current) {
        setSending(false);
        setStreamTools([]);
        setWorkingPaths(new Set());
        setGeneratingKeyframes([]);
        setGeneratingReferences([]);
        toolCallPathsRef.current.clear();
        viewPinnedRef.current = false;
        currentRunIdRef.current = null;
      } else if (abortRequestedRef.current && !startedRunId) {
        abortRequestedRef.current = false;
        setAbortingRun(false);
      }
    }
  }

  const renderLegacyChatPanel = false;
  const titleBarActions = (
    <>
      <div
        className="tabs view-switcher desktop-titlebar-view-switcher"
        role="tablist"
        aria-label="Workspace view"
      >
        <ChromeTip label="Canvas">
          <button
            className={`tab ${workspaceView === "canvas" ? "active" : ""}`}
            type="button"
            role="tab"
            aria-selected={workspaceView === "canvas"}
            aria-label="Canvas"
            data-project-tour="canvas"
            onClick={() => {
              viewPinnedRef.current = true;
              setWorkspaceView("canvas");
            }}
          >
            <Infinity aria-hidden="true" size={15} />
          </button>
        </ChromeTip>
        <ChromeTip label="Editor">
          <button
            className={`tab ${workspaceView === "editor" ? "active" : ""}`}
            type="button"
            role="tab"
            aria-selected={workspaceView === "editor"}
            aria-label="Editor"
            data-project-tour="editor"
            onClick={() => {
              viewPinnedRef.current = true;
              // Navigation must work even while the selected artifact's
              // immutable identity is still being acknowledged by the server.
              setWorkspaceView("editor");
              const focused = canvasAgentContextCandidate.focused;
              if (focused) {
                void openCanvasArtifactInEditor({ artifact: focused });
              }
            }}
          >
            <Clapperboard aria-hidden="true" size={14} />
          </button>
        </ChromeTip>
      </div>
      <ChromeTip
        label={
          agentContextState.connected
            ? "External terminal agent connected"
            : "External agents (Terminal)"
        }
      >
        <span className="inline-flex">
          <AgentContextIndicator
            approvalRequired={
              currentAgentInteraction?.kind === "approval" ||
              Boolean(userQuestion)
            }
            projectId={snapshot.project.id}
            state={agentContextState}
          />
        </span>
      </ChromeTip>
      <span className="desktop-titlebar-auth">
        <SidebarAuthBadge menuSide="bottom" nativeTitle />
      </span>
      <Menu>
        <MenuTrigger asChild>
          <button
            aria-label="Share project"
            className="workbench-action-button workbench-action-share desktop-titlebar-share"
            type="button"
          >
            <Share2
              aria-hidden="true"
              className="workbench-action-icon workbench-action-icon-stroked"
              fill="none"
              strokeWidth={2}
            />
            <span>
              {editorExportStatus.isExporting
                ? `Exporting ${Math.round(editorExportStatus.progress * 100)}%`
                : shareCopied
                  ? "Copied"
                  : "Share"}
            </span>
            <ChevronDown size={13} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </MenuTrigger>
        <MenuContent
          align="end"
          className="desktop-titlebar-share-menu"
          sideOffset={8}
        >
          <MenuItem onSelect={() => void shareProject()}>
            <Link2 size={16} />
            {shareCopied ? "Project link copied" : "Share project link"}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            disabled={editorExportStatus.isExporting}
            onSelect={requestEditorMp4Export}
          >
            {editorExportStatus.isExporting ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Download size={16} />
            )}
            {editorExportStatus.isExporting
              ? `Exporting MP4 ${Math.round(editorExportStatus.progress * 100)}%`
              : "Export as MP4"}
          </MenuItem>
          {editorExportStatus.error ? (
            <MenuItem disabled className="max-w-72 text-red-500">
              {editorExportStatus.error}
            </MenuItem>
          ) : null}
        </MenuContent>
      </Menu>
    </>
  );

  useEffect(() => {
    try {
      if (
        sessionStorage.getItem(OPEN_PROJECT_ACTIVITY_STORAGE_KEY) !==
        snapshot.project.id
      ) {
        return;
      }
      sessionStorage.removeItem(OPEN_PROJECT_ACTIVITY_STORAGE_KEY);
      queueMicrotask(() => setAgentActivityOpen(true));
    } catch {
      // The project remains usable if session storage is unavailable.
    }
  }, [snapshot.project.id]);

  return (
    <div
      className={`app-shell workbench-shell${sidebarCollapsed ? " is-sidebar-hidden" : ""}`}
    >
      <DesktopWindowChrome
        activity={agentActivityEvent}
        activityButtonRef={agentActivityButtonRef}
        activityExpanded={agentActivityOpen}
        availableProjects={[
          {
            id: snapshot.project.id,
            name: snapshot.project.name,
          },
        ]}
        catalogComplete={false}
        currentProject={{
          id: snapshot.project.id,
          name: snapshot.project.name,
        }}
        onOpenActivity={() =>
          setAgentActivityOpen((current) => !current)
        }
        rightActions={titleBarActions}
      />
      <WorkbenchSidebar
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebar}
      />
      <div className="app-main-col workbench-main-col">
      <div className="browser-workspace-toolbar" role="toolbar" aria-label="Project tools">
        <TooltipProvider>
          <ChromeTip label="AI chat">
            <button aria-label="Open AI chat" data-project-tour="chat" className="desktop-titlebar-companion" type="button" onClick={() => window.open(`/companion?project=${encodeURIComponent(snapshot.project.id)}`, "_blank", "noopener,noreferrer")}>
              <MessageSquare aria-hidden="true" size={15} />
            </button>
          </ChromeTip>
          {titleBarActions}
        </TooltipProvider>
      </div>
      <div
        className="workbench-body grid min-h-0 w-full flex-1 overflow-hidden max-[1100px]:grid-cols-1"
      >
      {renderLegacyChatPanel ? (
      <section className="chat-panel flex min-h-0 flex-col overflow-hidden">
        <div
          ref={chatListRef}
          className={[
            "chat-list min-h-0 flex-1 overflow-auto",
            chatEdgeFade.top ? "chat-list-fade-top" : "",
            chatEdgeFade.bottom ? "chat-list-fade-bottom" : "",
          ].filter(Boolean).join(" ")}
          onScroll={handleChatScroll}
        >
          <div ref={chatContentRef} className="chat-list-content">
          {snapshot.chat.length === 0 ? (
            <div className="chat-empty-state">
              <h2 className="chat-empty-title" aria-label={EMPTY_CHAT_TITLE}>
                {EMPTY_CHAT_TITLE.split("").map((letter, index) => (
                  <span
                    key={`${letter}-${index}`}
                    aria-hidden="true"
                    style={{ animationDelay: `${index * 34}ms` }}
                  >
                    {letter === " " ? "\u00a0" : letter}
                  </span>
                ))}
              </h2>
              <div className="chat-starter-list" aria-label="Starter requests">
                {STARTER_REQUESTS.map((request) => (
                  <button
                    key={request}
                    type="button"
                    className="chat-starter"
                    disabled={sending}
                    onClick={() => void send(request)}
                  >
                    <CornerDownRight size={16} aria-hidden="true" />
                    <span>{request}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {chatRows.map((row) => {
            if (row.kind === "user") {
              return (
                <div key={row.key} className="chat-message-group is-user">
                  <div className="bubble user">{row.body}</div>
                  {row.attachments.length ? (
                    <div className="chat-attachment-row">
                      {row.attachments.map((attachment, attachmentIndex) =>
                        attachment.path && /\.(png|jpe?g|webp|gif)$/i.test(attachment.path) ? (
                          <img
                            key={`${attachment.path}-${attachmentIndex}`}
                            className="chat-attachment-thumb"
                            src={mediaPathSrc(snapshot.project.id, attachment.path)}
                            alt={attachment.name}
                            title={attachment.name}
                          />
                        ) : (
                          <span
                            key={`${attachment.name}-${attachmentIndex}`}
                            className="chat-attachment-chip"
                            title={attachment.path ?? attachment.name}
                          >
                            <FileText size={13} aria-hidden="true" />
                            {attachment.name}
                          </span>
                        ),
                      )}
                    </div>
                  ) : null}
                  <ChatMessageActions
                    align="user"
                    onCopy={() => void copyChatMessage(row.actionText)}
                  />
                </div>
              );
            }
            if (row.kind === "canvas-task") {
              const expanded = expandedTaskKeys.has(row.key);
              const rawTaskText =
                row.canvasRequest.instruction ||
                `${canvasChatRequestLabel(row.canvasRequest.meta)} · ${row.canvasRequest.meta.title}`;
              // Mentions read as titles, not raw ids.
              const taskText = rawTaskText.replace(
                /@([A-Za-z0-9][A-Za-z0-9_-]+)/g,
                (token, mentionId: string) => refResolver(mentionId)?.title ?? token,
              );
              // Every resolvable mention in the reply = a created artifact.
              const linkedEntries: RefEntry[] = [];
              if (row.response) {
                const seenIds = new Set<string>();
                for (const match of row.response.text.matchAll(/@([A-Za-z0-9][A-Za-z0-9_-]+)/g)) {
                  const mentionId = match[1]!;
                  if (seenIds.has(mentionId)) continue;
                  seenIds.add(mentionId);
                  const resolved = refResolver(mentionId);
                  if (resolved) linkedEntries.push(resolved);
                  if (linkedEntries.length >= 8) break;
                }
              }
              const toggleExpanded = () => {
                // The expand animation grows the scroll area — keep the
                // bottom-pin from yanking the view while it runs.
                chatScrollSuppressUntilRef.current = Date.now() + 700;
                setExpandedTaskKeys((current) => {
                  const next = new Set(current);
                  if (next.has(row.key)) next.delete(row.key);
                  else next.add(row.key);
                  return next;
                });
              };
              const textExpandable = overflowingTaskKeys.has(row.key) || expanded;
              const expandable = textExpandable || linkedEntries.length > 0;
              const openArtifacts = () => {
                if (expandable) toggleExpanded();
              };
              const entryThumb = (entry: RefEntry) => entry.thumbUrl ?? entry.posterUrl ?? null;
              return (
                <div
                  key={row.key}
                  role="button"
                  tabIndex={0}
                  className={`canvas-task-row ${expanded ? "is-expanded" : ""}`}
                  data-status={row.status}
                  title={row.status === "error" ? (row.response?.text ?? undefined) : undefined}
                  onClick={openArtifacts}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openArtifacts();
                    }
                  }}
                >
                  <span className="canvas-task-body">
                    <span className="canvas-task-mark" aria-hidden="true">
                      <Infinity size={14} />
                    </span>
                    <span className="canvas-task-visual" aria-hidden="true">
                      {row.status === "running" ? (
                        <LoadingCube />
                      ) : row.status === "error" ? (
                        <X size={13} />
                      ) : (
                        <Check size={13} />
                      )}
                    </span>
                    <span className="canvas-task-text" data-task-key={row.key}>
                      {taskText}
                    </span>
                  </span>
                  {linkedEntries.length ? (
                    <span className={`canvas-task-detail-shell ${expanded ? "is-open" : ""}`}>
                      <span className="canvas-task-detail">
                        <span className="canvas-task-media">
                          {linkedEntries.map((entry) => {
                            const thumb = entryThumb(entry);
                            if (!thumb) return null;
                            return (
                              <button
                                key={entry.id}
                                type="button"
                                className="canvas-task-media-item"
                                title={entry.title}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  focusMention(entry);
                                }}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={thumb} alt="" draggable={false} loading="lazy" />
                              </button>
                            );
                          })}
                        </span>
                      </span>
                    </span>
                  ) : null}
                </div>
              );
            }
            return (
              <div key={row.key} className="chat-message-group is-assistant">
                <AssistantTurn
                  onRefClick={focusMention}
                  refResolver={refResolver}
                  text={row.entry.text}
                  tools={row.entry.tools}
                />
                <ChatMessageActions
                  align="assistant"
                  canFeedback
                  feedback={chatFeedback[row.key] ?? null}
                  onCopy={() => void copyChatMessage(row.copyText)}
                  onFeedback={(value) => setAssistantFeedback(row.key, value)}
                />
              </div>
            );
          })}
          {sending && chatRows[chatRows.length - 1]?.kind !== "canvas-task" ? (
            <AssistantTurn
              onRefClick={focusMention}
              refResolver={refResolver}
              text={streamText}
              tools={streamTools}
              fallback="Working through the workspace..."
            />
          ) : !sending && abortedAssistantTurn ? (
            <AssistantTurn
              onRefClick={focusMention}
              refResolver={refResolver}
              stopped={abortedAssistantTurn.stopped}
              text={abortedAssistantTurn.text}
              tools={abortedAssistantTurn.tools}
            />
          ) : null}
          {error ? (
            <AssistantTurn
              onRefClick={focusMention}
              refResolver={refResolver}
              text={error}
            />
          ) : null}
          </div>
        </div>
        {snapshot.chat.length === 0 ? (
          <div className="chat-empty-particles" aria-hidden="true">
            {EMPTY_CHAT_PARTICLES.map((style, index) => (
              <span key={index} className="chat-empty-particle" style={style} />
            ))}
          </div>
        ) : null}
        <MainChatComposer
          aborting={abortingRun}
          attachments={chatAttachments}
          empty={snapshot.chat.length === 0}
          browseItems={browseItems}
          mentions={mentionItems}
          onBrowsePick={importBrowseItem}
          onOpenBrowse={() => {
            viewPinnedRef.current = true;
            setWorkspaceView("canvas");
            window.requestAnimationFrame(() => openBrowseFnRef.current?.());
          }}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onOpenFlows={() => {
            viewPinnedRef.current = true;
            setWorkspaceView("canvas");
            window.requestAnimationFrame(() => openFlowsFnRef.current?.());
          }}
          onShareProject={() => void shareProject()}
          onSwitchView={(view) => {
            viewPinnedRef.current = true;
            setWorkspaceView(view);
          }}
          onUnstageRef={(id) => unstageRefFnRef.current?.(id)}
          prefill={chatPrefill}
          sending={sending}
          stagedRefs={stagedRefs}
          onAbort={() => void abortRun()}
          onAddFiles={addChatAttachmentFiles}
          onRemoveAttachment={removeChatAttachment}
          onSubmit={(text) => void send(text, { includeAttachments: true })}
        />
      </section>
      ) : null}

      {renderLegacyChatPanel ? (
      <div
        className="workbench-resizer"
        role="separator"
        aria-label="Resize chat and preview panels"
        aria-orientation="vertical"
        aria-valuemin={320}
        aria-valuemax={680}
        aria-valuenow={chatPanelWidth}
        tabIndex={0}
        onPointerDown={startPanelResize}
        onKeyDown={resizePanelWithKeyboard}
      />
      ) : null}

      <section
        id="preview-panel"
        className={`panel workspace-panel preview-panel flex min-h-0 flex-col overflow-hidden ${workspaceView === "editor" ? "is-editor-view" : ""}`}
      >
        {workspaceView === "files" ? (
          <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)] max-[1100px]:grid-cols-1">
            <div className="file-tree min-h-0 overflow-auto max-[1100px]:max-h-[260px]">{renderTree(fileTree)}</div>
            <div className="file-content min-h-0 overflow-auto">
              {selectedFile?.content ? (
                <>
                  <SourceInspectorHeader file={selectedFile} />
                  <div className="source-panel">
                    <SourceTextWithMedia content={selectedFile.content} projectId={snapshot.project.id} />
                  </div>
                </>
              ) : selectedFile?.kind === "media" && selectedMediaSrc ? (
                <>
                  <SourceInspectorHeader file={selectedFile} />
                  <div className="media-inspector">
                    {selectedMediaKind === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="media-inspector-item" alt={selectedFile.path} src={selectedMediaSrc} />
                    ) : selectedMediaKind === "video" ? (
                      <video className="media-inspector-item" controls playsInline src={selectedMediaSrc} />
                    ) : selectedMediaKind === "audio" ? (
                      <audio className="w-full max-w-2xl" controls src={selectedMediaSrc} />
                    ) : (
                      <a className="button secondary" href={selectedMediaSrc} target="_blank">
                        Open media
                      </a>
                    )}
                  </div>
                </>
              ) : (
                <div className="empty-state">Select a source file.</div>
              )}
            </div>
          </div>
        ) : workspaceView === "canvas" ? (
          <CanvasWorkspace
            actions={composerActions}
            cards={canvasCards}
            composerVisible
            focusRequest={canvasFocusRequest}
            isAborting={abortingRun}
            isSending={sending || canvasComposerBusy}
            onAbort={sending ? () => void abortRun() : undefined}
            onAgentContextChange={updateCanvasAgentContext}
            onAgentContextClear={() =>
              setAgentContextClearSequence((current) => current + 1)
            }
            onComposerRequest={requestCanvasComposer}
            onStagedRefsChange={setStagedRefs}
            onSelectedTileChange={setSelectedTile}
            onRegisterUnstage={(unstage) => {
              unstageRefFnRef.current = unstage;
            }}
            onRegisterOpenFlows={(open) => {
              openFlowsFnRef.current = open;
            }}
            onRegisterOpenBrowse={(open) => {
              openBrowseFnRef.current = open;
            }}
            onBrowseImport={importBrowseItem}
            editingCardIds={editingTileIds}
            onOpenShortcuts={() => setShortcutsOpen(true)}
            onApplySnapshot={(next) => applySnapshot(next as ProjectSnapshot)}
            onShareProject={() => void shareProject()}
            onSwitchView={(view) => {
              viewPinnedRef.current = true;
              setWorkspaceView(view === "editor" ? "editor" : "canvas");
            }}
            browseItems={browseItems}
            onBrowsePick={importBrowseItem}
            onCreateRequest={(text) => send(text)}
            onDeleteCards={requestCanvasDeleteCards}
            onDrawRequest={requestCanvasDrawChange}
            onEditClip={requestCanvasEditClip}
            onImportYoutube={importYoutubeToCanvas}
            onOpenFile={openFile}
            onOpenInEditor={openCanvasArtifactInEditor}
            onPromptRequest={requestCanvasPromptChange}
            onRefreshProject={refreshProjectSnapshot}
            onUploadFiles={uploadCanvasFiles}
            projectId={snapshot.project.id}
            editorPlacements={editorPlacements}
            resolvedCanvasArtifacts={[
              ...resolvedCanvasAgentContext.value.selected,
              ...resolvedCanvasAgentContext.value.pinned,
            ]}
            spawnOrigins={composerSpawnOrigins}
            youtubeImports={youtubeImports}
          />
        ) : workspaceView === "plan" && renderLegacyChatPanel ? (
          <div className="plan-view">
            <aside className="plan-history-col">
              {planHistory.length ? (
                <div className="plan-history">
                  <h4 className="plan-history-title">Previous plans</h4>
                  {planHistory.map((entry) => {
                    const expanded = expandedPlanPaths.includes(entry.path);
                    return (
                      <div key={entry.path} className="plan-history-entry">
                        <button
                          type="button"
                          className="plan-history-header"
                          aria-expanded={expanded}
                          onClick={() =>
                            setExpandedPlanPaths((current) =>
                              current.includes(entry.path)
                                ? current.filter((path) => path !== entry.path)
                                : [...current, entry.path],
                            )
                          }
                        >
                          <ChevronRight
                            size={13}
                            className={`plan-history-chevron ${expanded ? "is-open" : ""}`}
                          />
                          <span className="plan-history-name">
                            {entry.planTitle ?? entry.steps[0]?.title ?? "Plan"}
                          </span>
                          <span className="plan-history-date">
                            {entry.archivedAt
                              ? new Date(entry.archivedAt).toLocaleString(undefined, {
                                  day: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                  month: "short",
                                })
                              : "earlier"}
                          </span>
                        </button>
                        {expanded ? (
                          <ul className="plan-history-steps">
                            {entry.steps.map((step, index) => (
                              <li
                                key={index}
                                className={`plan-history-step is-${step.status}`}
                              >
                                {step.title}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </aside>
            <div className="plan-view-inner">
              <div className="plan-doc">
              {planSteps.length ? (
                <>
                  <h3 className="plan-view-title">{planTitle ?? "Plan"}</h3>
                  <ol
                    className="plan-list"
                    key={planSteps.map((step) => step.id).join("|")}
                  >
                    {planSteps.map((step) => (
                      <li key={step.id} className={`plan-step is-${step.status}`}>
                        <span className="plan-step-marker" aria-hidden="true">
                          {step.status === "done" ? (
                            "✓"
                          ) : step.status === "active" && sending ? (
                            <LoadingCube />
                          ) : (
                            ""
                          )}
                        </span>
                        <span className="plan-step-body">
                          <span className="plan-step-title">{step.title}</span>
                          {step.status === "active" ? (
                            <span className={`plan-step-now ${sending ? "" : "is-waiting"}`}>
                              {sending ? "now" : "up next"}
                            </span>
                          ) : null}
                          {step.note ? (
                            <span className="plan-step-note">{step.note}</span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ol>
                </>
              ) : (
                <p className="plan-view-empty">
                  No plan yet — the agent writes one when it starts multi-step work.
                </p>
              )}
              </div>
            </div>
          </div>
        ) : workspaceView === "references" ? (
          <ReferencesView
            focusRequest={referenceFocusRequest}
            generatingReferenceIds={generatingReferenceIds}
            isSending={sending}
            onRequestChange={(request) => void send(request)}
            projectId={snapshot.project.id}
            snapshot={snapshot}
          />
        ) : null}
        <AgentActivityOverlay
          acknowledgedFailureIds={acknowledgedActivityFailures}
          canStop={sending}
          error={agentActivityFailure}
          interaction={currentAgentInteraction}
          isRunning={agentActivityRunning}
          isStopping={abortingRun}
          items={agentActivityItems}
          onAcknowledge={(failureId) => {
            setAcknowledgedActivityFailures((current) => {
              const next = new Set(current);
              next.add(failureId);
              return next;
            });
            if (
              agentActivityFailure &&
              agentActivityFailureKey(agentActivityFailure) === failureId
            ) {
              setError(null);
            }
          }}
          onOpenQuestion={() => {
            window.requestAnimationFrame(() => {
              document
                .querySelector<HTMLElement>(
                  ".workbench-question-dialog button, .workbench-question-dialog textarea",
                )
                ?.focus();
            });
          }}
          onResolveInteraction={resolveAgentInteraction}
          onReconnect={() => {
            userStoppedRunRef.current = false;
            setAbortedAssistantTurn(null);
            setError(null);
            reconnectNowRef.current();
          }}
          onStop={() => void abortRun()}
          onOpenChange={changeAgentActivityOpen}
          open={agentActivityOpen}
          question={currentAgentQuestion}
          stopped={Boolean(abortedAssistantTurn?.stopped)}
        />
        {workspaceView === "editor" ? (
          <div className="editor-embed-surface is-active">
            <OpencutEditorMount
              active
              exportRequestId={editorExportRequestId}
              projectId={snapshot.project.id}
              projectName={snapshot.project.name}
              mediaAssets={editorMediaAssets}
              focusRequest={editorFocusRequest}
              onAgentContextChange={updateEditorAgentContext}
              onExportStatusChange={setEditorExportStatus}
              onShowSource={showEditorSourceOnCanvas}
            />
          </div>
        ) : null}
      </section>
      </div>
      </div>
      {billingUiEnabled ? (
        <BuyCreditsModal open={buyCreditsOpen} onOpenChange={setBuyCreditsOpen} />
      ) : null}
      <ProjectTour key={snapshot.project.id} />
      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent className="shortcuts-modal">
          <DialogTitle>Shortcuts</DialogTitle>
          {[
            {
              rows: [
                ["Enter", "Send message"],
                ["Shift + Enter", "New line"],
                ["@", "Mention a tile or reference"],
                ["/", "Commands"],
              ],
              title: "Composer",
            },
            {
              rows: [
                ["D", "Duplicate selected tile"],
                ["F / L", "Extract first / last frame of a clip"],
                ["M", "Mute / unmute selected clip"],
                ["S + ↑ / ↓", "Step playback speed"],
                ["Delete", "Delete selected tiles"],
                ["Shift + drag", "Select multiple tiles"],
                ["Drag onto composer", "Stage tile as a reference"],
              ],
              title: "Canvas",
            },
          ].map((section) => (
            <div key={section.title} className="shortcuts-section">
              <h3>{section.title}</h3>
              {section.rows.map(([keys, label]) => (
                <div key={keys} className="shortcuts-row">
                  <span className="shortcuts-keys">
                    {keys!.split(" + ").map((part, partIndex) => (
                      <ReactFragment key={part}>
                        {partIndex > 0 ? <em>+</em> : null}
                        <kbd>{part}</kbd>
                      </ReactFragment>
                    ))}
                  </span>
                  <span className="shortcuts-label">{label}</span>
                </div>
              ))}
            </div>
          ))}
        </DialogContent>
      </Dialog>
      {userQuestion ? (
        <Dialog open>
          <DialogContent
            className="workbench-question-dialog"
            data-agent-question-dialog
            showClose={false}
            onEscapeKeyDown={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
          >
            {(() => {
              const question = userQuestion.questions[userQuestion.activeIndex]!;
              const isLast = userQuestion.activeIndex === userQuestion.questions.length - 1;
              // Only use the image layout when an option actually resolves to a
              // real image tile — otherwise fall back to plain choice buttons so
              // simple questions don't render empty "no preview" boxes.
              const hasAssets = question.options.some(
                (option) =>
                  option.asset_id && canvasCards.find((entry) => entry.id === option.asset_id)?.src,
              );
              const isMulti = question.multi_select === true;
              const toggleOption = (label: string) => {
                setUserQuestion((current) => {
                  if (!current) return current;
                  const has = current.selected.includes(label);
                  return {
                    ...current,
                    selected: isMulti
                      ? has
                        ? current.selected.filter((entry) => entry !== label)
                        : [...current.selected, label]
                      : has
                        ? []
                        : [label],
                  };
                });
              };
              const commit = () => {
                const answers = [
                  ...userQuestion.answers,
                  {
                    custom_text: userQuestion.customText.trim() || null,
                    question: question.question,
                    selected: isMulti
                      ? userQuestion.selected
                      : userQuestion.selected[0] ?? null,
                    uploaded_ids: userQuestion.uploads.length
                      ? userQuestion.uploads.map((upload) => upload.id)
                      : null,
                  },
                ];
                if (isLast) void submitUserAnswer({ answers });
                else {
                  setUserQuestion({
                    ...userQuestion,
                    activeIndex: userQuestion.activeIndex + 1,
                    answers,
                    customText: "",
                    selected: [],
                    uploads: [],
                  });
                }
              };
              return (
                <>
                  <div className="question-masthead">
                    <span className="question-cube">
                      <LoadingCube />
                    </span>
                    <span className="question-masthead-label">
                      Impractical has a question for you
                    </span>
                    {userQuestion.questions.length > 1 ? (
                      <span className="question-progress">
                        {userQuestion.activeIndex + 1} of {userQuestion.questions.length}
                      </span>
                    ) : null}
                  </div>
                  <DialogHeader>
                    <DialogTitle className="question-title">{question.question}</DialogTitle>
                  </DialogHeader>
                  {hasAssets ? (
                    <div className="question-asset-grid">
                      {question.options.map((option) => {
                        const card = option.asset_id
                          ? canvasCards.find((entry) => entry.id === option.asset_id) ?? null
                          : null;
                        const isVideo =
                          card?.kind === "clip" || card?.kind === "video";
                        return (
                          <button
                            key={option.label}
                            type="button"
                            className={`question-asset ${userQuestion.selected.includes(option.label) ? "is-selected" : ""}`}
                            onClick={() => toggleOption(option.label)}
                            onMouseEnter={(event) => {
                              const media = event.currentTarget.querySelector("video, audio");
                              if (media instanceof HTMLMediaElement) {
                                void media.play().catch(() => {});
                              }
                            }}
                            onMouseLeave={(event) => {
                              const media = event.currentTarget.querySelector("video, audio");
                              if (media instanceof HTMLMediaElement) {
                                media.pause();
                                media.currentTime = 0;
                              }
                            }}
                          >
                            <span className="question-asset-media">
                              {card?.src && isVideo ? (
                                <video src={card.src} muted playsInline loop preload="metadata" />
                              ) : card?.src && card.kind === "audio" ? (
                                <>
                                  <AudioLines size={28} />
                                  { }
                                  <audio src={card.src} preload="metadata" loop />
                                </>
                              ) : card?.src ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={card.src} alt="" draggable={false} />
                              ) : (
                                <span className="question-asset-missing">no preview</span>
                              )}
                            </span>
                            <span className="question-asset-label">{option.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="question-options">
                      {question.options.map((option, index) => (
                        <button
                          key={option.label}
                          type="button"
                          className={`question-option ${userQuestion.selected.includes(option.label) ? "is-selected" : ""}`}
                          onClick={() => toggleOption(option.label)}
                        >
                          <span className="question-option-index">{index + 1}</span>
                          {option.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {isMulti ? (
                    <div className="question-multi-hint">Select all that apply</div>
                  ) : null}
                  {question.allow_custom !== false ? (
                    <>
                      {question.options.length ? <div className="question-or">or</div> : null}
                      <textarea
                        className="question-custom"
                        rows={question.options.length ? 2 : 3}
                        autoFocus={!question.options.length}
                        placeholder={
                          question.options.length ? "Type something else…" : "Type your answer…"
                        }
                        value={userQuestion.customText}
                        onChange={(event) =>
                          setUserQuestion({
                            ...userQuestion,
                            customText: event.currentTarget.value,
                            ...(isMulti ? {} : { selected: [] }),
                          })
                        }
                        onKeyDown={(event) => {
                          // Cmd/Ctrl+Enter submits; plain Enter stays a newline.
                          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            if (userQuestion.customText.trim() || userQuestion.selected.length) commit();
                          }
                        }}
                      />
                    </>
                  ) : null}
                  {question.allow_upload ? (
                    <div className="question-upload">
                      <label className={`question-upload-button ${userQuestion.uploading ? "is-busy" : ""}`}>
                        {userQuestion.uploading ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Plus size={14} />
                        )}
                        {userQuestion.uploading ? "Uploading…" : "Upload files"}
                        <input
                          type="file"
                          accept="image/*,video/*,audio/*"
                          multiple
                          hidden
                          disabled={userQuestion.uploading}
                          onChange={(event) => {
                            const files = Array.from(event.currentTarget.files ?? []);
                            event.currentTarget.value = "";
                            if (!files.length) return;
                            setUserQuestion((current) =>
                              current ? { ...current, uploading: true } : current,
                            );
                            void (async () => {
                              try {
                                const form = new FormData();
                                for (const file of files) form.append("files", file);
                                const response = await fetch(
                                  `/api/projects/${snapshot.project.id}/canvas/upload`,
                                  { body: form, method: "POST" },
                                );
                                const payload = await response.json().catch(() => ({}));
                                if (!response.ok) {
                                  throw new Error(
                                    typeof payload.error === "string" ? payload.error : "Upload failed.",
                                  );
                                }
                                if (payload.snapshot) applySnapshot(payload.snapshot);
                                const uploaded = Array.isArray(payload.uploaded)
                                  ? (payload.uploaded as Array<{ id: string }>)
                                  : [];
                                setUserQuestion((current) =>
                                  current
                                    ? {
                                        ...current,
                                        uploading: false,
                                        uploads: [
                                          ...current.uploads,
                                          ...uploaded.map((entry, index) => ({
                                            id: entry.id,
                                            name: files[index]?.name ?? entry.id,
                                          })),
                                        ],
                                      }
                                    : current,
                                );
                              } catch (caught) {
                                setError(
                                  caught instanceof Error ? caught.message : "Upload failed.",
                                );
                                setUserQuestion((current) =>
                                  current ? { ...current, uploading: false } : current,
                                );
                              }
                            })();
                          }}
                        />
                      </label>
                      {userQuestion.uploads.map((upload) => {
                        const uploadedCard =
                          canvasCards.find((entry) => entry.id === upload.id) ?? null;
                        const uploadIsVideo =
                          uploadedCard?.kind === "clip" || uploadedCard?.kind === "video";
                        return (
                          <span
                            key={upload.id}
                            className="question-upload-thumb"
                            title={upload.name}
                          >
                            {uploadedCard?.src && uploadIsVideo ? (
                              <video src={uploadedCard.src} muted playsInline preload="metadata" />
                            ) : uploadedCard?.src && uploadedCard.kind === "audio" ? (
                              <AudioLines size={20} aria-hidden="true" />
                            ) : uploadedCard?.src ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={uploadedCard.src} alt={upload.name} draggable={false} />
                            ) : (
                              <FileText size={16} aria-hidden="true" />
                            )}
                            <button
                              type="button"
                              className="question-upload-thumb-remove"
                              aria-label={`Remove ${upload.name}`}
                              onClick={() =>
                                setUserQuestion((current) =>
                                  current
                                    ? {
                                        ...current,
                                        uploads: current.uploads.filter(
                                          (entry) => entry.id !== upload.id,
                                        ),
                                      }
                                    : current,
                                )
                              }
                            >
                              <X size={11} />
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                  <DialogFooter className="question-footer">
                    <button
                      className="dialog-btn"
                      type="button"
                      onClick={() => void submitUserAnswer({ dismissed: true })}
                    >
                      Figure it out
                    </button>
                    <button
                      className="dialog-btn dialog-btn-primary"
                      type="button"
                      disabled={
                        (!userQuestion.selected.length &&
                          !userQuestion.customText.trim() &&
                          !userQuestion.uploads.length) ||
                        userQuestion.uploading
                      }
                      onClick={commit}
                    >
                      {isLast ? "Save" : "Next"}
                    </button>
                  </DialogFooter>
                </>
              );
            })()}
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
