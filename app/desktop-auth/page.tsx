import { Suspense } from "react";
import { DesktopAuthHandoff } from "@/components/desktop-auth-handoff";
import { isLocalAppMode } from "@/lib/app-mode";

export default function DesktopAuthPage() {
  if (isLocalAppMode()) {
    return <main className="auth-screen" />;
  }
  return (
    <Suspense fallback={<main className="auth-screen" />}>
      <DesktopAuthHandoff />
    </Suspense>
  );
}
