"use client";

import {
  ArrowRight,
  Check,
  ChevronDown,
  Film,
  LayoutGrid,
  LayoutList,
  List,
  MoreHorizontal,
  Plus,
  Search,
  Share2,
  Sparkles,
  Star,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useProjectDirectory } from "@/app/app-shell";
import { refreshCredits } from "@/lib/credit-context";
import type { HomeProjectCard } from "@/app/home-data";
import { MediaThumb } from "@/app/media-thumb";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { userFacingError } from "@/lib/user-facing-error";

type SortValue = "last-edited" | "title-asc" | "title-desc";

type FilterOption = { label: string; value: string };

function resolveSortLabel(value: SortValue) {
  if (value === "title-asc") return "Title A-Z";
  if (value === "title-desc") return "Title Z-A";
  return "Last edited";
}

function projectDate(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

const VISIBILITY_OPTIONS: FilterOption[] = [
  { label: "Any visibility", value: "any" },
  { label: "Private", value: "private" },
  { label: "Shared", value: "shared" },
  { label: "Public", value: "public" },
];

const STATUS_OPTIONS: FilterOption[] = [
  { label: "Any status", value: "any" },
  { label: "Draft", value: "draft" },
  { label: "Published", value: "published" },
];

const CREATOR_OPTIONS: FilterOption[] = [
  { label: "All creators", value: "all" },
  { label: "Only me", value: "me" },
];

const ACTIVITY_BUCKETS = ["Today", "Previous 7 days", "Previous 30 days", "Older"] as const;

function activityBucket(iso: string) {
  const day = 86_400_000;
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < day) return ACTIVITY_BUCKETS[0];
  if (diff < 7 * day) return ACTIVITY_BUCKETS[1];
  if (diff < 30 * day) return ACTIVITY_BUCKETS[2];
  return ACTIVITY_BUCKETS[3];
}

