"use client";

import {
  Compass,
  Home,
  LayoutGrid,
  Library,
  Menu as MenuIcon,
  MessageSquare,
  Plus,
  X,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  closeProjectTab,
  OPEN_PROJECT_TABS_STORAGE_KEY,
  openProjectTab,
  readOpenProjectTabIds,
  reconcileOpenProjectTabs,
  reorderProjectTab,
  reorderProjectTabRelative,
  type DesktopProjectTab,
} from "@/app/desktop-project-tabs";
import { AgentActivityStatusButton } from "@/app/projects/[id]/agent-activity-overlay";
import {
  activityFromEditorEvent,
  activityFromPaperEvent,
  type AgentActivityLifecycleEvent,
  type EditorActivityEvent,
  type PaperActivityEvent,
} from "@/app/projects/[id]/agent-activity-state";
import {
  lifecycleFromActivityItem,
  lifecycleFromAgentInteraction,
  isVisibleProjectTabActivity,
  OPEN_PROJECT_ACTIVITY_STORAGE_KEY,
  PROJECT_TAB_ACTIVITY_STORAGE_KEY,
  readProjectTabActivityMap,
  reconcileProjectTabActivityMap,
  projectTabLifecycleForDisplay,
  type ProjectTabActivityMap,
} from "@/app/project-tab-activity";
import type { AgentInteractionEvent } from "@/lib/agent-interaction-types";
import { startNavigationProgress } from "@/lib/navigation-progress";

declare global {
  interface Window {
    videoFsDesktopEnvironment?: Readonly<{
      authSessionCleared?: () => Promise<boolean>;
      authSessionConnected?: () => Promise<boolean>;
      companionHide?: () => Promise<void>;
      companionAttachmentRead?: (
        projectId: string,
        hash: string,
      ) => Promise<unknown>;
      companionAttachmentRemove?: (
        projectId: string,
        hash: string,
      ) => Promise<unknown>;
      companionAttachmentStore?: (
        projectId: string,
        attachment: unknown,
      ) => Promise<unknown>;
      companionComposeGet?: (projectId: string) => Promise<unknown>;
      companionComposeSet?: (
        projectId: string,
        state: unknown,
      ) => Promise<unknown>;
      companionOnProject?: (
        callback: (projectId: string | null) => void,
      ) => () => void;
      companionOpenProject?: (projectId: string) => Promise<boolean>;
      mainOnOpenProject?: (
        callback: (projectId: string) => void,
      ) => () => void;
      companionShow?: () => Promise<void>;
      companionTitleSet?: (
        projectId: string | null,
        name: string | null,
      ) => Promise<string>;
      companionToggle?: () => Promise<void>;
      platform: string;
      uiPreview?: "tab-activity" | null;
    }>;
  }
}

function writeOpenProjectTabs(projectIds: readonly string[]) {
  try {
    localStorage.setItem(
      OPEN_PROJECT_TABS_STORAGE_KEY,
      JSON.stringify(projectIds),
    );
  } catch {
    // The tabs still work for this session if storage is unavailable.
  }
}

function writeProjectTabActivityMap(activity: ProjectTabActivityMap) {
  try {
    localStorage.setItem(
      PROJECT_TAB_ACTIVITY_STORAGE_KEY,
      JSON.stringify(activity),
    );
  } catch {
    // Activity remains live for this renderer if storage is unavailable.
  }
}

