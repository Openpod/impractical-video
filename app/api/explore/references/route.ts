import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { listPublishedItems } from "@/lib/published-items";
import { isLocalAppMode } from "@/lib/app-mode";
import { listLocalCatalogItems } from "@/lib/local-catalog";
import { listPublicCatalogItems } from "@/lib/public-catalog";

export const dynamic = "force-dynamic";

const REFERENCE_LIMIT_PER_KIND = 120;
const CACHE_HEADERS = {
  "Cache-Control": "no-store",
};

export async function GET() {
  if (isLocalAppMode()) {
    const localItems = await listLocalCatalogItems({
        includeReferences: true,
        includeVideos: false,
      }).catch(() => []);
    try {
      const items = await listPublicCatalogItems("/api/explore/references");
      return NextResponse.json(
        { availability: "online", items, localItems },
        { headers: CACHE_HEADERS },
      );
    } catch {
      return NextResponse.json(
        {
          availability: "unavailable",
          error: "The canonical Explore catalog is unavailable. Showing assets on this device.",
          items: [],
          localItems,
        },
        { headers: CACHE_HEADERS },
      );
    }
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json(
      {
        availability: "unavailable",
        error: "The public Explore catalog is unavailable in this deployment.",
        items: [],
      },
      { headers: CACHE_HEADERS, status: 503 },
    );
  }
  try {
    const user = await ensureCurrentAppUser().catch(() => null);
    const currentUserId = user?.userId ?? null;
    const [characters, environments, props, styles, features] = await Promise.all([
      listPublishedItems({ currentUserId, kind: "character", limit: REFERENCE_LIMIT_PER_KIND }),
      listPublishedItems({ currentUserId, kind: "environment", limit: REFERENCE_LIMIT_PER_KIND }),
      listPublishedItems({ currentUserId, kind: "prop", limit: REFERENCE_LIMIT_PER_KIND }),
      listPublishedItems({ currentUserId, kind: "style", limit: REFERENCE_LIMIT_PER_KIND }),
      listPublishedItems({ currentUserId, kind: "feature", limit: REFERENCE_LIMIT_PER_KIND }),
    ]);

    return NextResponse.json({
      availability: "online",
      items: [...characters, ...environments, ...props, ...styles, ...features],
    }, { headers: CACHE_HEADERS });
  } catch (caught) {
    return NextResponse.json(
      {
        availability: "unavailable",
        error: "The public Explore catalog is temporarily unavailable.",
        items: [],
      },
      { headers: CACHE_HEADERS, status: 503 },
    );
  }
}
