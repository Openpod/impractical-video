#!/usr/bin/env tsx
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateFalImage, uploadToFalStorage } from "@/lib/media";
import { imageSize } from "@/lib/image-size";

type Args = {
  apply: boolean;
  aspectRatio: string;
  itemId: string | null;
  limit: number;
  noSource: boolean;
  promptExtra: string | null;
  promptFile: string | null;
  promptOverride: string | null;
  replace: boolean;
  sourceFile: string | null;
};

type PublishedItemRow = {
  description: string | null;
  id: string;
  kind: "character" | "environment";
  source_node_id: string | null;
  title: string;
};

type PublishedMediaRow = {
  height: number | null;
  id: string;
  item_id: string;
  kind: string;
  role: string;
  storage_path: string | null;
  url: string | null;
  width: number | null;
};

const PUBLISHED_MEDIA_BUCKET = "published-media";
const PUBLIC_VISIBILITIES = ["public", "featured", "unlisted"];
const IMAGE_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function usage() {
  return `Usage:
  npm run backfill:published-display -- [--apply] [--limit 1] [--item-id <uuid>] [--replace] [--prompt-extra "..."] [--prompt-override "..."] [--prompt-file ./prompt.txt] [--source-file ./reference.png] [--no-source] [--aspect-ratio 1:1]

Generates a user-facing 1:1 display image for published characters/environments
using the existing portfolio image as Nano Banana conditioning. Dry-run by default.`;
}

function readArgs(argv: string[]): Args {
  const parsed: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }

  const limit = typeof parsed.limit === "string" ? Number.parseInt(parsed.limit, 10) : 1;
  return {
    apply: parsed.apply === true,
    aspectRatio: typeof parsed["aspect-ratio"] === "string" ? parsed["aspect-ratio"].trim() : "1:1",
    itemId: typeof parsed["item-id"] === "string" ? parsed["item-id"] : null,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 1,
    noSource: parsed["no-source"] === true,
    promptExtra: typeof parsed["prompt-extra"] === "string" ? parsed["prompt-extra"].trim() : null,
    promptFile: typeof parsed["prompt-file"] === "string" ? parsed["prompt-file"] : null,
    promptOverride: typeof parsed["prompt-override"] === "string" ? parsed["prompt-override"].trim() : null,
    replace: parsed.replace === true,
    sourceFile: typeof parsed["source-file"] === "string" ? parsed["source-file"] : null,
  };
}

