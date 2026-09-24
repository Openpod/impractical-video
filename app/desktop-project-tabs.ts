export const OPEN_PROJECT_TABS_STORAGE_KEY =
  "video-fs.desktop.open-project-tabs.v1";

export type DesktopProjectTab = {
  id: string;
  name: string;
};

function uniqueProjectIds(projectIds: readonly string[]) {
  return projectIds.filter(
    (projectId, index) =>
      projectId.length > 0 && projectIds.indexOf(projectId) === index,
  );
}

export function readOpenProjectTabIds(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return uniqueProjectIds(
      parsed.filter(
        (projectId): projectId is string =>
          typeof projectId === "string" && projectId.trim() === projectId,
      ),
    );
  } catch {
    return [];
  }
}

export function openProjectTab(
  projectIds: readonly string[],
  projectId: string,
) {
  return uniqueProjectIds(
    projectIds.includes(projectId)
      ? projectIds
      : [...projectIds, projectId],
  );
}

export function reorderProjectTab(
  projectIds: readonly string[],
  projectId: string,
  targetIndex: number,
) {
  const ordered = uniqueProjectIds(projectIds);
  const currentIndex = ordered.indexOf(projectId);
  if (currentIndex < 0 || ordered.length < 2) return ordered;
  const boundedTargetIndex = Math.max(
    0,
    Math.min(Math.trunc(targetIndex), ordered.length - 1),
  );
  if (currentIndex === boundedTargetIndex) return ordered;
  const next = ordered.filter((id) => id !== projectId);
  next.splice(boundedTargetIndex, 0, projectId);
  return next;
}

export function reorderProjectTabRelative(
  projectIds: readonly string[],
  projectId: string,
  targetProjectId: string,
  placement: "before" | "after",
) {
  const ordered = uniqueProjectIds(projectIds);
  const currentIndex = ordered.indexOf(projectId);
  const targetIndex = ordered.indexOf(targetProjectId);
  if (
    currentIndex < 0 ||
    targetIndex < 0 ||
    projectId === targetProjectId
  ) {
    return ordered;
  }
  const withoutProject = ordered.filter((id) => id !== projectId);
  const adjustedTargetIndex = withoutProject.indexOf(targetProjectId);
  return reorderProjectTab(
    ordered,
    projectId,
    adjustedTargetIndex + (placement === "after" ? 1 : 0),
  );
}

export function reconcileOpenProjectTabs({
  currentProject,
  projectIds,
}: {
  availableProjects: readonly DesktopProjectTab[];
  currentProject?: DesktopProjectTab | null;
  projectIds: readonly string[];
}) {
  // A tab closes ONLY when the user closes it. The catalog can be transiently
  // incomplete (fresh navigation, fetch still in flight), so ids it cannot
  // name keep their slot — rendering simply skips them until the catalog
  // catches up.
  const reconciled = uniqueProjectIds(projectIds);
  if (currentProject) {
    return openProjectTab(reconciled, currentProject.id);
  }
  return reconciled;
}

export function closeProjectTab(
  projectIds: readonly string[],
  projectId: string,
) {
  const currentIndex = projectIds.indexOf(projectId);
  if (currentIndex < 0) {
    return {
      nextProjectId: null,
      projectIds: uniqueProjectIds(projectIds),
    };
  }
  const nextProjectIds = projectIds.filter((id) => id !== projectId);
  return {
    nextProjectId:
      nextProjectIds[currentIndex] ??
      nextProjectIds[currentIndex - 1] ??
      null,
    projectIds: nextProjectIds,
  };
}

export type RuntimeRectTarget = {
  getBoundingClientRect: () => Pick<DOMRect, "bottom" | "top">;
};

export function measureChromeContainment({
  chrome,
  regions,
}: {
  chrome: RuntimeRectTarget;
  regions: readonly RuntimeRectTarget[];
}) {
  const chromeBottom = chrome.getBoundingClientRect().bottom;
  return {
    chromeBottom,
    regionTops: regions.map(
      (region) => region.getBoundingClientRect().top,
    ),
    valid: regions.every(
      (region) => region.getBoundingClientRect().top >= chromeBottom,
    ),
  };
}
