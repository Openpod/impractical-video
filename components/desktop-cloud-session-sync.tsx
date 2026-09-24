"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect } from "react";
import { refreshCredits } from "@/lib/credit-context";
import { isBillingUiEnabled, isLocalAppModeClient } from "@/lib/app-mode";

const REFRESH_INTERVAL_MS = 45_000;

/** Keeps a short-lived Clerk token in the packaged local Next process. The
 * token is held in memory only and lets local filesystem/MCP requests call the
 * authenticated hosted billing and generation boundary. */
export function DesktopCloudSessionSync() {
  if (isLocalAppModeClient()) return <DesktopLocalSessionKeepalive />;
  if (!isBillingUiEnabled()) return null;
  return <HostedDesktopCloudSessionSync />;
}

function DesktopLocalSessionKeepalive() {
  useEffect(() => {
    let canceled = false;
    const refresh = async () => {
      const settings = await fetch("/api/settings/generation", { cache: "no-store" }).then(response => response.json()).catch(() => null);
      if (settings?.mode !== "credits" || !settings.connected || canceled) return;
      const response = await fetch("/api/desktop/cloud-session", { method: "PUT" }).catch(() => null);
      if (!canceled && response?.ok) {
        refreshCredits();
        window.dispatchEvent(new Event("video-fs:desktop-session-changed"));
        await window.videoFsDesktopEnvironment?.authSessionConnected?.();
      } else if (!canceled && response?.status === 401) {
        await window.videoFsDesktopEnvironment?.authSessionCleared?.();
      }
    };
    const interval = window.setInterval(() => void refresh(), 8 * 60_000);
    window.addEventListener("focus", refresh);
    return () => {
      canceled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return null;
}

function HostedDesktopCloudSessionSync() {
  const { getToken, isLoaded, isSignedIn } = useAuth();

  useEffect(() => {
    if (!isLoaded) return;
    let canceled = false;

    const clear = async () => {
      await fetch("/api/desktop/cloud-session", { method: "DELETE" }).catch(() => {});
    };
    const sync = async () => {
      if (!isSignedIn) {
        await clear();
        return;
      }
      const token = await getToken().catch(() => null);
      if (!token || canceled) return;
      const response = await fetch("/api/desktop/cloud-session", {
        headers: { authorization: `Bearer ${token}` },
        method: "POST",
      }).catch(() => null);
      if (!canceled && response?.ok) refreshCredits();
    };

    void sync();
    const interval = window.setInterval(() => void sync(), REFRESH_INTERVAL_MS);
    const onFocus = () => void sync();
    window.addEventListener("focus", onFocus);
    return () => {
      canceled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [getToken, isLoaded, isSignedIn]);

  return null;
}
