import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { setItemPlacement } from "@/lib/library";
import { isLocalAppMode } from "@/lib/app-mode";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (isLocalAppMode()) {
    return NextResponse.json(
      { error: "Local assets remain organized by project." },
      { status: 409 },
    );
  }
  try {
    const user = await ensureCurrentAppUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to organize your library." }, { status: 401 });
    }
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { folderId?: unknown };
    const folderId = typeof body.folderId === "string" && body.folderId ? body.folderId : null;
    await setItemPlacement({ folderId, itemId: id, ownerUserId: user.userId });
    return NextResponse.json({ ok: true });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Failed to move item.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
