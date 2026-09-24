import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { listWorkflowSummaries } from "@/lib/workflows";

// Built-in workflow recipes for the composer's Workflows menu.

export async function GET() {
  const user = await ensureCurrentAppUser();
  if (!user) return NextResponse.json({ error: "Sign in." }, { status: 401 });
  return NextResponse.json({ workflows: await listWorkflowSummaries() });
}
