"use client";

import { useSyncExternalStore } from "react";

export type UserMessageNotificationItem = {
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

type UserMessageNotificationsState = {
  hasLoaded: boolean;
  hasUnread: boolean;
  items: UserMessageNotificationItem[];
};

const listeners = new Set<() => void>();

let state: UserMessageNotificationsState = {
  hasLoaded: false,
  hasUnread: false,
  items: [],
};

let loadPromise: Promise<void> | null = null;

function emitChange() {
  listeners.forEach((listener) => listener());
}

function setState(nextState: UserMessageNotificationsState) {
  state = nextState;
  emitChange();
}

function applySnapshot(items: UserMessageNotificationItem[]) {
  setState({
    hasLoaded: true,
    hasUnread: items.some((item) => !item.isRead),
    items,
  });
}

export function subscribeToUserMessageNotifications(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getUserMessageNotificationsSnapshot() {
  return state;
}

export function useUserMessageNotifications() {
  return useSyncExternalStore(
    subscribeToUserMessageNotifications,
    getUserMessageNotificationsSnapshot,
    getUserMessageNotificationsSnapshot,
  );
}

export async function loadUserMessageNotifications() {
  if (typeof window === "undefined") return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const response = await fetch("/api/notifications/messages", { cache: "no-store" });
    if (response.status === 401) {
      applySnapshot([]);
      return;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `Notifications load failed (${response.status})`);
    }
    const body = (await response.json()) as { messages?: UserMessageNotificationItem[] };
    applySnapshot(Array.isArray(body.messages) ? body.messages : []);
  })().finally(() => {
    loadPromise = null;
  });

  return loadPromise;
}

export async function markUserMessageNotificationsRead(messageIds?: string[]) {
  const ids =
    messageIds?.filter((value): value is string => Boolean(value)) ??
    state.items.filter((item) => !item.isRead).map((item) => item.id);
  if (!ids.length) return;

  const readAt = new Date().toISOString();
  setState({
    ...state,
    hasUnread: false,
    items: state.items.map((item) =>
      ids.includes(item.id)
        ? {
            ...item,
            isRead: true,
            readAt: item.readAt ?? readAt,
          }
        : item,
    ),
  });

  const response = await fetch("/api/notifications/messages", {
    body: JSON.stringify({ ids }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  if (!response.ok && response.status !== 401) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Notifications read failed (${response.status})`);
  }
}
