import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { deleteOwnedItem, setItemPlacement } from "@/lib/library";
import { getPublishedItem } from "@/lib/published-items";
import { createServerClient } from "@/lib/supabase";
import { isLocalAppMode } from "@/lib/app-mode";
import { deleteLocalLibraryUpload, renameLocalLibraryUpload, LOCAL_LIBRARY_PREFIX, LocalLibraryError } from "@/lib/local-library";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (isLocalAppMode()) {
    const { id } = await params;
    if (id.startsWith(LOCAL_LIBRARY_PREFIX)) {
      try { await deleteLocalLibraryUpload(id); return NextResponse.json({ ok: true }); }
      catch (error) { return NextResponse.json({ error: error instanceof LocalLibraryError ? error.message : "Could not remove this asset." }, { status: error instanceof LocalLibraryError ? error.status : 500 }); }
    }
    return NextResponse.json(
      { error: "Edit or remove local assets from their project workspace." },
      { status: 409 },
    );
  }
  try {
    const user = await ensureCurrentAppUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to manage your library." }, { status: 401 });
    }
    const { id } = await params;
    await deleteOwnedItem({ itemId: id, ownerUserId: user.userId });
    return NextResponse.json({ ok: true });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Failed to delete item.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (isLocalAppMode()) {
    const { id } = await params;
    if (id.startsWith(LOCAL_LIBRARY_PREFIX)) {
      const body = await request.json().catch(() => null);
      if (typeof body?.title !== "string") return NextResponse.json({ error: "A name is required." }, { status: 400 });
      try { return NextResponse.json({ ok: true, item: await renameLocalLibraryUpload(id, body.title) }); }
      catch (error) { return NextResponse.json({ error: error instanceof LocalLibraryError ? error.message : "Could not rename this asset." }, { status: error instanceof LocalLibraryError ? error.status : 500 }); }
    }
    return NextResponse.json(
      { error: "Edit local assets from their project workspace." },
      { status: 409 },
    );
  }
  try {
    const user = await ensureCurrentAppUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to manage your library." }, { status: 401 });
    }
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const libraryStatus = typeof body.libraryStatus === "string" ? body.libraryStatus : null;
    const folderId = typeof body.folderId === "string" && body.folderId ? body.folderId : null;
    const title = typeof body.title === "string" ? body.title.trim() : null;
    if (libraryStatus && libraryStatus !== "saved") {
      return NextResponse.json({ error: "Unsupported item update." }, { status: 400 });
    }
    if (!libraryStatus && !title) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const supabase = createServerClient();
    const { data: item, error: readError } = await supabase
      .from("published_items")
      .select("id,metadata")
      .eq("publisher_id", user.userId)
      .eq("id", id)
      .maybeSingle();
    if (readError) throw new Error(`Failed to read item: ${readError.message}`);
    if (!item) return NextResponse.json({ error: "Item not found." }, { status: 404 });

    const metadata = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
      ? item.metadata as Record<string, unknown>
      : {};
    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (title) update.title = title;
    if (libraryStatus === "saved") {
      update.metadata = {
        ...metadata,
        library_status: "saved",
      };
      update.visibility = "unlisted";
    }
    const { error: updateError } = await supabase
      .from("published_items")
      .update(update)
      .eq("publisher_id", user.userId)
      .eq("id", id);
    if (updateError) throw new Error(`Failed to update item: ${updateError.message}`);

    if (libraryStatus === "saved") {
      await setItemPlacement({ folderId, itemId: id, ownerUserId: user.userId });
    }
    const updatedItem = await getPublishedItem(id, user.userId);
    return NextResponse.json({ item: updatedItem, ok: true });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Failed to update item.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
