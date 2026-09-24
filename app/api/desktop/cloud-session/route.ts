import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { isLocalAppMode } from "@/lib/app-mode";
import {
  clearDesktopCloudSessionToken,
  cloneCloudResponse,
  desktopCloudAppUrl,
  getDesktopCloudSessionRefreshToken,
  hasDesktopCloudSession,
  refreshDesktopCloudSession,
  restoreDesktopCloudSession,
  setDesktopCloudSessionToken,
} from "@/lib/desktop-cloud";

export const dynamic = "force-dynamic";

function unavailable() {
  return NextResponse.json({ error: "Desktop cloud sessions are unavailable." }, { status: 404 });
}

function hasDesktopProcessAuthorization(request: Request): boolean {
  const expected = process.env.PAPER_MCP_TOKEN?.trim() || "";
  const provided = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  if (!expected || !provided) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

export async function GET() {
  if (!isLocalAppMode()) return unavailable();
  return NextResponse.json({ connected: hasDesktopCloudSession() });
}

export async function POST(request: Request) {
  if (!isLocalAppMode()) return unavailable();
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

  try {
    // Validate the short-lived Clerk token against the hosted boundary before
    // retaining it in the local process. The hosted app remains the authority.
    const response = await fetch(`${desktopCloudAppUrl()}/api/credits`, {
      cache: "no-store",
      headers: {
        authorization: `Bearer ${token}`,
        "x-video-fs-client": "desktop",
      },
    });
    if (!response.ok) return cloneCloudResponse(response);
    setDesktopCloudSessionToken(token);
    return NextResponse.json({ connected: true });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not connect the desktop session.";
    return NextResponse.json({ error: message }, { status: 401 });
  }
}

export async function DELETE() {
  if (!isLocalAppMode()) return unavailable();
  clearDesktopCloudSessionToken();
  return NextResponse.json({ connected: false });
}

export async function PUT() {
  if (!isLocalAppMode()) return unavailable();
  try {
    const connected = await refreshDesktopCloudSession();
    return NextResponse.json({ connected }, { status: connected ? 200 : 401 });
  } catch {
    return NextResponse.json(
      { connected: false, error: "The account service could not be reached." },
      { status: 503 },
    );
  }
}

/** Electron-main-only bridge for OS-encrypted session persistence. The
 * renderer never receives the refresh credential or the process bearer. */
export async function PATCH(request: Request) {
  if (!isLocalAppMode()) return unavailable();
  if (!hasDesktopProcessAuthorization(request)) {
    return NextResponse.json({ error: "Desktop process authorization is required." }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as
    | { action?: unknown; refreshToken?: unknown }
    | null;
  if (body?.action === "export") {
    const refreshToken = getDesktopCloudSessionRefreshToken();
    if (!refreshToken) {
      return NextResponse.json({ error: "No renewable desktop session exists." }, { status: 404 });
    }
    return NextResponse.json({ refreshToken });
  }
  if (body?.action === "restore" && typeof body.refreshToken === "string") {
    try {
      const connected = await restoreDesktopCloudSession(body.refreshToken);
      return NextResponse.json({ connected }, { status: connected ? 200 : 401 });
    } catch {
      return NextResponse.json(
        { connected: false, error: "The account service could not be reached." },
        { status: 503 },
      );
    }
  }
  return NextResponse.json({ error: "Unsupported desktop session action." }, { status: 400 });
}
