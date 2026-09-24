import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import {
  billingEnabled,
  chargeForOp,
  getCreditBalance,
  quoteOp,
} from "@/lib/credits-service";
import { imageSize } from "@/lib/image-size";
import { generateFalImage, generateFalVoiceDesign } from "@/lib/media";
import {
  getPortfolioScaffoldUrl,
  portfolioPromptContract,
  PORTFOLIO_SCAFFOLD_INSTRUCTION,
  PORTFOLIO_TEXT_RESTRICTION,
  DEFAULT_PORTFOLIO_FORMAT,
} from "@/lib/portfolio-sheet";
import { getPublishedItem } from "@/lib/published-items";
import type { ReferenceCategory } from "@/lib/source-graph";
import { createServerClient } from "@/lib/supabase";
import type { BillableOp } from "@/lib/usage-pricing";
import { userFacingError } from "@/lib/user-facing-error";
import { safeRelativePath, withJsonFrontmatter } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const PUBLISHED_MEDIA_BUCKET = "published-media";

type AssetKind = "character" | "environment" | "prop" | "style";

const ASSET_CONFIG: Record<AssetKind, {
  category: ReferenceCategory;
  label: string;
  prefix: string;
  publicKind: string;
}> = {
  character: {
    category: "characters",
    label: "character",
    prefix: "char",
    publicKind: "character",
  },
  environment: {
    category: "environments",
    label: "environment",
    prefix: "env",
    publicKind: "environment",
  },
  prop: {
    category: "props",
    label: "object",
    prefix: "prop",
    publicKind: "prop",
  },
  style: {
    category: "styles",
    label: "style",
    prefix: "style",
    publicKind: "style",
  },
};

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_")
      .slice(0, 42) || "asset"
  );
}

function titleFromPrompt(prompt: string, label: string) {
  const cleaned = prompt
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter(Boolean).slice(0, 5);
  if (words.length >= 2) {
    return words
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }
  return `Untitled ${label}`;
}

function defaultTitle(label: string) {
  return `Untitled ${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function providerSafeAssetPrompt(value: string) {
  return value
    .replace(/\bcleavage\b/gi, "neckline")
    .replace(/\bsteep neckline\b/gi, "stylized neckline")
    .replace(/\brevealing\b/gi, "stylized")
    .replace(/\baccentuated assets\b/gi, "distinct silhouette")
    .replace(/\bassets\b/gi, "features")
    .replace(/\bsexy\b/gi, "confident")
    .replace(/\bseductive\b/gi, "confident")
    .replace(/\bteasingly\b/gi, "confidently")
    .replace(/\bprovocative\b/gi, "bold")
    .replace(/\bskimpy\b/gi, "minimal")
    .replace(/\berotic\b/gi, "editorial")
    .replace(/\bnsfw\b/gi, "fashion editorial")
    .replace(/\s+/g, " ")
    .trim();
}

function publicAssetError(message: string) {
  if (/content_policy_violation|content checker|flagged by a content checker/i.test(message)) {
    return "The image provider blocked the wording in this request. I softened the provider-facing wording, so try again with the same idea.";
  }
  return userFacingError(message);
}

function contentTypeExtension(contentType: string | null) {
  const clean = contentType?.split(";")[0]?.trim().toLowerCase();
  if (clean === "image/jpeg") return "jpg";
  if (clean === "image/webp") return "webp";
  if (clean === "image/png") return "png";
  return "png";
}

async function downloadImage(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download generated image (${response.status}).`);
  const contentType = response.headers.get("content-type") || "image/png";
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    buffer,
    contentType,
    extension: contentTypeExtension(contentType),
  };
}

function publicStorageUrl(storagePath: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");
  if (!supabaseUrl) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL.");
  return `${supabaseUrl}/storage/v1/object/public/${PUBLISHED_MEDIA_BUCKET}/${storagePath}`;
}