function loadDotEnvLocal() {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

function createSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function publicPublishedMediaUrl(storagePath: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");
  if (!supabaseUrl) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL.");
  return `${supabaseUrl}/storage/v1/object/public/${PUBLISHED_MEDIA_BUCKET}/${storagePath}`;
}

function mediaPublicUrl(media: PublishedMediaRow) {
  if (media.url) return media.url;
  return media.storage_path ? publicPublishedMediaUrl(media.storage_path) : null;
}

function pickPortfolioMedia(mediaRows: PublishedMediaRow[]) {
  const imageRows = mediaRows.filter((media) => media.kind === "image");
  return (
    imageRows.find((media) => media.role === "poster") ??
    imageRows.find((media) => media.role === "asset") ??
    imageRows.find((media) => media.role === "thumbnail") ??
    imageRows[0] ??
    null
  );
}

function displayPrompt(item: PublishedItemRow, promptExtra?: string | null) {
  const safeDescription = item.description
    ?.replace(/\b(revealing|lacy|lingerie|thong|cleavage|accentuated assets|flirty)\b/gi, "fashion")
    .replace(/\s+/g, " ")
    .trim();
  const extra = promptExtra?.trim();
  const wantsFullBody = /\b(full[-\s]?body|full[-\s]?length|head[-\s]?to[-\s]?toe|long shot|complete figure)\b/i.test(extra ?? "");
  const descriptionLine = !wantsFullBody && safeDescription ? `Description: ${safeDescription}` : "";

  if (item.kind === "environment") {
    return [
    "Using the attached portfolio contact sheet as exact visual reference, create one polished square 1:1 user-facing cover image for this environment.",
    `Environment: ${item.title}.`,
      descriptionLine,
      extra ? `Additional direction: ${extra}` : "",
      "Show one cohesive hero view, not a grid or collage. Preserve the environment's architecture, layout, color palette, mood, era, materials, and lighting language from the portfolio.",
      "Make it clean, high-resolution, cinematic, readable at thumbnail size, and suitable as the public card image.",
      "No text, no labels, no UI, no watermark, no contact-sheet borders.",
    ].filter(Boolean).join("\n");
  }

  return [
    wantsFullBody
      ? "Using the attached portfolio contact sheet as exact identity reference, create one polished square 1:1 user-facing display image of this same character."
      : "Using the attached portfolio contact sheet as exact identity reference, create one polished square 1:1 user-facing profile image of this same character.",
    `Character: ${item.title}.`,
    descriptionLine,
    extra ? `Additional direction: ${extra}` : "",
    wantsFullBody
      ? "Show a single centered long shot with the complete figure visible, a clear face, and readable silhouette. Preserve the character's identity, hairstyle, color palette, and defining visual traits from the portfolio."
      : "Show a single centered portrait or bust/waist-up image with a clear face and readable silhouette. Preserve the character's identity, outfit, age, body type, hairstyle, color palette, and defining traits from the portfolio.",
    wantsFullBody
      ? "Stay faithful to the visual styling in the portfolio contact sheet without redesigning the character."
      : "Stay faithful to the outfit and styling visible in the portfolio contact sheet without redesigning the character.",
    "Make it clean, high-resolution, cinematic, appealing, and readable at thumbnail size.",
    "No text, no labels, no UI, no watermark, no contact sheet, no grid, no multiple versions.",
  ].filter(Boolean).join("\n");
}

function contentTypeToExtension(contentType: string | null) {
  if (contentType?.includes("jpeg")) return "jpg";
  if (contentType?.includes("webp")) return "webp";
  return "png";
}

async function downloadGeneratedImage(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download generated display image (${response.status} ${response.statusText}).`);
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? null;
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    buffer,
    contentType: contentType && IMAGE_CONTENT_TYPES.has(contentType) ? contentType : "image/png",
  };
}

async function readItems(supabase: SupabaseClient, args: Args) {
  let query = supabase
    .from("published_items")
    .select("id,kind,title,description,source_node_id")
    .in("kind", ["character", "environment"])
    .in("visibility", PUBLIC_VISIBILITIES)
    .order("created_at", { ascending: false })
    .limit(args.itemId ? 1 : Math.max(args.limit * 8, args.limit));

  if (args.itemId) query = query.eq("id", args.itemId);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to read published items: ${error.message}`);
  return (data ?? []) as PublishedItemRow[];
}

