import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { publishItem } from "@/lib/publish-service";

export const dynamic = "force-dynamic";

const KINDS = new Set(["character", "environment", "prop", "style"]);
const VISIBILITIES = new Set(["draft", "unlisted", "public", "featured"]);

export async function POST(request: Request) {
  try {
    const user = await ensureCurrentAppUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to publish." }, { status: 401 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const sourceProjectId = typeof body.sourceProjectId === "string" ? body.sourceProjectId.trim() : "";
    const kind = typeof body.kind === "string" ? body.kind : "";
    const sourceNodeId = typeof body.sourceNodeId === "string" ? body.sourceNodeId.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!sourceProjectId || !sourceNodeId || !title || !KINDS.has(kind)) {
      return NextResponse.json(
        { error: "sourceProjectId, sourceNodeId, title, and a valid kind (character|environment|prop|style) are required." },
        { status: 400 },
      );
    }
    const visibility =
      typeof body.visibility === "string" && VISIBILITIES.has(body.visibility)
        ? (body.visibility as "draft" | "unlisted" | "public" | "featured")
        : "draft";
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === "string")
      : [];

    const result = await publishItem({
      sourceProjectId,
      kind: kind as "character" | "environment" | "prop" | "style",
      sourceNodeId,
      publisherId: user.userId,
      title,
      description: typeof body.description === "string" ? body.description : null,
      tags,
      visibility,
    });
    return NextResponse.json(result);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Failed to publish item.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
