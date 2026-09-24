"use client";

import { Loader2 } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ImpracticalLogo } from "@/app/impractical-logo";
import { DotField } from "@/components/dot-field";
import { isBillingUiEnabled, isLocalAppModeClient } from "@/lib/app-mode";

/** Desktop account gate. Production Clerk never runs on the loopback app
 * origin; this gate starts a short-lived PKCE handoff on the hosted domain
 * and watches the local session boundary for completion. */

export function DesktopAuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [isDesktop, setIsDesktop] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    // Desktop-only: the hosted web app gates through its own sign-in pages,
    // and the companion window rides the main window's session.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsDesktop(Boolean(window.videoFsDesktopEnvironment?.platform));
    setChecked(true);
  }, []);

  if (
    isLocalAppModeClient() ||
    !isBillingUiEnabled() ||
    (checked && !isDesktop) ||
    pathname.startsWith("/companion")
  ) {
    return <>{children}</>;
  }
  if (!checked) return null;
  return <DesktopHostedSessionGate>{children}</DesktopHostedSessionGate>;
}

function DesktopHostedSessionGate({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attemptedRef = useRef(false);

  const checkSession = useCallback(async () => {
    const response = await fetch("/api/desktop/cloud-session", { cache: "no-store" }).catch(() => null);
    const body = response
      ? ((await response.json().catch(() => null)) as { connected?: unknown } | null)
      : null;
    const next = response?.ok && body?.connected === true;
    setConnected(Boolean(next));
    return Boolean(next);
  }, []);

  useEffect(() => {
    let canceled = false;
    const check = async () => {
      if (canceled) return;
      await checkSession();
    };
    void check();
    const interval = window.setInterval(() => void check(), 1_250);
    window.addEventListener("focus", check);
    return () => {
      canceled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", check);
    };
  }, [checkSession]);

  useEffect(() => {
    if (!connected) return;
    window.dispatchEvent(new Event("video-fs:desktop-session-changed"));
    void window.videoFsDesktopEnvironment?.authSessionConnected?.();
  }, [connected]);

  const startSignIn = useCallback(async () => {
    attemptedRef.current = true;
    setStarting(true);
    setError(null);
    const response = await fetch("/api/desktop/auth/start", { method: "POST" }).catch(() => null);
    const body = response
      ? ((await response.json().catch(() => null)) as { error?: unknown; url?: unknown } | null)
      : null;
    if (!response?.ok || typeof body?.url !== "string") {
      setStarting(false);
      setError(typeof body?.error === "string" ? body.error : "Could not open sign-in.");
      return;
    }
    const authUrl = new URL(body.url);
    authUrl.searchParams.set("surface", "desktop");
    window.open(authUrl.href, "_blank", "noopener,noreferrer");
    setStarting(false);
  }, []);

  useEffect(() => {
    if (connected !== false || attemptedRef.current) return;
    void startSignIn();
  }, [connected, startSignIn]);

  if (connected) return <>{children}</>;

  return (
    <div aria-modal className="desktop-auth-gate" role="dialog">
      <span aria-hidden className="desktop-auth-gate-dragbar" />
      <DotField className="desktop-auth-gate-dots" ink="#ffffff" />
      <div className="desktop-auth-flow desktop-auth-handoff-card">
        <span className="auth-logo" aria-hidden="true">
          <ImpracticalLogo />
        </span>
        <h1 className="auth-title">Make anything.</h1>
        <p className="desktop-auth-handoff-copy">
          Sign in to sync your credits and projects across devices.
        </p>
        <button
          className="auth-submit"
          disabled={starting || connected === null}
          onClick={() => void startSignIn()}
          type="button"
        >
          {starting || connected === null ? <Loader2 className="spin" size={16} /> : null}
          <span>{starting || connected === null ? "Opening sign in…" : error ? "Try again" : "Open sign in"}</span>
        </button>
        {error ? <p className="auth-error">{error}</p> : null}
      </div>
    </div>
  );
}
