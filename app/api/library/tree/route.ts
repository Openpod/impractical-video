import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { loadLibraryTree } from "@/lib/library";
import { isLocalAppMode } from "@/lib/app-mode";
import { listLocalCatalogItems } from "@/lib/local-catalog";
import { listLocalLibraryUploads } from "@/lib/local-library";

export const dynamic = "force-dynamic";

const CACHE_HEADERS = {
  "Cache-Control": "no-store",
};

export async function GET() {
  try {
    if (isLocalAppMode()) {
      const [uploads, projectItems] = await Promise.all([listLocalLibraryUploads(), listLocalCatalogItems()]);
      return NextResponse.json(
        {
          availability: "online",
          folders: [],
          items: [],
          localItems: [...uploads, ...projectItems],
          placements: [],
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
    const tree = await loadLibraryTree(user.userId);
    return NextResponse.json({ availability: "online", ...tree }, { headers: CACHE_HEADERS });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Failed to load library.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
