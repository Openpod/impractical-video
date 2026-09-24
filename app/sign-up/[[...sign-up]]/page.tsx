"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { AuthFlow } from "@/components/auth/auth-flow";
import { resolveRedirectUrl } from "@/lib/auth-redirect";

function SignUpInner() {
  const params = useSearchParams();
  const redirectUrl = useMemo(() => resolveRedirectUrl(params), [params]);
  return <AuthFlow mode="sign-up" redirectUrl={redirectUrl} />;
}

export default function SignUpPage() {
  return (
    <main className="auth-screen">
      <Suspense fallback={null}>
        <SignUpInner />
      </Suspense>
    </main>
  );
}
