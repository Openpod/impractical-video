import { NextResponse } from "next/server";
import { isLocalAppMode } from "@/lib/app-mode";
import { startDesktopAuthAttempt } from "@/lib/desktop-auth-attempt";

export const dynamic = "force-dynamic";

export async function POST() {
  if (!isLocalAppMode()) {
    return NextResponse.json({ error: "Desktop auth is unavailable." }, { status: 404 });
  }
  try {
    return NextResponse.json({ url: startDesktopAuthAttempt() });
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : "Could not start desktop sign-in.";
    return NextResponse.json({ error }, { status: 500 });
  }
}
