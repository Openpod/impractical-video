"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { AuthFlow } from "@/components/auth/auth-flow";
import { resolveRedirectUrl } from "@/lib/auth-redirect";

function SignInInner() {
  const params = useSearchParams();
  const redirectUrl = useMemo(() => resolveRedirectUrl(params), [params]);
  return <AuthFlow mode="sign-in" redirectUrl={redirectUrl} />;
}

export default function SignInPage() {
  return (
    <main className="auth-screen">
      <Suspense fallback={null}>
        <SignInInner />
      </Suspense>
    </main>
  );
}