function providerInputUrl(url: string | null | undefined) {
  if (!url) return null;
  if (url.startsWith("data:")) return url;
  try {
    if (url.startsWith("/api/media-proxy")) {
      const parsedProxy = new URL(url, "http://localhost");
      const raw = parsedProxy.searchParams.get("url");
      return raw && /^https?:\/\//i.test(raw) ? raw : null;
    }
    if (/^https?:\/\//i.test(url)) return url;
    const publicBaseUrl =
      process.env.PUBLIC_BASE_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXT_PUBLIC_BASE_URL ||
      null;
    if (publicBaseUrl && url.startsWith("/")) return new URL(url, publicBaseUrl).toString();
  } catch {
    return null;
  }
  return null;
}

function referenceMarkdown(input: {
  category: ReferenceCategory;
  id: string;
  prompt: string;
  title: string;
  voiceId?: string | null;
}) {
  return withJsonFrontmatter(
    {
      id: input.id,
      type: "reference",
      category: input.category,
      status: "active",
      created_from: "explore_create",
      ...(input.voiceId ? { voice_id: input.voiceId } : {}),
    },
    `# ${input.title}\n\n${input.prompt}`,
  );
}

function displayPrompt(input: {
  label: string;
  prompt: string;
  previousDisplayAttached?: boolean;
  title: string;
}) {
  const base = [
    `Using the attached 3x3 portfolio contact sheet as exact visual reference, create one polished square 1:1 user-facing image for this ${input.label}.`,
    "Show one cohesive hero image, not a grid or collage.",
    "Preserve the identity, design, materials, color palette, mood, proportions, and visual language established in the portfolio.",
    ...(input.previousDisplayAttached
      ? ["A previous user-facing profile image is also attached for continuity; update it to match the edited portfolio instead of copying it unchanged."]
      : []),
    "No text, labels, captions, UI, watermarks, logos, or annotations.",
    `Asset brief: ${input.title}. ${providerSafeAssetPrompt(input.prompt)}`,
  ];
  if (input.label === "character") {
    base.splice(
      2,
      0,
      "Show a single readable portrait or full-body editorial image with a clear face and silhouette.",
    );
  }
  if (input.label === "style") {
    base.splice(
      2,
      0,
      "Show a single cinematic frame that clearly demonstrates the style language without becoming a contact sheet.",
    );
  }
  return base.join("\n");
}

function portfolioMarkdown(input: {
  displayUrl: string | null;
  id: string;
  portfolioUrl: string;
  prompt: string;
  title: string;
}) {
  return withJsonFrontmatter(
    {
      id: `${input.id}_portfolio`,
      type: "portfolio",
      reference_id: input.id,
      portfolio_format: DEFAULT_PORTFOLIO_FORMAT,
      status: "generated",
      urls: [input.portfolioUrl],
      display_url: input.displayUrl,
      source: {
        type: "explore_create",
        generator: "nano-banana",
      },
    },
    `# ${input.title} portfolio\n\n## Prompt\n\n${input.prompt}\n\n## Media\n\n${input.portfolioUrl}`,
  );
}

async function uploadPublishedImage(input: {
  buffer: Buffer;
  contentType: string;
  itemId: string;
  nodeId: string;
  relPath: string;
  role: "asset" | "display" | "poster";
}) {
  const supabase = createServerClient();
  const storagePath = `${input.itemId}/${safeRelativePath(input.relPath)}`;
  const { error: uploadError } = await supabase.storage
    .from(PUBLISHED_MEDIA_BUCKET)
    .upload(storagePath, input.buffer, { contentType: input.contentType, upsert: true });
  if (uploadError) throw new Error(`Failed to upload generated image: ${uploadError.message}`);
  const dims = imageSize(input.buffer);
  const { error: mediaError } = await supabase.from("published_item_media").insert({
    item_id: input.itemId,
    role: input.role,
    kind: "image",
    storage_path: storagePath,
    node_id: input.nodeId,
    mime_type: input.contentType,
    bytes: input.buffer.byteLength,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    metadata: {
      generated_from: "explore_create",
      portfolio_sheet: input.role === "poster",
      display_image: input.role === "display",
    },
  });
  if (mediaError) throw new Error(`Failed to record generated image: ${mediaError.message}`);
  return publicStorageUrl(storagePath);
}

function insufficientCreditsResponse(input: { balance: number; required: number }) {
  return NextResponse.json(
    {
      balance: input.balance,
      error: `Insufficient credits. Asset creation needs ${input.required} credits, but your account has ${input.balance}.`,
      required: input.required,
    },
    { status: 402 },
  );
}

async function preflightAssetCredits(userId: string, ops: BillableOp[]) {
  if (!billingEnabled()) return null;
  const required = ops.reduce((sum, op) => sum + quoteOp(op), 0);
  const balance = await getCreditBalance(userId);
  return balance.total < required ? { balance: balance.total, required } : null;
}

async function chargeAssetOp(input: {
  description: string;
  idempotencyKey: string;
  op: BillableOp;
  userId: string;
}) {
  if (!billingEnabled()) return null;
  const result = await chargeForOp({
    description: input.description,
    idempotencyKey: input.idempotencyKey,
    op: input.op,
    projectId: null,
    userId: input.userId,
  });
  if (!result.ok && result.reason === "insufficient") {
    return { balance: result.balance, required: result.required };
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const user = await ensureCurrentAppUser();
    if (!user) return NextResponse.json({ error: "Sign in to create assets." }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const kind = typeof body.kind === "string" ? body.kind : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const previousItemId = typeof body.previousItemId === "string" ? body.previousItemId.trim() : null;
    const saveMode = body.saveMode === "library-draft" ? "library-draft" : "public";
    const referenceImageUrls = Array.isArray(body.referenceImageUrls)
      ? body.referenceImageUrls
          .filter((url): url is string => typeof url === "string")
          .map((url) => providerInputUrl(url))
          .filter((url): url is string => Boolean(url))
          .slice(0, 6)
      : [];
    if (!prompt) return NextResponse.json({ error: "Describe what to create." }, { status: 400 });
    if (!["character", "environment", "prop", "style"].includes(kind)) {
      return NextResponse.json({ error: "kind must be character, environment, prop, or style." }, { status: 400 });
    }

    const config = ASSET_CONFIG[kind as AssetKind];
    const isLibraryDraft = saveMode === "library-draft";
    const title = isLibraryDraft ? defaultTitle(config.label) : titleFromPrompt(prompt, config.label);
    const referenceId = `${config.prefix}_${slugify(title)}_${randomUUID().slice(0, 6)}`;
    const itemId = randomUUID();
    const portfolioOp: BillableOp = {
      kind: "portfolio",
      resolution: "2K",
      tool: "generateReferencePortfolio",
    };
    const displayOp: BillableOp = {
      kind: "image",
      resolution: "1K",
      tool: "generateImage",
    };
    const scaffoldUrl = await getPortfolioScaffoldUrl();
    const previous = previousItemId ? await getPublishedItem(previousItemId, user.userId).catch(() => null) : null;
    const previousPortfolioUrl = providerInputUrl(
      previous?.media.find((media) => media.role === "poster" && media.url)?.url,
    );
    const previousDisplayUrl = providerInputUrl(
      previous?.media.find((media) => (
        ["display", "thumbnail", "preview"].includes(media.role) &&
        media.kind === "image" &&
        media.url
      ))?.url,
    );
    const creditDenied = await preflightAssetCredits(user.userId, [portfolioOp, displayOp]);
    if (creditDenied) return insufficientCreditsResponse(creditDenied);

    const conditioningImageUrls = [providerInputUrl(scaffoldUrl), previousPortfolioUrl, ...referenceImageUrls]
      .filter((url): url is string => Boolean(url));
    const scaffoldNote = scaffoldUrl
      ? `\n\n${PORTFOLIO_SCAFFOLD_INSTRUCTION}`
      : "\n\nA blank 3x3 scaffold image could not be attached; still follow the written nine-cell grid exactly.";
    const continuityNote = previousPortfolioUrl
      ? [
          "\n\nA previous version of this asset is attached as visual reference.",
          "This is an edit, not a full regeneration: preserve the same identity, proportions, materials, color palette, and visual language.",
          "Preserve the 3x3 portfolio structure exactly: keep the same nine cell purposes, same camera angles, same framing, same poses/composition, and same row/column logic as the previous portfolio.",
          "Apply only the user's requested change inside the matching cells. Do not invent new angles, reorder cells, change shot types, crop differently, or redesign the character/environment/prop/style unless explicitly requested.",
        ].join("\n")
      : "";
    const attachedReferenceNote = referenceImageUrls.length
      ? "\n\nUser-attached reference images are included. Use them as visual references for identity, shape, materials, styling, color, or mood where relevant, while still obeying the 3x3 portfolio contract."
      : "";
    const providerPrompt = providerSafeAssetPrompt(prompt);
    const portfolioPrompt = [
      portfolioPromptContract(config.category),
      scaffoldNote,
      "\n\nAsset-specific brief:",
      `${title}: ${providerPrompt}`,
      continuityNote,
      attachedReferenceNote,
      `\n\n${PORTFOLIO_TEXT_RESTRICTION}`,
    ].join("\n");

    const portfolioGeneration = await generateFalImage({
      aspectRatio: "1:1",
      backend: process.env.FAL_CHARACTER_EDIT_BACKEND || "gpt-image",
      imageUrls: conditioningImageUrls,
      prompt: portfolioPrompt,
    });
    if (!portfolioGeneration.ok || !portfolioGeneration.url) {
      return NextResponse.json(
        { error: publicAssetError(portfolioGeneration.error || "Portfolio generation failed.") },
        { status: 502 },
      );
    }
    const portfolioChargeDenied = await chargeAssetOp({
      description: `Create ${config.label} portfolio`,
      idempotencyKey: `explore-create:${itemId}:portfolio`,
      op: portfolioOp,
      userId: user.userId,
    });
    if (portfolioChargeDenied) return insufficientCreditsResponse(portfolioChargeDenied);

    const supabase = createServerClient();
    const portfolioImage = await downloadImage(portfolioGeneration.url);
    const portfolioRel = `media/references/${config.category}/${referenceId}/portfolio-contact-sheet.${portfolioImage.extension}`;
    const { error: itemError } = await supabase.from("published_items").insert({
      id: itemId,
      kind: config.publicKind,
      publisher_id: user.userId,
      source_project_id: null,
      source_node_id: referenceId,
      title,
      description: prompt,
      visibility: isLibraryDraft ? "draft" : "public",
      tags: [
        config.publicKind,
        config.category.replace(/s$/, ""),
        "explore-create",
        ...(isLibraryDraft ? ["library-draft"] : []),
      ],
      metadata: {
        generated_from: "explore_create",
        parent_item_id: previousItemId,
        reference_category: config.category,
        ...(isLibraryDraft ? { library_status: "draft" } : {}),
      },
    });
    if (itemError) throw new Error(`Failed to create published item: ${itemError.message}`);

    const portfolioUrl = await uploadPublishedImage({
      buffer: portfolioImage.buffer,
      contentType: portfolioImage.contentType,
      itemId,
      nodeId: referenceId,
      relPath: portfolioRel,
      role: "poster",
    });

    let displayUrl: string | null = null;
    let displayWarning: string | null = null;
    const displayGeneration = await generateFalImage({
      aspectRatio: "1:1",
      backend: process.env.FAL_CHARACTER_EDIT_BACKEND || "gpt-image",
      imageUrls: [portfolioUrl, previousDisplayUrl, ...referenceImageUrls].filter((url): url is string => Boolean(url)),
      prompt: displayPrompt({ label: config.label, previousDisplayAttached: Boolean(previousDisplayUrl), prompt, title }),
    });
    if (displayGeneration.ok && displayGeneration.url) {
      const displayChargeDenied = await chargeAssetOp({
        description: `Create ${config.label} display image`,
        idempotencyKey: `explore-create:${itemId}:display`,
        op: displayOp,
        userId: user.userId,
      });
      if (displayChargeDenied) {
        displayWarning = `Portfolio created, but the display image was not saved because it needs ${displayChargeDenied.required} more credits.`;
      } else {
        const displayImage = await downloadImage(displayGeneration.url);
        const displayRel = `media/references/${config.category}/${referenceId}/display.${displayImage.extension}`;
        displayUrl = await uploadPublishedImage({
          buffer: displayImage.buffer,
          contentType: displayImage.contentType,
          itemId,
          nodeId: referenceId,
          relPath: displayRel,
          role: "display",
        });
      }
    } else {
      displayWarning = publicAssetError(displayGeneration.error ?? "Display image generation failed; using portfolio image.");
    }

    // Characters get a designed voice: cast from the character prompt, first
    // preview wins, and the preview audio becomes a playable media row.
    let voiceId: string | null = null;
    if (config.category === "characters") {
      const voiceDesign = await generateFalVoiceDesign({
        prompt: `Voice matching this character: ${prompt}`.slice(0, 900),
      }).catch(() => null);
      const preview = voiceDesign && voiceDesign.ok ? voiceDesign.previews[0] : null;
      if (preview?.voiceId) {
        const voiceChargeDenied = await chargeAssetOp({
          description: `Design ${config.label} voice`,
          idempotencyKey: `explore-create:${itemId}:voice`,
          op: { characters: 300, kind: "speech", tool: "designVoice" },
          userId: user.userId,
        });
        if (!voiceChargeDenied) {
          voiceId = preview.voiceId;
          try {
            const audioBuffer = preview.audioBase64
              ? Buffer.from(preview.audioBase64, "base64")
              : preview.url
                ? Buffer.from(await (await fetch(preview.url)).arrayBuffer())
                : null;
            if (audioBuffer) {
              const supabaseClient = createServerClient();
              const voicePath = `${itemId}/media/references/${config.category}/${referenceId}/voice-preview.mp3`;
              const { error: voiceUploadError } = await supabaseClient.storage
                .from(PUBLISHED_MEDIA_BUCKET)
                .upload(voicePath, audioBuffer, { contentType: "audio/mpeg", upsert: true });
              if (!voiceUploadError) {
                await supabaseClient.from("published_item_media").insert({
                  item_id: itemId,
                  role: "voice_preview",
                  kind: "audio",
                  storage_path: voicePath,
                  node_id: referenceId,
                  mime_type: "audio/mpeg",
                  bytes: audioBuffer.byteLength,
                  metadata: { generated_from: "explore_create", voice_id: voiceId },
                });
              }
            }
          } catch {
            // The cast voice_id still lands in reference.md; only the
            // playable preview is lost.
          }
        }
      }
    }

    const referencePath = `references/${config.category}/${referenceId}/reference.md`;
    const portfolioPath = `references/${config.category}/${referenceId}/portfolio.md`;
    const files = [
      {
        path: referencePath,
        content: referenceMarkdown({ category: config.category, id: referenceId, prompt, title, voiceId }),
      },
      {
        path: portfolioPath,
        content: portfolioMarkdown({
          displayUrl,
          id: referenceId,
          portfolioUrl,
          prompt: portfolioPrompt,
          title,
        }),
      },
    ];
    const { error: filesError } = await supabase.from("published_item_files").insert(
      files.map((file) => ({
        item_id: itemId,
        path: file.path,
        content: file.content,
      })),
    );
    if (filesError) throw new Error(`Failed to write published files: ${filesError.message}`);

    const item = await getPublishedItem(itemId, user.userId);
    return NextResponse.json({
      item,
      credits: {
        charged: quoteOp(portfolioOp) + (displayUrl ? quoteOp(displayOp) : 0),
        display: displayUrl ? quoteOp(displayOp) : 0,
        portfolio: quoteOp(portfolioOp),
      },
      warning: displayUrl ? null : displayWarning,
    });
  } catch (caught) {
    const message = publicAssetError(caught instanceof Error ? caught.message : "Failed to create asset.");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
