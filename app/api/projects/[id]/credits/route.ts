import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { createServerClient } from "@/lib/supabase";
import {
  listProjectFiles,
  parseJsonFrontmatter,
  readProjectMeta,
  signedWorkspaceMediaUrl,
} from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** Ledger rows carry tool ids and op metadata — turn them into plain words:
 * what the task was, and what it produced. */
function humanizeLedgerRow(row: Record<string, unknown>, type: string) {
  const tool = typeof row.tool_name === "string" ? row.tool_name : "";
  const description = typeof row.description === "string" ? row.description : "";
  const metadata =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  const op =
    metadata.op && typeof metadata.op === "object" && !Array.isArray(metadata.op)
      ? (metadata.op as Record<string, unknown>)
      : {};

  if (type === "refund") {
    return { detail: "Credits returned", task: "Task refunded" };
  }
  if (type !== "usage") {
    return { detail: "", task: "Credits added" };
  }

  const kind = typeof op.kind === "string" ? op.kind : "";
  const seconds = typeof op.seconds === "number" ? op.seconds : null;
  const resolution = typeof op.resolution === "string" ? op.resolution : null;
  const characters = typeof op.characters === "number" ? op.characters : null;
  const minutes = typeof op.minutes === "number" ? op.minutes : null;

  const detail =
    kind === "clip"
      ? `Video clip${seconds ? ` · ${seconds}s` : ""}`
      : kind === "portfolio"
        ? "Reference sheet + profile image"
        : kind === "image"
          ? `Image${resolution ? ` · ${resolution}` : ""}`
          : kind === "speech"
            ? `Voice audio${characters ? ` · ${characters} characters` : ""}`
            : kind === "music"
              ? `Music${minutes ? ` · ${Math.round(minutes * 10) / 10} min` : ""}`
              : "";

  const bare = tool.replace(/^composer\./, "").replace(/^regenerate\./, "");
  const task = /designvoice/i.test(bare)
    ? "Designed a voice"
    : /portfolio/i.test(bare)
      ? "Created a reference"
      : /keyframe/i.test(bare)
        ? "Generated a keyframe"
        : /editstill|editimage/i.test(bare)
          ? "Edited an image"
          : /image/i.test(bare)
            ? "Generated an image"
            : /speech/i.test(bare)
              ? "Generated speech"
              : /music/i.test(bare)
                ? "Generated music"
                : /youtubeimport/i.test(bare)
                  ? "Imported a YouTube shot"
                  : /video|clip/i.test(bare)
                    ? "Generated a video clip"
                    : /frame/i.test(bare)
                      ? "Extracted a frame"
                      : description.replace(/\s*\([0-9a-f-]{8,}\)\s*$/i, "") || "Generation";
  return { detail, task };
}

/** The project's credit ledger, newest first — charges, refunds, grants. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await ensureCurrentAppUser();
    if (!user) return NextResponse.json({ error: "Sign in." }, { status: 401 });
    const { id } = await params;
    // Ownership: the ledger + file scan below must be gated to the owner.
    await readProjectMeta(id, user.userId);
    const supabase = createServerClient();
    // Two queries, merged: rows properly stamped with project_id, plus legacy
    // rows that only carry the project id inside the description. (A single
    // .or() can't express the second — parentheses in ilike patterns break
    // PostgREST's or-parser.)
    const [stamped, legacy] = await Promise.all([
      supabase
        .from("credit_transactions")
        .select("*")
        .eq("user_id", user.userId)
        .eq("project_id", id)
        .order("created_at", { ascending: false })
        .limit(60),
      supabase
        .from("credit_transactions")
        .select("*")
        .eq("user_id", user.userId)
        .ilike("description", `%${id}%`)
        .order("created_at", { ascending: false })
        .limit(60),
    ]);
    if (stamped.error) throw new Error(stamped.error.message);
    if (legacy.error) throw new Error(legacy.error.message);
    // Remote generation URLs expire (fal retention, signed-URL TTLs) but the
    // bytes live in the workspace forever. Workspace files record the source
    // url beside their local_path — build that map so every thumbnail can be
    // re-signed fresh on each read, permanently.
    const urlToPath = new Map<string, string>();
    try {
      const files = await listProjectFiles(id, true);
      for (const file of files) {
        if (!file.path.endsWith(".md") || !file.content) continue;
        const parsed = parseJsonFrontmatter(file.content);
        const register = (url: unknown, localPath: unknown) => {
          if (typeof url === "string" && url && typeof localPath === "string" && localPath) {
            urlToPath.set(url, localPath);
          }
        };
        register(parsed.meta.url, parsed.meta.local_path);
        if (Array.isArray(parsed.meta.versions)) {
          for (const version of parsed.meta.versions) {
            if (version && typeof version === "object") {
              const entry = version as Record<string, unknown>;
              register(entry.url, entry.local_path);
            }
          }
        }
      }
    } catch {
      // Thumbnails degrade to stored URLs / kind icons if the scan fails.
    }
    const seen = new Set<string>();
    const rows = [...(stamped.data ?? []), ...(legacy.data ?? [])]
      .filter((row: Record<string, unknown>) => {
        const rowId = String(row.id ?? "");
        if (seen.has(rowId)) return false;
        seen.add(rowId);
        return true;
      })
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
        String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
      )
      .slice(0, 60);
    const transactions = await Promise.all(rows.map(async (row: Record<string, unknown>) => {
      const amount = Number(row.amount) || 0;
      const type = typeof row.type === "string" ? row.type : "usage";
      const { detail, task } = humanizeLedgerRow(row, type);
      const metadata =
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {};
      const op =
        metadata.op && typeof metadata.op === "object" && !Array.isArray(metadata.op)
          ? (metadata.op as Record<string, unknown>)
          : {};
      // Thumbnail: a workspace path re-signs fresh every read; a remote URL
      // is used as-is (may eventually expire — the client falls back).
      const artifact =
        metadata.artifact && typeof metadata.artifact === "object" && !Array.isArray(metadata.artifact)
          ? (metadata.artifact as Record<string, unknown>)
          : null;
      let thumb: string | null = null;
      if (artifact) {
        const url = typeof artifact.url === "string" ? artifact.url : null;
        const path =
          (typeof artifact.path === "string" && artifact.path) ||
          (url ? (urlToPath.get(url) ?? null) : null);
        if (path) thumb = await signedWorkspaceMediaUrl(id, path).catch(() => null);
        if (!thumb && url) thumb = url;
      }
      return {
        amount,
        at: typeof row.created_at === "string" ? row.created_at : null,
        detail,
        id: String(row.id ?? `${row.created_at}-${amount}`),
        kind: typeof op.kind === "string" ? op.kind : type === "refund" ? "refund" : "other",
        task,
        thumb,
        type,
      };
    }));
    return NextResponse.json({ transactions });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Failed to load transactions.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