function ToolbarMenu({
  options,
  onValueChange,
  value,
}: {
  options: FilterOption[];
  onValueChange: (value: string) => void;
  value: string;
}) {
  const label = options.find((option) => option.value === value)?.label ?? options[0]?.label;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="projects-filter" type="button">
          <span>{label}</span>
          <ChevronDown size={18} />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="projects-filter-menu">
        <MenuRadioGroup onValueChange={onValueChange} value={value}>
          {options.map((option) => (
            <MenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

export function ProjectList({
  description,
  initialProjects,
  limit,
  title = "Projects",
  variant,
}: {
  description?: string;
  initialProjects: HomeProjectCard[];
  limit?: number;
  title?: string;
  variant?: "home" | "projects";
}) {
  const router = useRouter();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");
    if (!checkout) return;
    const sessionId = params.get("session_id");
    params.delete("checkout");
    params.delete("credits");
    params.delete("session_id");
    params.delete("tier");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);

    if (checkout === "canceled") {
      toast("Checkout canceled — no charge was made.");
      return;
    }
    if (checkout !== "success") return;

    if (!sessionId) {
      toast.success("Payment complete.");
      refreshCredits();
      return;
    }

    const controller = new AbortController();
    void fetch(`/api/checkout/credits/confirm?session_id=${encodeURIComponent(sessionId)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as {
          credits?: number;
          error?: string;
        };
        if (!response.ok) throw new Error(data.error || "Could not confirm the payment.");
        refreshCredits();
        const purchased = Number(data.credits);
        toast.success(
          Number.isFinite(purchased)
            ? `${purchased.toLocaleString("en-US")} credits added to your balance.`
            : "Credits added to your balance.",
        );
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        toast.error(caught instanceof Error ? caught.message : "Could not confirm the payment.");
      });

    return () => controller.abort();
  }, []);
  const directory = useProjectDirectory();
  const [localProjects, setLocalProjects] = useState(initialProjects);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortValue, setSortValue] = useState<SortValue>("last-edited");
  const [visibility, setVisibility] = useState("any");
  const [status, setStatus] = useState("any");
  const [creator, setCreator] = useState("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [grouped, setGrouped] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<HomeProjectCard | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [creatingLocal, setCreatingLocal] = useState(false);
  const resolvedVariant = variant ?? (limit ? "home" : "projects");
  const isProjectsView = resolvedVariant === "projects";
  const projects = directory?.projects ?? localProjects;
  const activeDeletingId = directory?.deletingId ?? deletingId;
  const creating = Boolean(directory?.creating || creatingLocal);

  const visibleProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    let nextProjects = normalizedQuery
      ? projects.filter((project) => project.name.toLowerCase().includes(normalizedQuery))
      : projects;

    nextProjects = [...nextProjects].sort((left, right) => {
      if (sortValue === "title-asc") return left.name.localeCompare(right.name);
      if (sortValue === "title-desc") return right.name.localeCompare(left.name);
      return right.updatedAt.localeCompare(left.updatedAt);
    });

    return typeof limit === "number" ? nextProjects.slice(0, limit) : nextProjects;
  }, [limit, projects, query, sortValue]);

  const groups = useMemo(() => {
    if (!grouped) return [{ label: null as string | null, items: visibleProjects }];
    return ACTIVITY_BUCKETS.map((bucket) => ({
      label: bucket as string | null,
      items: visibleProjects.filter((project) => activityBucket(project.updatedAt) === bucket),
    })).filter((group) => group.items.length > 0);
  }, [grouped, visibleProjects]);

  async function createProject() {
    if (creating) return;
    setError(null);
    setCreatingLocal(true);
    try {
      if (directory) {
        await directory.createProject();
      } else {
        const response = await fetch("/api/projects", {
          body: JSON.stringify({ name: "Untitled video" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.project) throw new Error(data.error || "Create failed.");
      }
      toast.success("Project created.");
    } catch (caught) {
      const message = userFacingError(caught, "Create failed.");
      setError(message);
      toast.error(message);
    } finally {
      setCreatingLocal(false);
    }
  }

  async function removeProject(project: HomeProjectCard) {
    if (directory) {
      await directory.deleteProject(project);
    } else {
      const response = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Delete failed.");
      }
      setLocalProjects((current) => current.filter((item) => item.id !== project.id));
    }
  }

  function requestDelete(project: HomeProjectCard) {
    if (activeDeletingId) return;
    setPendingDelete(project);
  }

  async function confirmDelete() {
    const project = pendingDelete;
    if (!project) return;
    setDeletingId(project.id);
    setError(null);
    try {
      await removeProject(project);
      toast.success("Project deleted.");
    } catch (caught) {
      const message = userFacingError(caught, "Delete failed.");
      setError(message);
      toast.error(message);
    } finally {
      setDeletingId(null);
      setPendingDelete(null);
    }
  }

  async function confirmBulkDelete() {
    const targets = visibleProjects.filter((project) => selected.has(project.id));
    setError(null);
    try {
      for (const project of targets) {
        await removeProject(project);
      }
      setSelected(new Set());
      setSelectionMode(false);
      toast.success(targets.length === 1 ? "Project deleted." : "Projects deleted.");
    } catch (caught) {
      const message = userFacingError(caught, "Delete failed.");
      setError(message);
      toast.error(message);
    } finally {
      setBulkConfirm(false);
    }
  }

  const deleteDialogs = (
    <>
      <Dialog
        open={pendingDelete != null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project?</DialogTitle>
            <DialogDescription>
              “{pendingDelete?.name}” will be moved to trash. You can’t undo this from here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <button className="dialog-btn" type="button">
                Cancel
              </button>
            </DialogClose>
            <button
              className="dialog-btn dialog-btn-danger"
              disabled={activeDeletingId != null}
              onClick={() => void confirmDelete()}
              type="button"
            >
              {activeDeletingId != null ? "Deleting…" : "Delete"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkConfirm} onOpenChange={setBulkConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {selected.size} project{selected.size === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>The selected projects will be moved to trash.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <button className="dialog-btn" type="button">
                Cancel
              </button>
            </DialogClose>
            <button
              className="dialog-btn dialog-btn-danger"
              onClick={() => void confirmBulkDelete()}
              type="button"
            >
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleFavorite(id: string) {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function shareProject(project: HomeProjectCard) {
    const url = `${window.location.origin}/projects/${project.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(project.id);
      window.setTimeout(() => setCopiedId((current) => (current === project.id ? null : current)), 1400);
    } catch {
      setError("Couldn't copy the project link.");
      toast.error("Couldn't copy the project link.");
    }
  }

  function renderCard(project: HomeProjectCard) {
    const isSelected = selected.has(project.id);
    const isFavorite = favorites.has(project.id);
    const thumb = (
      <MediaThumb
        className="lv-card-media"
        gradientIndex={project.gradientIndex}
        kind={project.thumbnailKind ?? "project"}
        src={project.thumbnailUrl}
        title={project.name}
      />
    );
    return (
      <article
        className={`lv-card${isSelected ? " is-selected" : ""}`}
        data-project-card
        key={project.id}
      >
        <div className="lv-card-thumb">
          {selectionMode ? (
            <button
              aria-pressed={isSelected}
              className="lv-card-thumb-link"
              onClick={() => toggleSelected(project.id)}
              type="button"
            >
              {thumb}
            </button>
          ) : (
            <Link aria-label={project.name} className="lv-card-thumb-link" href={`/projects/${project.id}`}>
              {thumb}
            </Link>
          )}
          {selectionMode ? (
            <span className={`lv-card-check${isSelected ? " is-on" : ""}`} aria-hidden="true">
              {isSelected ? <Check size={15} strokeWidth={3} /> : null}
            </span>
          ) : (
            <button
              aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={isFavorite}
              className={`lv-card-fav${isFavorite ? " is-active" : ""}`}
              onClick={() => toggleFavorite(project.id)}
              type="button"
            >
              <Star size={18} />
            </button>
          )}
        </div>

        <div className="lv-card-meta">
          <span className="lv-card-avatar" aria-hidden="true">
            <UserRound size={18} />
          </span>
          <div className="lv-card-meta-text">
            <div className="lv-card-meta-top">
              {selectionMode ? (
                <span className="lv-card-name lv-card-name-static">
                  <p>{project.name}</p>
                </span>
              ) : (
                <Link className="lv-card-name" href={`/projects/${project.id}`}>
                  <p>{project.name}</p>
                </Link>
              )}
              <div className="lv-card-actions">
                <button
                  aria-label={`Share ${project.name}`}
                  className="lv-card-action"
                  onClick={() => void shareProject(project)}
                  type="button"
                >
                  {copiedId === project.id ? <Check size={17} /> : <Share2 size={17} />}
                </button>
                <Menu>
                  <MenuTrigger asChild>
                    <button
                      aria-label={`More options for ${project.name}`}
                      className="lv-card-action"
                      disabled={activeDeletingId === project.id}
                      type="button"
                    >
                      <MoreHorizontal size={17} />
                    </button>
                  </MenuTrigger>
                  <MenuContent align="end">
                    <MenuItem onSelect={() => void shareProject(project)}>
                      <Share2 size={16} />
                      Share
                    </MenuItem>
                    <MenuItem variant="destructive" onSelect={() => requestDelete(project)}>
                      <Trash2 size={16} />
                      Delete
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </div>
            </div>
            <p className="lv-card-edited">Edited {projectDate(project.updatedAt)}</p>
          </div>
        </div>
      </article>
    );
  }

  // ----- Lovable-style browser ("projects" variant) -----
  if (isProjectsView) {
    return (
      <section className="projects-section projects-browser">
        <header className="projects-header">
          <h1 className="projects-header-title">{title}</h1>
          <Menu>
            <MenuTrigger asChild>
              <button className="projects-create" disabled={creating} type="button">
                <span>{creating ? "Creating…" : "Create"}</span>
                <ChevronDown size={18} />
              </button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => void createProject()}>
                <Plus size={16} />
                Blank video
              </MenuItem>
              <MenuItem onSelect={() => router.push("/")}>
                <Sparkles size={16} />
                Start from a prompt
              </MenuItem>
            </MenuContent>
          </Menu>
        </header>

        <div className="projects-toolbar">
          <label className="projects-search">
            <Search size={16} />
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search projects..."
              type="search"
              value={query}
            />
          </label>

          <div className="projects-filters">
            <ToolbarMenu
              onValueChange={(next) => setSortValue(next as SortValue)}
              options={[
                { label: resolveSortLabel("last-edited"), value: "last-edited" },
                { label: resolveSortLabel("title-asc"), value: "title-asc" },
                { label: resolveSortLabel("title-desc"), value: "title-desc" },
              ]}
              value={sortValue}
            />
            <ToolbarMenu onValueChange={setVisibility} options={VISIBILITY_OPTIONS} value={visibility} />
            <ToolbarMenu onValueChange={setStatus} options={STATUS_OPTIONS} value={status} />
            <ToolbarMenu onValueChange={setCreator} options={CREATOR_OPTIONS} value={creator} />
          </div>

          <div className="projects-view-tools">
            <button
              aria-label="Group by activity"
              aria-pressed={grouped}
              className={`projects-icon-btn${grouped ? " is-active" : ""}`}
              onClick={() => setGrouped((value) => !value)}
              type="button"
            >
              <LayoutList size={18} />
            </button>
            <button
              aria-label="Select projects"
              aria-pressed={selectionMode}
              className={`projects-icon-btn${selectionMode ? " is-active" : ""}`}
              onClick={() => {
                setSelectionMode((value) => !value);
                setSelected(new Set());
              }}
              type="button"
            >
              <Check size={18} />
            </button>
            <div className="projects-view-toggle" role="group" aria-label="View">
              <button
                aria-label="Grid view"
                aria-pressed={viewMode === "grid"}
                className="projects-view-seg"
                onClick={() => setViewMode("grid")}
                type="button"
              >
                <LayoutGrid size={18} />
              </button>
              <button
                aria-label="List view"
                aria-pressed={viewMode === "list"}
                className="projects-view-seg"
                onClick={() => setViewMode("list")}
                type="button"
              >
                <List size={18} />
              </button>
            </div>
          </div>
        </div>

        {selectionMode ? (
          <div className="projects-select-bar">
            <span>{selected.size} selected</span>
            <button
              className="projects-select-action"
              disabled={selected.size === 0}
              onClick={() => setBulkConfirm(true)}
              type="button"
            >
              <Trash2 size={15} />
              Delete
            </button>
            <button
              className="projects-select-action"
              onClick={() => {
                setSelectionMode(false);
                setSelected(new Set());
              }}
              type="button"
            >
              <X size={15} />
              Cancel
            </button>
          </div>
        ) : null}

        {groups.map((group) => (
          <div className="projects-group" key={group.label ?? "all"}>
            {group.label ? <h2 className="projects-group-label">{group.label}</h2> : null}
            <div className={viewMode === "list" ? "projects-browser-list" : "projects-browser-grid"}>
              {group.items.map((project) => renderCard(project))}
            </div>
          </div>
        ))}

        {query.trim() && !visibleProjects.length ? (
          <div className="project-search-empty">No projects match that search.</div>
        ) : null}
        {deleteDialogs}
      </section>
    );
  }

  // ----- Home strip ("home" variant) -----
  return (
    <section className="projects-section projects-home-strip">
      <div className="section-title-row">
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {limit && projects.length > limit ? (
          <Link className="section-link" href="/projects">
            View all
            <ArrowRight size={15} />
          </Link>
        ) : null}
      </div>

      {visibleProjects.length ? (
        <div className="project-list">
          {visibleProjects.map((project) => (
            <article className="project-tile" key={project.id}>
              <Link className="project-tile-main" href={`/projects/${project.id}`}>
                <MediaThumb
                  className="project-tile-thumb"
                  gradientIndex={project.gradientIndex}
                  kind={project.thumbnailKind ?? "project"}
                  src={project.thumbnailUrl}
                  title={project.name}
                />
                <span className="project-tile-title">{project.name}</span>
              </Link>
              <button
                aria-label={`Delete ${project.name}`}
                className="project-tile-delete"
                disabled={activeDeletingId === project.id}
                onClick={() => requestDelete(project)}
                title={`Delete ${project.name}`}
                type="button"
              >
                <Trash2 size={15} />
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="project-empty">
          <Film size={22} />
          <h2>No projects yet</h2>
        </div>
      )}
      {deleteDialogs}
    </section>
  );
}
