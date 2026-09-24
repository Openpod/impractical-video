import "server-only";

import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { renameProject } from "@/lib/workspace";

const DEFAULT_NAMES = new Set(["", "untitled video", "untitled", "new project"]);

/** Only auto-name projects still on a placeholder title. */
export function isDefaultProjectName(name: string): boolean {
  return DEFAULT_NAMES.has(name.trim().toLowerCase());
}

function heuristicName(query: string): string {
  const cleaned = query.trim().replace(/\s+/g, " ");
  if (!cleaned) return "Untitled video";
  return cleaned.length > 48 ? `${cleaned.slice(0, 45).trimEnd()}…` : cleaned;
}

/**
 * Name a freshly-created project after the user's first query. Tries a short LLM
 * title (2–5 words) and falls back to a cleaned truncation. Best-effort and
 * non-blocking: a failure leaves the placeholder name untouched.
 */
export async function autonameProjectFromQuery(input: {
  projectId: string;
  query: string;
  currentName: string;
  userId?: string | null;
}): Promise<void> {
  if (!isDefaultProjectName(input.currentName)) return;
  const query = input.query.trim();
  if (!query) return;

  let title = "";
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (apiKey) {
    try {
      const openrouter = createOpenRouter({ apiKey });
      const model =
        process.env.VIDEO_FS_AUTONAME_MODEL ||
        process.env.VIDEO_FS_AGENT_MODEL ||
        "openai/gpt-5.3-codex";
      const { text } = await generateText({
        model: openrouter.chat(model),
        system:
          "Generate a concise, specific project title (2–5 words, Title Case) for a video project from the user's request. No surrounding quotes, no trailing punctuation. Return ONLY the title.",
        prompt: query.slice(0, 500),
      });
      title = text
        .trim()
        .split("\n")[0]
        .replace(/^["'#\s]+|["'\s]+$/g, "")
        .slice(0, 64);
    } catch {
      title = "";
    }
  }
  if (!title) title = heuristicName(query);

  await renameProject(input.projectId, title, input.userId ?? null).catch(() => {});
}
