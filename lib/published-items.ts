import { createServerClient } from "@/lib/supabase";
import { cleanExplorePromptNullable, cleanExplorePromptText } from "@/lib/explore-prompt-cleanup";

export type PublishedItemKind = "character" | "environment" | "clip" | "video" | "template" | string;

export type PublishedItemSummary = {
  createdAt: string;
  description: string | null;
  featuredRank: number | null;
  id: string;
  isLiked: boolean;
  kind: PublishedItemKind;
  libraryStatus: string | null;
  likeCount: number;
  posterHeight: number | null;
  posterMediaKind: string | null;
  posterOrientation: "landscape" | "portrait" | "square";
  posterUrl: string | null;
  posterWidth: number | null;
  previewVideoUrl: string | null;
  publisher: {
    displayName: string | null;
    userId: string;
  } | null;
  sourceEntryId: string | null;
  tags: string[];
  title: string;
  useCount: number;
  viewCount: number;
  visibility: string;
};

export type PublishedItemDetail = PublishedItemSummary & {
  files: Array<{
    content: string;
    path: string;
  }>;
  media: PublishedItemMedia[];
  metadata: Record<string, unknown> | null;
  sourceNodeId: string | null;
  sourceProjectId: string | null;
};

export type PublishedItemMedia = {
  durationS: number | null;
  height: number | null;
  id: string;
  kind: string;
  mimeType: string | null;
  nodeId: string | null;
  role: string;
  url: string | null;
  width: number | null;
};

type PublishedItemRow = {
  created_at: string;
  description: string | null;
  featured_rank: number | null;
  id: string;
  kind: string;
  like_count: number;
  metadata?: unknown;
  publisher_id: string;
  source_node_id?: string | null;
  source_project_id?: string | null;
  tags: string[] | null;
  title: string;
  use_count: number;
  view_count: number;
  visibility: string;
};

type PublishedMediaRow = {
  duration_s: number | null;
  height: number | null;
  id: string;
  item_id: string;
  kind: string;
  mime_type: string | null;
  node_id: string | null;
  role: string;
  storage_path: string | null;
  url: string | null;
  width: number | null;
};

type PublisherRow = {
  display_name: string | null;
  user_id: string;
};

type AiVideoEntryRow = {
  bucket_name: string | null;
  content_type: string | null;
  created_at: string;
  creator: string | null;
  description: string | null;
  id: string;
  metadata: Record<string, unknown> | null;
  model: string | null;
  original_video_url: string | null;
  prompt: string | null;
  source_site: string | null;
  source_url: string | null;
  storage_path: string | null;
  storage_status: string | null;
  tags: string[] | null;
  thumbnail_url: string | null;
  title: string | null;
};

const AI_VIDEO_ID_PREFIX = "ai-video-";
const AI_VIDEO_LIMIT = 5000;
const AI_VIDEO_FETCH_LIMIT = 5000;
const PUBLIC_VISIBILITIES = ["public", "featured"];
const DETAIL_VISIBILITIES = ["public", "featured", "unlisted"];
const PUBLISHED_KIND_ALIASES: Record<string, string[]> = {
  character: ["character", "characters"],
  environment: ["environment", "environments"],
  feature: ["feature", "features"],
  prop: ["prop", "props", "object", "objects"],
  style: ["style", "styles"],
};

function normalizePublishedKind(kind: string): PublishedItemKind {
  if (kind === "characters") return "character";
  if (kind === "environments") return "environment";
  if (kind === "props" || kind === "object" || kind === "objects") return "prop";
  if (kind === "styles") return "style";
  if (kind === "features") return "feature";
  return kind;
}

function publishedKindQueryValues(kind: string) {
  return PUBLISHED_KIND_ALIASES[kind] ?? [kind];
}

function publicMediaUrl(
  storagePath: string | null,
  explicitUrl: string | null,
  thumbWidth?: number,
) {
  if (explicitUrl) return proxiedExternalMediaUrl(explicitUrl);
  if (!storagePath) return null;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");
  if (!supabaseUrl) return null;
  // Gallery posters serve a resized, CDN-cached thumbnail via Supabase image
  // transformation — full-resolution objects made grids crawl.
  if (thumbWidth) {
    return `${supabaseUrl}/storage/v1/render/image/public/published-media/${storagePath}?width=${thumbWidth}&quality=72&resize=contain`;
  }
  return `${supabaseUrl}/storage/v1/object/public/published-media/${storagePath}`;
}

