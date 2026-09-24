import type { Metadata } from "next";
import { Suspense } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { AppAuthProvider } from "@/lib/app-auth";
import { isLocalAppMode } from "@/lib/app-mode";
import { AppToaster } from "@/components/app-toaster";
import { IntercomProvider } from "@/components/intercom-provider";
import { NavigationProgressBar } from "@/components/navigation-progress-bar";
import { ThemeSynchronizer } from "@/app/theme-synchronizer";
import { DesktopAuthGate } from "@/app/desktop-auth-gate";
import { DesktopCloudSessionSync } from "@/components/desktop-cloud-session-sync";
import "./globals.css";

export const metadata: Metadata = {
  title: "Impractical",
  description: "Generate cinematic AI video on an infinite canvas.",
};

const themeScript = `try{var t=localStorage.getItem('theme');var p=t==='light'||t==='dark'||t==='system'?t:'system';var s=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.setAttribute('data-theme',p==='light'||p==='dark'?p:s)}catch(e){document.documentElement.setAttribute('data-theme','dark')}
try{if(location.pathname==='/companion'||location.pathname.indexOf('/companion/')===0){document.documentElement.setAttribute('data-video-fs-companion','true')}if(location.pathname==='/desktop-auth'){document.documentElement.setAttribute('data-video-fs-auth','true')}}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const document = (
    <html lang="en" suppressHydrationWarning>
        <head>
          <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        </head>
        <body>
          <AppAuthProvider>
            <DesktopCloudSessionSync />
            <ThemeSynchronizer />
            <Suspense fallback={null}>
              <DesktopAuthGate>{children}</DesktopAuthGate>
            </Suspense>
            <Suspense fallback={null}>
              <NavigationProgressBar />
            </Suspense>
            <AppToaster />
            <Suspense fallback={null}>
              <IntercomProvider />
            </Suspense>
          </AppAuthProvider>
          {/* Non-closeable mobile gate — shown only below the desktop
              breakpoint via CSS. The canvas app is desktop-only for now. */}
          <div className="mobile-gate" role="alertdialog" aria-label="Desktop only">
            <div className="mobile-gate-inner">
              <span className="mobile-gate-mark" aria-hidden="true">Impractical</span>
              <h1 className="mobile-gate-title">Impractical is built for the web.</h1>
              <p className="mobile-gate-sub">Mobile coming soon.</p>
            </div>
          </div>
        </body>
      </html>
  );
  // Production Clerk sessions are valid only on the hosted domain. Desktop
  // signs in through a hosted handoff and deliberately never mounts Clerk on
  // its loopback origin.
  if (isLocalAppMode()) return document;
  return <ClerkProvider>{document}</ClerkProvider>;
}
