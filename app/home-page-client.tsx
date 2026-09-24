"use client";

import { ArrowRight, ArrowUp, Loader2, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { toast } from "sonner";
import { useProjectDirectory } from "@/app/app-shell";
import {
  ExploreCartBar,
  ExploreCartDialog,
  normalizeExploreKind,
} from "@/app/explore/explore-page-client";
import type { HomeProjectCard, ReferenceTile } from "@/app/home-data";
import { MediaThumb } from "@/app/media-thumb";
import { ProjectList } from "@/app/project-list";
import { AttachmentTile } from "@/components/attachment-tile";
import { DotField } from "@/components/dot-field";
import { SignedOutHome } from "@/components/home/signed-out-home";
import { WelcomeModal } from "@/components/onboarding/welcome-modal";
import { stashStartIntent } from "@/lib/onboarding-intent";
import type { PublishedItemSummary } from "@/lib/published-items";
import { useAuthGate } from "@/lib/use-auth-gate";
import { userFacingError } from "@/lib/user-facing-error";

const HERO_WORDS = [
  "impractical",
  "spectacular",
  "suspenseful",
  "captivating",
  "mesmerizing",
  "atmospheric",
  "sentimental",
  "tear-jerking",
  "intelligent",
  "imaginative",
];

type HeroWordLayer = {
  id: number;
  phase: "enter" | "exit";
  word: string;
};

function projectNameFromPrompt(prompt: string) {
  const cleaned = prompt.trim().replace(/\s+/g, " ");
  if (!cleaned) return "Untitled video";
  return cleaned.length > 64 ? `${cleaned.slice(0, 61).trimEnd()}...` : cleaned;
}

function HomeHeroTitle() {
  const [wordLayers, setWordLayers] = useState<HeroWordLayer[]>([
    { id: 0, phase: "enter", word: HERO_WORDS[0] ?? "" },
  ]);
  const longestWord = useMemo(
    () => HERO_WORDS.reduce((longest, current) => (current.length > longest.length ? current : longest)),
    [],
  );

  useEffect(() => {
    let wordIndex = 0;
    let layerId = 0;
    const timeoutIds: number[] = [];
    const intervalId = window.setInterval(() => {
      wordIndex = (wordIndex + 1) % HERO_WORDS.length;
      layerId += 1;
      const nextWord = HERO_WORDS[wordIndex] ?? HERO_WORDS[0] ?? "";
      setWordLayers((current) => [
        ...current
          .filter((layer) => layer.phase === "enter")
          .map((layer) => ({ ...layer, phase: "exit" as const })),
        { id: layerId, phase: "enter", word: nextWord },
      ]);
      timeoutIds.push(
        window.setTimeout(() => {
          setWordLayers((current) => current.filter((layer) => layer.phase === "enter"));
        }, 560),
      );
    }, 1800);
    return () => {
      window.clearInterval(intervalId);
      timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
    };
  }, []);

  return (
    <h1 className="home-hero-title" id="home-title">
      <span>Make something </span>
      <span className="home-title-word" aria-live="polite">
        <span aria-hidden="true" className="home-title-word-spacer">
          {longestWord}
        </span>
        {wordLayers.map((layer) => (
          <span
            aria-hidden={layer.phase === "exit" ? "true" : undefined}
            className={`home-title-word-active is-${layer.phase}`}
            key={layer.id}
          >
            {layer.word.split("").map((letter, index) => (
              <span
                className="home-title-letter"
                key={`${layer.id}-${letter}-${index}`}
                style={{ animationDelay: `${index * (layer.phase === "exit" ? 18 : 34)}ms` }}
              >
                {letter === " " ? "\u00A0" : letter}
              </span>
            ))}
          </span>
        ))}
      </span>
    </h1>
  );
}

function ReferenceSection({
  tiles,
  title,
}: {
  tiles: ReferenceTile[];
  title: string;
}) {
  if (!tiles.length) return null;

  return (
    <section className="home-image-section">
      <div className="section-title-row">
        <h2>{title}</h2>
      </div>
      <div className="image-tile-grid">
        {tiles.map((tile) => {
          const content = (
            <>
              <MediaThumb
                className="image-tile-thumb"
                gradientIndex={tile.gradientIndex}
                kind={tile.imageUrl ? "image" : tile.type}
                src={tile.imageUrl}
                title={tile.title}
              />
              <span className="image-tile-title">{tile.title}</span>
            </>
          );

          return (
            <Link className="image-tile" href={`/projects/${tile.projectId}`} key={tile.id}>
              {content}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export function HomePageClient({
  characters: initialCharacters = [],
  environments: initialEnvironments = [],
  initialProjects = [],
  initialSignedIn = false,
}: {
  characters?: ReferenceTile[];
  environments?: ReferenceTile[];
  initialProjects?: HomeProjectCard[];
  initialSignedIn?: boolean;
}) {
  const directory = useProjectDirectory();
  const { isLoaded: authLoaded, isSignedIn: authSignedIn, requireAuth } = useAuthGate();
  // Server-seeded so signed-in content doesn't flash out on first paint.
  const isSignedIn = authLoaded ? authSignedIn : initialSignedIn;
  const characters = directory?.characters ?? initialCharacters;
  const environments = directory?.environments ?? initialEnvironments;
  const projects = directory?.projects ?? initialProjects;
  const [prompt, setPrompt] = useState("");
  // Signed-out picks from the browse grid below, surfaced as attachments in
  // this composer. Toggled from the grid or removed via each tile's ✕.
  const [picks, setPicks] = useState<PublishedItemSummary[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  // The floating cart pill mirrors the composer's picks, but only appears once
  // the composer (where the attachments live) has scrolled out of view.
  const composerRef = useRef<HTMLDivElement | null>(null);
  const [composerInView, setComposerInView] = useState(true);
  const creating = Boolean(directory?.creating);
  const router = useRouter();
  // Fresh signed-in users (no projects yet) see the same get-started browse as
  // signed-out visitors — carousels of characters/environments/styles + clips.
  const hasProjects = projects.length > 0;
  const showBrowse = !isSignedIn || !hasProjects;
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const node = composerRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => setComposerInView(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "-64px 0px 0px 0px", threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [isSignedIn]);

  function togglePick(item: PublishedItemSummary) {
    setPicks((current) =>
      current.some((entry) => entry.id === item.id)
        ? current.filter((entry) => entry.id !== item.id)
        : [...current, item],
    );
  }

  async function createFromPrompt(value = prompt) {
    const trimmed = value.trim();
    if (!isSignedIn) {
      // Preserve the picks + prompt through sign-up so we can build the project
      // and fire the prompt once they're back (see StartContinuation).
      stashStartIntent({ pickIds: picks.map((pick) => pick.id), prompt: trimmed });
    }
    if (!requireAuth()) return;
    if (!directory || creating || starting) return;

    // With browse picks selected, create the project and import the picks BEFORE
    // navigating so the references are attached when the prompt auto-fires.
    if (picks.length) {
      setStarting(true);
      const toastId = toast.loading("Setting up your project…");
      try {
        const response = await fetch("/api/projects", {
          body: JSON.stringify({ name: projectNameFromPrompt(value) }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.project) throw new Error(data.error || "Create failed.");
        const projectId = data.project.id as string;
        let imported = 0;
        for (const pick of picks) {
          const used = await fetch(`/api/published-items/${encodeURIComponent(pick.id)}/use`, {
            body: JSON.stringify({ projectId }),
            headers: { "content-type": "application/json" },
            method: "POST",
          });
          if (used.ok) imported += 1;
        }
        toast.success(imported ? `Added ${imported} to your new project.` : "Project created.", { id: toastId });
        const query = trimmed ? `?prompt=${encodeURIComponent(trimmed)}` : "";
        router.push(`/projects/${projectId}${query}`);
      } catch (caught) {
        toast.error(userFacingError(caught, "Create failed."), { id: toastId });
        setStarting(false);
      }
      return;
    }

    // No picks: the normal composer create (directory handles cache + nav).
    try {
      await directory.createProject(projectNameFromPrompt(value), value);
    } catch (caught) {
      toast.error(userFacingError(caught, "Create failed."));
    }
  }

  return (
    <div className={`home-page${showBrowse ? " is-browse" : ""}`}>
      <WelcomeModal onCreateProject={async () => {
        if (!directory) throw new Error("The workspace is still loading. Please try again.");
        return directory.createProject("My first project");
      }} />
      <section className="home-hero" aria-labelledby="home-title">
        <DotField className="home-hero-ripples" radial />
        <div className="home-hero-stage">
          <div className="home-hero-head">
            {isSignedIn && hasProjects ? (
              <Link className="home-hero-pill" href="/projects">
                <span className="hero-pill-cube" aria-hidden="true">
                  <span className="hero-pill-cube-scene">
                    <span className="hero-pill-cube-inner">
                      <span className="assistant-cube-face front" />
                      <span className="assistant-cube-face back" />
                      <span className="assistant-cube-face right" />
                      <span className="assistant-cube-face left" />
                      <span className="assistant-cube-face top" />
                      <span className="assistant-cube-face bottom" />
                    </span>
                  </span>
                </span>
                <span>Browse your projects</span>
                <ArrowRight size={14} />
              </Link>
            ) : null}
            <HomeHeroTitle />
          </div>

          <div className={`fcomposer home-composer-fc${picks.length ? " has-tray" : ""}`} ref={composerRef}>
            <div className="fcomposer-tray" aria-hidden={!picks.length}>
              <div className="fcomposer-tray-inner">
                <div className="tray-tiles">
                  {picks.map((pick) => {
                    const normalized = normalizeExploreKind(pick.kind);
                    return (
                      <AttachmentTile
                        aspectRatio={normalized === "video" ? "16 / 9" : "1 / 1"}
                        key={pick.id}
                        kind={normalized === "video" ? "video" : "image"}
                        name={pick.title}
                        onRemove={() => togglePick(pick)}
                        src={pick.posterUrl}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
            <form
              className="home-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void createFromPrompt();
              }}
            >
            <TextareaAutosize
              className="home-composer-textarea"
              maxRows={6}
              minRows={2}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                // Enter (and Cmd/Ctrl+Enter) submits; Shift+Enter is a newline.
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void createFromPrompt();
                }
              }}
              placeholder="What do you want to make?"
              value={prompt}
            />
            <div className="home-composer-controls">
              <button
                aria-label="Create blank video"
                className="home-composer-icon-button"
                disabled={creating || starting}
                onClick={() => void createFromPrompt("")}
                title="Create blank video"
                type="button"
              >
                <Plus size={18} />
              </button>
              <button
                aria-label="Start creating"
                className="home-composer-submit"
                disabled={creating || starting}
                title="Start creating"
                type="submit"
              >
                {creating || starting ? <Loader2 className="spin" size={17} /> : <ArrowUp size={18} />}
              </button>
            </div>
            </form>
          </div>
        </div>
      </section>

      {isSignedIn && hasProjects ? (
        <div className="home-content">
          <ProjectList initialProjects={projects} limit={8} title="Projects" />
          <ReferenceSection tiles={characters} title="Characters" />
          <ReferenceSection tiles={environments} title="Environments" />
        </div>
      ) : (
        // Get-started browse (signed-out visitors AND fresh signed-in users with
        // no projects): public references/clips in the home's card layout; picks
        // surface as attachments in the composer above.
        <SignedOutHome onTogglePick={togglePick} picks={picks} />
      )}

      {/* Floating cart pill — only once the composer (with the attachments) has
          scrolled out of view, so signed-out browsers can still Start. */}
      {showBrowse && !composerInView ? (
        <>
          <ExploreCartBar items={picks} onOpen={() => setCartOpen(true)} onStart={() => setCartOpen(false)} />
          <ExploreCartDialog
            items={picks}
            open={cartOpen}
            onOpenChange={setCartOpen}
            onRemove={(id) => setPicks((current) => current.filter((entry) => entry.id !== id))}
          />
        </>
      ) : null}
    </div>
  );
}