function pickPosterMedia(media: PublishedMediaRow[] | undefined) {
  if (!media?.length) return null;
  return (
    media.find((item) => item.role === "display") ??
    media.find((item) => item.role === "poster") ??
    media.find((item) => item.role === "thumbnail") ??
    media.find((item) => item.role === "preview") ??
    media[0] ??
    null
  );
}

function orientationFor(width: number | null, height: number | null): "landscape" | "portrait" | "square" {
  if (!width || !height) return "square";
  if (width / height >= 1.2) return "landscape";
  if (height / width >= 1.2) return "portrait";
  return "square";
}

function parseRatio(value: unknown): { height: number; width: number } | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*[/x:]\s*(\d+(?:\.\d+)?)$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function aiVideoEntryId(id: string) {
  return `${AI_VIDEO_ID_PREFIX}${id}`;
}

function aiVideoRawId(itemId: string) {
  return itemId.startsWith(AI_VIDEO_ID_PREFIX) ? itemId.slice(AI_VIDEO_ID_PREFIX.length) : null;
}

function sourceEntryIdFromMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value =
    (metadata as Record<string, unknown>).source_entry_id ??
    (metadata as Record<string, unknown>).sourceEntryId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function libraryStatusFromMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).library_status;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function proxiedExternalMediaUrl(url: string | null) {
  if (!url) return null;
  if (url.startsWith("/")) return url;
  try {
    const parsed = new URL(url);
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (supabaseUrl && parsed.hostname === new URL(supabaseUrl).hostname) {
      return url;
    }
    // Our own Supabase storage (public buckets, open CORS) is served direct —
    // in prod NEXT_PUBLIC_SUPABASE_URL is the custom domain (db.impractical.ai)
    // while stored media URLs use the raw *.supabase.co host, so the match
    // above misses and they'd wrongly route through the (allowlisted) proxy.
    if (parsed.hostname.endsWith(".supabase.co")) {
      return url;
    }
    if (parsed.protocol === "https:") {
      return `/api/media-proxy?url=${encodeURIComponent(url)}`;
    }
  } catch {
    return url;
  }
  return url;
}

function normalizeMedia(row: PublishedMediaRow): PublishedItemMedia {
  return {
    durationS: row.duration_s,
    height: row.height,
    id: row.id,
    kind: row.kind,
    mimeType: row.mime_type,
    nodeId: row.node_id,
    role: row.role,
    url: publicMediaUrl(row.storage_path, row.url),
    width: row.width,
  };
}

function aiVideoDimensions(row: AiVideoEntryRow) {
  const ratio = parseRatio(row.metadata?.ratio);
  if (!ratio) {
    return {
      height: null,
      width: null,
    };
  }
  return {
    height: Math.round(ratio.height * 100),
    width: Math.round(ratio.width * 100),
  };
}

function aiVideoAspectBucket(row: AiVideoEntryRow) {
  const ratio = parseRatio(row.metadata?.ratio);
  if (!ratio) return "unknown";
  const aspect = ratio.width / ratio.height;
  if (aspect >= 1.9) return "wide";
  if (aspect >= 1.2) return "landscape";
  if (aspect <= 0.83) return "portrait";
  return "square";
}

function interleaveAiVideoRows(rows: AiVideoEntryRow[]) {
  const groups = new Map<string, AiVideoEntryRow[]>([
    ["portrait", []],
    ["landscape", []],
    ["square", []],
    ["wide", []],
    ["unknown", []],
  ]);

  for (const row of rows) {
    groups.get(aiVideoAspectBucket(row))?.push(row);
  }

  const total = rows.length;
  const totals = new Map([...groups.entries()].map(([bucket, group]) => [bucket, group.length]));
  const emitted = new Map([...groups.keys()].map((bucket) => [bucket, 0]));
  const result: AiVideoEntryRow[] = [];
  while ([...groups.values()].some((group) => group.length > 0)) {
    const nextBucket = [...groups.keys()]
      .filter((bucket) => (groups.get(bucket)?.length ?? 0) > 0)
      .sort((a, b) => {
        const aDeficit = ((totals.get(a) ?? 0) / total) * (result.length + 1) - (emitted.get(a) ?? 0);
        const bDeficit = ((totals.get(b) ?? 0) / total) * (result.length + 1) - (emitted.get(b) ?? 0);
        return bDeficit - aDeficit;
      })[0];
    if (!nextBucket) break;
    const next = groups.get(nextBucket)?.shift();
    if (!next) break;
    result.push(next);
    emitted.set(nextBucket, (emitted.get(nextBucket) ?? 0) + 1);
  }
  return result;
}

