import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { togglePublishedItemLike } from "@/lib/published-items";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await ensureCurrentAppUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to like published items." }, { status: 401 });
    }
    const { id } = await params;
    const result = await togglePublishedItemLike(id, user.userId);
    return NextResponse.json(result);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Failed to update like.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
