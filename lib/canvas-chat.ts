// Canvas-originated requests are logged to chat as compact entries: a marker
// line with small JSON metadata, then the user's written instruction. The
// annotation geometry and media payloads deliberately stay out of the chat log.

export type CanvasChatRequestMeta = {
  kind: "compose" | "draw" | "edit" | "section" | "track";
  title: string;
  /** Clip-section requests: editor element + source-time span the user marked. */
  element_id?: string;
  in_seconds?: number;
  media_id?: string | null;
  out_seconds?: number;
};

const CANVAS_REQUEST_PREFIX = "[[canvas-request]]";

export function formatCanvasChatRequest(meta: CanvasChatRequestMeta, instruction: string) {
  return `${CANVAS_REQUEST_PREFIX} ${JSON.stringify(meta)}\n${instruction.trim()}`.trimEnd();
}

export function parseCanvasChatRequest(
  text: string,
): { instruction: string; meta: CanvasChatRequestMeta } | null {
  if (!text.startsWith(CANVAS_REQUEST_PREFIX)) return null;
  const newline = text.indexOf("\n");
  const metaRaw = (newline === -1 ? text.slice(CANVAS_REQUEST_PREFIX.length) : text.slice(CANVAS_REQUEST_PREFIX.length, newline)).trim();
  try {
    const meta = JSON.parse(metaRaw) as CanvasChatRequestMeta;
    if (!meta || typeof meta !== "object" || typeof meta.title !== "string") return null;
    const kind =
      meta.kind === "draw" || meta.kind === "track" || meta.kind === "compose" || meta.kind === "section"
        ? meta.kind
        : "edit";
    return {
      instruction: newline === -1 ? "" : text.slice(newline + 1).trim(),
      meta: { kind, title: meta.title },
    };
  } catch {
    return null;
  }
}

export function canvasChatRequestLabel(meta: CanvasChatRequestMeta) {
  if (meta.kind === "track") return "Track object";
  if (meta.kind === "draw") return "Marked edit";
  if (meta.kind === "compose") return "Canvas task";
  if (meta.kind === "section") return "Fix section";
  return "Edit";
}
