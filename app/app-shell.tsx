"use client";

import {
  ArrowRight,
  Bell,
  CircleHelp,
  Compass,
  FolderKanban,
  Home,
  KeyRound,
  LayoutGrid,
  Library,
  LogIn,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Terminal as TerminalIcon,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from "react";
import { ImpracticalLogo } from "@/app/impractical-logo";
import { ChromeTip, DesktopWindowChrome } from "@/app/desktop-window-chrome";
import { LoadingCube } from "@/app/loading-cube";
import { MediaThumb } from "@/app/media-thumb";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { showIntercomSupport } from "@/components/intercom-provider";
import { CreditMenuSection } from "@/components/billing/credit-menu-section";
import { StartContinuation } from "@/components/onboarding/start-continuation";
import { BuyCreditsModal } from "@/components/billing/buy-credits-modal";
import { ProviderSettings } from "@/components/provider-settings";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { HomeProjectCard, ReferenceTile } from "@/app/home-data";
import type { ProjectMeta } from "@/lib/workspace";
import { startNavigationProgress } from "@/lib/navigation-progress";
import { useAppAuth } from "@/lib/app-auth";
import { useGenerationBilling } from "@/lib/use-generation-billing";
import {
  loadUserMessageNotifications,
  markUserMessageNotificationsRead,
  useUserMessageNotifications,
} from "@/lib/user-message-notifications";

type ProjectDirectoryContextValue = {
  characters: ReferenceTile[];
  creating: boolean;
  deletingId: string | null;
  environments: ReferenceTile[];
  projects: HomeProjectCard[];
  createProject: (name?: string, initialPrompt?: string) => Promise<ProjectMeta>;
  deleteProject: (project: ProjectMeta) => Promise<void>;
  setProjects: Dispatch<SetStateAction<HomeProjectCard[]>>;
};

type ThemePreference = "light" | "dark" | "system";

const ProjectDirectoryContext = createContext<ProjectDirectoryContextValue | null>(null);
const EXPLORE_PREFETCH_VIDEO_LIMIT = 96;
const PROJECT_SEEN_STORAGE_KEY = "app-sidebar-project-seen-updates";
const SHELL_PROJECT_CACHE_KEY = "workbench-sidebar-projects-v1";
let exploreCatalogWarmPromise: Promise<void> | null = null;
let homeDataHydrationPromise: Promise<{
  characters: ReferenceTile[];
  environments: ReferenceTile[];
  projects: HomeProjectCard[];
}> | null = null;

function warmExploreCatalog() {
  if (typeof window === "undefined") return;
  exploreCatalogWarmPromise ??= Promise.allSettled([
    fetch("/api/explore/references", { cache: "force-cache" }),
    fetch(`/api/explore/videos?limit=${EXPLORE_PREFETCH_VIDEO_LIMIT}`, { cache: "force-cache" }),
  ]).then(() => undefined);
}

export function useProjectDirectory() {
  return useContext(ProjectDirectoryContext);
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

function isReferenceTile(value: unknown): value is ReferenceTile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReferenceTile>;
  return (
    typeof candidate.gradientIndex === "number" &&
    typeof candidate.id === "string" &&
    (typeof candidate.imageUrl === "string" || candidate.imageUrl === null) &&
    typeof candidate.projectId === "string" &&
    typeof candidate.projectName === "string" &&
    typeof candidate.title === "string" &&
    (candidate.type === "character" || candidate.type === "environment")
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

function readCachedHomeProjects() {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SHELL_PROJECT_CACHE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter(isHomeProjectCard) : [];
  } catch {
    return [];
  }
}

function writeCachedHomeProjects(projects: HomeProjectCard[]) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(SHELL_PROJECT_CACHE_KEY, JSON.stringify(projects));
  } catch {
    // Best-effort warm cache; the app can still hydrate from the API.
  }
}

