import {
  listProjectFiles,
  parseJsonFrontmatter,
  type ProjectMeta,
  type TimelineItem,
  type WorkspaceFile,
} from "@/lib/workspace";

export type HomeProjectCard = ProjectMeta & {
  gradientIndex: number;
  isWorking?: boolean;
  thumbnailKind: "image" | "video" | null;
  thumbnailUrl: string | null;
};

export type ReferenceTile = {
  gradientIndex: number;
  id: string;
  imageUrl: string | null;
  projectId: string;
  projectName: string;
  title: string;
  type: "character" | "environment";
};

export type HomePageData = {
  characters: ReferenceTile[];
  environments: ReferenceTile[];
  projects: HomeProjectCard[];
};

type ProjectPreviewSnapshot = {
  files: WorkspaceFile[];
  project: ProjectMeta;
  timeline: TimelineItem[];
};

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function isVideoUrl(url: string) {
  return /\.(mp4|mov|webm)(?:$|\?)/i.test(url);
}

function mediaUrlFromLocalPath(projectId: string, localPath: unknown) {
  if (typeof localPath !== "string") return null;
  if (!localPath.startsWith("media/")) return null;
  const relative = localPath.slice("media/".length);
  const base = `/api/projects/${encodeURIComponent(projectId)}/media/${relative
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
  // Card thumbnails only need ~480px; images redirect to a resized render.
  return /\.(png|jpe?g|webp)$/i.test(relative) ? `${base}?w=480` : base;
}

function firstString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstUrlFromMeta(meta: Record<string, unknown>) {
  const direct = firstString(meta.url);
  if (direct) return direct;
  if (Array.isArray(meta.urls)) {
    const match = meta.urls.find((item): item is string => typeof item === "string" && item.trim().length > 0);
    return match?.trim() ?? null;
  }
  return null;
}

function firstGeneratedImage(snapshot: ProjectPreviewSnapshot) {
  for (const file of snapshot.files) {
    if (!file.path.endsWith(".md") || typeof file.content !== "string") continue;
    const parsed = parseJsonFrontmatter(file.content);
    const type = parsed.meta.type;
    if (type !== "keyframe" && type !== "portfolio") continue;
    const url = firstUrlFromMeta(parsed.meta) ?? mediaUrlFromLocalPath(snapshot.project.id, parsed.meta.local_path);
    if (url) return url;
  }
  return null;
}

function projectThumbnail(snapshot: ProjectPreviewSnapshot): Pick<HomeProjectCard, "thumbnailKind" | "thumbnailUrl"> {
  const timelineItem = snapshot.timeline.find((item) => item.url || item.local_path);
  const timelineUrl =
    firstString(timelineItem?.url) ?? mediaUrlFromLocalPath(snapshot.project.id, timelineItem?.local_path);
  if (timelineUrl) {
    return {
      thumbnailKind: timelineItem?.kind === "video" || isVideoUrl(timelineUrl) ? "video" : "image",
      thumbnailUrl: timelineUrl,
    };
  }

  const imageUrl = firstGeneratedImage(snapshot);
  return {
    thumbnailKind: imageUrl ? "image" : null,
    thumbnailUrl: imageUrl,
  };
}

function titleFromSlug(value: string) {
  return (
    value
      .replace(/^(char|env|asset|style)[_-]/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
      .trim() || value
  );
}

function titleFromReference(referenceFile: WorkspaceFile | undefined, fallback: string) {
  if (typeof referenceFile?.content !== "string") return titleFromSlug(fallback);
  const parsed = parseJsonFrontmatter(referenceFile.content);
  const firstBodyLine = parsed.body
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstBodyLine) return titleFromSlug(fallback);
  const beforeColon = firstBodyLine.split(":")[0]?.trim();
  return beforeColon ? beforeColon.replace(/^#+\s*/, "") : titleFromSlug(fallback);
}

function collectReferences(snapshot: ProjectPreviewSnapshot, type: "character" | "environment") {
  const category = type === "character" ? "characters" : "environments";
  const tiles: ReferenceTile[] = [];

  for (const file of snapshot.files) {
    const match = file.path.match(new RegExp(`^references/${category}/([^/]+)/portfolio\\.md$`));
    if (!match || typeof file.content !== "string") continue;
    const [, slug] = match;
    const parsed = parseJsonFrontmatter(file.content);
    const imageUrl = firstUrlFromMeta(parsed.meta) ?? mediaUrlFromLocalPath(snapshot.project.id, parsed.meta.local_path);
    const referenceId = firstString(parsed.meta.reference_id) ?? slug;
    const referenceFile = snapshot.files.find(
      (candidate) => candidate.path === `references/${category}/${slug}/reference.md`,
    );
    tiles.push({
      gradientIndex: hashString(`${snapshot.project.id}:${slug}`),
      id: `${snapshot.project.id}:${referenceId}`,
      imageUrl,
      projectId: snapshot.project.id,
      projectName: snapshot.project.name,
      title: titleFromReference(referenceFile, referenceId),
      type,
    });
  }

  return tiles;
}

function timelineFromCachedFile(files: WorkspaceFile[]): TimelineItem[] {
  const timelineFile = files.find((file) => file.path === "timeline.json");
  if (typeof timelineFile?.content !== "string") return [];
  try {
    const parsed = JSON.parse(timelineFile.content);
    return Array.isArray(parsed) ? (parsed as TimelineItem[]) : [];
  } catch {
    return [];
  }
}

export async function buildHomePageData(projects: ProjectMeta[]): Promise<HomePageData> {
  const snapshots = await Promise.all(
    projects.map(async (project): Promise<ProjectPreviewSnapshot | null> => {
      const files = await listProjectFiles(project.id, true);
      return {
        files,
        project,
        timeline: timelineFromCachedFile(files),
      };
    }).map((promise) => promise.catch(() => null)),
  );
  const snapshotById = new Map(
    snapshots
      .filter((snapshot): snapshot is ProjectPreviewSnapshot => snapshot != null)
      .map((snapshot) => [snapshot.project.id, snapshot]),
  );

  return {
    characters: snapshots
      .flatMap((snapshot) => (snapshot ? collectReferences(snapshot, "character") : []))
      .slice(0, 8),
    environments: snapshots
      .flatMap((snapshot) => (snapshot ? collectReferences(snapshot, "environment") : []))
      .slice(0, 8),
    projects: projects.map((project) => {
      const snapshot = snapshotById.get(project.id);
      const thumbnail = snapshot
        ? projectThumbnail(snapshot)
        : { thumbnailKind: null, thumbnailUrl: null };
      return {
        ...project,
        gradientIndex: hashString(project.id),
        thumbnailKind: thumbnail.thumbnailKind,
        thumbnailUrl: thumbnail.thumbnailUrl,
      };
    }),
  };
}
