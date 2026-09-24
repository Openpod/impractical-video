#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServerClient } from "@/lib/supabase";
import { imageSize } from "@/lib/image-size";
import { DEFAULT_PORTFOLIO_FORMAT } from "@/lib/portfolio-sheet";
import {
  generatePortfolioSheet,
  renderPortfolioMarkdown,
  renderReferenceMarkdown,
  type PlannedVideoPortfolioEntity,
  type VideoPortfolioPoint,
} from "@/lib/video-portfolio-pipeline";
import type { ReferenceCategory } from "@/lib/source-graph";

type CuratedKind = "character" | "style" | "feature";
type CuratedDecision = "approved" | "pending" | "skip";

type CuratedItem = {
  id: string;
  source_entry_id: string;
  source_video_title: string;
  entity_id: string;
  raw_title: string;
  canonical_title: string;
  kind: CuratedKind;
  decision: CuratedDecision;
  category: ReferenceCategory;
  description?: string;
  canonical_outfit?: string | null;
  paths: {
    reference_md: string;
    portfolio_md: string;
    evidence_frames: string[];
    portfolio_sheet: string | null;
  };
  notes?: string;
};

type Args = {
  dryRun: boolean;
  limit: number | null;
  publisherId: string;
  root: string;
  visibility: "draft" | "unlisted" | "public" | "featured";
};

const PUBLISHED_MEDIA_BUCKET = "published-media";

function usage() {
  return `Usage:
  npm run publish:curated-portfolios -- --root /tmp/vp-higgsfield-50 --publisher-id <app_user_id> [--visibility unlisted] [--limit N] [--dry-run]

Publishes only curation.json items with decision:"approved". Missing portfolio
sheets are generated first with Nano Banana.`;
}

function readArgs(argv: string[]): Args {
  const out: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    index += 1;
  }
  const root = typeof out.root === "string" ? out.root : "/tmp/vp-higgsfield-50";
  const publisherId =
    typeof out["publisher-id"] === "string"
      ? out["publisher-id"]
      : process.env.VIDEO_FS_PUBLISHER_ID ?? "";
  const visibility =
    typeof out.visibility === "string" ? out.visibility : "unlisted";
  if (!["draft", "unlisted", "public", "featured"].includes(visibility)) {
    throw new Error("visibility must be draft, unlisted, public, or featured.");
  }
  const limit =
    typeof out.limit === "string" && Number.isFinite(Number(out.limit))
      ? Math.max(1, Math.floor(Number(out.limit)))
      : null;
  return {
    dryRun: out["dry-run"] === true,
    limit,
    publisherId,
    root,
    visibility: visibility as Args["visibility"],
  };
}

