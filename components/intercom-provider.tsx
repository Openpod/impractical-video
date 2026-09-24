"use client";

import { useEffect, useMemo, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useAppAuth } from "@/lib/app-auth";
import { buildIntercomSettings, getIntercomAppId, type IntercomSettings } from "@/lib/intercom";

type IntercomCommand = "boot" | "shutdown" | "show" | "showSpace" | "update";

type IntercomFn = (command: IntercomCommand, ...args: unknown[]) => void;

declare global {
  interface Window {
    Intercom?: IntercomFn & {
      q?: unknown[][];
    };
    __intercomLoaderPromise__?: Promise<void>;
    intercomSettings?: IntercomSettings;
  }
}

function loadIntercom(appId: string): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Intercom requires a browser environment."));
  }

  if (window.__intercomLoaderPromise__) {
    return window.__intercomLoaderPromise__;
  }

  window.__intercomLoaderPromise__ = new Promise<void>((resolve, reject) => {
    if (typeof window.Intercom === "function" && !window.Intercom.q) {
      resolve();
      return;
    }

    if (typeof window.Intercom !== "function") {
      const intercomStub = ((...args: unknown[]) => {
        intercomStub.q = intercomStub.q ?? [];
        intercomStub.q.push(args);
      }) as IntercomFn & {
        q?: unknown[][];
      };
      intercomStub.q = [];
      window.Intercom = intercomStub;
    }

    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[data-intercom-loader="true"]`,
    );

    const handleReady = () => resolve();
    const handleError = () => reject(new Error("Failed to load Intercom."));

    if (existingScript) {
      existingScript.addEventListener("load", handleReady, { once: true });
      existingScript.addEventListener("error", handleError, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.async = true;
    script.src = `https://widget.intercom.io/widget/${appId}`;
    script.dataset.intercomLoader = "true";
    script.onload = handleReady;
    script.onerror = handleError;
    document.head.appendChild(script);
  });

  return window.__intercomLoaderPromise__;
}

export function showIntercomSupport() {
  if (typeof window === "undefined" || typeof window.Intercom !== "function") {
    return false;
  }

  window.Intercom("show");
  return true;
}

export function IntercomProvider() {
  const { isLoaded, isLocal, isSignedIn, user } = useAppAuth();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const bootedUserIdRef = useRef<string | null>(null);
  const appId = getIntercomAppId();
  const currentUrl = useMemo(() => {
    const query = searchParams.toString();
    return query ? `${pathname}?${query}` : pathname;
  }, [pathname, searchParams]);

  useEffect(() => {
    if (isLocal || !appId || !isLoaded) {
      return;
    }

    if (!isSignedIn || !user) {
      if (bootedUserIdRef.current && typeof window.Intercom === "function") {
        window.Intercom("shutdown");
      }
      bootedUserIdRef.current = null;
      return;
    }

    let cancelled = false;
    const settings = buildIntercomSettings(appId, {
      createdAt: user.createdAt,
      email: user.email,
      name: user.fullName || user.firstName || user.username || null,
      userId: user.id,
    });

    window.intercomSettings = settings;

    void loadIntercom(appId)
      .then(() => {
        if (cancelled || typeof window.Intercom !== "function") {
          return;
        }

        if (bootedUserIdRef.current !== user.id) {
          if (bootedUserIdRef.current) {
            window.Intercom("shutdown");
          }
          window.Intercom("boot", settings);
          bootedUserIdRef.current = user.id;
          return;
        }

        window.Intercom("update", settings);
      })
      .catch((error: unknown) => {
        console.error("[Intercom] bootstrap failed", error);
      });

    return () => {
      cancelled = true;
    };
  }, [appId, isLoaded, isLocal, isSignedIn, user]);

  useEffect(() => {
    if (
      isLocal ||
      !appId ||
      !isLoaded ||
      !isSignedIn ||
      !user ||
      !bootedUserIdRef.current ||
      typeof window.Intercom !== "function"
    ) {
      return;
    }

    window.Intercom("update");
  }, [appId, currentUrl, isLoaded, isLocal, isSignedIn, user]);

  return null;
}
