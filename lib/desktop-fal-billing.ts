import type { BillableOp, VideoResolution } from "@/lib/usage-pricing";

const ALLOWED_IMAGE_ENDPOINTS = new Set([
  "fal-ai/nano-banana-2",
  "fal-ai/nano-banana-2/edit",
  "fal-ai/qwen-image-edit-plus",
  "fal-ai/flux-pro/kontext/max/multi",
  "fal-ai/gpt-image-1.5/edit",
  "openai/gpt-image-2/edit",
]);

const ALLOWED_VIDEO_ENDPOINTS = new Set([
  "bytedance/seedance-2.0/image-to-video",
  "bytedance/seedance-2.0/fast/image-to-video",
  "bytedance/seedance-2.0/fast/text-to-video",
  "bytedance/seedance-2.0/reference-to-video",
]);

const ALLOWED_AUDIO_ENDPOINTS = new Set([
  "fal-ai/elevenlabs/sound-effects/v2",
  "fal-ai/elevenlabs/tts/eleven-v3",
  "fal-ai/elevenlabs/tts/multilingual-v2",
  "fal-ai/elevenlabs/text-to-voice/design/eleven-v3",
  "fal-ai/elevenlabs/music",
]);

export type DesktopFalKind = "audio" | "image" | "video";

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedSeconds(value: unknown, fallback: number, maximum: number): number {
  return Math.max(1, Math.min(maximum, Math.ceil(finiteNumber(value) ?? fallback)));
}

function videoResolution(value: unknown): VideoResolution {
  return value === "480p" || value === "1080p" ? value : "720p";
}

export function isAllowedDesktopFalEndpoint(kind: DesktopFalKind, endpoint: string): boolean {
  if (kind === "image") return ALLOWED_IMAGE_ENDPOINTS.has(endpoint);
  if (kind === "video") return ALLOWED_VIDEO_ENDPOINTS.has(endpoint);
  return ALLOWED_AUDIO_ENDPOINTS.has(endpoint);
}

const ASPECT_RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);
const GPT_IMAGE_SIZES = new Set(["1024x1024", "1024x1536", "1536x1024", "auto"]);

function stringField(
  input: Record<string, unknown>,
  name: string,
  options: { max: number; required?: boolean },
): string | undefined {
  const value = typeof input[name] === "string" ? input[name].trim() : "";
  if (!value) {
    if (options.required) throw new Error(`${name} is required.`);
    return undefined;
  }
  if (value.length > options.max) throw new Error(`${name} is too long.`);
  return value;
}

function httpsUrl(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length > 4_096) throw new Error(`${name} is invalid.`);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("unsafe URL");
    return url.toString();
  } catch {
    throw new Error(`${name} must be a public HTTPS URL.`);
  }
}

function urlArray(
  input: Record<string, unknown>,
  name: string,
  maximum: number,
  required = false,
): string[] | undefined {
  const value = input[name];
  if (value == null) {
    if (required) throw new Error(`${name} is required.`);
    return undefined;
  }
  if (!Array.isArray(value) || value.length < (required ? 1 : 0) || value.length > maximum) {
    throw new Error(`${name} has too many references.`);
  }
  return value.map((url, index) => httpsUrl(url, `${name}[${index}]`));
}

function aspectRatio(value: unknown): string {
  return typeof value === "string" && ASPECT_RATIOS.has(value) ? value : "16:9";
}

/** Rebuild the provider payload from endpoint-specific fields. This strips
 * cost multipliers such as num_images, sync modes, arbitrary API keys, and
 * custom output dimensions before any request reaches fal. */
