import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isLocalAppMode } from "@/lib/app-mode";
import {
  createDesktopRefreshCode,
  verifyDesktopRefreshCode,
} from "@/lib/desktop-auth-code";

export const dynamic = "force-dynamic";

const SESSION_TOKEN_TTL_SECONDS = 10 * 60;

export async function POST(request: Request) {
  if (isLocalAppMode()) {
    return NextResponse.json({ error: "Desktop session refresh is unavailable." }, { status: 404 });
  }
  try {
    const body = (await request.json()) as { refreshToken?: unknown };
    const payload = verifyDesktopRefreshCode(body.refreshToken);
    const client = await clerkClient();
    const session = await client.sessions.getSession(payload.sessionId);
    if (session.status !== "active" || session.userId !== payload.userId) {
      return NextResponse.json({ error: "The desktop session is no longer active." }, { status: 401 });
    }
    const token = await client.sessions.getToken(
      payload.sessionId,
      undefined,
      SESSION_TOKEN_TTL_SECONDS,
    );
    return NextResponse.json({
      refreshToken: createDesktopRefreshCode(payload),
      token: token.jwt,
    });
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : "Desktop session refresh failed.";
    return NextResponse.json({ error }, { status: 401 });
  }
}
