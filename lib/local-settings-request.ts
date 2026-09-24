import { isLocalAppMode } from "@/lib/app-mode";

export function localSettingsGuard(request: Request) {
  const deny = (error: string, status: number) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
  if (!isLocalAppMode()) return deny("Local API settings are unavailable.", 404);
  try {
    const url = new URL(request.url);
    const target = new URL(`${url.protocol}//${request.headers.get("host") || url.host}`);
    const origin = request.headers.get("origin");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
        (origin && origin !== target.origin) || request.headers.get("sec-fetch-site") === "cross-site") {
      return deny("Settings are available only from the local app.", 403);
    }
  } catch { return deny("Invalid local host.", 403); }
  return null;
}
