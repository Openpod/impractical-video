import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isLocalAppMode } from "@/lib/app-mode";
import {
  createDesktopRefreshCode,
  verifyDesktopAuthorizationCode,
} from "@/lib/desktop-auth-code";

export const dynamic = "force-dynamic";

const SESSION_TOKEN_TTL_SECONDS = 10 * 60;

export async function POST(request: Request) {
  if (isLocalAppMode()) {
    return NextResponse.json({ error: "Desktop token exchange is unavailable." }, { status: 404 });
  }
  try {
    const body = (await request.json()) as { code?: unknown; verifier?: unknown };
    const payload = verifyDesktopAuthorizationCode(body.code, body.verifier);
    const client = await clerkClient();
    const session = await client.sessions.getSession(payload.sessionId);
    if (session.status !== "active" || session.userId !== payload.userId) {
      return NextResponse.json({ error: "The signed-in session is no longer active." }, { status: 401 });
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
    const error = caught instanceof Error ? caught.message : "Desktop token exchange failed.";
    return NextResponse.json({ error }, { status: 401 });
  }
}