function hydrateHomeData() {
  homeDataHydrationPromise ??= fetch("/api/home-data", { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error("Failed to load home data.");
      return response.json();
    })
    .then((data) => ({
      characters: Array.isArray(data?.characters) ? data.characters.filter(isReferenceTile) : [],
      environments: Array.isArray(data?.environments) ? data.environments.filter(isReferenceTile) : [],
      projects: Array.isArray(data?.projects) ? data.projects.filter(isHomeProjectCard) : [],
    }))
    .catch(() => ({
      characters: [],
      environments: [],
      projects: [],
    }));
  return homeDataHydrationPromise;
}

function readSeenProjectUpdates(projects: HomeProjectCard[]) {
  const currentEntries = Object.fromEntries(projects.map((project) => [project.id, project.updatedAt]));
  if (typeof window === "undefined") return currentEntries;
  try {
    const parsed = JSON.parse(localStorage.getItem(PROJECT_SEEN_STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return currentEntries;
    const storedEntries = Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
    return { ...currentEntries, ...storedEntries };
  } catch {
    return currentEntries;
  }
}

function projectIdFromPathname(pathname: string) {
  const match = pathname.match(/^\/projects\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

function isProjectUnread(project: HomeProjectCard, seenProjectUpdates: Record<string, string>) {
  const seenUpdatedAt = seenProjectUpdates[project.id];
  if (!seenUpdatedAt) return false;
  return new Date(project.updatedAt).getTime() > new Date(seenUpdatedAt).getTime();
}

function formatNotificationTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "now";
  const diffMs = Date.now() - parsed.getTime();
  if (diffMs < 60_000) return "now";
  if (diffMs < 3_600_000) return `${Math.max(1, Math.round(diffMs / 60_000))}m ago`;
  if (diffMs < 86_400_000) return `${Math.max(1, Math.round(diffMs / 3_600_000))}h ago`;
  return parsed.toLocaleDateString("en", { day: "numeric", month: "short" });
}

export function SidebarNotifications({
  menuSide = "top",
  nativeTitle,
}: {
  menuSide?: "bottom" | "top";
  nativeTitle: boolean;
}) {
  const [open, setOpen] = useState(false);
  const notifications = useUserMessageNotifications();

  useEffect(() => {
    void loadUserMessageNotifications().catch((error) => {
      console.error("[notifications] Failed to load notifications:", error);
    });
  }, []);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) return;
    void loadUserMessageNotifications()
      .then(() => markUserMessageNotificationsRead())
      .catch((error) => {
        console.error("[notifications] Failed to update notifications:", error);
      });
  }

  return (
    <div className="app-sidebar-notifications">
      <Menu onOpenChange={handleOpenChange} open={open}>
        <MenuTrigger asChild>
          <button
            aria-label="Notifications"
            className={`app-sidebar-icon-button ${open ? "active" : ""}`}
            title={nativeTitle ? "Notifications" : undefined}
            type="button"
          >
            <Bell size={16} />
            {notifications.hasUnread ? <span className="app-sidebar-notification-dot" aria-hidden="true" /> : null}
          </button>
        </MenuTrigger>
        <MenuContent
          align={menuSide === "bottom" ? "end" : "start"}
          className="app-menu-notifications"
          side={menuSide}
          sideOffset={12}
        >
          <div className="app-menu-notifications-head">
            <Bell size={15} />
            <strong>Notifications</strong>
          </div>
          <div className="app-menu-notifications-scroll">
            {!notifications.hasLoaded ? (
              <div className="app-notification-empty">Loading notifications...</div>
            ) : notifications.items.length ? (
              notifications.items.map((notification) => (
                <div className="app-notification-card" key={notification.id}>
                  <div className="app-notification-copy">
                    <div className="app-notification-title-row">
                      {!notification.isRead ? (
                        <span aria-label="Unread" className="app-notification-unread-dot" role="img" />
                      ) : null}
                      <h3>{notification.title}</h3>
                    </div>
                    {notification.subtext ? <p>{notification.subtext}</p> : null}
                    <span>{formatNotificationTime(notification.publishedAt)}</span>
                  </div>
                  <div className="app-notification-thumb" aria-hidden="true">
                    {notification.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img alt="" src={notification.thumbnailUrl} />
                    ) : (
                      <ImpracticalLogo />
                    )}
                  </div>
                </div>
              ))
            ) : (
              <div className="app-notification-empty">No notifications yet.</div>
            )}
          </div>
        </MenuContent>
      </Menu>
    </div>
  );
}

