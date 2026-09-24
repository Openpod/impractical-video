import { createServerClient } from "@/lib/supabase";

export type UserMessageRecord = {
  action_label: string | null;
  action_payload: Record<string, unknown> | null;
  action_type: string | null;
  audience_type: "all_users" | string;
  created_at: string;
  expires_at: string | null;
  external_url: string | null;
  id: string;
  published_at: string;
  status: "archived" | "draft" | "published" | string;
  subtext: string | null;
  thumbnail_url: string | null;
  title: string;
  updated_at: string;
};

export type UserMessageDeliveryRecord = {
  action_completed_at: string | null;
  action_result: Record<string, unknown> | null;
  created_at: string;
  id: string;
  message_id: string;
  read_at: string | null;
  updated_at: string;
  user_id: string;
};

export type UserMessageItem = {
  actionCompletedAt: string | null;
  actionLabel: string | null;
  actionPayload: Record<string, unknown> | null;
  actionResult: Record<string, unknown> | null;
  actionType: string | null;
  externalUrl: string | null;
  id: string;
  isRead: boolean;
  publishedAt: string;
  readAt: string | null;
  subtext: string | null;
  thumbnailUrl: string | null;
  title: string;
  updatedAt: string;
};

const USER_MESSAGE_SELECT =
  "id, audience_type, status, title, subtext, thumbnail_url, external_url, action_type, action_label, action_payload, published_at, expires_at, created_at, updated_at";
const USER_MESSAGE_DELIVERY_SELECT =
  "id, message_id, user_id, read_at, action_completed_at, action_result, created_at, updated_at";

function normalizeObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isActiveMessage(row: Pick<UserMessageRecord, "expires_at" | "published_at" | "status">) {
  if (row.status !== "published") return false;
  const now = Date.now();
  const publishedAt = new Date(row.published_at).getTime();
  if (Number.isFinite(publishedAt) && publishedAt > now) return false;
  if (!row.expires_at) return true;
  const expiresAt = new Date(row.expires_at).getTime();
  return !Number.isFinite(expiresAt) || expiresAt > now;
}

export function isMissingUserMessagesSchemaError(error: {
  code?: string;
  details?: string;
  hint?: string;
  message?: string;
} | null) {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "42703" || error.code === "PGRST204") return true;
  const message = `${error.message || ""} ${error.details || ""} ${error.hint || ""}`.toLowerCase().trim();
  return (
    (message.includes("user_messages") || message.includes("user_message_deliveries")) &&
    (message.includes("does not exist") ||
      message.includes("could not find") ||
      message.includes("schema cache") ||
      message.includes("column"))
  );
}

function toUserMessageItem(row: UserMessageRecord, delivery?: UserMessageDeliveryRecord | null): UserMessageItem {
  return {
    actionCompletedAt: delivery?.action_completed_at ?? null,
    actionLabel: row.action_label,
    actionPayload: normalizeObject(row.action_payload),
    actionResult: normalizeObject(delivery?.action_result),
    actionType: row.action_type,
    externalUrl: row.external_url,
    id: row.id,
    isRead: Boolean(delivery?.read_at),
    publishedAt: row.published_at,
    readAt: delivery?.read_at ?? null,
    subtext: row.subtext,
    thumbnailUrl: row.thumbnail_url,
    title: row.title,
    updatedAt: row.updated_at,
  };
}

export async function listUserMessagesForUser(userId: string) {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("user_messages")
    .select(USER_MESSAGE_SELECT)
    .eq("audience_type", "all_users")
    .order("published_at", { ascending: false });

  if (error) return { data: null, error };

  const messageRows = Array.isArray(data) ? (data as UserMessageRecord[]).filter(isActiveMessage) : [];
  if (!messageRows.length) return { data: [] as UserMessageItem[], error: null };

  const { data: deliveries, error: deliveryError } = await supabase
    .from("user_message_deliveries")
    .select(USER_MESSAGE_DELIVERY_SELECT)
    .eq("user_id", userId)
    .in(
      "message_id",
      messageRows.map((row) => row.id),
    );

  if (deliveryError) return { data: null, error: deliveryError };

  const deliveryMap = new Map(
    ((deliveries as UserMessageDeliveryRecord[] | null) ?? []).map((row) => [row.message_id, row]),
  );

  return {
    data: messageRows.map((row) => toUserMessageItem(row, deliveryMap.get(row.id))),
    error: null,
  };
}

export async function markUserMessagesRead(userId: string, messageIds: string[]) {
  if (!messageIds.length) return { error: null };
  const supabase = createServerClient();
  const readAt = new Date().toISOString();
  const rows = messageIds.map((messageId) => ({
    message_id: messageId,
    read_at: readAt,
    user_id: userId,
  }));

  const { error } = await supabase.from("user_message_deliveries").upsert(rows, {
    onConflict: "message_id,user_id",
  });

  return { error };
}
