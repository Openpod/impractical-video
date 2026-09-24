import {
  listProjectFiles,
  listProjects,
  parseJsonFrontmatter,
  type ProjectMeta,
  type WorkspaceFile,
} from "@/lib/workspace";
import type {
  PublishedItemDetail,
  PublishedItemMedia,
  PublishedItemSummary,
} from "@/lib/published-items";
import { getLocalLibraryUpload, LOCAL_LIBRARY_PREFIX } from "@/lib/local-library";

const LOCAL_ITEM_PREFIX = "local:";

function firstString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstUrl(meta: Record<string, unknown>) {
  const direct = firstString(meta.url);
  if (direct) return direct;
  if (!Array.isArray(meta.urls)) return null;
  return meta.urls.find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  )?.trim() ?? null;
}

function localMediaUrl(projectId: string, localPath: unknown) {
  const value = firstString(localPath);
  if (!value?.startsWith("media/")) return null;
  const relative = value.slice("media/".length);
  return `/api/projects/${encodeURIComponent(projectId)}/media/${relative
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

function mediaUrl(projectId: string, meta: Record<string, unknown>) {
  return localMediaUrl(projectId, meta.local_path) ?? firstUrl(meta);
}

function titleFromSlug(slug: string) {
  return (
    slug
      .replace(/^(char|env|asset|style|prop|clip)[_-]/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
      .trim() || slug
  );
}

function referenceTitle(file: WorkspaceFile | undefined, slug: string) {
  if (typeof file?.content !== "string") return titleFromSlug(slug);
  const parsed = parseJsonFrontmatter(file.content);
  const explicit = firstString(parsed.meta.name) ?? firstString(parsed.meta.title);
  if (explicit) return explicit;
  const line = parsed.body.split("\n").map((value) => value.trim()).find(Boolean);
  if (!line) return titleFromSlug(slug);
  return (line.split(":")[0] ?? line).replace(/^#+\s*/, "").trim() || titleFromSlug(slug);
}

function summary(input: {
  createdAt: string;
  description: string | null;
  id: string;
  kind: string;
  posterUrl: string | null;
  projectId: string;
  title: string;
}): PublishedItemSummary {
  const isVideo = input.kind === "video";
  return {
    createdAt: input.createdAt,
    description: input.description,
    featuredRank: null,
    id: input.id,
    isLiked: false,
    kind: input.kind,
    libraryStatus: "saved",
    likeCount: 0,
    posterHeight: null,
    posterMediaKind: isVideo ? "video" : "image",
    posterOrientation: isVideo ? "landscape" : "square",
    posterUrl: input.posterUrl,
    posterWidth: null,
    previewVideoUrl: isVideo ? input.posterUrl : null,
    publisher: null,
    sourceEntryId: null,
    tags: ["local", `project:${input.projectId}`],
    title: input.title,
    useCount: 0,
    viewCount: 0,
    visibility: "private",
  };
}

function localId(projectId: string, type: "reference" | "video", category: string, slug: string) {
  return `${LOCAL_ITEM_PREFIX}${projectId}:${type}:${category}:${slug}`;
}

function collectReferences(project: ProjectMeta, files: WorkspaceFile[]) {
  const items: PublishedItemDetail[] = [];
  for (const portfolio of files) {
    const match = portfolio.path.match(
      /^references\/(characters|environments|props|styles)\/([^/]+)\/portfolio\.md$/,
    );
    if (!match || typeof portfolio.content !== "string") continue;
    const [, category, slug] = match;
    const parsedPortfolio = parseJsonFrontmatter(portfolio.content);
    const referencePath = `references/${category}/${slug}/reference.md`;
    const reference = files.find((file) => file.path === referencePath);
    const parsedReference =
      typeof reference?.content === "string" ? parseJsonFrontmatter(reference.content) : null;
    const kind =
      category === "characters"
        ? "character"
        : category === "environments"
          ? "environment"
          : category === "props"
            ? "prop"
            : "style";
    // The profile shot (display_url) is the tile face everywhere — the
    // portfolio sheet is working material, not a poster.
    const posterUrl =
      firstString(parsedPortfolio.meta.display_url) ??
      mediaUrl(project.id, parsedPortfolio.meta);
    const base = summary({
      createdAt: project.updatedAt,
      description: parsedReference?.body.trim() || parsedPortfolio.body.trim() || null,
      id: localId(project.id, "reference", category, slug),
      kind,
      posterUrl,
      projectId: project.id,
      title: referenceTitle(reference, slug),
    });
    const media: PublishedItemMedia[] = posterUrl
      ? [{
          durationS: null,
          height: null,
          id: `${base.id}:portfolio`,
          kind: "image",
          mimeType: null,
          nodeId: firstString(parsedPortfolio.meta.id),
          role: "display",
          url: posterUrl,
          width: null,
        }]
      : [];
    items.push({
      ...base,
      files: [
        ...(typeof reference?.content === "string"
          ? [{ content: reference.content, path: referencePath }]
          : []),
        { content: portfolio.content, path: portfolio.path },
      ],
      media,
      metadata: {
        category,
        local: true,
        projectId: project.id,
        projectName: project.name,
        slug,
      },
      sourceNodeId: firstString(parsedPortfolio.meta.reference_id) ?? slug,
      sourceProjectId: project.id,
    });
  }
  return items;
}

function collectVideos(project: ProjectMeta, files: WorkspaceFile[]) {
  const timeline = files.find((file) => file.path === "timeline.json");
  if (typeof timeline?.content !== "string") return [];
  let entries: Array<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(timeline.content);
    entries = Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
  return entries.flatMap((entry): PublishedItemDetail[] => {
    if (entry.kind !== "video") return [];
    const slug = firstString(entry.clip_id) ?? firstString(entry.id);
    if (!slug) return [];
    const url = localMediaUrl(project.id, entry.local_path) ?? firstString(entry.url);
    const base = summary({
      createdAt: project.updatedAt,
      description: `Video from ${project.name}`,
      id: localId(project.id, "video", "timeline", slug),
      kind: "video",
      posterUrl: url,
      projectId: project.id,
      title: firstString(entry.title) ?? titleFromSlug(slug),
    });
    return [{
      ...base,
      files: [{ content: timeline.content as string, path: "timeline.json" }],
      media: url
        ? [{
            durationS: typeof entry.duration === "number" ? entry.duration : null,
            height: null,
            id: `${base.id}:video`,
            kind: "video",
            mimeType: null,
            nodeId: slug,
            role: "display",
            url,
            width: null,
          }]
        : [],
      metadata: { local: true, projectId: project.id, projectName: project.name },
      sourceNodeId: slug,
      sourceProjectId: project.id,
    }];
  });
}

/** The full-workspace scan behind the local catalog stats and reads every
 * project file; uncached it ran on every navigation (multiple seconds on real
 * libraries). A short TTL keeps listings feeling live while navigation reuses
 * the last scan. */
const CATALOG_CACHE_TTL_MS = 10_000;
const catalogCache = globalThis as typeof globalThis & {
  __videoFsLocalCatalogCache?: {
    at: number;
    details: ReturnType<typeof scanLocalDetails>;
  };
};

async function scanLocalDetails() {
  const projects = await listProjects();
  const details = await Promise.all(
    projects.map(async (project) => {
      const files = await listProjectFiles(project.id, true);
      return [...collectReferences(project, files), ...collectVideos(project, files)];
    }),
  );
  return details.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function allLocalDetails() {
  const cached = catalogCache.__videoFsLocalCatalogCache;
  if (cached && Date.now() - cached.at < CATALOG_CACHE_TTL_MS) {
    return cached.details;
  }
  const details = scanLocalDetails();
  catalogCache.__videoFsLocalCatalogCache = { at: Date.now(), details };
  details.catch(() => {
    // A failed scan should not poison the cache window.
    if (catalogCache.__videoFsLocalCatalogCache?.details === details) {
      catalogCache.__videoFsLocalCatalogCache = undefined;
    }
  });
  return details;
}

export async function listLocalCatalogItems(options?: {
  includeReferences?: boolean;
  includeVideos?: boolean;
  limit?: number;
}) {
  const includeReferences = options?.includeReferences ?? true;
  const includeVideos = options?.includeVideos ?? true;
  const items = (await allLocalDetails()).filter((item) => {
    if (item.kind === "video") return includeVideos;
    return includeReferences;
  });
  return items.slice(0, options?.limit ?? items.length);
}

export async function getLocalCatalogItem(id: string) {
  if (id.startsWith(LOCAL_LIBRARY_PREFIX)) return getLocalLibraryUpload(id).catch(() => null);
  if (!id.startsWith(LOCAL_ITEM_PREFIX)) return null;
  return (await allLocalDetails()).find((item) => item.id === id) ?? null;
}
