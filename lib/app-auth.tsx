"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import {
  useCallback,
  createContext,
  useEffect,
  useContext,
  useState,
  type ReactNode,
} from "react";
import {
  isLocalAppModeClient,
  LOCAL_APP_USER_ID,
} from "@/lib/app-mode";

export type AppAuthUser = {
  createdAt: Date | null;
  email: string | null;
  firstName: string | null;
  fullName: string | null;
  id: string;
  imageUrl: string | null;
  username: string | null;
};

export type AppAuthValue = {
  isLoaded: boolean;
  isLocal: boolean;
  isSignedIn: boolean;
  openUserProfile: () => void;
  signOut: (input?: { redirectUrl?: string }) => Promise<void>;
  user: AppAuthUser | null;
};

const LOCAL_AUTH: AppAuthValue = {
  isLoaded: true,
  isLocal: true,
  isSignedIn: true,
  openUserProfile: () => {
    window.open("https://chat.impractical.ai", "_blank", "noopener,noreferrer");
  },
  signOut: async (input) => {
    await fetch("/api/desktop/cloud-session", { method: "DELETE" }).catch(() => {});
    await window.videoFsDesktopEnvironment?.authSessionCleared?.();
    window.location.assign(input?.redirectUrl || "/");
  },
  user: {
    createdAt: null,
    email: null,
    firstName: "Local",
    fullName: "Local workspace",
    id: LOCAL_APP_USER_ID,
    imageUrl: null,
    username: "local",
  },
};

const AppAuthContext = createContext<AppAuthValue | null>(null);

function isDesktopAccountUser(value: unknown): value is AppAuthUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Partial<AppAuthUser>;
  return typeof user.id === "string" && user.id.length > 0;
}

function DesktopAppAuthBridge({ children }: { children: ReactNode }) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [user, setUser] = useState<AppAuthUser | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/desktop/account", { cache: "no-store" }).catch(() => null);
    const body = response
      ? ((await response.json().catch(() => null)) as { user?: unknown } | null)
      : null;
    if (response?.ok && isDesktopAccountUser(body?.user)) {
      const account = body.user as AppAuthUser & { createdAt?: unknown };
      setUser({
        ...account,
        createdAt:
          typeof account.createdAt === "string" && account.createdAt
            ? new Date(account.createdAt)
            : null,
      });
    } else if (response?.status === 401) {
      setUser(null);
    }
    setIsLoaded(true);
  }, []);

  useEffect(() => {
    const onSessionChange = () => void refresh();
    const initial = window.setTimeout(onSessionChange, 0);
    const interval = window.setInterval(onSessionChange, 60_000);
    window.addEventListener("focus", onSessionChange);
    window.addEventListener("video-fs:desktop-session-changed", onSessionChange);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      window.removeEventListener("focus", onSessionChange);
      window.removeEventListener("video-fs:desktop-session-changed", onSessionChange);
    };
  }, [refresh]);

  return (
    <AppAuthContext.Provider
      value={{
        isLoaded,
        isLocal: true,
        isSignedIn: true,
        openUserProfile: () => {
          window.open("https://chat.impractical.ai", "_blank", "noopener,noreferrer");
        },
        signOut: async (input) => {
          await fetch("/api/desktop/cloud-session", { method: "DELETE" }).catch(() => {});
          await window.videoFsDesktopEnvironment?.authSessionCleared?.();
          setUser(null);
          window.location.assign(input?.redirectUrl || "/");
        },
        user: user || LOCAL_AUTH.user,
      }}
    >
      {children}
    </AppAuthContext.Provider>
  );
}

function HostedAppAuthBridge({
  children,
  isLocal = false,
}: {
  children: ReactNode;
  isLocal?: boolean;
}) {
  const { openUserProfile, signOut } = useClerk();
  const { isLoaded, isSignedIn, user } = useUser();
  const normalizedUser: AppAuthUser | null = user
    ? {
        createdAt: user.createdAt ?? null,
        email: user.primaryEmailAddress?.emailAddress ?? null,
        firstName: user.firstName,
        fullName: user.fullName,
        id: user.id,
        imageUrl: user.imageUrl ?? null,
        username: user.username,
      }
    : null;

  return (
    <AppAuthContext.Provider
      value={{
        isLoaded,
        isLocal,
        isSignedIn: Boolean(isSignedIn),
        openUserProfile,
        signOut: async (input) => {
          await signOut(input);
        },
        user: normalizedUser,
      }}
    >
      {children}
    </AppAuthContext.Provider>
  );
}

export function AppAuthProvider({ children }: { children: ReactNode }) {
  if (isLocalAppModeClient()) {
    return <DesktopAppAuthBridge>{children}</DesktopAppAuthBridge>;
  }
  return <HostedAppAuthBridge>{children}</HostedAppAuthBridge>;
}

export function useAppAuth(): AppAuthValue {
  const value = useContext(AppAuthContext);
  if (!value) {
    throw new Error("useAppAuth must be used inside AppAuthProvider.");
  }
  return value;
}