async function readMediaByItem(supabase: SupabaseClient, itemIds: string[]) {
  const byItem = new Map<string, PublishedMediaRow[]>();
  if (!itemIds.length) return byItem;
  const { data, error } = await supabase
    .from("published_item_media")
    .select("id,item_id,role,kind,storage_path,url,width,height")
    .in("item_id", itemIds)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to read published media: ${error.message}`);
  for (const media of (data ?? []) as PublishedMediaRow[]) {
    const current = byItem.get(media.item_id) ?? [];
    current.push(media);
    byItem.set(media.item_id, current);
  }
  return byItem;
}

async function deleteDisplayRows(supabase: SupabaseClient, itemId: string) {
  const { error } = await supabase
    .from("published_item_media")
    .delete()
    .eq("item_id", itemId)
    .eq("role", "display");
  if (error) throw new Error(`Failed to delete old display media for ${itemId}: ${error.message}`);
}

async function insertDisplayRow(input: {
  buffer: Buffer;
  contentType: string;
  item: PublishedItemRow;
  prompt: string;
  sourceUrl: string;
  supabase: SupabaseClient;
}) {
  const dimensions = imageSize(input.buffer);
  const extension = contentTypeToExtension(input.contentType);
  const storagePath = `${input.item.id}/display/${randomUUID()}.${extension}`;
  const { error: uploadError } = await input.supabase.storage
    .from(PUBLISHED_MEDIA_BUCKET)
    .upload(storagePath, input.buffer, {
      contentType: input.contentType,
      upsert: false,
    });
  if (uploadError) throw new Error(`Failed to upload ${storagePath}: ${uploadError.message}`);

  const { error: insertError } = await input.supabase.from("published_item_media").insert({
    bytes: input.buffer.byteLength,
    height: dimensions?.height ?? null,
    item_id: input.item.id,
    kind: "image",
    metadata: {
      generated_from: "published_reference_display_backfill",
      prompt: input.prompt,
      source_portfolio_url: input.sourceUrl,
    },
    mime_type: input.contentType,
    node_id: input.item.source_node_id,
    role: "display",
    storage_path: storagePath,
    width: dimensions?.width ?? null,
  });
  if (insertError) {
    throw new Error(
      `Failed to insert display media for ${input.item.id}: ${insertError.message}. Apply database/video_fs_published_display_media.sql first if the role constraint rejected "display".`,
    );
  }
  return {
    storagePath,
    url: publicPublishedMediaUrl(storagePath),
  };
}

async function main() {
  loadDotEnvLocal();
  const args = readArgs(process.argv.slice(2));
  const supabase = createSupabase();
  const items = await readItems(supabase, args);
  const mediaByItem = await readMediaByItem(supabase, items.map((item) => item.id));
  const candidates = items
    .map((item) => {
      const mediaRows = mediaByItem.get(item.id) ?? [];
      const display = mediaRows.find((media) => media.role === "display");
      const portfolio = pickPortfolioMedia(mediaRows);
      const portfolioUrl = portfolio ? mediaPublicUrl(portfolio) : null;
      return { display, item, portfolio, portfolioUrl };
    })
    .filter((candidate) => (args.replace || !candidate.display) && candidate.portfolioUrl)
    .slice(0, args.limit);

  if (!args.apply) {
    console.log(JSON.stringify({
      apply: false,
      candidates: candidates.map((candidate) => ({
        id: candidate.item.id,
        kind: candidate.item.kind,
        portfolioUrl: candidate.portfolioUrl,
        title: candidate.item.title,
        wouldReplace: Boolean(candidate.display),
      })),
      note: "Dry run only. Add --apply to generate and insert display media.",
    }, null, 2));
    return;
  }

  const results = [];
  for (const candidate of candidates) {
    const portfolioUrl = candidate.portfolioUrl;
    if (!portfolioUrl) continue;
    const prompt = args.promptFile
      ? readFileSync(resolve(args.promptFile), "utf8").trim()
      : args.promptOverride || displayPrompt(candidate.item, args.promptExtra);
    let sourceUrl = portfolioUrl;
    if (args.sourceFile) {
      const sourceBuffer = readFileSync(resolve(args.sourceFile));
      const uploaded = await uploadToFalStorage(sourceBuffer, `published-display-source-${candidate.item.id}.png`, "image/png");
      if (!uploaded.ok) {
        results.push({
          error: uploaded.error,
          id: candidate.item.id,
          ok: false,
        });
        continue;
      }
      sourceUrl = uploaded.url;
    }
    const generation = await generateFalImage({
      aspectRatio: args.aspectRatio,
      imageUrls: args.noSource ? undefined : [sourceUrl],
      prompt,
    });
    if (!generation.ok || !generation.url) {
      results.push({
        error: generation.error ?? "Generation failed.",
        id: candidate.item.id,
        ok: false,
      });
      continue;
    }

    const downloaded = await downloadGeneratedImage(generation.url);
    if (args.replace) await deleteDisplayRows(supabase, candidate.item.id);
    const inserted = await insertDisplayRow({
      buffer: downloaded.buffer,
      contentType: downloaded.contentType,
      item: candidate.item,
      prompt,
      sourceUrl,
      supabase,
    });
    results.push({
      id: candidate.item.id,
      ok: true,
      sourcePortfolioUrl: sourceUrl,
      title: candidate.item.title,
      ...inserted,
    });
  }

  console.log(JSON.stringify({ apply: true, results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
