import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { createLibraryFolder } from "@/lib/library";
import { isLocalAppMode } from "@/lib/app-mode";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (isLocalAppMode()) {
    return NextResponse.json(
      { error: "Local library folders are not available yet. Assets remain organized by project." },
      { status: 409 },
    );
  }
  try {
    const user = await ensureCurrentAppUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to organize your library." }, { status: 401 });
    }
    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown;
      parentFolderId?: unknown;
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "A folder name is required." }, { status: 400 });
    }
    const parentFolderId = typeof body.parentFolderId === "string" ? body.parentFolderId : null;
    const folder = await createLibraryFolder({ name, ownerUserId: user.userId, parentFolderId });
    return NextResponse.json({ folder });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Failed to create folder.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
