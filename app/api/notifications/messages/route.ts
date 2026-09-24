import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import {
  isMissingUserMessagesSchemaError,
  listUserMessagesForUser,
  markUserMessagesRead,
} from "@/lib/user-messages";
import { isLocalAppMode } from "@/lib/app-mode";

export const dynamic = "force-dynamic";

function getObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export async function GET() {
  if (isLocalAppMode()) {
    return NextResponse.json({ success: true, messages: [] });
  }
  const user = await ensureCurrentAppUser().catch(() => null);
  if (!user?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await listUserMessagesForUser(user.userId);
  if (error) {
    if (isMissingUserMessagesSchemaError(error)) {
      return NextResponse.json({ success: true, messages: [] });
    }
    console.error("[GET /api/notifications/messages] Failed:", error);
    return NextResponse.json({ error: "Failed to fetch notifications." }, { status: 500 });
  }

  return NextResponse.json({ success: true, messages: data ?? [] });
}

export async function PATCH(request: Request) {
  if (isLocalAppMode()) {
    return NextResponse.json({ success: true });
  }
  const user = await ensureCurrentAppUser().catch(() => null);
  if (!user?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const payload = getObject(body);
  const ids = getStringArray(payload?.ids);
  if (!ids.length) {
    return NextResponse.json({ error: "Missing message ids." }, { status: 400 });
  }

  const { error } = await markUserMessagesRead(user.userId, ids);
  if (error) {
    if (isMissingUserMessagesSchemaError(error)) {
      return NextResponse.json({ success: true });
    }
    console.error("[PATCH /api/notifications/messages] Failed:", error);
    return NextResponse.json({ error: "Failed to mark notifications read." }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
