import type { PublishedItemDetail, PublishedItemSummary } from "@/lib/published-items";

export const DEFAULT_PUBLIC_CATALOG_BASE_URL = "https://chat.impractical.ai";

type PublicCatalogListResponse = {
  items: PublishedItemSummary[];
};

function catalogBaseUrl() {
  const raw =
    process.env.VIDEO_FS_PUBLIC_CATALOG_URL?.trim() ||
    DEFAULT_PUBLIC_CATALOG_BASE_URL;
  const url = new URL(raw);
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !isLoopback) {
    throw new Error("The public catalog endpoint must use HTTPS.");
  }
  return url;
}

async function catalogRequest<T>(path: string): Promise<T> {
  const url = new URL(path, catalogBaseUrl());
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    // Callers sit on navigation paths and fall back to local items; a slow
    // or offline network must never hold the app hostage for long.
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    throw new Error(`Public catalog request failed (${response.status}).`);
  }
  return body as T;
}

export async function listPublicCatalogItems(path: string) {
  const body = await catalogRequest<PublicCatalogListResponse>(path);
  return Array.isArray(body.items) ? body.items : [];
}

export async function getPublicCatalogItem(itemId: string) {
  return catalogRequest<PublishedItemDetail>(
    `/api/published-items/${encodeURIComponent(itemId)}`,
  );
}
