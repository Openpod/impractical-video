"use client";

import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";
import Link from "next/link";
import { isLocalAppModeClient } from "@/lib/app-mode";

/** OAuth (Google/GitHub) return handler — Clerk finalizes the session and
 * forwards to redirectUrlComplete. */
export default function SsoCallbackPage() {
  if (isLocalAppModeClient()) {
    return <main className="auth-screen"><Link href="/">Return to your local workspace</Link></main>;
  }
  return (
    <main className="auth-screen">
      <AuthenticateWithRedirectCallback signInFallbackRedirectUrl="/" signUpFallbackRedirectUrl="/" />
    </main>
  );
}