function normalizeAiVideoEntry(
  row: AiVideoEntryRow,
  posterUrl: string | null,
  posterMediaKind: "image" | "video",
): PublishedItemSummary {
  const { height, width } = aiVideoDimensions(row);
  const creator = row.creator?.replace(/\\+$/g, "").trim() || null;
  const title = row.title?.replace(/\\+$/g, "").trim() || "Untitled video";
  const description = cleanExplorePromptNullable(row.description) ?? cleanExplorePromptNullable(row.prompt);
  return {
    createdAt: row.created_at,
    description,
    featuredRank: null,
    id: aiVideoEntryId(row.id),
    isLiked: false,
    kind: "video",
    libraryStatus: null,
    likeCount: 0,
    posterHeight: height,
    posterMediaKind,
    posterOrientation: orientationFor(width, height),
    posterUrl,
    posterWidth: width,
    previewVideoUrl: proxiedExternalMediaUrl(row.original_video_url),
    publisher: {
      displayName: creator ?? row.source_site ?? "AI video library",
      userId: "ai-video-library",
    },
    sourceEntryId: row.id,
    tags: row.tags ?? [],
    title,
    useCount: 0,
    viewCount: 0,
    visibility: "public",
  };
}

async function signedAiVideoUrl(row: AiVideoEntryRow) {
  if (row.bucket_name && row.storage_path && row.storage_status === "stored") {
    const supabase = createServerClient();
    const { data, error } = await supabase.storage
      .from(row.bucket_name)
      .createSignedUrl(row.storage_path, 60 * 60);
    if (!error && data?.signedUrl) return data.signedUrl;
  }
  return row.original_video_url;
}

function hydrateAiVideoEntries(rows: AiVideoEntryRow[], limit: number) {
  return interleaveAiVideoRows(rows)
    .slice(0, limit)
    .map((row) => normalizeAiVideoEntry(
      row,
      proxiedExternalMediaUrl(row.thumbnail_url ?? row.original_video_url),
      row.thumbnail_url ? "image" : "video",
    ));
}

function normalizeItem(
  row: PublishedItemRow,
  options: {
    likedIds: Set<string>;
    mediaByItem: Map<string, PublishedMediaRow[]>;
    publishers: Map<string, PublisherRow>;
  },
): PublishedItemSummary {
  const publisher = options.publishers.get(row.publisher_id) ?? null;
  const poster = pickPosterMedia(options.mediaByItem.get(row.id));
  return {
    createdAt: row.created_at,
    description: cleanExplorePromptNullable(row.description),
    featuredRank: row.featured_rank,
    id: row.id,
    isLiked: options.likedIds.has(row.id),
    kind: normalizePublishedKind(row.kind),
    libraryStatus: libraryStatusFromMetadata(row.metadata),
    likeCount: row.like_count,
    posterHeight: poster?.height ?? null,
    posterMediaKind: poster?.kind ?? null,
    posterOrientation: orientationFor(poster?.width ?? null, poster?.height ?? null),
    posterUrl: poster ? publicMediaUrl(poster.storage_path, poster.url, 480) : null,
    posterWidth: poster?.width ?? null,
    previewVideoUrl: null,
    publisher: publisher
      ? {
          displayName: publisher.display_name,
          userId: publisher.user_id,
        }
      : null,
    sourceEntryId: sourceEntryIdFromMetadata(row.metadata),
    tags: row.tags ?? [],
    title: row.title,
    useCount: row.use_count,
    viewCount: Number(row.view_count),
    visibility: row.visibility,
  };
}

async function hydrateItems(rows: PublishedItemRow[], currentUserId?: string | null) {
  if (!rows.length) return [];
  const supabase = createServerClient();
  const ids = rows.map((row) => row.id);
  const publisherIds = Array.from(new Set(rows.map((row) => row.publisher_id)));

  const [{ data: mediaRows, error: mediaError }, { data: publisherRows, error: publisherError }] =
    await Promise.all([
      supabase
        .from("published_item_media")
        .select("id,item_id,role,kind,storage_path,url,node_id,mime_type,width,height,duration_s")
        .in("item_id", ids)
        .order("created_at", { ascending: true }),
      supabase.from("app_users").select("user_id,display_name").in("user_id", publisherIds),
    ]);

  if (mediaError) throw new Error(`Failed to read published media: ${mediaError.message}`);
  if (publisherError) throw new Error(`Failed to read publishers: ${publisherError.message}`);

  const likedIds = new Set<string>();
  if (currentUserId) {
    const { data: likes, error: likesError } = await supabase
      .from("published_item_interactions")
      .select("item_id")
      .eq("user_id", currentUserId)
      .eq("kind", "like")
      .in("item_id", ids);
    if (likesError) throw new Error(`Failed to read published likes: ${likesError.message}`);
    for (const like of (likes ?? []) as Array<{ item_id: string }>) {
      likedIds.add(like.item_id);
    }
  }

  const mediaByItem = new Map<string, PublishedMediaRow[]>();
  for (const media of (mediaRows ?? []) as PublishedMediaRow[]) {
    const current = mediaByItem.get(media.item_id) ?? [];
    current.push(media);
    mediaByItem.set(media.item_id, current);
  }

  const publishers = new Map<string, PublisherRow>();
  for (const publisher of (publisherRows ?? []) as PublisherRow[]) {
    publishers.set(publisher.user_id, publisher);
  }

  return rows.map((row) => normalizeItem(row, { likedIds, mediaByItem, publishers }));
}

