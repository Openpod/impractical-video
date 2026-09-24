import { NextResponse } from "next/server";
import { isLocalAppMode } from "@/lib/app-mode";
import { interruptCompanionSession } from "@/lib/companion-session";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Aborts the companion session's in-flight turn (Esc-equivalent). */
export async function POST(_request: Request, { params }: Params) {
  if (!isLocalAppMode(process.env)) {
    return NextResponse.json(
      { error: "The companion chat is desktop-only." },
      { status: 404 },
    );
  }
  const { id } = await params;
  return NextResponse.json(await interruptCompanionSession(id));
}
