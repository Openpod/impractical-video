"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  APP_NAVIGATION_PROGRESS_SCOPE,
  doneNavigationProgress,
  getNextNavigationProgressValue,
  NAVIGATION_PROGRESS_EVENT,
  startNavigationProgress,
  type NavigationProgressEventDetail,
} from "@/lib/navigation-progress";

const HIDE_DELAY_MS = 180;
const TRICKLE_INTERVAL_MS = 140;

function shouldTrackAnchorNavigation(anchor: HTMLAnchorElement): boolean {
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#")) return false;
  if (anchor.hasAttribute("download")) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  if (anchor.getAttribute("rel")?.includes("external")) return false;
  if (anchor.dataset.noNavigationProgress === "true") return false;

  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return false;
  if (url.pathname === window.location.pathname && url.search === window.location.search) return false;

  return true;
}

export function NavigationProgressBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const [isVisible, setIsVisible] = useState(false);
  const [progress, setProgress] = useState(0);
  const activeScopeRef = useRef<string | null>(null);
  const finishTimeoutRef = useRef<number | null>(null);
  const trickleIntervalRef = useRef<number | null>(null);

  const stopTrickling = useCallback(() => {
    if (trickleIntervalRef.current == null) return;
    window.clearInterval(trickleIntervalRef.current);
    trickleIntervalRef.current = null;
  }, []);

  const clearFinishTimeout = useCallback(() => {
    if (finishTimeoutRef.current == null) return;
    window.clearTimeout(finishTimeoutRef.current);
    finishTimeoutRef.current = null;
  }, []);

  const completeProgress = useCallback(() => {
    if (activeScopeRef.current !== APP_NAVIGATION_PROGRESS_SCOPE) return;
    activeScopeRef.current = null;
    stopTrickling();
    clearFinishTimeout();
    setProgress(1);
    finishTimeoutRef.current = window.setTimeout(() => {
      setIsVisible(false);
      setProgress(0);
      finishTimeoutRef.current = null;
    }, HIDE_DELAY_MS);
    doneNavigationProgress(APP_NAVIGATION_PROGRESS_SCOPE);
  }, [clearFinishTimeout, stopTrickling]);

  useEffect(() => {
    const handleDocumentClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (!shouldTrackAnchorNavigation(anchor)) return;
      startNavigationProgress();
    };

    const handleProgressEvent = (event: Event) => {
      const detail = (event as CustomEvent<NavigationProgressEventDetail>).detail;
      if (!detail || detail.scope !== APP_NAVIGATION_PROGRESS_SCOPE) return;

      if (detail.type === "done") {
        completeProgress();
        return;
      }

      activeScopeRef.current = detail.scope;
      clearFinishTimeout();
      stopTrickling();
      setIsVisible(true);
      setProgress((current) => Math.max(0.08, Math.min(current, 0.2)));
      trickleIntervalRef.current = window.setInterval(() => {
        setProgress((current) => getNextNavigationProgressValue(current));
      }, TRICKLE_INTERVAL_MS);
    };

    document.addEventListener("click", handleDocumentClick, true);
    window.addEventListener(NAVIGATION_PROGRESS_EVENT, handleProgressEvent);
    return () => {
      document.removeEventListener("click", handleDocumentClick, true);
      window.removeEventListener(NAVIGATION_PROGRESS_EVENT, handleProgressEvent);
      stopTrickling();
      clearFinishTimeout();
    };
  }, [clearFinishTimeout, completeProgress, stopTrickling]);

  useEffect(() => {
    if (activeScopeRef.current !== APP_NAVIGATION_PROGRESS_SCOPE) return;
    completeProgress();
  }, [completeProgress, pathname, searchKey]);

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none fixed inset-x-0 top-0 z-[2147483647] transition-opacity duration-150 ${
        isVisible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div
        className="h-[2px] origin-left bg-[#ed1d24] shadow-[0_0_12px_rgba(237,29,36,0.45)] transition-transform duration-200 ease-out"
        style={{ transform: `scaleX(${progress})` }}
      />
    </div>
  );
}