function safeJoin(root: string, relativePath: string) {
  const target = path.resolve(root, relativePath);
  const resolvedRoot = path.resolve(root);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Unsafe path outside root: ${relativePath}`);
  }
  return target;
}

function extOf(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  return ext || "";
}

function mimeForPath(filePath: string) {
  const ext = extOf(filePath);
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  return map[ext] ?? "application/octet-stream";
}

function mediaKindForPath(filePath: string) {
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(extOf(filePath))) return "image";
  return "other";
}

function stripFrontmatter(markdown: string) {
  if (!markdown.startsWith("---")) return { body: markdown.trim(), meta: {} as Record<string, unknown> };
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return { body: markdown.trim(), meta: {} as Record<string, unknown> };
  const raw = markdown.slice(markdown.indexOf("\n") + 1, end);
  const body = markdown.slice(end + 4).trim();
  try {
    return { body, meta: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return { body, meta: {} as Record<string, unknown> };
  }
}

function pointsFromPortfolio(markdown: string): VideoPortfolioPoint[] {
  const parsed = stripFrontmatter(markdown);
  const source = parsed.meta.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return [];
  const frames = (source as Record<string, unknown>).evidence_frames;
  if (!Array.isArray(frames)) return [];
  return frames.flatMap((frame) => {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return [];
    const record = frame as Record<string, unknown>;
    const seconds = typeof record.seconds === "number" ? record.seconds : null;
    const description = typeof record.description === "string" ? record.description : "";
    if (seconds == null || !description) return [];
    return [
      {
        seconds,
        timecode: typeof record.timecode === "string" ? record.timecode : undefined,
        description,
      },
    ];
  });
}

function categoryToExtractionCategory(category: ReferenceCategory) {
  if (category === "characters") return "character";
  if (category === "environments") return "environment";
  if (category === "styles") return "style";
  return "prop";
}

function itemDescription(item: CuratedItem, referenceMarkdown: string) {
  if (item.description?.trim()) return item.description.trim();
  const body = stripFrontmatter(referenceMarkdown).body;
  return body
    .replace(/^# .+$/m, "")
    .replace(/^Observed as:.*$/gm, "")
    .replace(/^Importance:.*$/gm, "")
    .trim();
}

function entityFromItem(input: {
  item: CuratedItem;
  portfolioMarkdown: string;
  referenceMarkdown: string;
}): PlannedVideoPortfolioEntity {
  const points = pointsFromPortfolio(input.portfolioMarkdown);
  return {
    id: input.item.entity_id,
    name: input.item.canonical_title,
    rawName: input.item.raw_title,
    category: categoryToExtractionCategory(input.item.category),
    description: itemDescription(input.item, input.referenceMarkdown),
    canonicalOutfit: input.item.canonical_outfit ?? undefined,
    referenceCategory: input.item.category,
    referencePath: stripSourcePrefix(input.item.paths.reference_md),
    portfolioPath: stripSourcePrefix(input.item.paths.portfolio_md),
    framePaths: input.item.paths.evidence_frames.map(stripSourcePrefix),
    contactSheetPath:
      input.item.paths.portfolio_sheet?.split("/").slice(1).join("/") ??
      stripSourcePrefix(input.item.paths.portfolio_md)
        .replace(/^references\//, "media/references/")
        .replace(/\/portfolio\.md$/, "/portfolio-contact-sheet.jpg"),
    timestampedPoints: points,
  };
}

function stripSourcePrefix(relativePath: string) {
  const parts = relativePath.split("/");
  if (parts[0]?.match(/^[0-9a-f-]{36}$/i)) return parts.slice(1).join("/");
  return relativePath;
}

async function ensurePortfolioSheet(input: {
  entity: PlannedVideoPortfolioEntity;
  item: CuratedItem;
  root: string;
}) {
  const outputRel = `${input.item.source_entry_id}/${input.entity.contactSheetPath}`;
  const outputPath = safeJoin(input.root, outputRel);
  if (fs.existsSync(outputPath)) {
    return { falUrl: null, generatedNow: false, outputRel };
  }
  const localFramePaths = input.item.paths.evidence_frames.map((frame) => safeJoin(input.root, frame));
  const result = await generatePortfolioSheet({ entity: input.entity, localFramePaths });
  if (!result.ok || !result.bytes) {
    throw new Error(`Failed to generate sheet for ${input.item.id}: ${result.error ?? "unknown error"}`);
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.bytes);
  return { falUrl: result.falUrl, generatedNow: true, outputRel };
}

async function publishLocalBundle(input: {
  entity: PlannedVideoPortfolioEntity;
  item: CuratedItem;
  publisherId: string;
  root: string;
  visibility: Args["visibility"];
}) {
  const supabase = createServerClient();
  const itemId = randomUUID();
  const metadata = {
    reference_category: input.item.category,
    source_entry_id: input.item.source_entry_id,
    source_video_title: input.item.source_video_title,
    raw_title: input.item.raw_title,
    canonical_title: input.item.canonical_title,
    extraction_id: input.item.id,
    generated_from: "video_portfolio_curated_batch",
  };
  const { error: itemError } = await supabase.from("published_items").insert({
    id: itemId,
    kind: input.item.kind,
    publisher_id: input.publisherId,
    source_project_id: null,
    source_node_id: input.entity.id,
    title: input.item.canonical_title,
    description: input.entity.description,
    visibility: input.visibility,
    tags: [
      input.item.kind,
      input.item.category.replace(/s$/, ""),
      "video-portfolio",
      "higgsfield",
    ],
    metadata,
  });
  if (itemError) throw new Error(`Failed to create published item: ${itemError.message}`);

  const textFiles = [input.entity.referencePath, input.entity.portfolioPath];
  for (const rel of textFiles) {
    const content = await readFile(safeJoin(input.root, `${input.item.source_entry_id}/${rel}`), "utf8");
    const { error } = await supabase.from("published_item_files").insert({
      item_id: itemId,
      path: rel,
      content,
    });
    if (error) throw new Error(`Failed to publish file ${rel}: ${error.message}`);
  }

  const mediaFiles = [
    input.entity.contactSheetPath,
    ...input.entity.framePaths,
  ];
  let mediaCount = 0;
  for (const rel of mediaFiles) {
    const full = safeJoin(input.root, `${input.item.source_entry_id}/${rel}`);
    if (!fs.existsSync(full)) continue;
    const content = await readFile(full);
    const storagePath = `${itemId}/${rel}`;
    const contentType = mimeForPath(rel);
    const { error: uploadError } = await supabase.storage
      .from(PUBLISHED_MEDIA_BUCKET)
      .upload(storagePath, content, { contentType, upsert: true });
    if (uploadError) throw new Error(`Failed to upload ${rel}: ${uploadError.message}`);
    const dims = mediaKindForPath(rel) === "image" ? imageSize(content) : null;
    const { error: mediaError } = await supabase.from("published_item_media").insert({
      item_id: itemId,
      role: rel === input.entity.contactSheetPath ? "poster" : "asset",
      kind: mediaKindForPath(rel),
      storage_path: storagePath,
      node_id: input.entity.id,
      mime_type: contentType,
      bytes: content.byteLength,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      metadata: rel === input.entity.contactSheetPath ? { portfolio_sheet: true } : { evidence_frame: true },
    });
    if (mediaError) throw new Error(`Failed to record media ${rel}: ${mediaError.message}`);
    mediaCount += 1;
  }

  return { itemId, fileCount: textFiles.length, mediaCount };
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.publisherId) {
    console.error(usage());
    throw new Error("Missing --publisher-id or VIDEO_FS_PUBLISHER_ID.");
  }
  const curationPath = path.join(args.root, "curation.json");
  const curation = JSON.parse(await readFile(curationPath, "utf8")) as { items: CuratedItem[] };
  const approved = curation.items
    .filter((item) => item.decision === "approved")
    .slice(0, args.limit ?? undefined);

  console.log(
    JSON.stringify({
      approved: approved.length,
      dryRun: args.dryRun,
      root: args.root,
      visibility: args.visibility,
      byKind: approved.reduce<Record<string, number>>((acc, item) => {
        acc[item.kind] = (acc[item.kind] ?? 0) + 1;
        return acc;
      }, {}),
    }),
  );

  for (const item of approved) {
    const referencePath = safeJoin(args.root, item.paths.reference_md);
    const portfolioPath = safeJoin(args.root, item.paths.portfolio_md);
    const referenceMarkdown = await readFile(referencePath, "utf8");
    const portfolioMarkdown = await readFile(portfolioPath, "utf8");
    const entity = entityFromItem({ item, portfolioMarkdown, referenceMarkdown });

    if (args.dryRun) {
      console.log(`[dry-run] ${item.kind}/${item.category} ${entity.id} "${item.canonical_title}"`);
      continue;
    }

    const sheet = await ensurePortfolioSheet({ entity, item, root: args.root });
    await writeFile(
      referencePath,
      renderReferenceMarkdown(entity),
      "utf8",
    );
    await writeFile(
      portfolioPath,
      renderPortfolioMarkdown({
        entity,
        mediaUrl: (mediaPath) => mediaPath,
        generated: true,
        falUrl: sheet.falUrl,
      }),
      "utf8",
    );
    item.paths.portfolio_sheet = `${item.source_entry_id}/${entity.contactSheetPath}`;
    const published = await publishLocalBundle({
      entity,
      item,
      publisherId: args.publisherId,
      root: args.root,
      visibility: args.visibility,
    });
    console.log(
      `[published] ${item.kind}/${item.category} ${entity.id} "${item.canonical_title}" -> ${published.itemId} (${sheet.generatedNow ? "generated" : "existing"} sheet)`,
    );
  }

  await writeFile(curationPath, JSON.stringify(curation, null, 2), "utf8");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
