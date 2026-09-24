import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { listActiveProjectIdsForUser } from "@/lib/agent-runs";
import { isLocalAppMode, LOCAL_APP_USER_ID } from "@/lib/app-mode";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = isLocalAppMode() ? LOCAL_APP_USER_ID : (await auth()).userId;
  const projectIds = await listActiveProjectIdsForUser(userId);
  return NextResponse.json({ projectIds: Array.from(projectIds) });
}
