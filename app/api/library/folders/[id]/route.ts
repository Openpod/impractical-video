import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { deleteLibraryFolder, moveLibraryFolder, renameLibraryFolder } from "@/lib/library";
import { isLocalAppMode } from "@/lib/app-mode";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown;
      parentFolderId?: unknown;
    };

    if (typeof body.name === "string") {
      const folder = await renameLibraryFolder({ folderId: id, name: body.name, ownerUserId: user.userId });
      return NextResponse.json({ folder });
    }
    if ("parentFolderId" in body) {
      const parentFolderId =
        typeof body.parentFolderId === "string" ? body.parentFolderId : null;
      const folder = await moveLibraryFolder({ folderId: id, ownerUserId: user.userId, parentFolderId });
      return NextResponse.json({ folder });
    }
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Failed to update folder.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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
    const { id } = await params;
    await deleteLibraryFolder({ folderId: id, ownerUserId: user.userId });
    return NextResponse.json({ ok: true });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Failed to delete folder.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
