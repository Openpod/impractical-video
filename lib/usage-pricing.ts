/**
 * Single source of truth for usage economics: what we pay providers (COGS) and
 * what we charge users (credits). Runner-independent — import this from the fal
 * wrappers (lib/media.ts), the LLM loop, and the credits UI alike.
 *
 * Provider rates are from the fal + OpenRouter docs (June 2026); see the table
 * in PRICING.md / the credits discussion. Pricing is subject to provider change,
 * so keep these constants as the only place rates live.
 */

// ---- Credit unit ----------------------------------------------------------
// 1 credit = $0.01 USD (100 credits = $1). Fine-grained enough to price every
// op at the markup with no rounding distortion.
export const USD_PER_CREDIT = 0.01;

// 50% markup over raw provider cost. This produces a 33.3% gross margin before
// Stripe fees and bundled LLM usage, leaving a real contribution margin after
// those costs instead of pricing generation near break-even.
export const PRICING_MARKUP = 1.5;

/** Convert a raw USD provider cost into user-facing credits (never undercharge). */
export function usdToCredits(usd: number): number {
  return Math.ceil((usd * PRICING_MARKUP) / USD_PER_CREDIT);
}

/** Convert a raw USD cost into credits WITHOUT markup (internal COGS accounting). */
export function usdToCreditsAtCost(usd: number): number {
  return usd / USD_PER_CREDIT;
}

// ---- Provider COGS rates (USD) -------------------------------------------
// fal nano-banana-2 (images): per output image, by longest-edge resolution.
export const NANO_BANANA_USD: Record<ImageResolution, number> = {
  "0.5K": 0.06,
  "1K": 0.08,
  "2K": 0.12,
  "4K": 0.16,
};

// fal Seedance 2.0 (video): per SECOND, by tier and resolution. 720p is fal's
// default. Audio is included free. Fast ≈ 0.8x standard.
export const SEEDANCE_USD_PER_SEC: Record<VideoTier, Partial<Record<VideoResolution, number>>> = {
  standard: { "480p": 0.1345, "720p": 0.3024, "1080p": 0.6804 },
  fast: { "480p": 0.1076, "720p": 0.2419 },
};

// OpenRouter gpt-5.3-codex (the agent + critic), USD per 1M tokens.
export const LLM_USD_PER_MTOK = { input: 1.75, output: 14 } as const;

// fal ElevenLabs TTS (multilingual v2): billed per character.
export const ELEVENLABS_TTS_USD_PER_1K_CHARS = 0.1;

// fal ElevenLabs music: billed per generated minute.
export const ELEVENLABS_MUSIC_USD_PER_MINUTE = 0.5;

export type ImageResolution = "0.5K" | "1K" | "2K" | "4K";
export type VideoResolution = "480p" | "720p" | "1080p";
export type VideoTier = "standard" | "fast";

// ---- COGS (what WE pay) ---------------------------------------------------
export function imageCogsUsd(resolution: ImageResolution = "1K"): number {
  return NANO_BANANA_USD[resolution];
}

export function clipCogsUsd(input: {
  tier: VideoTier;
  resolution: VideoResolution;
  seconds: number;
}): number {
  const perSec = SEEDANCE_USD_PER_SEC[input.tier]?.[input.resolution];
  if (perSec == null) {
    throw new Error(`No Seedance rate for ${input.tier} ${input.resolution}`);
  }
  return perSec * input.seconds;
}

export function llmCogsUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * LLM_USD_PER_MTOK.input +
    (outputTokens / 1_000_000) * LLM_USD_PER_MTOK.output
  );
}

// ---- Credit price (what the USER pays) -----------------------------------
// Only generation artifacts are charged; LLM tokens are bundled into the markup.
export function imageCredits(resolution: ImageResolution = "1K"): number {
  return usdToCredits(imageCogsUsd(resolution));
}

export function clipCredits(input: {
  tier: VideoTier;
  resolution: VideoResolution;
  seconds: number;
}): number {
  return usdToCredits(clipCogsUsd(input));
}

/** Per-second credit rate for a video tier/resolution (for "X cr/s" display). */
export function clipCreditsPerSecond(tier: VideoTier, resolution: VideoResolution): number {
  return usdToCredits(clipCogsUsd({ tier, resolution, seconds: 1 }));
}

export function speechCogsUsd(characters: number): number {
  return (Math.max(1, characters) / 1000) * ELEVENLABS_TTS_USD_PER_1K_CHARS;
}

export function speechCredits(characters: number): number {
  return usdToCredits(speechCogsUsd(characters));
}

export function musicCogsUsd(seconds: number): number {
  return (Math.max(1, seconds) / 60) * ELEVENLABS_MUSIC_USD_PER_MINUTE;
}

export function musicCredits(seconds: number): number {
  return usdToCredits(musicCogsUsd(seconds));
}

// ---- Op catalog -----------------------------------------------------------
// Maps each billable tool to how its credits are computed. Free/bundled tools
// (captureFrame, reviewKeyframes, readFile, viewImage, the agent loop, …) are
// intentionally absent — they cost 0 credits to the user.
export type BillableOp =
  | { kind: "image"; tool: string; resolution?: ImageResolution }
  | { kind: "portfolio"; tool: string; resolution?: ImageResolution }
  | { kind: "provider"; tool: string; cogsUsd: number }
  | {
      kind: "clip";
      tool: string;
      pinned: boolean; // pinned (first+last) / reference-conditioned → standard tier; else fast
      resolution: VideoResolution;
      seconds: number;
    }
  | { kind: "speech"; tool: string; characters: number }
  | { kind: "music"; tool: string; seconds: number };

/** Credits a billable op will cost the user. The estimator and the live charge
 *  both call this so a quoted run can't drift from what gets deducted. */
export function opCredits(op: BillableOp): number {
  switch (op.kind) {
    case "image":
      return imageCredits(op.resolution ?? "1K");
    case "portfolio":
      // A portfolio is TWO generations: the contact sheet plus its companion
      // profile/display image.
      return imageCredits(op.resolution ?? "2K") + imageCredits("1K");
    case "provider":
      return usdToCredits(op.cogsUsd);
    case "clip":
      return clipCredits({
        tier: op.pinned ? "standard" : "fast",
        resolution: op.resolution,
        seconds: op.seconds,
      });
    case "speech":
      return speechCredits(op.characters);
    case "music":
      return musicCredits(op.seconds);
  }
}

/** Raw provider COGS for a billable op (internal margin accounting). */
export function opCogsUsd(op: BillableOp): number {
  switch (op.kind) {
    case "image":
      return imageCogsUsd(op.resolution ?? "1K");
    case "portfolio":
      return imageCogsUsd(op.resolution ?? "2K") + imageCogsUsd("1K");
    case "provider":
      return op.cogsUsd;
    case "clip":
      return clipCogsUsd({
        tier: op.pinned ? "standard" : "fast",
        resolution: op.resolution,
        seconds: op.seconds,
      });
    case "speech":
      return speechCogsUsd(op.characters);
    case "music":
      return musicCogsUsd(op.seconds);
  }
}