export async function listPublishedItems(options: {
  currentUserId?: string | null;
  kind?: string;
  limit?: number;
} = {}): Promise<PublishedItemSummary[]> {
  const supabase = createServerClient();
  const itemLimit = options.limit && options.limit > 0 ? Math.floor(options.limit) : null;
  let query = supabase
    .from("published_items")
    .select(
      "id,kind,publisher_id,title,description,visibility,tags,metadata,like_count,use_count,view_count,featured_rank,created_at",
    )
    .in("visibility", PUBLIC_VISIBILITIES)
    .order("featured_rank", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (options.kind) {
    const kindValues = publishedKindQueryValues(options.kind);
    query = kindValues.length > 1 ? query.in("kind", kindValues) : query.eq("kind", options.kind);
  }
  if (itemLimit) query = query.limit(itemLimit);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to read published items: ${error.message}`);
  const publishedItems = await hydrateItems((data ?? []) as PublishedItemRow[], options.currentUserId);

  if (options.kind && options.kind !== "video") return publishedItems;

  const aiFetchLimit = itemLimit ? Math.min(AI_VIDEO_FETCH_LIMIT, Math.max(itemLimit * 2, itemLimit)) : AI_VIDEO_FETCH_LIMIT;
  const { data: aiRows, error: aiError } = await supabase
    .from("ai_video_entries")
    .select(
      "id,source_site,source_url,title,prompt,description,model,creator,tags,original_video_url,bucket_name,storage_path,storage_status,content_type,thumbnail_url,metadata,created_at",
    )
    .eq("storage_status", "stored")
    .neq("source_site", "lumiying")
    .order("created_at", { ascending: false })
    .limit(aiFetchLimit);
  if (aiError) throw new Error(`Failed to read AI video entries: ${aiError.message}`);

  return [
    ...publishedItems,
    ...hydrateAiVideoEntries((aiRows ?? []) as AiVideoEntryRow[], itemLimit ?? AI_VIDEO_LIMIT),
  ];
}

export async function listOwnedPublishedItems(options: {
  currentUserId: string;
  kind?: string;
  limit?: number;
}): Promise<PublishedItemSummary[]> {
  const supabase = createServerClient();
  const itemLimit = options.limit && options.limit > 0 ? Math.floor(options.limit) : null;
  let query = supabase
    .from("published_items")
    .select(
      "id,kind,publisher_id,title,description,visibility,tags,metadata,like_count,use_count,view_count,featured_rank,created_at",
    )
    .eq("publisher_id", options.currentUserId)
    .order("created_at", { ascending: false });

  if (options.kind) {
    const kindValues = publishedKindQueryValues(options.kind);
    query = kindValues.length > 1 ? query.in("kind", kindValues) : query.eq("kind", options.kind);
  }
  if (itemLimit) query = query.limit(itemLimit);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to read library items: ${error.message}`);
  return hydrateItems((data ?? []) as PublishedItemRow[], options.currentUserId);
}

