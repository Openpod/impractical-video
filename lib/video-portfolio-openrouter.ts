import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildVideoPortfolioPrompt,
  parseGeminiVideoPortfolioJson,
  type VideoPortfolioExtraction,
} from "@/lib/video-portfolio-pipeline";

/**
 * OpenRouter analyzer for video-portfolio extraction. Reuses the app's existing
 * OPENROUTER_API_KEY instead of provisioning a separate GEMINI_API_KEY.
 *
 * Unlike the native @google/genai path (which uploads via the Files API),
 * OpenRouter takes the video inline as a base64 `video_url` data URL on the
 * standard chat-completions endpoint. That caps practical input size at
 * Gemini's inline limit (~100MB pre-base64), which is ample for the Explore /
 * ai_video_entries library (clips are single-digit to low-double-digit MB).
 *
 * Provider note: OpenRouter -> Google AI Studio only accepts YouTube links for
 * video, while the Vertex route accepts base64 data URLs. We therefore pin the
 * provider to a base64-capable one by default (overridable via
 * OPENROUTER_VIDEO_PROVIDER, comma-separated; empty string disables pinning).
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export const DEFAULT_VIDEO_PORTFOLIO_OPENROUTER_MODEL = "google/gemini-3-flash-preview";

function mimeTypeForPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".m4v") return "video/x-m4v";
  return "video/mp4";
}

function resolveProviderRouting(): { order: string[]; allow_fallbacks: boolean } | undefined {
  const raw = process.env.OPENROUTER_VIDEO_PROVIDER;
  // Explicit empty string disables pinning entirely.
  if (raw === "") return undefined;
  const order = (raw ?? "google-vertex")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (order.length === 0) return undefined;
  return { order, allow_fallbacks: true };
}

export async function analyzeVideoWithOpenRouter(input: {
  videoPath: string;
  apiKey?: string;
  model?: string;
  maxEntities?: number;
  maxPointsPerEntity?: number;
}): Promise<VideoPortfolioExtraction> {
  const apiKey = input.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required for the OpenRouter video analyzer.");
  }

  const model =
    input.model ?? process.env.GEMINI_VIDEO_PORTFOLIO_OPENROUTER_MODEL ?? DEFAULT_VIDEO_PORTFOLIO_OPENROUTER_MODEL;
  const prompt = buildVideoPortfolioPrompt({
    maxEntities: input.maxEntities ?? 24,
    maxPointsPerEntity: input.maxPointsPerEntity ?? 9,
  });

  const bytes = await readFile(input.videoPath);
  const dataUrl = `data:${mimeTypeForPath(input.videoPath)};base64,${bytes.toString("base64")}`;

  const provider = resolveProviderRouting();
  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "video_url", video_url: { url: dataUrl } },
        ],
      },
    ],
    response_format: { type: "json_object" },
    max_tokens: 16384,
  };
  if (provider) body.provider = provider;

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter video analysis failed (${response.status} ${response.statusText}): ${detail.slice(0, 500)}`,
    );
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    error?: { message?: string };
  };
  if (json.error) throw new Error(`OpenRouter error: ${json.error.message ?? "unknown"}`);

  const content = json.choices?.[0]?.message?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "",
          )
          .join("")
      : "";
  if (!text.trim()) {
    throw new Error("OpenRouter returned an empty response for video analysis.");
  }

  return parseGeminiVideoPortfolioJson(text);
}
