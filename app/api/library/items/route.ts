import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { listOwnedPublishedItems } from "@/lib/published-items";
import { isLocalAppMode } from "@/lib/app-mode";
import { listLocalCatalogItems } from "@/lib/local-catalog";
import { listLocalLibraryUploads } from "@/lib/local-library";

export const dynamic = "force-dynamic";

const LIBRARY_LIMIT = 500;
const CACHE_HEADERS = {
  "Cache-Control": "no-store",
};

export async function GET() {
  try {
    if (isLocalAppMode()) {
      const [uploads, projectItems] = await Promise.all([listLocalLibraryUploads(), listLocalCatalogItems({ limit: LIBRARY_LIMIT })]);
      return NextResponse.json(
        {
          availability: "online",
          items: [],
          localItems: [...uploads, ...projectItems].slice(0, LIBRARY_LIMIT),
        },
        { headers: CACHE_HEADERS },
      );
    }
    const user = await ensureCurrentAppUser().catch(() => null);
    if (!user?.userId) {
      return NextResponse.json(
        { availability: "auth-required", error: "Sign in to view your private library." },
        { headers: CACHE_HEADERS, status: 401 },
      );
    }
    const items = await listOwnedPublishedItems({
      currentUserId: user.userId,
      limit: LIBRARY_LIMIT,
    });
    return NextResponse.json({ availability: "online", items }, { headers: CACHE_HEADERS });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Failed to load library items.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
