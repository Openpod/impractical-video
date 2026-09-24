import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createFalClient } from "@fal-ai/client";
import { isLocalAppMode } from "@/lib/app-mode";
import { getGenerationMode } from "@/lib/local-generation-mode";
import { getFalKey, MISSING_FAL_KEY } from "@/lib/local-provider-settings";
import { desktopCloudFetch } from "@/lib/desktop-cloud";
import { extractFrameRemote, isFFmpegLambdaConfigured } from "@/lib/ffmpeg-lambda";

const execFileAsync = promisify(execFile);

export type GeneratedMedia = {
  provider: "fal" | "none";
  endpoint: string | null;
  input?: Record<string, unknown>;
  ok: boolean;
  raw?: unknown;
  error?: string;
  url?: string | null;
};

function collectUrls(value: unknown, urls: string[] = []) {
  if (!value) return urls;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) urls.push(value);
    return urls;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, urls);
    return urls;
  }
  if (typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectUrls(child, urls);
    }
  }
  return urls;
}

function chooseUrl(urls: string[], kind: "image" | "video" | "audio") {
  const extensions =
    kind === "video"
      ? [".mp4", ".webm", ".mov"]
      : kind === "audio"
        ? [".mp3", ".wav", ".m4a"]
        : [".png", ".jpg", ".jpeg", ".webp"];
  return (
    urls.find((url) => extensions.some((extension) => url.toLowerCase().includes(extension))) ??
    urls[0] ??
    null
  );
}

/**
 * Fal can only fetch hosted media — a workspace path like "media/uploads/x.png"
 * is meaningless to it and fails opaquely downstream. Reject any url-shaped
 * field that isn't http(s)/data BEFORE the call, naming the offender, so the
 * bug surfaces at the caller that forgot to resolve (sign/upload) the media.
 */
function findLocalPathInUrlFields(input: Record<string, unknown>): string | null {
  const isRemote = (value: string) => /^(https?:|data:)/i.test(value);
  for (const [key, value] of Object.entries(input)) {
    if (!/_urls?$/.test(key)) continue;
    if (typeof value === "string" && value && !isRemote(value)) return `${key}: "${value}"`;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry && !isRemote(entry)) return `${key}: "${entry}"`;
      }
    }
  }
  return null;
}

