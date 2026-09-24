import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { importItemIntoProject } from "@/lib/publish-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await ensureCurrentAppUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to use published items." }, { status: 401 });
    }
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { projectId?: unknown };
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) {
      return NextResponse.json({ error: "A target projectId is required." }, { status: 400 });
    }
    const result = await importItemIntoProject({ itemId: id, targetProjectId: projectId, userId: user.userId });
    return NextResponse.json(result);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Failed to use published item.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
