"use client";

import { Compass, FolderKanban, Home, LayoutGrid, Library, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SidebarAuthBadge, SidebarNotifications } from "@/app/app-shell";
import { ImpracticalLogo } from "@/app/impractical-logo";
import { LoadingCube } from "@/app/loading-cube";
import { MediaThumb } from "@/app/media-thumb";
import type { HomeProjectCard } from "@/app/home-data";
import { startNavigationProgress } from "@/lib/navigation-progress";
import type { ProjectMeta } from "@/lib/workspace";

const WORKBENCH_PROJECT_CACHE_KEY = "workbench-sidebar-projects-v1";
const EXPLORE_PREFETCH_VIDEO_LIMIT = 96;
const WORKBENCH_PREFETCH_ROUTES = ["/", "/projects", "/explore", "/library"] as const;
let cachedWorkbenchProjects: HomeProjectCard[] | null = null;
let pendingWorkbenchProjects: Promise<HomeProjectCard[]> | null = null;
let workbenchExploreWarmPromise: Promise<void> | null = null;

function warmWorkbenchExploreCatalog() {
  if (typeof window === "undefined") return;
  workbenchExploreWarmPromise ??= Promise.allSettled([
    fetch("/api/explore/references", { cache: "force-cache" }),
    fetch(`/api/explore/videos?limit=${EXPLORE_PREFETCH_VIDEO_LIMIT}`, { cache: "force-cache" }),
  ]).then(() => undefined);
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function toHomeProjectCard(project: ProjectMeta): HomeProjectCard {
  return {
    ...project,
    gradientIndex: hashString(project.id),
    isWorking: false,
    thumbnailKind: null,
    thumbnailUrl: null,
  };
}

function isProjectMeta(value: unknown): value is ProjectMeta {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProjectMeta>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

function isHomeProjectCard(value: unknown): value is HomeProjectCard {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HomeProjectCard>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    typeof candidate.gradientIndex === "number" &&
    (candidate.thumbnailKind === "image" || candidate.thumbnailKind === "video" || candidate.thumbnailKind === null) &&
    (typeof candidate.thumbnailUrl === "string" || candidate.thumbnailUrl === null)
  );
}

function readCachedProjects() {
  if (cachedWorkbenchProjects) return cachedWorkbenchProjects;
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(sessionStorage.getItem(WORKBENCH_PROJECT_CACHE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    const projects = parsed
      .filter((project): project is HomeProjectCard | ProjectMeta => isHomeProjectCard(project) || isProjectMeta(project))
      .map((project) => (isHomeProjectCard(project) ? project : toHomeProjectCard(project)));
    cachedWorkbenchProjects = projects;
    return projects;
  } catch {
    return [];
  }
}

function writeCachedProjects(projects: HomeProjectCard[]) {
  cachedWorkbenchProjects = projects;
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(WORKBENCH_PROJECT_CACHE_KEY, JSON.stringify(projects));
  } catch {
    // Ignore cache write failures; the sidebar can still fetch normally.
  }
}

function fetchWorkbenchProjects() {
  pendingWorkbenchProjects ??= fetch("/api/projects", { cache: "no-store" })
    .then((response) => response.json())
    .then((data) => {
      if (!Array.isArray(data?.projects)) return readCachedProjects();
      const projects = data.projects.filter(isProjectMeta).map(toHomeProjectCard);
      writeCachedProjects(projects);
      return projects;
    })
    .catch(() => readCachedProjects())
    .finally(() => {
      pendingWorkbenchProjects = null;
    });
  return pendingWorkbenchProjects;
}

/**
 * The app navigation sidebar, docked beside the workbench like the one on the
 * home shell. Collapsed state is owned by the workbench so the desktop title
 * bar toggle and the in-sidebar toggle stay in sync.
 */
export function WorkbenchSidebar({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // Start empty to match SSR output; the sessionStorage cache is read after
  // mount (reading it in the initializer causes a hydration mismatch).
  const [projects, setProjects] = useState<HomeProjectCard[]>([]);
  const [activeProjectIds, setActiveProjectIds] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);

  const prefetchRoute = useCallback(
    (href: string) => {
      router.prefetch(href);
      if (href === "/explore") warmWorkbenchExploreCatalog();
    },
    [router],
  );

  const navigateFromSidebar = useCallback(
    (href: string) => {
      startNavigationProgress();
      prefetchRoute(href);
    },
    [prefetchRoute],
  );

  const refreshActiveRuns = useCallback(async () => {
    try {
      const response = await fetch("/api/projects/active-runs", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json().catch(() => null);
      if (!data || !Array.isArray(data.projectIds)) return;
      const nextActiveProjectIds = new Set<string>(
        data.projectIds.filter((projectId: unknown): projectId is string => typeof projectId === "string"),
      );
      setActiveProjectIds(nextActiveProjectIds);
    } catch {
      // Best-effort sidebar presence signal.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const cached = readCachedProjects();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (cached.length) setProjects(cached);
    WORKBENCH_PREFETCH_ROUTES.forEach((href) => router.prefetch(href));
    void fetchWorkbenchProjects().then((nextProjects) => {
      if (!cancelled) setProjects(nextProjects);
    });
    const timeoutId = window.setTimeout(() => void refreshActiveRuns(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [refreshActiveRuns, router]);

  useEffect(() => {
    projects.slice(0, 8).forEach((project) => {
      router.prefetch(`/projects/${project.id}`);
    });
  }, [projects, router]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refreshActiveRuns();
    }, 5000);
    const handleFocus = () => void refreshActiveRuns();
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
    };
  }, [refreshActiveRuns]);

  async function createProject() {
    if (creating) return;
    setCreating(true);
    try {
      const response = await fetch("/api/projects", {
        body: JSON.stringify({ name: "Untitled video" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && isProjectMeta(data.project)) {
        const createdProject = toHomeProjectCard(data.project);
        const nextProjects = [
          createdProject,
          ...projects.filter((project) => project.id !== createdProject.id),
        ];
        setProjects(nextProjects);
        writeCachedProjects(nextProjects);
        startNavigationProgress();
        router.push(`/projects/${data.project.id}`);
      }
    } finally {
      setCreating(false);
    }
  }

  const isProjectsActive = pathname === "/projects";
  const projectsWithActivity = useMemo(
    () =>
      projects.map((project) => {
        const isWorking = activeProjectIds.has(project.id);
        return project.isWorking === isWorking ? project : { ...project, isWorking };
      }),
    [activeProjectIds, projects],
  );
  const recentProjects = projectsWithActivity.slice(0, 8);

  return (
    <aside
      aria-label="Application navigation"
      className="app-sidebar workbench-sidebar"
      inert={collapsed || undefined}
    >
      <div className="app-sidebar-head">
        <div className="app-logo-slot">
          <Link className="app-logo" href="/" title="Home">
            <span className="app-logo-mark" aria-hidden="true">
              <ImpracticalLogo className="app-logo-svg" />
            </span>
            <span className="app-logo-copy">
              <strong>Impractical</strong>
            </span>
          </Link>
          <button
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="app-logo-hover-toggle"
            onClick={onToggleCollapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            type="button"
          >
            {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
        </div>
        <button
          aria-expanded={!collapsed}
          aria-label="Collapse sidebar"
          className="app-sidebar-toggle"
          onClick={onToggleCollapsed}
          title="Collapse sidebar"
          type="button"
        >
          <PanelLeftClose size={15} />
        </button>
      </div>

      <nav className="app-sidebar-nav" aria-label="Primary">
        <Link
          aria-current={pathname === "/" ? "page" : undefined}
          className={`app-sidebar-link ${pathname === "/" ? "active" : ""}`}
          href="/"
          onClick={() => navigateFromSidebar("/")}
          onFocus={() => prefetchRoute("/")}
          onPointerEnter={() => prefetchRoute("/")}
          title="Home"
        >
          <Home size={18} />
          <span>Home</span>
        </Link>
        <Link
          aria-current={isProjectsActive ? "page" : undefined}
          className={`app-sidebar-link ${isProjectsActive ? "active" : ""}`}
          href="/projects"
          onClick={() => navigateFromSidebar("/projects")}
          onFocus={() => prefetchRoute("/projects")}
          onPointerEnter={() => prefetchRoute("/projects")}
          title="Projects"
        >
          <LayoutGrid size={18} />
          <span>Projects</span>
        </Link>
        <Link
          aria-current={pathname.startsWith("/explore") ? "page" : undefined}
          className={`app-sidebar-link ${pathname.startsWith("/explore") ? "active" : ""}`}
          href="/explore"
          onClick={() => navigateFromSidebar("/explore")}
          onFocus={() => prefetchRoute("/explore")}
          onPointerEnter={() => prefetchRoute("/explore")}
          title="Explore"
        >
          <Compass size={18} />
          <span>Explore</span>
        </Link>
        <Link
          aria-current={pathname.startsWith("/library") ? "page" : undefined}
          className={`app-sidebar-link ${pathname.startsWith("/library") ? "active" : ""}`}
          href="/library"
          onClick={() => navigateFromSidebar("/library")}
          onFocus={() => prefetchRoute("/library")}
          onPointerEnter={() => prefetchRoute("/library")}
          title="Library"
        >
          <Library size={18} />
          <span>Library</span>
        </Link>
        <button
          className="app-sidebar-create"
          disabled={creating}
          onClick={() => void createProject()}
          title="New project"
          type="button"
        >
          <Plus size={18} />
          <span>{creating ? "Creating..." : "New project"}</span>
        </button>
      </nav>

      <div className="app-sidebar-section">
        <div className="app-sidebar-label">Recents</div>
        <div className="app-sidebar-projects">
          {recentProjects.length ? (
            recentProjects.map((project) => {
              const active = pathname === `/projects/${project.id}`;
              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={`app-sidebar-project${project.isWorking ? " is-working" : ""}${active ? " active" : ""}`}
                  href={`/projects/${project.id}`}
                  key={project.id}
                  onClick={() => navigateFromSidebar(`/projects/${project.id}`)}
                  onFocus={() => prefetchRoute(`/projects/${project.id}`)}
                  onPointerEnter={() => prefetchRoute(`/projects/${project.id}`)}
                  title={project.name}
                >
                  <MediaThumb
                    className="app-sidebar-project-thumb"
                    gradientIndex={project.gradientIndex}
                    kind={project.thumbnailKind ?? "project"}
                    src={project.thumbnailUrl}
                    title={project.name}
                  />
                  {project.isWorking ? (
                    <LoadingCube className="app-sidebar-project-working-collapsed" />
                  ) : null}
                  {project.isWorking ? (
                    <LoadingCube className="app-sidebar-project-working-expanded" />
                  ) : null}
                  <span className="app-sidebar-project-name">{project.name}</span>
                </Link>
              );
            })
          ) : (
            <div className="app-sidebar-empty">
              <FolderKanban size={18} />
              <span>No projects yet</span>
            </div>
          )}
        </div>
      </div>

      <div className="app-sidebar-footer">
        <SidebarAuthBadge nativeTitle />
        <SidebarNotifications nativeTitle />
      </div>
    </aside>
  );
}
