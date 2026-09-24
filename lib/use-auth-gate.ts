"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { useAppAuth } from "@/lib/app-auth";

/**
 * The single gate for create-intent actions on public surfaces (home, explore).
 * Signed-out users can browse, but the moment they try to create — type in the
 * composer, add to a project, hit start/use — we send them to the app's own
 * sign-up page (with a redirect back to where they were).
 */
export function useAuthGate() {
  const { isLoaded, isSignedIn } = useAppAuth();
  const router = useRouter();

  const promptSignUp = useCallback(() => {
    const returnTo =
      typeof window !== "undefined" ? `${window.location.pathname}${window.location.search}` : "/";
    router.push(`/sign-up?redirect_url=${encodeURIComponent(returnTo)}`);
  }, [router]);

  /**
   * Returns true when the caller may proceed (signed in). When signed out it
   * opens the sign-up modal and returns false, so guards read as:
   * `if (!requireAuth()) return;`. While Clerk is still loading it no-ops
   * rather than risk a false prompt on a signed-in user.
   */
  const requireAuth = useCallback((): boolean => {
    if (isSignedIn) return true;
    if (!isLoaded) return false;
    promptSignUp();
    return false;
  }, [isLoaded, isSignedIn, promptSignUp]);

  return { isLoaded, isSignedIn: Boolean(isSignedIn), promptSignUp, requireAuth };
}
