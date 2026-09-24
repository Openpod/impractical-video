import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { getPublishedItem } from "@/lib/published-items";
import { isLocalAppMode } from "@/lib/app-mode";
import { getLocalCatalogItem } from "@/lib/local-catalog";
import { getPublicCatalogItem } from "@/lib/public-catalog";

export const dynamic = "force-dynamic";

/**
 * Detail fetch for the Explore modal. Public by default — auth only personalizes
 * `isLiked`. Returns the full PublishedItemDetail (files + media + metadata) for
 * real published items and `ai-video-` ids. Temporary client-side stub items
 * (ids starting with `temp-`) have no DB row, so the client renders those from
 * the summary it already holds and must not call this route.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (isLocalAppMode() && id.startsWith("local:")) {
      const item = await getLocalCatalogItem(id);
      if (!item) {
        return NextResponse.json({ error: "Local item not found." }, { status: 404 });
      }
      return NextResponse.json(item);
    }
    if (isLocalAppMode()) {
      try {
        return NextResponse.json(await getPublicCatalogItem(id));
      } catch {
        return NextResponse.json(
          { error: "The canonical Explore catalog is unavailable." },
          { status: 503 },
        );
      }
    }
    const user = await ensureCurrentAppUser().catch(() => null);
    const item = await getPublishedItem(id, user?.userId ?? null);
    if (!item) {
      return NextResponse.json({ error: "Published item not found." }, { status: 404 });
    }
    return NextResponse.json(item);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Failed to read published item.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
