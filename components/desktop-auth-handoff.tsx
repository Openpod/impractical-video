"use client";

import { useAuth } from "@clerk/nextjs";
import { Copy, ExternalLink, Loader2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AuthFlow, type AuthOAuthStrategy } from "@/components/auth/auth-flow";
import { DotField } from "@/components/dot-field";
import { DESKTOP_PORT_END, DESKTOP_PORT_START } from "@/lib/desktop-origins";

type HandoffParameters = {
  callback: string;
  challenge: string;
  state: string;
};

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    if (!copied) throw new Error("Could not copy sign-in link.");
  }
}

function DesktopAuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="desktop-auth-gate desktop-auth-hosted">
      <span aria-hidden className="desktop-auth-gate-dragbar" />
      <DotField className="desktop-auth-gate-dots" ink="#ffffff" />
      <div className="desktop-auth-flow">{children}</div>
    </main>
  );
}

function parametersFromSearch(params: URLSearchParams): HandoffParameters | null {
  const callback = params.get("callback") || "";
  const challenge = params.get("challenge") || "";
  const state = params.get("state") || "";
  try {
    const url = new URL(callback);
    const port = Number(url.port);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      port < DESKTOP_PORT_START ||
      port > DESKTOP_PORT_END ||
      url.pathname !== "/api/desktop/auth/callback" ||
      url.search ||
      url.hash ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(state)
    ) {
      return null;
    }
    return { callback: url.href, challenge, state };
  } catch {
    return null;
  }
}

export function DesktopAuthHandoff() {
  const searchParams = useSearchParams();
  const { isLoaded, isSignedIn } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [retry, setRetry] = useState(0);
  const startedRef = useRef(false);
  const parameters = useMemo(
    () => parametersFromSearch(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  const returnUrl = parameters
    ? `/desktop-auth?${new URLSearchParams(parameters).toString()}`
    : "/desktop-auth";
  const surface = searchParams.get("surface");
  const embedded = surface === "desktop";
  const method = searchParams.get("method");
  const initialOAuthStrategy: AuthOAuthStrategy | undefined =
    surface === "browser" && method === "google"
      ? "oauth_google"
      : surface === "browser" && method === "github"
        ? "oauth_github"
        : undefined;
  const browserFallbackUrl = useMemo(
    () => {
      if (!parameters) return null;
      const query = new URLSearchParams(parameters);
      query.set("surface", "browser");
      return `/desktop-auth?${query.toString()}`;
    },
    [parameters],
  );

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !parameters || startedRef.current) return;
    let canceled = false;
    startedRef.current = true;
    setConnecting(true);
    void (async () => {
      const response = await fetch("/api/desktop/auth/authorize", {
        body: JSON.stringify({
          challenge: parameters.challenge,
          state: parameters.state,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }).catch(() => null);
      const body = response
        ? ((await response.json().catch(() => null)) as { code?: unknown; error?: unknown } | null)
        : null;
      if (canceled) return;
      if (!response?.ok || typeof body?.code !== "string") {
        startedRef.current = false;
        setConnecting(false);
        setError(typeof body?.error === "string" ? body.error : "Could not connect the desktop app.");
        return;
      }
      const callback = new URL(parameters.callback);
      callback.searchParams.set("code", body.code);
      callback.searchParams.set("state", parameters.state);
      window.location.assign(callback.href);
    })();
    return () => {
      canceled = true;
    };
  }, [isLoaded, isSignedIn, parameters, retry]);

  if (!parameters) {
    return (
      <DesktopAuthShell>
        <div className="auth-card">
          <h1 className="auth-title">Open sign-in from Video FS</h1>
          <p className="auth-error">This desktop sign-in link is invalid or expired.</p>
        </div>
      </DesktopAuthShell>
    );
  }
  if (!isLoaded || isSignedIn) {
    return (
      <DesktopAuthShell>
        <div className="auth-card auth-loading" role="status">
          {error ? (
            <>
              <span>{error}</span>
              <button
                className="auth-submit"
                onClick={() => {
                  startedRef.current = false;
                  setError(null);
                  setRetry((value) => value + 1);
                }}
                type="button"
              >
                Try again
              </button>
            </>
          ) : (
            <>
              <Loader2 className="spin" size={18} />
              <span>{connecting ? "Connecting your desktop app…" : "Checking your session…"}</span>
            </>
          )}
        </div>
      </DesktopAuthShell>
    );
  }
  return (
    <DesktopAuthShell>
      <AuthFlow
        forceHosted
        initialOAuthStrategy={initialOAuthStrategy}
        mode="sign-in"
        redirectUrl={returnUrl}
      />
      {embedded && browserFallbackUrl ? (
        <div className="desktop-auth-fallback">
          <span>Having trouble?</span>
          <button
            onClick={() => {
              window.open(
                new URL(browserFallbackUrl, window.location.origin).href,
                "_blank",
                "noopener,noreferrer",
              );
            }}
            type="button"
          >
            <ExternalLink size={13} />
            Open in browser
          </button>
          <button
            onClick={() => {
              const value = new URL(browserFallbackUrl, window.location.origin).href;
              void copyText(value)
                .then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2_000);
                })
                .catch(() => setCopied(false));
            }}
            type="button"
          >
            <Copy size={13} />
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      ) : null}
    </DesktopAuthShell>
  );
}
