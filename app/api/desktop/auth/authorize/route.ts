import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isLocalAppMode } from "@/lib/app-mode";
import {
  assertDesktopAuthState,
  assertDesktopPkceChallenge,
  createDesktopAuthorizationCode,
} from "@/lib/desktop-auth-code";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (isLocalAppMode()) {
    return NextResponse.json({ error: "Desktop authorization is unavailable." }, { status: 404 });
  }
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin && origin !== requestOrigin) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const { sessionId, userId } = await auth();
  if (!sessionId || !userId) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  try {
    const body = (await request.json()) as { challenge?: unknown; state?: unknown };
    const code = createDesktopAuthorizationCode({
      challenge: assertDesktopPkceChallenge(body.challenge),
      sessionId,
      state: assertDesktopAuthState(body.state),
      userId,
    });
    return NextResponse.json({ code });
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : "Invalid desktop authorization request.";
    return NextResponse.json({ error }, { status: 400 });
  }
}