export function sanitizeDesktopFalInput(input: {
  endpoint: string;
  input: Record<string, unknown>;
  kind: DesktopFalKind;
}): Record<string, unknown> {
  if (!isAllowedDesktopFalEndpoint(input.kind, input.endpoint)) {
    throw new Error("That generation endpoint is not available to Video FS Desktop.");
  }

  const source = input.input;
  if (input.kind === "image") {
    const prompt = stringField(source, "prompt", { max: 20_000, required: true });
    if (input.endpoint === "fal-ai/nano-banana-2") {
      return { aspect_ratio: aspectRatio(source.aspect_ratio), prompt };
    }
    if (input.endpoint === "fal-ai/nano-banana-2/edit") {
      return {
        aspect_ratio: aspectRatio(source.aspect_ratio),
        image_urls: urlArray(source, "image_urls", 9, true),
        prompt,
      };
    }
    if (input.endpoint === "fal-ai/qwen-image-edit-plus") {
      return {
        enable_safety_checker: false,
        image_urls: urlArray(source, "image_urls", 9, true),
        prompt,
      };
    }
    if (input.endpoint === "fal-ai/flux-pro/kontext/max/multi") {
      return {
        aspect_ratio: aspectRatio(source.aspect_ratio),
        image_urls: urlArray(source, "image_urls", 5, true),
        prompt,
        safety_tolerance: "6",
      };
    }
    if (input.endpoint === "fal-ai/gpt-image-1.5/edit") {
      const requestedSize = typeof source.image_size === "string" ? source.image_size : "1024x1024";
      return {
        image_size: GPT_IMAGE_SIZES.has(requestedSize) ? requestedSize : "1024x1024",
        image_urls: urlArray(source, "image_urls", 9, true),
        input_fidelity: "high",
        output_format: "png",
        prompt,
        quality: "high",
      };
    }
    return {
      image_size: "auto",
      image_urls: urlArray(source, "image_urls", 9, true),
      mask_image_url: httpsUrl(source.mask_image_url, "mask_image_url"),
      output_format: "png",
      prompt,
      quality: "high",
    };
  }

  if (input.kind === "video") {
    const duration = boundedSeconds(source.duration, 5, 15);
    const payload: Record<string, unknown> = {
      aspect_ratio: aspectRatio(source.aspect_ratio),
      duration: String(duration),
      prompt: stringField(source, "prompt", { max: 20_000, required: true }),
      resolution: videoResolution(source.resolution),
    };
    if (source.generate_audio === true) payload.generate_audio = true;
    if (input.endpoint === "bytedance/seedance-2.0/reference-to-video") {
      const images = urlArray(source, "image_urls", 9);
      const videos = urlArray(source, "video_urls", 3);
      if (!images?.length && !videos?.length) throw new Error("A reference image or video is required.");
      if (images?.length) payload.image_urls = images;
      if (videos?.length) payload.video_urls = videos;
      return payload;
    }
    if (input.endpoint !== "bytedance/seedance-2.0/fast/text-to-video") {
      payload.image_url = httpsUrl(source.image_url, "image_url");
    }
    if (input.endpoint === "bytedance/seedance-2.0/image-to-video") {
      payload.end_image_url = httpsUrl(source.end_image_url, "end_image_url");
    }
    return payload;
  }

  if (input.endpoint === "fal-ai/elevenlabs/music") {
    const milliseconds = Math.round(
      Math.max(1_000, Math.min(120_000, finiteNumber(source.music_length_ms) ?? 30_000)),
    );
    return {
      music_length_ms: milliseconds,
      prompt: stringField(source, "prompt", { max: 20_000, required: true }),
    };
  }
  if (input.endpoint === "fal-ai/elevenlabs/sound-effects/v2") {
    return { text: stringField(source, "text", { max: 20_000, required: true }) };
  }
  if (
    input.endpoint === "fal-ai/elevenlabs/tts/eleven-v3" ||
    input.endpoint === "fal-ai/elevenlabs/tts/multilingual-v2"
  ) {
    return {
      text: stringField(source, "text", { max: 100_000, required: true }),
      voice: stringField(source, "voice", { max: 200 }) ?? "Rachel",
    };
  }
  const text = stringField(source, "text", { max: 5_000 });
  return {
    auto_generate_text: !text,
    prompt: stringField(source, "prompt", { max: 2_000, required: true }),
    ...(text ? { text } : {}),
  };
}

/** Derive billing exclusively from the allowlisted endpoint and actual provider
 * input. The desktop cannot submit a cheaper billing hint than the work it asks
 * the hosted service to perform. */
export function desktopFalBillableOp(input: {
  endpoint: string;
  input: Record<string, unknown>;
  kind: DesktopFalKind;
}): BillableOp {
  if (!isAllowedDesktopFalEndpoint(input.kind, input.endpoint)) {
    throw new Error("That generation endpoint is not available to Video FS Desktop.");
  }

  if (input.kind === "image") {
    if (input.endpoint === "fal-ai/gpt-image-1.5/edit") {
      // High-quality output plus up to nine high-fidelity reference images and
      // prompt/reasoning tokens. This conservative ceiling preserves margin.
      return { cogsUsd: 0.5, kind: "provider", tool: `desktop:${input.endpoint}` };
    }
    if (input.endpoint === "openai/gpt-image-2/edit") {
      // Auto sizing can reach 4K; include a conservative input-token allowance.
      return { cogsUsd: 0.75, kind: "provider", tool: `desktop:${input.endpoint}` };
    }
    if (input.endpoint === "fal-ai/qwen-image-edit-plus") {
      return { cogsUsd: 0.03, kind: "provider", tool: `desktop:${input.endpoint}` };
    }
    if (input.endpoint === "fal-ai/flux-pro/kontext/max/multi") {
      return { cogsUsd: 0.08, kind: "provider", tool: `desktop:${input.endpoint}` };
    }
    return { kind: "image", resolution: "1K", tool: `desktop:${input.endpoint}` };
  }

  if (input.kind === "video") {
    const standard =
      input.endpoint === "bytedance/seedance-2.0/image-to-video" ||
      input.endpoint === "bytedance/seedance-2.0/reference-to-video";
    return {
      kind: "clip",
      pinned: standard,
      resolution: videoResolution(input.input.resolution),
      seconds: boundedSeconds(input.input.duration, 5, 15),
      tool: `desktop:${input.endpoint}`,
    };
  }

  if (input.endpoint === "fal-ai/elevenlabs/music") {
    const milliseconds = finiteNumber(input.input.music_length_ms);
    return {
      kind: "music",
      seconds: boundedSeconds(milliseconds == null ? null : milliseconds / 1000, 30, 120),
      tool: `desktop:${input.endpoint}`,
    };
  }

  if (
    input.endpoint === "fal-ai/elevenlabs/tts/eleven-v3" ||
    input.endpoint === "fal-ai/elevenlabs/tts/multilingual-v2"
  ) {
    return {
      characters: Math.max(1, String(input.input.text ?? "").length),
      kind: "speech",
      tool: `desktop:${input.endpoint}`,
    };
  }

  if (input.endpoint === "fal-ai/elevenlabs/text-to-voice/design/eleven-v3") {
    return {
      characters: Math.max(1, String(input.input.text ?? input.input.prompt ?? "").length * 3),
      kind: "speech",
      tool: `desktop:${input.endpoint}`,
    };
  }

  // Preserve the existing sound-effect allowance: one request is priced as a
  // 30-second audio generation until fal exposes stable per-second SFX rates.
  return { kind: "music", seconds: 30, tool: `desktop:${input.endpoint}` };
}