export async function getPublishedItem(
  itemId: string,
  currentUserId?: string | null,
): Promise<PublishedItemDetail | null> {
  const supabase = createServerClient();
  const aiVideoId = aiVideoRawId(itemId);
  if (aiVideoId) {
    const { data: aiRow, error: aiError } = await supabase
      .from("ai_video_entries")
      .select(
        "id,source_site,source_url,title,prompt,description,model,creator,tags,original_video_url,bucket_name,storage_path,storage_status,content_type,thumbnail_url,metadata,created_at",
      )
      .eq("id", aiVideoId)
      .maybeSingle();
    if (aiError) throw new Error(`Failed to read AI video entry: ${aiError.message}`);
    if (!aiRow) return null;

    const row = aiRow as AiVideoEntryRow;
    const videoUrl = await signedAiVideoUrl(row);
    const summary = normalizeAiVideoEntry(row, videoUrl, "video");
    return {
      ...summary,
      files: row.prompt
        ? [
            {
              content: cleanExplorePromptText(row.prompt),
              path: "prompt.md",
            },
          ]
        : [],
      media: [
        {
          durationS: null,
          height: summary.posterHeight,
          id: `${summary.id}:video`,
          kind: "video",
          mimeType: row.content_type,
          nodeId: null,
          role: "poster",
          url: videoUrl,
          width: summary.posterWidth,
        },
        ...(row.thumbnail_url
          ? [
              {
                durationS: null,
                height: summary.posterHeight,
                id: `${summary.id}:thumbnail`,
                kind: "image",
                mimeType: null,
                nodeId: null,
                role: "thumbnail",
                url: proxiedExternalMediaUrl(row.thumbnail_url),
                width: summary.posterWidth,
              },
            ]
          : []),
      ],
      metadata: {
        ...(row.metadata ?? {}),
        model: row.model,
        sourceSite: row.source_site,
        sourceUrl: row.source_url,
      },
      sourceNodeId: null,
      sourceProjectId: null,
    };
  }

  const { data: row, error } = await supabase
    .from("published_items")
    .select(
      "id,kind,publisher_id,source_project_id,source_node_id,title,description,visibility,tags,metadata,like_count,use_count,view_count,featured_rank,created_at",
    )
    .eq("id", itemId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read published item: ${error.message}`);
  if (!row) return null;
  const canReadDraft = row.visibility === "draft" && Boolean(currentUserId) && row.publisher_id === currentUserId;
  if (!DETAIL_VISIBILITIES.includes(row.visibility) && !canReadDraft) return null;

  const [summary] = await hydrateItems([row as PublishedItemRow], currentUserId);
  if (!summary) return null;

  const [{ data: files, error: filesError }, { data: media, error: mediaError }] = await Promise.all([
    supabase
      .from("published_item_files")
      .select("path,content")
      .eq("item_id", itemId)
      .order("path", { ascending: true }),
    supabase
      .from("published_item_media")
      .select("id,item_id,role,kind,storage_path,url,node_id,mime_type,width,height,duration_s")
      .eq("item_id", itemId)
      .order("created_at", { ascending: true }),
  ]);
  if (filesError) throw new Error(`Failed to read published files: ${filesError.message}`);
  if (mediaError) throw new Error(`Failed to read published media: ${mediaError.message}`);

  return {
    ...summary,
    files: ((files ?? []) as Array<{ content: string; path: string }>).map((file) => ({
      content: file.content,
      path: file.path,
    })),
    media: ((media ?? []) as PublishedMediaRow[]).map(normalizeMedia),
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : null,
    sourceNodeId: row.source_node_id ?? null,
    sourceProjectId: row.source_project_id ?? null,
  };
}

export async function togglePublishedItemLike(itemId: string, userId: string) {
  const supabase = createServerClient();
  const { data: item, error: itemError } = await supabase
    .from("published_items")
    .select("id,visibility")
    .eq("id", itemId)
    .in("visibility", DETAIL_VISIBILITIES)
    .maybeSingle();
  if (itemError) throw new Error(`Failed to read published item: ${itemError.message}`);
  if (!item) throw new Error("Published item not found.");

  const { data: existing, error: existingError } = await supabase
    .from("published_item_interactions")
    .select("id")
    .eq("item_id", itemId)
    .eq("user_id", userId)
    .eq("kind", "like")
    .maybeSingle();
  if (existingError) throw new Error(`Failed to read like: ${existingError.message}`);

  if (existing) {
    const { error: deleteError } = await supabase
      .from("published_item_interactions")
      .delete()
      .eq("id", existing.id);
    if (deleteError) throw new Error(`Failed to unlike item: ${deleteError.message}`);
  } else {
    const { error: insertError } = await supabase.from("published_item_interactions").insert({
      item_id: itemId,
      kind: "like",
      user_id: userId,
    });
    if (insertError) throw new Error(`Failed to like item: ${insertError.message}`);
  }

  const { data: updated, error: updatedError } = await supabase
    .from("published_items")
    .select("like_count,use_count")
    .eq("id", itemId)
    .single();
  if (updatedError) throw new Error(`Failed to read updated like count: ${updatedError.message}`);

  return {
    isLiked: !existing,
    likeCount: updated.like_count as number,
    useCount: updated.use_count as number,
  };
}
