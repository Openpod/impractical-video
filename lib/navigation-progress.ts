export const NAVIGATION_PROGRESS_EVENT = "video-fs:navigation-progress";

export const APP_NAVIGATION_PROGRESS_SCOPE = "app-navigation";

export type NavigationProgressScope = typeof APP_NAVIGATION_PROGRESS_SCOPE;

export type NavigationProgressEventDetail = {
  type: "start" | "done";
  scope: NavigationProgressScope;
};

const MAX_TRICKLE_PROGRESS = 0.94;

export function getNextNavigationProgressValue(current: number): number {
  if (!Number.isFinite(current) || current <= 0) return 0.08;
  if (current >= MAX_TRICKLE_PROGRESS) return MAX_TRICKLE_PROGRESS;
  if (current < 0.2) return Math.min(MAX_TRICKLE_PROGRESS, current + 0.12);
  if (current < 0.5) return Math.min(MAX_TRICKLE_PROGRESS, current + 0.08);
  if (current < 0.8) return Math.min(MAX_TRICKLE_PROGRESS, current + 0.04);
  return Math.min(MAX_TRICKLE_PROGRESS, current + 0.015);
}

function dispatchNavigationProgress(detail: NavigationProgressEventDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<NavigationProgressEventDetail>(NAVIGATION_PROGRESS_EVENT, {
      detail,
    }),
  );
}

export function startNavigationProgress(scope: NavigationProgressScope = APP_NAVIGATION_PROGRESS_SCOPE): void {
  dispatchNavigationProgress({ type: "start", scope });
}

export function doneNavigationProgress(scope: NavigationProgressScope = APP_NAVIGATION_PROGRESS_SCOPE): void {
  dispatchNavigationProgress({ type: "done", scope });
}