export function DesktopWindowChrome({
  activity,
  activityButtonRef,
  activityExpanded = false,
  availableProjects,
  catalogComplete = true,
  currentProject = null,
  onOpenActivity,
  rightActions,
}: {
  activity?: AgentActivityLifecycleEvent;
  activityButtonRef?: RefObject<HTMLButtonElement | null>;
  activityExpanded?: boolean;
  availableProjects: readonly DesktopProjectTab[];
  catalogComplete?: boolean;
  currentProject?: DesktopProjectTab | null;
  onOpenActivity?: () => void;
  rightActions?: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [navExpanded, setNavExpanded] = useState(false);
  useEffect(() => {
    // The chrome remounts between pages; the hamburger stays open until the
    // user closes it, so the state lives in storage rather than the mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNavExpanded(localStorage.getItem("desktop-nav-expanded") === "true");
  }, []);
  const toggleNav = () => {
    setNavExpanded((current) => {
      const next = !current;
      try {
        localStorage.setItem("desktop-nav-expanded", next ? "true" : "false");
      } catch {
        // The nav still toggles for this page if storage is unavailable.
      }
      return next;
    });
  };
  const [tabActivityPreview, setTabActivityPreview] = useState(false);
  const [fetchedCatalog, setFetchedCatalog] = useState<DesktopProjectTab[]>([]);
  const [fetchedCatalogReady, setFetchedCatalogReady] = useState(false);
  const [openProjectIds, setOpenProjectIds] = useState<string[]>([]);
  const [tabsHydrated, setTabsHydrated] = useState(false);
  const [projectActivity, setProjectActivity] =
    useState<ProjectTabActivityMap>({});
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(
    null,
  );
  const [dropTarget, setDropTarget] = useState<{
    placement: "before" | "after";
    projectId: string;
  } | null>(null);
  const [tabAnnouncement, setTabAnnouncement] = useState("");
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const availableProjectsKey = availableProjects
    .map((project) => `${project.id}\u0000${project.name}`)
    .join("\u0001");
  const currentProjectId = currentProject?.id ?? null;
  const declaredProjects = useMemo(
    () =>
      availableProjectsKey
        ? availableProjectsKey.split("\u0001").map((entry) => {
            const [id, name = ""] = entry.split("\u0000");
            return { id, name };
          })
        : [],
    [availableProjectsKey],
  );

  useLayoutEffect(() => {
    const platform = window.videoFsDesktopEnvironment?.platform;
    if (!platform) return;
    document.documentElement.dataset.videoFsDesktop = platform;
    const preview =
      window.videoFsDesktopEnvironment?.uiPreview === "tab-activity";
    queueMicrotask(() => setTabActivityPreview(preview));
  }, []);

  useEffect(() => {
    let stored: ProjectTabActivityMap = {};
    try {
      stored = readProjectTabActivityMap(
        localStorage.getItem(PROJECT_TAB_ACTIVITY_STORAGE_KEY),
      );
    } catch {
      stored = {};
    }
    queueMicrotask(() => setProjectActivity(stored));
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (catalogComplete) return;
    void fetch("/api/projects", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled || !Array.isArray(data?.projects)) return;
        const projects = data.projects
          .filter(
            (project: unknown): project is DesktopProjectTab =>
              Boolean(
                project &&
                  typeof project === "object" &&
                  typeof (project as DesktopProjectTab).id === "string" &&
                  typeof (project as DesktopProjectTab).name === "string",
              ),
          )
          .map(({ id, name }: DesktopProjectTab) => ({ id, name }));
        setFetchedCatalog(projects);
        setFetchedCatalogReady(true);
      })
      .catch(() => {
        if (!cancelled) setFetchedCatalogReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    catalogComplete,
  ]);

  useEffect(() => {
    let storedIds: string[] = [];
    try {
      storedIds = readOpenProjectTabIds(
        localStorage.getItem(OPEN_PROJECT_TABS_STORAGE_KEY),
      );
    } catch {
      storedIds = [];
    }
    const nextIds = currentProjectId
      ? openProjectTab(storedIds, currentProjectId)
      : storedIds;
    // Storage is an external desktop-session source. Hydrate only after mount
    // so the server and first client render remain identical.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenProjectIds(nextIds);
    setTabsHydrated(true);
    writeOpenProjectTabs(nextIds);
  }, [currentProjectId]);

  const catalog = useMemo(() => {
    if (catalogComplete) return declaredProjects;
    const merged = new Map(
      fetchedCatalog.map((project) => [project.id, project]),
    );
    declaredProjects.forEach((project) => merged.set(project.id, project));
    return [...merged.values()];
  }, [catalogComplete, declaredProjects, fetchedCatalog]);
  const catalogReady = catalogComplete || fetchedCatalogReady;
  const effectiveOpenProjectIds = useMemo(
    () =>
      catalogReady
        ? reconcileOpenProjectTabs({
            availableProjects: catalog,
            // Opening the route is handled once during hydration. Adding the
            // active route here would reopen a tab while its close navigates.
            projectIds: openProjectIds,
          })
        : openProjectIds,
    [
      catalog,
      catalogReady,
      openProjectIds,
    ],
  );

  useEffect(() => {
    if (!catalogReady || !tabsHydrated) return;
    writeOpenProjectTabs(effectiveOpenProjectIds);
  }, [catalogReady, effectiveOpenProjectIds, tabsHydrated]);

  useEffect(() => {
    queueMicrotask(() =>
      setProjectActivity((current) => {
        const next = reconcileProjectTabActivityMap(
          current,
          effectiveOpenProjectIds,
        );
        writeProjectTabActivityMap(next);
        return next;
      }),
    );
  }, [effectiveOpenProjectIds]);

  useEffect(() => {
    if (!currentProjectId || !activity) return;
    queueMicrotask(() =>
      setProjectActivity((current) => {
        const next = { ...current, [currentProjectId]: activity };
        writeProjectTabActivityMap(next);
        return next;
      }),
    );
  }, [activity, currentProjectId]);

  useEffect(() => {
    if (!effectiveOpenProjectIds.length) return;
    const query = effectiveOpenProjectIds
      .slice(0, 24)
      .map((projectId) => `id=${encodeURIComponent(projectId)}`)
      .join("&");
    const events = new EventSource(`/api/projects/tab-activity?${query}`);
    const record = (
      projectId: string,
      event: AgentActivityLifecycleEvent,
    ) => {
      setProjectActivity((current) => {
        const next = { ...current, [projectId]: event };
        writeProjectTabActivityMap(next);
        return next;
      });
    };
    const onPaper = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as PaperActivityEvent & {
          projectId: string;
        };
        record(event.projectId, lifecycleFromActivityItem(activityFromPaperEvent(event)));
      } catch {
        // Ignore malformed local lifecycle events.
      }
    };
    const onEditor = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as EditorActivityEvent & {
          projectId: string;
        };
        const item = activityFromEditorEvent(event);
        if (item) record(event.projectId, lifecycleFromActivityItem(item));
      } catch {
        // Ignore malformed local lifecycle events.
      }
    };
    const onInteraction = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as AgentInteractionEvent;
        record(event.projectId, lifecycleFromAgentInteraction(event));
      } catch {
        // Ignore malformed local lifecycle events.
      }
    };
    events.addEventListener("paper", onPaper as EventListener);
    events.addEventListener("editor-command", onEditor as EventListener);
    events.addEventListener(
      "agent-interaction",
      onInteraction as EventListener,
    );
    return () => {
      events.close();
    };
  }, [effectiveOpenProjectIds]);

  const projectById = useMemo(
    () => new Map(catalog.map((project) => [project.id, project])),
    [catalog],
  );
  const openProjects = useMemo(
    () =>
      effectiveOpenProjectIds
        .map((projectId) => projectById.get(projectId))
        .filter((project): project is DesktopProjectTab => Boolean(project)),
    [effectiveOpenProjectIds, projectById],
  );

  const navigateTo = useCallback(
    (href: string) => {
      startNavigationProgress();
      router.push(href);
    },
    [router],
  );

  // Warm the router cache for every open tab so switching is near-instant
  // instead of a full RSC round-trip with a loading flash.
  useEffect(() => {
    for (const projectId of effectiveOpenProjectIds) {
      router.prefetch(`/projects/${encodeURIComponent(projectId)}`);
    }
  }, [effectiveOpenProjectIds, router]);

  // The companion chat's project switcher opens projects here: add the tab
  // and navigate, exactly as if the user had opened it in this window.
  useEffect(() => {
    return window.videoFsDesktopEnvironment?.mainOnOpenProject?.(
      (projectId) => {
        setOpenProjectIds((current) => {
          const next = openProjectTab(current, projectId);
          writeOpenProjectTabs(next);
          return next;
        });
        navigateTo(`/projects/${encodeURIComponent(projectId)}`);
      },
    );
  }, [navigateTo]);

  const [creatingProject, setCreatingProject] = useState(false);
  const createBlankProject = useCallback(async () => {
    if (creatingProject) return;
    setCreatingProject(true);
    try {
      const response = await fetch("/api/projects", {
        body: JSON.stringify({ name: "Untitled video" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const data = (await response.json().catch(() => ({}))) as {
        project?: { id?: string };
      };
      const projectId = data.project?.id;
      if (!response.ok || !projectId) return;
      setOpenProjectIds((current) => openProjectTab(current, projectId));
      navigateTo(`/projects/${projectId}`);
    } finally {
      setCreatingProject(false);
    }
  }, [creatingProject, navigateTo]);

  function closeTab(projectId: string) {
    const result = closeProjectTab(effectiveOpenProjectIds, projectId);
    setOpenProjectIds(result.projectIds);
    writeOpenProjectTabs(result.projectIds);
    if (currentProjectId !== projectId) return;
    navigateTo(
      result.nextProjectId
        ? `/projects/${result.nextProjectId}`
        : "/projects",
    );
  }

  function persistProjectOrder(projectIds: readonly string[]) {
    const nextIds = [...projectIds];
    setOpenProjectIds(nextIds);
    writeOpenProjectTabs(nextIds);
  }

  function announceProjectMove(projectId: string, projectIds: readonly string[]) {
    const position = projectIds.indexOf(projectId);
    const project = projectById.get(projectId);
    if (!project || position < 0) return;
    setTabAnnouncement(
      `Moved ${project.name} to position ${position + 1} of ${projectIds.length}.`,
    );
  }

  function focusProjectTab(projectId: string) {
    requestAnimationFrame(() => tabButtonRefs.current.get(projectId)?.focus());
  }

  function openProjectActivity(projectId: string) {
    if (projectId === currentProjectId && onOpenActivity) {
      onOpenActivity();
      return;
    }
    try {
      sessionStorage.setItem(
        OPEN_PROJECT_ACTIVITY_STORAGE_KEY,
        projectId,
      );
    } catch {
      // Navigation still succeeds if storage is unavailable.
    }
    navigateTo(`/projects/${projectId}`);
  }

  function reorderWithKeyboard(
    event: KeyboardEvent<HTMLButtonElement>,
    projectId: string,
  ) {
    if (
      !event.altKey ||
      !event.shiftKey ||
      (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
    ) {
      return false;
    }
    event.preventDefault();
    const currentIndex = effectiveOpenProjectIds.indexOf(projectId);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextIds = reorderProjectTab(
      effectiveOpenProjectIds,
      projectId,
      currentIndex + direction,
    );
    persistProjectOrder(nextIds);
    announceProjectMove(projectId, nextIds);
    focusProjectTab(projectId);
    return true;
  }

  function handleDragOver(
    event: DragEvent<HTMLDivElement>,
    projectId: string,
  ) {
    if (!draggingProjectId || draggingProjectId === projectId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const placement =
      event.clientX < rect.left + rect.width / 2 ? "before" : "after";
    setDropTarget({ placement, projectId });
    const tabs = event.currentTarget.closest(".desktop-project-tabs");
    if (!(tabs instanceof HTMLElement)) return;
    const edge = 32;
    if (event.clientX < tabs.getBoundingClientRect().left + edge) {
      tabs.scrollLeft -= edge;
    } else if (event.clientX > tabs.getBoundingClientRect().right - edge) {
      tabs.scrollLeft += edge;
    }
  }

  function handleDrop(
    event: DragEvent<HTMLDivElement>,
    targetProjectId: string,
  ) {
    event.preventDefault();
    const projectId =
      draggingProjectId ||
      event.dataTransfer.getData("application/x-video-fs-project-tab");
    const placement =
      dropTarget?.projectId === targetProjectId
        ? dropTarget.placement
        : "before";
    const nextIds = reorderProjectTabRelative(
      effectiveOpenProjectIds,
      projectId,
      targetProjectId,
      placement,
    );
    persistProjectOrder(nextIds);
    announceProjectMove(projectId, nextIds);
    setDraggingProjectId(null);
    setDropTarget(null);
    focusProjectTab(projectId);
  }

  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={120}>
    <div
      aria-label="Window title bar"
      className={`app-desktop-window-chrome${pathname === "/" ? " is-home" : ""}`}
      data-desktop-chrome
    >
      <div className="desktop-titlebar-left">
        <div
          className={`desktop-titlebar-nav${navExpanded ? " is-expanded" : ""}`}
        >
          <ChromeTip label={navExpanded ? "Hide navigation" : "Navigation"}>
            <button
              aria-expanded={navExpanded}
              aria-label={
                navExpanded ? "Collapse navigation" : "Expand navigation"
              }
              className="desktop-titlebar-sidebar-toggle"
              onClick={toggleNav}
              type="button"
            >
              <MenuIcon aria-hidden="true" size={15} />
            </button>
          </ChromeTip>
          <div aria-hidden={!navExpanded} className="desktop-titlebar-nav-links">
            <div className="desktop-titlebar-nav-links-inner">
              {(
                [
                  { href: "/", icon: Home, label: "Home" },
                  { href: "/projects", icon: LayoutGrid, label: "Projects" },
                  { href: "/explore", icon: Compass, label: "Explore" },
                  { href: "/library", icon: Library, label: "Library" },
                ] as const
              ).map(({ href, icon: Icon, label }) => {
                const active =
                  href === "/" ? pathname === "/" : pathname.startsWith(href);
                return (
                  <ChromeTip key={href} label={label}>
                    <button
                      aria-current={active ? "page" : undefined}
                      aria-label={label}
                      className={`desktop-titlebar-nav-link${active ? " is-active" : ""}`}
                      onClick={() => navigateTo(href)}
                      tabIndex={navExpanded ? 0 : -1}
                      type="button"
                    >
                      <Icon aria-hidden="true" size={15} />
                    </button>
                  </ChromeTip>
                );
              })}
            </div>
          </div>
        </div>
        <div
          aria-label="Open projects"
          className="desktop-project-tabs"
          role="tablist"
        >
        {openProjects.map((project, index) => {
          const active = pathname === `/projects/${project.id}`;
          const projectLifecycle = projectTabLifecycleForDisplay(
            projectActivity[project.id],
            project.id,
            tabActivityPreview,
          );
          return (
            <div
              className={`desktop-project-tab${active ? " is-active" : ""}${
                draggingProjectId === project.id ? " is-dragging" : ""
              }${
                dropTarget?.projectId === project.id
                  ? ` is-drop-${dropTarget.placement}`
                  : ""
              }`}
              data-project-tab-id={project.id}
              draggable
              key={project.id}
              onDragEnd={() => {
                setDraggingProjectId(null);
                setDropTarget(null);
              }}
              onDragOver={(event) => handleDragOver(event, project.id)}
              onDragStart={(event) => {
                setDraggingProjectId(project.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(
                  "application/x-video-fs-project-tab",
                  project.id,
                );
              }}
              onDrop={(event) => handleDrop(event, project.id)}
            >
              <button
                aria-label={project.name}
                aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
                aria-selected={active}
                className="desktop-project-tab-activate"
                onKeyDown={(event) => {
                  if (reorderWithKeyboard(event, project.id)) return;
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                    return;
                  }
                  const tabs = Array.from(
                    event.currentTarget
                      .closest('[role="tablist"]')
                      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ??
                      [],
                  );
                  const currentIndex = tabs.indexOf(event.currentTarget);
                  const direction = event.key === "ArrowRight" ? 1 : -1;
                  const next = tabs.at(
                    (currentIndex + direction + tabs.length) % tabs.length,
                  );
                  if (!next) return;
                  event.preventDefault();
                  next.focus();
                }}
                onClick={() => navigateTo(`/projects/${project.id}`)}
                ref={(node) => {
                  if (node) tabButtonRefs.current.set(project.id, node);
                  else tabButtonRefs.current.delete(project.id);
                }}
                role="tab"
                tabIndex={active || (!currentProject && index === 0) ? 0 : -1}
                title={`${project.name} — move with Option+Shift+Left/Right`}
                type="button"
              >
                <span dir="auto">{project.name}</span>
              </button>
              <span
                aria-hidden={!projectLifecycle}
                className="desktop-project-tab-activity-slot"
              >
                {isVisibleProjectTabActivity(projectLifecycle) ? (
                  <AgentActivityStatusButton
                    compact
                    controlsId={
                      active ? "agent-activity-surface" : ""
                    }
                    event={projectLifecycle!}
                    expanded={active && activityExpanded}
                    onOpenActivity={() => openProjectActivity(project.id)}
                    preview={tabActivityPreview}
                    projectName={project.name}
                    ref={active ? activityButtonRef : undefined}
                  />
                ) : null}
              </span>
              <button
                aria-label={`Close ${project.name} tab`}
                className="desktop-project-tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(project.id);
                }}
                title={`Close ${project.name} tab`}
                type="button"
              >
                <X aria-hidden="true" size={12} />
              </button>
            </div>
          );
        })}
        <ChromeTip label="New project">
          <button
            aria-label="New project"
            className="desktop-project-tab-add"
            disabled={creatingProject}
            onClick={() => void createBlankProject()}
            type="button"
          >
            <Plus aria-hidden="true" size={14} />
          </button>
        </ChromeTip>
      </div>
      </div>
      <div className="desktop-titlebar-actions">
        <ChromeTip label="AI chat (⌥ Space)">
          <button
            aria-label="Open AI chat"
            data-project-tour="chat"
            className="desktop-titlebar-companion"
            onClick={() =>
              void window.videoFsDesktopEnvironment?.companionToggle?.()
            }
            title="AI chat"
            type="button"
          >
            <MessageSquare aria-hidden="true" size={15} />
          </button>
        </ChromeTip>
        {rightActions}
      </div>
      <p aria-live="polite" className="sr-only" role="status">
        {tabAnnouncement}
      </p>
    </div>
    </TooltipProvider>
  );
}

/** Titlebar tooltip: native `title` attributes are unreliable inside Electron
 * frameless drag regions, so chrome controls use the app tooltip instead. */
export function ChromeTip({
  children,
  label,
}: {
  children: ReactElement;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