async function runDesktopCloudFal(
  kind: "image" | "video" | "audio",
  endpoint: string,
  input: Record<string, unknown>,
): Promise<GeneratedMedia> {
  try {
    const response = await desktopCloudFetch("/api/desktop/fal/run", {
      body: JSON.stringify({ endpoint, input, kind }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const result = (await response.json().catch(() => ({}))) as GeneratedMedia & {
      error?: string;
      required?: number;
    };
    if (!response.ok) {
      return {
        endpoint,
        error:
          result.error ||
          (response.status === 401
            ? "Sign in to use cloud generation from Video FS Desktop."
            : response.status === 402
              ? `Not enough credits${result.required ? ` (${result.required} required)` : ""}.`
              : `Desktop cloud generation failed (${response.status}).`),
        input,
        ok: false,
        provider: "none",
        url: null,
      };
    }
    return result;
  } catch (caught) {
    return {
      endpoint,
      error: caught instanceof Error ? caught.message : "Desktop cloud generation failed.",
      input,
      ok: false,
      provider: "none",
      url: null,
    };
  }
}

export async function runFalRequest(
  kind: "image" | "video" | "audio",
  endpoint: string | null,
  input: Record<string, unknown>,
): Promise<GeneratedMedia> {
  const localPath = findLocalPathInUrlFields(input);
  if (localPath) {
    return {
      provider: "none",
      endpoint,
      ok: false,
      error: `Refusing to send a local workspace path to fal (${localPath}). Media must be resolved to a hosted URL (signed workspace URL or fal storage upload) before generation.`,
      input,
      url: null,
    };
  }
  if (!endpoint) {
    return {
      provider: "none",
      endpoint: null,
      ok: false,
      error: `No Fal endpoint configured for ${kind}.`,
      input,
      url: null,
    };
  }
  if (
    isLocalAppMode() &&
    (await getGenerationMode()) === "credits"
  ) {
    return runDesktopCloudFal(kind, endpoint, input);
  }
  let credentials: string | null;
  try {
    credentials = await getFalKey();
  } catch {
    return { provider: "none", endpoint, ok: false, error: "Could not read API settings. Open Account → API keys to replace or remove the saved key.", input, url: null };
  }
  if (!credentials) {
    return {
      provider: "none",
      endpoint,
      ok: false,
      error: isLocalAppMode() ? MISSING_FAL_KEY : "FAL_KEY is not configured.",
      input,
      url: null,
    };
  }
  // Each request keeps its own credentials, including across retries. New
  // requests pick up saved changes immediately without mutating a global client.
  const fal = createFalClient({ credentials });
  // Model queues intermittently 504 ("downstream_service_unavailable") while
  // the platform stays green; a short backoff absorbs the blip instead of
  // failing the whole task and letting the agent hammer the queue instantly.
  const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
  const RETRY_DELAYS_MS = [5_000, 12_000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await fal.subscribe(endpoint, { input, logs: true });
      const raw = "data" in result ? result.data : result;
      return {
        provider: "fal",
        endpoint,
        input,
        ok: true,
        raw,
        url: chooseUrl(collectUrls(raw), kind),
      };
    } catch (error) {
      const status =
        error instanceof Error ? (error as Error & { status?: number }).status : undefined;
      const transient = typeof status === "number" && TRANSIENT_STATUSES.has(status);
      const delay = RETRY_DELAYS_MS[attempt];
      if (transient && delay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return {
        provider: "fal",
        endpoint,
        ok: false,
        error: describeFalError(error, endpoint, credentials),
        input,
        url: null,
      };
    }
  }
}

/**
 * Fal API errors carry the useful part (validation detail, status) in
 * `error.body`, not `error.message` — which is often empty. An empty error
 * leaves the agent retrying blind; always surface the body.
 */
function describeFalError(error: unknown, endpoint: string, credentials: string): string {
  if (!(error instanceof Error)) return `Fal call to ${endpoint} failed.`;
  const status = (error as Error & { status?: number }).status;
  if (status === 401 || status === 403) {
    return isLocalAppMode()
      ? "fal.ai rejected the API key or model access. Check your key in Account → API keys and the key's permissions in the fal.ai dashboard."
      : "fal.ai rejected the API key or model access. Check FAL_KEY and model permissions.";
  }
  if (status === 402) return "fal.ai reports insufficient balance. Add credits to your own fal.ai account and try again.";
  const parts: string[] = [];
  if (error.message?.trim()) parts.push(error.message.trim());
  const withMeta = error as Error & { status?: number; body?: unknown };
  if (typeof withMeta.status === "number") parts.push(`status ${withMeta.status}`);
  if (withMeta.body !== undefined) {
    try {
      parts.push(JSON.stringify(withMeta.body).slice(0, 1_500));
    } catch {
      // Unserializable body.
    }
  }
  const message = parts.length ? parts.join(" — ") : `Fal call to ${endpoint} failed (no detail provided).`;
  return message.replaceAll(credentials, "[redacted]");
}

/**
 * The reference/edit backend is swappable via FAL_EDIT_BACKEND so we can A/B
 * away from nano-banana (Gemini), whose Google safety filter cannot be disabled
 * and over-flags. Alternatives are open/permissive multi-image edit models:
 *   - qwen         -> fal-ai/qwen-image-edit-plus (enable_safety_checker:false)
 *   - flux-kontext -> fal-ai/flux-pro/kontext/max/multi (safety_tolerance:"6")
 * Each respects its own *_ENDPOINT env override so a specific version can be pinned.
 */
// gpt-image only supports square / 3:2 / 2:3 — map our aspect to its sizes.
function gptImageSize(aspect: string): string {
  switch (aspect) {
    case "1:1":
      return "1024x1024";
    case "2:3":
    case "9:16":
      return "1024x1536";
    case "3:2":
    case "16:9":
      return "1536x1024";
    default:
      return "1024x1024";
  }
}

export async function generateFalImage(input: {
  aspectRatio?: string;
  backend?: string;
  imageUrls?: string[];
  prompt: string;
}) {
  const hasReferences = Boolean(input.imageUrls?.length);
  const aspect = input.aspectRatio ?? "16:9";

  if (hasReferences) {
    // Per-call backend wins; the global env is only a manual override. Default
    // is nano-banana so swaps stay scoped to the caller that opts in.
    const backend = (input.backend || process.env.FAL_EDIT_BACKEND || "nano-banana").toLowerCase();

    if (backend === "qwen") {
      return runFalRequest("image", process.env.FAL_QWEN_EDIT_ENDPOINT || "fal-ai/qwen-image-edit-plus", {
        prompt: input.prompt,
        image_urls: input.imageUrls,
        enable_safety_checker: false,
      });
    }

    if (backend === "flux-kontext" || backend === "flux") {
      return runFalRequest(
        "image",
        process.env.FAL_FLUX_KONTEXT_ENDPOINT || "fal-ai/flux-pro/kontext/max/multi",
        {
          prompt: input.prompt,
          image_urls: input.imageUrls,
          aspect_ratio: aspect,
          safety_tolerance: process.env.FAL_FLUX_SAFETY_TOLERANCE || "6",
        },
      );
    }

    if (backend === "gpt-image" || backend === "gpt") {
      // OpenAI gpt-image edit: handles multi-image refs well. input_fidelity:high
      // preserves the source. NOTE: no native 16:9 (auto picks 1:1/3:2/2:3) and
      // OpenAI-moderated, so this does NOT fix the over-flagging problem.
      return runFalRequest("image", process.env.FAL_GPT_IMAGE_EDIT_ENDPOINT || "fal-ai/gpt-image-1.5/edit", {
        prompt: input.prompt,
        image_urls: input.imageUrls,
        image_size: process.env.FAL_GPT_IMAGE_SIZE || gptImageSize(aspect),
        input_fidelity: "high",
        quality: "high",
        output_format: "png",
      });
    }

    if (backend === "grok" || backend === "grok-imagine") {
      // Grok Imagine (xAI) via fal — wired but not user-exposed; endpoint
      // overridable while fal's id stabilizes.
      return runFalRequest("image", process.env.FAL_GROK_IMAGE_ENDPOINT || "xai/grok-imagine", {
        prompt: input.prompt,
        image_urls: input.imageUrls,
        aspect_ratio: aspect,
      });
    }

    // Default: nano-banana-2 edit (Gemini). honors aspect_ratio incl. 16:9.
    const referenceField = process.env.FAL_IMAGE_REFERENCE_FIELD || "image_urls";
    return runFalRequest("image", process.env.FAL_IMAGE_EDIT_ENDPOINT || "fal-ai/nano-banana-2/edit", {
      prompt: input.prompt,
      [referenceField]: input.imageUrls,
      aspect_ratio: aspect,
    });
  }

  // Text-to-image (no references). Keyframe/clip aspect MUST agree for
  // first/last-frame video, so we always pass aspect_ratio.
  const textBackend = (input.backend || "").toLowerCase();
  if (textBackend === "grok" || textBackend === "grok-imagine") {
    return runFalRequest("image", process.env.FAL_GROK_IMAGE_ENDPOINT || "xai/grok-imagine", {
      prompt: input.prompt,
      aspect_ratio: aspect,
    });
  }
  return runFalRequest("image", process.env.FAL_IMAGE_ENDPOINT || "fal-ai/nano-banana-2", {
    prompt: input.prompt,
    aspect_ratio: aspect,
  });
}

export async function generateFalMaskedImageEdit(input: {
  imageSize?: string;
  imageUrls: string[];
  maskUrl: string;
  prompt: string;
}) {
  return runFalRequest(
    "image",
    process.env.FAL_MASKED_IMAGE_EDIT_ENDPOINT || "openai/gpt-image-2/edit",
    {
      prompt: input.prompt,
      image_urls: input.imageUrls,
      mask_image_url: input.maskUrl,
      image_size: input.imageSize ?? "auto",
      output_format: "png",
      quality: "high",
    },
  );
}

export async function generateFalVideo(input: {
  aspectRatio?: string;
  backend?: string;
  duration?: string;
  endImageUrl?: string | null;
  generateAudio?: boolean;
  imageUrl?: string | null;
  prompt: string;
}) {
  const videoBackend = (input.backend || "").toLowerCase();
  if (videoBackend === "grok" || videoBackend === "grok-imagine") {
    // Grok Imagine video — wired but not user-exposed.
    return runFalRequest(
      "video",
      process.env.FAL_GROK_VIDEO_ENDPOINT || "xai/grok-imagine/video",
      {
        prompt: input.prompt,
        image_url: input.imageUrl || undefined,
        aspect_ratio: input.aspectRatio ?? "16:9",
        duration: input.duration ?? "5",
      },
    );
  }
  const endpoint = input.imageUrl && input.endImageUrl
    ? process.env.FAL_FIRST_LAST_VIDEO_ENDPOINT ||
      "bytedance/seedance-2.0/image-to-video"
    : input.imageUrl
    ? process.env.FAL_IMAGE_TO_VIDEO_ENDPOINT ||
      "bytedance/seedance-2.0/fast/image-to-video"
    : process.env.FAL_TEXT_TO_VIDEO_ENDPOINT ||
      "bytedance/seedance-2.0/fast/text-to-video";
  return runFalRequest("video", endpoint, {
    prompt: input.prompt,
    end_image_url: input.endImageUrl || undefined,
    image_url: input.imageUrl || undefined,
    aspect_ratio: input.aspectRatio ?? "16:9",
    duration: input.duration ?? "5",
    generate_audio: input.generateAudio || undefined,
  });
}

/** ElevenLabs sound effects via fal (FAL_AUDIO_ENDPOINT overridable). */
export async function generateFalAudio(input: { prompt: string }) {
  return runFalRequest(
    "audio",
    process.env.FAL_AUDIO_ENDPOINT || "fal-ai/elevenlabs/sound-effects/v2",
    { text: input.prompt },
  );
}

/**
 * Seedance 2.0 reference-to-video. Per fal's schema: up to 9 `image_urls`
 * and up to 3 `video_urls`; the prompt refers to them as @Image1..@ImageN and
 * @Video1..@VideoN in attachment order.
 */
export async function generateFalReferenceVideo(input: {
  aspectRatio?: string;
  duration?: string;
  generateAudio?: boolean;
  prompt: string;
  referenceImageUrls: string[];
  referenceVideoUrls?: string[];
}) {
  return runFalRequest(
    "video",
    process.env.FAL_REFERENCE_VIDEO_ENDPOINT ||
      "bytedance/seedance-2.0/reference-to-video",
    {
      prompt: input.prompt,
      image_urls: input.referenceImageUrls.length ? input.referenceImageUrls : undefined,
      video_urls: input.referenceVideoUrls?.length ? input.referenceVideoUrls : undefined,
      aspect_ratio: input.aspectRatio ?? "16:9",
      duration: input.duration ?? "5",
      generate_audio: input.generateAudio || undefined,
    },
  );
}

/** ElevenLabs text-to-speech via fal (FAL_TTS_ENDPOINT overridable). */
export async function generateFalSpeech(input: { text: string; voice?: string }) {
  const voice = input.voice || process.env.FAL_TTS_DEFAULT_VOICE || "Rachel";
  // Designed voices are raw ElevenLabs voice IDs (long alphanumeric), which
  // resolve on the v3 endpoint; premade names stay on the stable v2 default.
  const looksLikeVoiceId = /^[a-zA-Z0-9]{16,}$/.test(voice);
  const endpoint = looksLikeVoiceId
    ? process.env.FAL_TTS_V3_ENDPOINT || "fal-ai/elevenlabs/tts/eleven-v3"
    : process.env.FAL_TTS_ENDPOINT || "fal-ai/elevenlabs/tts/multilingual-v2";
  return runFalRequest("audio", endpoint, { text: input.text, voice });
}

/** ElevenLabs Voice Design via fal: a text description → ~3 synthetic voice
 * previews, each with an id usable as the TTS `voice`. Output shape is
 * normalized defensively (fal may return preview URLs or base64 audio). */
export async function generateFalVoiceDesign(input: {
  /** Description of the voice: gender, age, accent, tone, mood. */
  prompt: string;
  /** Optional preview line to voice; omitted → auto-generated. */
  text?: string | null;
}): Promise<
  | {
      ok: true;
      previews: Array<{ audioBase64: string | null; url: string | null; voiceId: string }>;
      raw: unknown;
    }
  | { error: string; ok: false }
> {
  const result = await runFalRequest(
    "audio",
    process.env.FAL_VOICE_DESIGN_ENDPOINT || "fal-ai/elevenlabs/text-to-voice/design/eleven-v3",
    {
      prompt: input.prompt,
      ...(input.text ? { text: input.text } : { auto_generate_text: true }),
    },
  );
  if (!result.ok) return { error: result.error || "Voice design failed.", ok: false };
  const raw = (result.raw ?? {}) as Record<string, unknown>;
  const rawPreviews = Array.isArray(raw.previews)
    ? (raw.previews as Array<Record<string, unknown>>)
    : [];
  const previews = rawPreviews
    .map((preview) => {
      const voiceId =
        (typeof preview.voice_id === "string" && preview.voice_id) ||
        (typeof preview.generated_voice_id === "string" && preview.generated_voice_id) ||
        null;
      const audio = preview.audio as Record<string, unknown> | undefined;
      const url =
        (typeof preview.url === "string" && preview.url) ||
        (audio && typeof audio.url === "string" && audio.url) ||
        null;
      const audioBase64 =
        (typeof preview.audio_base_64 === "string" && preview.audio_base_64) ||
        (typeof preview.audio_base64 === "string" && preview.audio_base64) ||
        null;
      return voiceId ? { audioBase64, url, voiceId } : null;
    })
    .filter((preview): preview is NonNullable<typeof preview> => preview !== null);
  if (!previews.length) {
    return { error: "Voice design returned no usable previews.", ok: false };
  }
  return { ok: true, previews, raw: result.raw };
}

/** ElevenLabs music generation via fal (FAL_MUSIC_ENDPOINT overridable). */
export async function generateFalMusic(input: {
  durationSeconds?: number;
  prompt: string;
}) {
  const payload: Record<string, unknown> = { prompt: input.prompt };
  if (input.durationSeconds) {
    payload.music_length_ms = Math.round(input.durationSeconds * 1000);
  }
  return runFalRequest("audio", process.env.FAL_MUSIC_ENDPOINT || "fal-ai/elevenlabs/music", payload);
}

/**
 * Extract a single frame from a video URL via ffmpeg. `seconds` may be
 * negative to seek from the end (e.g. -0.1 for the final frame).
 */
export async function extractVideoFrame(input: {
  videoUrl: string;
  seconds: number;
}): Promise<{ ok: true; buffer: Buffer } | { ok: false; error: string }> {
  if (isFFmpegLambdaConfigured() && /^https?:\/\//i.test(input.videoUrl)) {
    const remote = await extractFrameRemote({
      videoUrl: input.videoUrl,
      timestamp: Math.abs(input.seconds),
      fromEnd: input.seconds < 0,
    });
    if (!remote.success || !remote.outputUrl) {
      return { ok: false, error: remote.error || "ffmpeg frame extraction failed." };
    }
    try {
      const response = await fetch(remote.outputUrl);
      if (!response.ok) {
        return { ok: false, error: `Failed to fetch extracted frame (${response.status}).` };
      }
      return { ok: true, buffer: Buffer.from(await response.arrayBuffer()) };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "Failed to fetch extracted frame.",
      };
    }
  }
  const workDir = await mkdtemp(path.join(tmpdir(), "vfs-frame-"));
  const outputPath = path.join(workDir, "frame.png");
  try {
    // For seek-from-end, container duration can exceed the video stream's end
    // (audio tail), so a tight -sseof can land past the last frame. Seek well
    // back and let -update overwrite until the true final frame remains.
    const args =
      input.seconds < 0
        ? [
            "-sseof",
            String(Math.min(input.seconds, -0.5)),
            "-i",
            input.videoUrl,
            "-update",
            "1",
            "-q:v",
            "2",
            "-y",
            outputPath,
          ]
        : [
            "-ss",
            String(input.seconds),
            "-i",
            input.videoUrl,
            "-frames:v",
            "1",
            "-q:v",
            "2",
            "-y",
            outputPath,
          ];
    await execFileAsync("ffmpeg", args, { timeout: 60_000 });
    return { ok: true, buffer: await readFile(outputPath) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `ffmpeg frame extraction failed: ${error.message}`
          : "ffmpeg frame extraction failed.",
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Prepare a local clip for Seedance reference-to-video input. The endpoint
 * caps reference videos at ~720p-equivalent area and 15s combined duration,
 * so oversized or overlong clips are scaled/tail-trimmed (the ending carries
 * the continuity, so the tail is what an extension needs to see).
 */
export async function prepareClipForExtension(input: {
  localPath: string;
  maxSeconds?: number;
}): Promise<{ ok: true; buffer: Buffer } | { ok: false; error: string }> {
  const maxSeconds = input.maxSeconds ?? 14;
  const workDir = await mkdtemp(path.join(tmpdir(), "vfs-extend-"));
  const outputPath = path.join(workDir, "extend-input.mp4");
  try {
    const probe = await execFileAsync(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height:format=duration",
        "-of", "json",
        input.localPath,
      ],
      { timeout: 30_000 },
    );
    const parsed = JSON.parse(probe.stdout) as {
      format?: { duration?: string };
      streams?: Array<{ height?: number; width?: number }>;
    };
    const duration = Number(parsed.format?.duration ?? 0);
    const width = parsed.streams?.[0]?.width ?? 0;
    const height = parsed.streams?.[0]?.height ?? 0;
    // ~720p-equivalent pixel-area ceiling per fal's schema (834x1112).
    const tooLarge = width * height > 834 * 1112;
    const tooLong = duration > maxSeconds;
    if (!tooLarge && !tooLong) {
      return { ok: true, buffer: await readFile(input.localPath) };
    }
    // Re-encode in both cases: stream-copy after -sseof snaps to a prior
    // keyframe and can exceed the duration cap.
    const args = ["-i", input.localPath];
    if (tooLong) args.unshift("-sseof", String(-maxSeconds));
    if (tooLarge) {
      args.push(
        "-vf",
        "scale='min(1280,iw)':-2:force_original_aspect_ratio=decrease",
      );
    }
    args.push(
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac",
      "-y", outputPath,
    );
    await execFileAsync("ffmpeg", args, { timeout: 120_000 });
    return { ok: true, buffer: await readFile(outputPath) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `Extension input preparation failed: ${error.message}`
          : "Extension input preparation failed.",
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Host a buffer on Fal storage so later generation calls can reference it by URL. */
export async function uploadToFalStorage(
  buffer: Buffer,
  fileName: string,
  contentType = "image/png",
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const useDesktopCloud =
    isLocalAppMode() &&
    (await getGenerationMode()) === "credits";
  if (useDesktopCloud) {
    try {
      const initiate = await desktopCloudFetch("/api/desktop/fal/upload", {
        body: JSON.stringify({ contentType, fileName, size: buffer.byteLength }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const result = (await initiate.json().catch(() => ({}))) as {
        error?: string;
        uploadUrl?: string;
        url?: string;
      };
      if (!initiate.ok || !result.uploadUrl || !result.url) {
        return {
          error: result.error || `Could not initiate fal storage upload (${initiate.status}).`,
          ok: false,
        };
      }
      const uploaded = await fetch(result.uploadUrl, {
        body: new Uint8Array(buffer),
        headers: { "content-type": contentType },
        method: "PUT",
      });
      if (!uploaded.ok) {
        return { error: `Fal storage upload failed (${uploaded.status}).`, ok: false };
      }
      return { ok: true, url: result.url };
    } catch (caught) {
      return {
        error: caught instanceof Error ? caught.message : "Fal storage upload failed.",
        ok: false,
      };
    }
  }
  let credentials: string | null;
  try {
    credentials = await getFalKey();
  } catch {
    return { ok: false, error: "Could not read API settings. Open Account → API keys to replace or remove the saved key." };
  }
  if (!credentials) return { ok: false, error: isLocalAppMode() ? MISSING_FAL_KEY : "FAL_KEY is not configured." };
  try {
    const fal = createFalClient({ credentials });
    const file = new File([new Uint8Array(buffer)], fileName, { type: contentType });
    const url = await fal.storage.upload(file);
    return { ok: true, url };
  } catch (error) {
    return {
      ok: false,
      error: describeFalError(error, "storage upload", credentials),
    };
  }
}

/** Center-crop an image buffer to EXACTLY the given aspect ratio. Image
 * models' "16:9" is often approximate (e.g. 1376x768 = 1.792); feeding such a
 * frame as a pinned endpoint makes the video drift through a subtle squeeze.
 * No-op when already within 0.2%. */
export async function cropImageToAspect(input: Buffer, aspectRatio: string): Promise<Buffer> {
  const [awRaw, ahRaw] = aspectRatio.split(/[:/]/).map((part) => Number(part.trim()));
  if (!awRaw || !ahRaw || !Number.isFinite(awRaw) || !Number.isFinite(ahRaw)) return input;
  const target = awRaw / ahRaw;
  const { mkdtemp, readFile: readTemp, rm, writeFile: writeTemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const workDir = await mkdtemp(path.join(tmpdir(), "vfs-crop-"));
  try {
    const inPath = path.join(workDir, "in.png");
    const outPath = path.join(workDir, "out.png");
    await writeTemp(inPath, input);
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0",
      inPath,
    ]);
    const [width, height] = stdout.trim().split(",").map(Number);
    if (!width || !height) return input;
    const actual = width / height;
    if (Math.abs(actual - target) / target < 0.002) return input;
    let cropW = width;
    let cropH = height;
    if (actual > target) cropW = Math.round((height * target) / 2) * 2;
    else cropH = Math.round(width / target / 2) * 2;
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", inPath,
      "-vf", `crop=${cropW}:${cropH}`,
      "-frames:v", "1",
      "-y", outPath,
    ]);
    return await readTemp(outPath);
  } catch {
    return input;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
