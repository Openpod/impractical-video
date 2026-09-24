"use client";

import { ArrowRight, X } from "lucide-react";
import { Popover } from "radix-ui";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useOnboardingFlag } from "@/lib/onboarding";
import styles from "./project-tour.module.css";

const STEPS = [
  { target: "canvas", description: "Add footage and references to your canvas, then arrange your scenes." },
  { target: "editor", description: "Switch to the editor to trim clips, arrange your timeline, and add sound." },
  { target: "chat", description: "Open chat to ask your agent for ideas or edits." },
] as const;

function TourSpotlight({ target }: { target: HTMLElement }) {
  const spotlightRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const spotlight = spotlightRef.current;
    if (!spotlight) return;
    let frame = 0;
    let previous = "";
    const track = () => {
      const rect = target.getBoundingClientRect();
      const visible = target.isConnected && rect.width > 0 && rect.height > 0;
      const radius = Math.min(Math.max(parseFloat(getComputedStyle(target).borderTopLeftRadius) || 8, 8), rect.width / 2, rect.height / 2) + 4;
      const signature = [visible, rect.x, rect.y, rect.width, rect.height, radius].join(":");
      if (signature !== previous) {
        previous = signature;
        Object.assign(spotlight.style, {
          visibility: visible ? "visible" : "hidden",
          left: `${rect.left - 4}px`, top: `${rect.top - 4}px`,
          width: `${rect.width + 8}px`, height: `${rect.height + 8}px`,
        });
        spotlight.style.setProperty("--spotlight-radius", `${radius}px`);
      }
      // Keep the cutout attached during sidebar transitions, scrolling, zoom,
      // and window resizing without re-rendering the tour on every frame.
      frame = requestAnimationFrame(track);
    };
    track();
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return <div ref={spotlightRef} className={styles.spotlight} data-project-tour-spotlight />;
}

export function ProjectTour() {
  const { ready, seen, dismiss } = useOnboardingFlag("project-tour");
  const [replay, setReplay] = useState(false);
  const [step, setStep] = useState(0);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [nativeChat, setNativeChat] = useState(false);
  const descriptionId = useId();
  const open = ready && (!seen || replay);
  const info = STEPS[step];
  const anchor = useMemo(() => target ? { current: target } : null, [target]);
  const finish = useCallback(() => { dismiss(); setReplay(false); }, [dismiss]);

  useEffect(() => {
    const restart = () => { setStep(0); setReplay(true); };
    window.addEventListener("impractical:project-tour", restart);
    return () => window.removeEventListener("impractical:project-tour", restart);
  }, []);

  useEffect(() => {
    if (!open) return;
    // Desktop and browser render separate toolbars. Follow the visible one,
    // including after resizing, switching a view, or entering fullscreen.
    const findTarget = () => {
      const next = [...document.querySelectorAll<HTMLElement>(`[data-project-tour="${info.target}"]`)].find(element => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
      }) ?? null;
      setTarget(current => current === next ? current : next);
      setNativeChat(Boolean(window.videoFsDesktopEnvironment?.companionToggle));
    };
    const frame = requestAnimationFrame(findTarget);
    const observer = new MutationObserver(findTarget);
    const shell = document.querySelector(".workbench-shell");
    if (shell) observer.observe(shell, { childList: true, subtree: true });
    window.addEventListener("resize", findTarget);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", findTarget); };
  }, [info.target, open]);

  useEffect(() => {
    if (!open || !target) return;
    target.setAttribute("data-project-tour-active", "true");
    const previousDescription = target.getAttribute("aria-describedby");
    target.setAttribute("aria-describedby", [previousDescription, descriptionId].filter(Boolean).join(" "));
    return () => {
      target.removeAttribute("data-project-tour-active");
      if (previousDescription) target.setAttribute("aria-describedby", previousDescription);
      else target.removeAttribute("aria-describedby");
    };
  }, [descriptionId, open, target]);

  if (!open || !anchor) return null;
  return <Popover.Root open onOpenChange={next => { if (!next) finish(); }} modal={false}>
    <Popover.Anchor virtualRef={anchor} />
    <Popover.Portal>
      <div className={styles.spotlightLayer} aria-hidden="true" data-project-tour-backdrop>
        {target ? <TourSpotlight target={target} /> : null}
      </div>
    </Popover.Portal>
    <Popover.Portal>
      <Popover.Content
        className={styles.card}
        aria-label="Project tour"
        aria-describedby={descriptionId}
        data-project-tour-card
        side="bottom" align="end" sideOffset={14} collisionPadding={16} arrowPadding={18}
        updatePositionStrategy="always"
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
        onFocusOutside={event => event.preventDefault()}
        onInteractOutside={event => { if (target?.contains(event.target as Node)) event.preventDefault(); }}
      >
        <div className={styles.top}><span className={styles.count}>{step + 1} / {STEPS.length}</span><button className={styles.close} type="button" aria-label="Dismiss project tour" onClick={finish}><X size={14} /></button></div>
        <p id={descriptionId}>{info.description}{info.target === "chat" ? nativeChat ? " Toggle it anytime with Option + Space." : " It opens in a separate tab." : ""}</p>
        <div className={styles.footer}><button className={styles.skip} type="button" aria-label="Skip tour" onClick={finish}>Skip</button><button className={styles.next} type="button" onClick={() => { if (step === STEPS.length - 1) finish(); else setStep(value => value + 1); }}>{step === STEPS.length - 1 ? "Got it" : "Next"}<ArrowRight size={13} /></button></div>
        <Popover.Arrow className={styles.arrow} width={14} height={7} />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
