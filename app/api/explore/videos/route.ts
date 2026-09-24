import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { listPublishedItems } from "@/lib/published-items";
import { isLocalAppMode } from "@/lib/app-mode";
import { listLocalCatalogItems } from "@/lib/local-catalog";
import { listPublicCatalogItems } from "@/lib/public-catalog";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 96;
const MAX_LIMIT = 160;
const CACHE_HEADERS = {
  "Cache-Control": "private, max-age=30",
};

function limitFromRequest(request: Request) {
  const raw = new URL(request.url).searchParams.get("limit");
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

export async function GET(request: Request) {
  if (isLocalAppMode()) {
    const limit = limitFromRequest(request);
    const localItems = await listLocalCatalogItems({
        includeReferences: false,
        includeVideos: true,
        limit,
      }).catch(() => []);
    try {
      const items = await listPublicCatalogItems(`/api/explore/videos?limit=${limit}`);
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
    const items = await listPublishedItems({
      currentUserId: user?.userId ?? null,
      kind: "video",
      limit: limitFromRequest(request),
    });
    return NextResponse.json({ availability: "online", items }, { headers: CACHE_HEADERS });
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