export type AgentPresenceState = {
  claude: boolean;
  codex: boolean;
  connected: boolean;
};

/** Polls which agent sessions are currently connected to this desktop. */
export function useAgentPresence(): AgentPresenceState {
  const [presence, setPresence] = useState<AgentPresenceState>({
    claude: false,
    codex: false,
    connected: false,
  });
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const response = await fetch("/api/agent-presence", {
          cache: "no-store",
        });
        const payload = (await response.json()) as Partial<AgentPresenceState>;
        if (!cancelled) {
          setPresence({
            claude: Boolean(payload.claude),
            codex: Boolean(payload.codex),
            connected: Boolean(payload.connected),
          });
        }
      } catch {
        if (!cancelled) {
          setPresence({ claude: false, codex: false, connected: false });
        }
      }
    };
    void check();
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void check();
    }, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);
  return presence;
}

export function agentPresenceLabel(presence: AgentPresenceState) {
  if (presence.claude && presence.codex) return "Claude & Codex connected";
  if (presence.claude) return "Claude connected";
  if (presence.codex) return "Codex connected";
  if (presence.connected) return "Agent connected";
  return "No agent session connected";
}

/** Per-agent live status rows shown inside the lightning popover. */
export function AgentSessionRows({
  presence,
}: {
  presence: AgentPresenceState;
}) {
  return (
    <div className="agent-session-rows">
      {(
        [
          { connected: presence.claude, name: "Claude" },
          { connected: presence.codex, name: "Codex" },
        ] as const
      ).map(({ connected, name }) => (
        <div className="agent-session-row" key={name}>
          <span
            aria-hidden
            className={`agent-session-dot${connected ? " is-connected" : ""}`}
          />
          <strong>{name}</strong>
          <span className={connected ? "is-connected" : undefined}>
            {connected ? "Connected" : "Not connected"}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The popover footer: Codex (black, left) and Claude (orange, right). */
export function AgentLaunchFooter({
  disabled = false,
  onLaunch,
}: {
  disabled?: boolean;
  onLaunch: (agent: "claude" | "codex") => void;
}) {
  return (
    <div className="agent-launch-footer">
      <button
        className="agent-launch-button is-codex"
        disabled={disabled}
        onClick={() => onLaunch("codex")}
        type="button"
      >
        <TerminalIcon aria-hidden size={13} />
        Open Codex in Terminal
      </button>
      <button
        className="agent-launch-button is-claude"
        disabled={disabled}
        onClick={() => onLaunch("claude")}
        type="button"
      >
        <TerminalIcon aria-hidden size={13} />
        Open Claude in Terminal
      </button>
    </div>
  );
}

export function launchAgentSession(agent: "claude" | "codex", projectId: string) {
  void fetch("/api/agent-launch", {
    body: JSON.stringify({ agent, projectId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).catch(() => {});
}

function resolveSystemTheme() {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function getStoredThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const stored = localStorage.getItem("theme");
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function applyThemePreference(preference: ThemePreference) {
  const theme = preference === "system" ? resolveSystemTheme() : preference;
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("theme", preference);
}

function SidebarThemeSection() {
  const [preference, setPreference] = useState<ThemePreference>(() => getStoredThemePreference());

  useEffect(() => {
    applyThemePreference(preference);
  }, [preference]);

  useEffect(() => {
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = () => applyThemePreference("system");
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [preference]);

  function handleThemeChange(value: string) {
    if (value !== "light" && value !== "dark" && value !== "system") return;
    setPreference(value);
    applyThemePreference(value);
  }

  return (
    <div className="app-menu-theme-section">
      <MenuLabel className="app-menu-theme-label">Theme</MenuLabel>
      <MenuRadioGroup onValueChange={handleThemeChange} value={preference}>
        <MenuRadioItem value="light">Light</MenuRadioItem>
        <MenuRadioItem value="dark">Dark</MenuRadioItem>
        <MenuRadioItem value="system">System</MenuRadioItem>
      </MenuRadioGroup>
    </div>
  );
}

export function SidebarAuthBadge({
  menuSide = "top",
  nativeTitle,
}: {
  menuSide?: "bottom" | "top";
  nativeTitle: boolean;
}) {
  const { isLocal, isSignedIn, openUserProfile, signOut, user } = useAppAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [showBuyCredits, setShowBuyCredits] = useState(false);
  const [showApiKeys, setShowApiKeys] = useState(false);
  const displayName = user?.fullName || user?.email || "Account";
  const email = user?.email;
  const billingUiEnabled = useGenerationBilling();

  return (
    <div className="app-sidebar-auth">
      <Menu>
        <MenuTrigger asChild>
          <button
            aria-label={isSignedIn ? "Account" : "Sign in"}
            className="app-sidebar-auth-trigger"
            title={nativeTitle ? (isSignedIn ? "Account" : "Sign in") : undefined}
            type="button"
          >
            {isSignedIn && user?.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img alt="" className="app-sidebar-user-avatar" src={user.imageUrl} />
            ) : isSignedIn ? (
              <span className="app-sidebar-user-avatar app-sidebar-user-avatar-fallback">
                <UserRound size={16} />
              </span>
            ) : (
              <LogIn size={16} />
            )}
          </button>
        </MenuTrigger>
        <MenuContent
          align={menuSide === "bottom" ? "end" : "start"}
          className="app-menu-account"
          side={menuSide}
          sideOffset={12}
        >
          <div className="app-menu-account-head">
            <span className="app-menu-account-avatar">
              {isSignedIn && user?.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img alt="" src={user.imageUrl} />
              ) : (
                <UserRound size={18} />
              )}
            </span>
            <div className="app-menu-account-id">
              <strong>{isSignedIn ? displayName : "Guest"}</strong>
              <small>{isSignedIn ? (email ?? "Signed in") : "Sign in to save your work"}</small>
            </div>
          </div>

          <MenuSeparator />

          {isSignedIn ? (
            <>
              {billingUiEnabled ? (
                <>
                  <CreditMenuSection onRequestPurchase={() => setShowBuyCredits(true)} />
                  <MenuSeparator />
                </>
              ) : null}

              <MenuItem onSelect={() => router.push("/?setup=1")}>
                <Settings size={16} />
                Setup guide
              </MenuItem>
              {pathname.startsWith("/projects/") ? (
                <MenuItem onSelect={() => window.dispatchEvent(new Event("impractical:project-tour"))}>
                  <Compass size={16} />
                  Project tour
                </MenuItem>
              ) : null}
              {isLocal ? (
                <MenuItem onSelect={() => setShowApiKeys(true)}>
                  <KeyRound size={16} />
                  API keys
                </MenuItem>
              ) : null}
              <MenuItem onSelect={() => showIntercomSupport()}>
                <CircleHelp size={16} />
                Support
              </MenuItem>
              {(!isLocal || billingUiEnabled) ? (
                <MenuItem onSelect={() => openUserProfile()}>
                  <Settings size={16} />
                  Account settings
                </MenuItem>
              ) : null}

              <MenuSeparator />

              <SidebarThemeSection />

              {(!isLocal || billingUiEnabled) ? (
                <>
                  <MenuSeparator />
                  <MenuItem onSelect={() => void signOut({ redirectUrl: "/" })}>
                    <LogOut size={16} />
                    Sign out
                  </MenuItem>
                </>
              ) : null}
            </>
          ) : (
            <>
              <SidebarThemeSection />

              <MenuSeparator />

              <MenuItem onSelect={() => router.push("/sign-in")}>
                <LogIn size={16} />
                Sign in
              </MenuItem>
            </>
          )}
        </MenuContent>
      </Menu>
      {billingUiEnabled ? (
        <BuyCreditsModal open={showBuyCredits} onOpenChange={setShowBuyCredits} />
      ) : null}
      {isLocal && showApiKeys ? <ProviderSettings onOpenChange={setShowApiKeys} /> : null}
    </div>
  );
}

export function AppShell({
  children,
  contentClassName = "",
  initialCharacters = [],
  initialEnvironments = [],
  initialProjects,
  initialSignedIn = false,
}: {
  children: ReactNode;
  contentClassName?: string;
  initialCharacters?: ReferenceTile[];
  initialEnvironments?: ReferenceTile[];
  initialProjects: HomeProjectCard[];
  initialSignedIn?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { isLoaded: authLoaded, isSignedIn } = useAppAuth();
  // Seeded from the server (`auth()`) so the first paint already knows the
  // real state — signed-in users never flash a stripped sidebar.
  const signedIn = authLoaded ? Boolean(isSignedIn) : initialSignedIn;
  const [characters, setCharacters] = useState(initialCharacters);
  const [environments, setEnvironments] = useState(initialEnvironments);
  // localStorage-backed state initializes to the server-renderable value and
  // hydrates after mount — reading storage during the first render makes the
  // SSR HTML disagree with the client and fails hydration.
  const [projects, setProjects] = useState<HomeProjectCard[]>(initialProjects);
  const [activeProjectIds, setActiveProjectIds] = useState<Set<string>>(
    () =>
      new Set(
        initialProjects
          .filter((project) => project.isWorking)
          .map((project) => project.id),
      ),
  );
  const activeProjectIdsRef = useRef(
    new Set(
      initialProjects
        .filter((project) => project.isWorking)
        .map((project) => project.id),
    ),
  );
  const [seenProjectUpdates, setSeenProjectUpdates] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState(false);
  const [sidebarTransitioning, setSidebarTransitioning] = useState(false);
  const hasMountedSidebarTransitionRef = useRef(false);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sidebarError, setSidebarError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(localStorage.getItem("app-sidebar-collapsed") === "true");
    const base = initialProjects.length ? initialProjects : readCachedHomeProjects();
    if (!initialProjects.length && base.length) {
      setProjects(base);
      const working = new Set(
        base.filter((project) => project.isWorking).map((project) => project.id),
      );
      setActiveProjectIds(working);
      activeProjectIdsRef.current = working;
    }
    setSeenProjectUpdates(readSeenProjectUpdates(base));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasHydratedCollapsedRef = useRef(false);
  useEffect(() => {
    // Skip the pre-hydration first run so the stored value isn't clobbered.
    if (!hasHydratedCollapsedRef.current) {
      hasHydratedCollapsedRef.current = true;
      return;
    }
    localStorage.setItem("app-sidebar-collapsed", collapsed ? "true" : "false");
  }, [collapsed]);

  useEffect(() => {
    if (!hasMountedSidebarTransitionRef.current) {
      hasMountedSidebarTransitionRef.current = true;
      return;
    }
    setSidebarTransitioning(true);
    const timeout = window.setTimeout(() => setSidebarTransitioning(false), 260);
    return () => window.clearTimeout(timeout);
  }, [collapsed]);

  useEffect(() => {
    localStorage.setItem(PROJECT_SEEN_STORAGE_KEY, JSON.stringify(seenProjectUpdates));
  }, [seenProjectUpdates]);

  useEffect(() => {
    router.prefetch("/");
    router.prefetch("/projects");
    router.prefetch("/explore");
    router.prefetch("/library");
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    void hydrateHomeData().then((homeData) => {
      if (cancelled) return;
      setCharacters(homeData.characters);
      setEnvironments(homeData.environments);
      if (homeData.projects.length) {
        const nextActiveProjectIds = new Set(
          homeData.projects.filter((project) => project.isWorking).map((project) => project.id),
        );
        activeProjectIdsRef.current = nextActiveProjectIds;
        setActiveProjectIds(nextActiveProjectIds);
        setProjects((current) => {
          const hydratedIds = new Set(homeData.projects.map((project) => project.id));
          const localOnlyProjects = current.filter((project) => !hydratedIds.has(project.id));
          const nextProjects = [...localOnlyProjects, ...homeData.projects];
          writeCachedHomeProjects(nextProjects);
          return nextProjects;
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshProjectMetadata = useCallback(async () => {
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json().catch(() => null);
      if (!data || !Array.isArray(data.projects)) return;
      const projectRows: ProjectMeta[] = data.projects.filter((project: unknown): project is ProjectMeta => {
        if (!project || typeof project !== "object") return false;
        const candidate = project as Record<string, unknown>;
        return (
          typeof candidate.id === "string" &&
          typeof candidate.name === "string" &&
          typeof candidate.createdAt === "string" &&
          typeof candidate.updatedAt === "string"
        );
      });
      const projectMetaById = new Map<string, ProjectMeta>(
        projectRows.map((project) => [project.id, project]),
      );
      setProjects((current) => {
        const nextProjects = current.map((project) => {
          const meta = projectMetaById.get(project.id);
          return meta
            ? { ...project, createdAt: meta.createdAt, name: meta.name, updatedAt: meta.updatedAt }
            : project;
        });
        writeCachedHomeProjects(nextProjects);
        return nextProjects;
      });
    } catch {
      // Best-effort metadata refresh for unread indicators.
    }
  }, []);

  const refreshActiveRuns = useCallback(async () => {
    try {
      const response = await fetch("/api/projects/active-runs", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json().catch(() => null);
      if (!data || !Array.isArray(data.projectIds)) return;
      const nextActiveProjectIds = new Set<string>(
        data.projectIds.filter((projectId: unknown): projectId is string => typeof projectId === "string"),
      );
      const hadCompletedRun = [...activeProjectIdsRef.current].some((projectId) => !nextActiveProjectIds.has(projectId));
      activeProjectIdsRef.current = nextActiveProjectIds;
      setActiveProjectIds(nextActiveProjectIds);
      if (hadCompletedRun) void refreshProjectMetadata();
    } catch {
      // Best-effort sidebar presence signal.
    }
  }, [refreshProjectMetadata]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void refreshActiveRuns(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [pathname, refreshActiveRuns]);

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

  const currentProjectId = useMemo(() => projectIdFromPathname(pathname), [pathname]);

  const markProjectSeen = useCallback((project: Pick<HomeProjectCard, "id" | "updatedAt">) => {
    setSeenProjectUpdates((current) => {
      if (current[project.id] === project.updatedAt) return current;
      return { ...current, [project.id]: project.updatedAt };
    });
  }, []);

  useEffect(() => {
    if (!currentProjectId) return;
    const project = projects.find((item) => item.id === currentProjectId);
    if (!project) return;
    const timeoutId = window.setTimeout(() => markProjectSeen(project), 0);
    return () => window.clearTimeout(timeoutId);
  }, [currentProjectId, markProjectSeen, projects]);

  const createProject = useCallback(
    async (name = "Untitled video", initialPrompt?: string) => {
      if (creating) throw new Error("A project is already being created.");
      setCreating(true);
      try {
        const response = await fetch("/api/projects", {
          body: JSON.stringify({ name: name.trim() || "Untitled video" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.project) {
          throw new Error(data.error || "Create failed.");
        }
        const project = data.project as ProjectMeta;
        startNavigationProgress();
        setSeenProjectUpdates((current) => ({ ...current, [project.id]: project.updatedAt }));
        setProjects((current) => {
          const nextProjects = [
            toHomeProjectCard(project),
            ...current.filter((item) => item.id !== project.id),
          ];
          writeCachedHomeProjects(nextProjects);
          return nextProjects;
        });
        router.push(
          initialPrompt?.trim()
            ? `/projects/${project.id}?prompt=${encodeURIComponent(initialPrompt.trim())}`
            : `/projects/${project.id}`,
        );
        return project;
      } finally {
        setCreating(false);
      }
    },
    [creating, router],
  );

  const deleteProject = useCallback(
    async (project: ProjectMeta) => {
      if (deletingId) throw new Error("A project is already being deleted.");
      setDeletingId(project.id);
      try {
        const response = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || "Delete failed.");
        }
        setProjects((current) => {
          const nextProjects = current.filter((item) => item.id !== project.id);
          writeCachedHomeProjects(nextProjects);
          return nextProjects;
        });
        setSeenProjectUpdates((current) => {
          const next = { ...current };
          delete next[project.id];
          return next;
        });
        setCharacters((current) => current.filter((item) => item.projectId !== project.id));
        setEnvironments((current) => current.filter((item) => item.projectId !== project.id));
      } finally {
        setDeletingId(null);
      }
    },
    [deletingId],
  );

  const projectsWithActivity = useMemo(
    () =>
      projects.map((project) => {
        const isWorking = activeProjectIds.has(project.id);
        return project.isWorking === isWorking ? project : { ...project, isWorking };
      }),
    [activeProjectIds, projects],
  );

  const value = useMemo(
    () => ({
      characters,
      creating,
      createProject,
      deletingId,
      deleteProject,
      environments,
      projects: projectsWithActivity,
      setProjects,
    }),
    [characters, creating, createProject, deletingId, deleteProject, environments, projectsWithActivity],
  );
  const recentProjects = useMemo(() => projectsWithActivity.slice(0, 8), [projectsWithActivity]);

  useEffect(() => {
    recentProjects.forEach((project) => {
      router.prefetch(`/projects/${project.id}`);
    });
  }, [recentProjects, router]);

  const shellClassName = [
    "app-shell",
    collapsed ? "is-sidebar-collapsed" : "",
    sidebarTransitioning ? "is-sidebar-transitioning" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const mainClassName = ["app-main", contentClassName].filter(Boolean).join(" ");

  async function createProjectFromSidebar() {
    setSidebarError(null);
    try {
      await createProject();
    } catch (caught) {
      setSidebarError(caught instanceof Error ? caught.message : "Create failed.");
    }
  }

  function sidebarTooltip(label: string, child: ReactElement, key?: string) {
    if (!collapsed) return child;
    return (
      <Tooltip key={key}>
        <TooltipTrigger asChild>{child}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={14}>
          {label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <ProjectDirectoryContext.Provider value={value}>
      <StartContinuation />
      <TooltipProvider delayDuration={120} skipDelayDuration={80}>
        <div className={shellClassName}>
          <DesktopWindowChrome
            availableProjects={projectsWithActivity.map(({ id, name }) => ({
              id,
              name,
            }))}
            rightActions={
              <>
                {signedIn ? (
                  <ChromeTip label="Notifications">
                    <span className="inline-flex">
                      <SidebarNotifications menuSide="bottom" nativeTitle />
                    </span>
                  </ChromeTip>
                ) : null}
                <ChromeTip label="Account">
                  <span className="inline-flex">
                    <SidebarAuthBadge menuSide="bottom" nativeTitle />
                  </span>
                </ChromeTip>
              </>
            }
          />
          <aside className="app-sidebar" aria-label="Application navigation">
            <div className="app-sidebar-head">
              <div className="app-logo-slot">
                {sidebarTooltip(
                  "Home",
                  <Link className="app-logo" href="/" title={collapsed ? undefined : "Home"}>
                    <span className="app-logo-mark" aria-hidden="true">
                      <ImpracticalLogo className="app-logo-svg" />
                    </span>
                    <span className="app-logo-copy">
                      <strong>Impractical</strong>
                    </span>
                  </Link>,
                )}
                {sidebarTooltip(
                  collapsed ? "Expand sidebar" : "Collapse sidebar",
                  <button
                    aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                    className="app-logo-hover-toggle"
                    onClick={() => setCollapsed((current) => !current)}
                    title={collapsed ? undefined : "Collapse sidebar"}
                    type="button"
                  >
                    {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
                  </button>,
                )}
              </div>
              <button
                aria-expanded={!collapsed}
                aria-label="Collapse sidebar"
                className="app-sidebar-toggle"
                onClick={() => setCollapsed((current) => !current)}
                title="Collapse sidebar"
                type="button"
              >
                <PanelLeftClose size={15} />
              </button>
            </div>

            <nav className="app-sidebar-nav" aria-label="Primary">
              {sidebarTooltip(
                "Home",
                <Link
                  aria-current={pathname === "/" ? "page" : undefined}
                  className={`app-sidebar-link ${pathname === "/" ? "active" : ""}`}
                  href="/"
                  title={collapsed ? undefined : "Home"}
                >
                  <Home size={18} />
                  <span>Home</span>
                </Link>,
              )}
              {signedIn
                ? sidebarTooltip(
                    "Projects",
                    <Link
                      aria-current={pathname === "/projects" ? "page" : undefined}
                      className={`app-sidebar-link ${pathname === "/projects" ? "active" : ""}`}
                      href="/projects"
                      title={collapsed ? undefined : "Projects"}
                    >
                      <LayoutGrid size={18} />
                      <span>Projects</span>
                    </Link>,
                  )
                : null}
              {sidebarTooltip(
                "Explore",
                <Link
                  aria-current={pathname.startsWith("/explore") ? "page" : undefined}
                  className={`app-sidebar-link ${pathname.startsWith("/explore") ? "active" : ""}`}
                  href="/explore"
                  onClick={warmExploreCatalog}
                  onFocus={warmExploreCatalog}
                  onPointerEnter={warmExploreCatalog}
                  title={collapsed ? undefined : "Explore"}
                >
                  <Compass size={18} />
                  <span>Explore</span>
                </Link>,
              )}
              {signedIn
                ? sidebarTooltip(
                    "Library",
                    <Link
                      aria-current={pathname.startsWith("/library") ? "page" : undefined}
                      className={`app-sidebar-link ${pathname.startsWith("/library") ? "active" : ""}`}
                      href="/library"
                      title={collapsed ? undefined : "Library"}
                    >
                      <Library size={18} />
                      <span>Library</span>
                    </Link>,
                  )
                : null}
            </nav>

            {sidebarError ? <div className="app-sidebar-error">{sidebarError}</div> : null}

            {signedIn ? (
            <div className="app-sidebar-section">
              <div className="app-sidebar-label">Recents</div>
              <div className="app-sidebar-projects">
                {recentProjects.length ? (
                  recentProjects.map((project) => {
                    const unread = isProjectUnread(project, seenProjectUpdates);
                    return sidebarTooltip(
                      unread ? `${project.name} has unread updates` : project.name,
                      <Link
                        key={project.id}
                        className={`app-sidebar-project${project.isWorking ? " is-working" : ""}${unread ? " is-unread" : ""}`}
                        href={`/projects/${project.id}`}
                        onClick={() => markProjectSeen(project)}
                        title={collapsed ? undefined : project.name}
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
                        {unread ? <span className="app-sidebar-project-unread-dot" aria-hidden="true" /> : null}
                      </Link>,
                      project.id,
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
            ) : null}

            <div className="app-sidebar-footer">
              {sidebarTooltip("Account", <SidebarAuthBadge nativeTitle={!collapsed} />)}
              {signedIn
                ? sidebarTooltip(
                    "Notifications",
                    <SidebarNotifications nativeTitle={!collapsed} />,
                  )
                : null}
            </div>
          </aside>
          <div className="app-main-col">
            {!signedIn ? (
              <Link className="free-credits-banner" href="/sign-up">
                <span className="free-credits-banner-spark" aria-hidden="true" />
                <span>
                  Get started with <strong>150 free credits</strong>
                </span>
                <ArrowRight size={15} aria-hidden="true" />
              </Link>
            ) : null}
            <main className={mainClassName}>{children}</main>
          </div>
        </div>
      </TooltipProvider>
    </ProjectDirectoryContext.Provider>
  );
}
