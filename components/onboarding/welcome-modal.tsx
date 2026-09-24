"use client";

import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Coins, KeyRound, Loader2, ShieldCheck, Sparkles, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ImpracticalLogo } from "@/app/impractical-logo";
import { useAppAuth } from "@/lib/app-auth";
import { useOnboardingFlag } from "@/lib/onboarding";
import { CREDIT_PACKS, formatPrice, type CreditPackId } from "@/lib/credits";
import { openExternalOrNavigate } from "@/lib/open-external";
import { refreshCredits } from "@/lib/credit-context";
import { StudioArt } from "./studio-art";
import styles from "./studio-onboarding.module.css";

const STEP_KEY = "video-fs-setup-step";
const STEPS = [
  { label: "Welcome", title: "Big ideas.\nSmall beginnings.", description: "A space to turn the thing in your head into something you can press play on. Let’s make it yours." },
  { label: "Your creative partner", title: "You direct.\nYour agent creates.", description: "Connect an agent to help bring your ideas to life. Use the account you already have." },
  { label: "Generation & billing", title: "A little fuel for\nyour imagination.", description: "Choose how you’d like to generate. Bring your own fal.ai key, or get credits here." },
  { label: "Your first project", title: "The next frame\nis yours.", description: "Start with an idea or bring your own footage. Build on the canvas, then shape your story in the editor." },
];

type AgentStatus = { agent: "claude" | "codex"; installed: boolean; signedIn: boolean; stage: string; detail?: string | null };

function AgentSetup() {
  const [agents, setAgents] = useState<Partial<Record<"claude" | "codex", AgentStatus>>>({});
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let checking = false;
    async function check() {
      if (checking) return;
      checking = true;
      try {
        const results = await Promise.all((["claude", "codex"] as const).map(async agent => {
          const response = await fetch(`/api/agent-connect?agent=${agent}`, { cache: "no-store" });
          if (!response.ok) throw new Error("Could not check your agents. You can connect them from your project later.");
          return [agent, await response.json()] as const;
        }));
        if (active) { setAgents(Object.fromEntries(results)); setError(""); }
      } catch (caught) { if (active) setError(caught instanceof Error ? caught.message : "Could not check your agents."); }
      finally { checking = false; }
    }
    void check();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void check(); }, 5000);
    window.addEventListener("focus", check);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", check); };
  }, []);
  async function connect(agent: "claude" | "codex") {
    setPending(agent); setError("");
    try {
      const response = await fetch("/api/agent-connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not connect your agent.");
      setAgents(previous => ({ ...previous, [agent]: result }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not connect your agent."); }
    finally { setPending(null); }
  }
  return <>
    <div className={styles.agentList}>{(["claude", "codex"] as const).map(agent => {
      const status = agents[agent];
      const busy = pending === agent || status?.stage === "installing" || status?.stage === "awaiting_browser";
      return <div className={styles.agentRow} key={agent}>
        <span className={styles.agentIcon}>{agent === "claude" ? <Sparkles size={18} /> : <Terminal size={18} />}</span>
        <div><strong>{agent === "claude" ? "Claude Code" : "Codex"}</strong><small>{!status ? "Checking your computer…" : status.signedIn ? "Installed and signed in" : status.stage === "installing" ? "Installing…" : status.stage === "awaiting_browser" ? "Finish signing in in your browser" : status.installed ? "Installed · sign in to connect" : "Not installed yet"}</small></div>
        {status?.signedIn ? <span className={styles.agentReady}><Check size={13} /> Ready</span> : <button type="button" className={styles.agentButton} disabled={!status || busy} onClick={() => void connect(agent)}>{busy ? "Connecting…" : status?.installed ? "Connect" : "Install & connect"}</button>}
      </div>;
    })}</div>
    <p className={styles.help} style={{ marginTop: 17 }}>Claude powers the in-app companion. Claude and Codex can both work from your project’s terminal. Agent subscriptions are separate from video generation.</p>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {Object.values(agents).filter(agent => agent?.stage === "error").map(agent => <p role="alert" className={styles.error} key={agent!.agent}>{agent!.detail || "Connection didn’t finish. Try again."}</p>)}
  </>;
}

export function WelcomeModal({ onCreateProject }: { onCreateProject: () => Promise<unknown> }) {
  const { isLoaded, isSignedIn, isLocal } = useAppAuth();
  const { dismiss, ready, seen } = useOnboardingFlag("studio-setup");
  const query = useSearchParams();
  const router = useRouter();
  const replay = query.get("setup") === "1";
  const [step, setStep] = useState(0);
  const [choice, setChoice] = useState<"key" | "credits" | null>(null);
  const [key, setKey] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [connected, setConnected] = useState(!isLocal);
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceError, setBalanceError] = useState("");
  const [balanceCheck, setBalanceCheck] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [desktop, setDesktop] = useState(false);
  const [closed, setClosed] = useState(false);
  const sessionSaved = useRef(false);
  const open = isLoaded && isSignedIn && ready && (!seen || replay) && !closed;

  useEffect(() => {
    // Restore only the step, never an API key, after checkout or an app restart.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDesktop(Boolean(window.videoFsDesktopEnvironment?.platform));
    const restored = Number(localStorage.getItem(STEP_KEY) || 0);
    setStep(replay ? 0 : Math.max(0, Math.min(3, Number.isInteger(restored) ? restored : 0)));
    setClosed(false);
  }, [replay]);

  useEffect(() => {
    if (!open || step !== 2 || !isLocal) return;
    let active = true;
    void fetch("/api/settings/providers", { cache: "no-store" }).then(response => response.json()).then(result => {
      if (active) setKeyConfigured(result.configured === true);
    }).catch(() => {});
    return () => { active = false; };
  }, [open, step, isLocal]);

  useEffect(() => { if (open) document.querySelector<HTMLElement>("[data-studio-title]")?.focus(); }, [step, choice, open]);

  useEffect(() => {
    if (!open || step !== 2 || choice !== "credits" || (isLocal && !desktop)) return;
    let active = true;
    let checking = false;
    async function check() {
      if (checking) return;
      checking = true;
      try {
        if (isLocal) {
          const sessionResponse = await fetch("/api/desktop/cloud-session", { cache: "no-store" });
          if (!sessionResponse.ok) throw new Error("Could not check your account. Please try again.");
          const session = await sessionResponse.json();
          if (!active) return;
          setConnected(session.connected === true);
          if (!session.connected) { setBalance(null); setBalanceError(""); return; }
          if (!sessionSaved.current) {
            await window.videoFsDesktopEnvironment?.authSessionConnected?.();
            sessionSaved.current = true;
            window.dispatchEvent(new Event("video-fs:desktop-session-changed"));
          }
        }
        const response = await fetch("/api/credits", { cache: "no-store" });
        if (!response.ok) throw new Error("Could not check your balance. Please try again.");
        const result = await response.json();
        if (active) { setBalance(Math.max(0, Number(result.credits?.total) || 0)); setBalanceError(""); }
      } catch (caught) {
        if (active) { setBalance(null); setBalanceError(caught instanceof Error ? caught.message : "Could not check your balance. Please try again."); }
      }
      finally { checking = false; }
    }
    void check();
    const timer = setInterval(() => void check(), 4000);
    window.addEventListener("focus", check);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", check); };
  }, [choice, desktop, isLocal, open, step, balanceCheck]);

  function goTo(next: number) {
    setStep(next); setChoice(null); setKey(""); setError(""); setNotice(""); setBalanceError("");
    localStorage.setItem(STEP_KEY, String(next));
  }
  function finish() {
    dismiss(); setClosed(true); setKey(""); localStorage.removeItem(STEP_KEY);
    if (replay) router.replace("/", { scroll: false });
  }
  async function mode(value: "fal" | "credits") {
    if (!isLocal) return;
    const response = await fetch("/api/settings/generation", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: value }) });
    if (!response.ok) throw new Error("Could not save your generation preference.");
    window.dispatchEvent(new Event("video-fs:generation-changed"));
  }
  async function saveKey() {
    setBusy(true); setError("");
    try {
      if (key.trim()) {
        const response = await fetch("/api/settings/providers", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ falKey: key.trim() }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not save your key.");
        setKeyConfigured(true);
      }
      await mode("fal");
      goTo(3);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save your key."); }
    finally { setBusy(false); }
  }
  async function startSignIn() {
    setBusy(true); setError("");
    try {
      await mode("credits");
      const response = await fetch("/api/desktop/auth/start", { method: "POST" });
      const result = await response.json();
      if (!response.ok || !result.url) throw new Error(result.error || "Could not open sign-in.");
      const url = new URL(result.url); url.searchParams.set("surface", "desktop");
      window.open(url.href, "_blank", "noopener,noreferrer");
      setNotice("Finish signing in in the window that opened. We’ll pick up here when you’re back.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not open sign-in."); }
    finally { setBusy(false); }
  }
  async function buy(packId: CreditPackId) {
    setBusy(true); setError("");
    try {
      await mode("credits");
      const response = await fetch("/api/checkout/credits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packId }) });
      const result = await response.json();
      if (!response.ok || !result.url) throw new Error(result.error || "Could not start checkout.");
      localStorage.setItem(STEP_KEY, "2");
      openExternalOrNavigate(result.url);
      setNotice("Checkout opened. Your balance will update here after payment. Nothing is charged until you confirm at checkout.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not start checkout."); }
    finally { setBusy(false); }
  }
  async function continueWithCredits() {
    setBusy(true); setError("");
    try { await mode("credits"); refreshCredits(); goTo(3); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not use credits."); }
    finally { setBusy(false); }
  }
  async function createProject() {
    setBusy(true); setError("");
    try { await onCreateProject(); dismiss(); setClosed(true); setKey(""); localStorage.removeItem(STEP_KEY); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not create your project. Please try again."); }
    finally { setBusy(false); }
  }
  const info = STEPS[step];
  return <Dialog open={open} onOpenChange={next => { if (!next && !busy) finish(); }}>
    <DialogContent className={styles.flow} showClose={false} data-theme="light" aria-label="Welcome to Impractical" aria-labelledby={undefined} onOpenAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLElement>("[data-studio-title]")?.focus(); }} onInteractOutside={event => event.preventDefault()}>
      <header className={styles.header}>
        <div className={styles.progress} role="progressbar" aria-label="Setup progress" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step + 1} aria-valuetext={`Step ${step + 1} of ${STEPS.length}`}>
          <div className={styles.progressTrack} aria-hidden="true">{STEPS.map((_, i) => <i key={i} data-active={i <= step} />)}</div>
          <span aria-hidden="true">Step {step + 1} of {STEPS.length}</span>
        </div>
        <div className={styles.brand}><ImpracticalLogo /><span>Impractical</span></div>
        <button type="button" className={styles.textButton} onClick={finish} disabled={busy}>Skip setup <ArrowUpRight size={13} /></button>
      </header>
      <main className={styles.body}>
        <section className={styles.left}>
          <div className={styles.copy} key={step}>
            <DialogTitle className={styles.title} data-studio-title tabIndex={-1}>{info.title}</DialogTitle>
            <DialogDescription className={styles.description}>{info.description}</DialogDescription>
            {step === 0 ? <><div className={styles.actions}><button className={styles.primary} type="button" onClick={() => goTo(1)}>Let’s get started <ArrowRight size={15} /></button></div><p className={styles.smallNote}>A few quick steps. Then it’s all you.</p></> : null}
            {step === 1 ? <>{isLocal ? <AgentSetup /> : <p className={styles.help}>Your workspace is ready. Connect Claude Code or Codex from the desktop app to work with a local agent.</p>}<div className={styles.actions}><button className={styles.primary} type="button" onClick={() => goTo(2)}>Continue <ArrowRight size={15} /></button><button className={styles.textButton} type="button" onClick={() => goTo(2)}>I’ll do this later</button></div></> : null}
            {step === 2 ? <>
              {!choice ? <><div className={styles.choices}>
                <button className={styles.choice} type="button" onClick={() => { setChoice("key"); setError(""); }}><KeyRound /><ArrowUpRight className={styles.choiceArrow} size={15} /><span><strong>I’ve got a fal API key</strong><small>Use your own account</small></span></button>
                <button className={styles.choice} type="button" onClick={() => { setChoice("credits"); setError(""); }}><Coins /><ArrowUpRight className={styles.choiceArrow} size={15} /><span><strong>Purchase credits</strong><small>Pay as you create</small></span></button>
              </div>{keyConfigured ? <p className={styles.status}><Check size={14} /> A fal.ai key is already configured.</p> : null}</> : <>
                <button className={styles.textButton} type="button" onClick={() => { setChoice(null); setKey(""); setError(""); setNotice(""); }} disabled={busy}><ArrowLeft size={13} /> Choose another option</button>
                {choice === "key" ? isLocal ? <form className={styles.form} onSubmit={event => { event.preventDefault(); void saveKey(); }}>
                  <label htmlFor="onboarding-fal-key">Your fal.ai API key</label><input id="onboarding-fal-key" className={styles.input} type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" maxLength={2048} placeholder={keyConfigured ? "Keep your saved key, or paste a new one" : "Paste your complete key"} value={key} onChange={event => setKey(event.target.value)} disabled={busy} />
                  <p className={styles.help}>Find it in your <a href="https://fal.ai/dashboard/keys" target="_blank" rel="noopener noreferrer">fal.ai dashboard ↗</a>. Generation is billed to your fal.ai account. Saving doesn’t spend credits or check your balance.</p>
                  <button className={styles.primary} type="submit" disabled={busy || (!key.trim() && !keyConfigured)}>{busy ? "Saving…" : keyConfigured && !key.trim() ? "Use saved key" : "Save & continue"}<ArrowRight size={14} /></button><p className={styles.smallNote}><ShieldCheck size={12} /> Kept on this computer, outside your projects.</p>
                </form> : <p className={styles.help}>Bring your own key in Impractical Desktop. On the web, purchase Impractical credits to generate.</p> : isLocal && !desktop ? <p className={styles.help}>Open Impractical Desktop to purchase and use credits. In this local browser workspace, you can use a fal.ai key or skip generation setup.</p> : !connected ? <><p className={styles.help}>Sign in to Impractical to keep your credits with your account. Then choose a one-time credit pack.</p><div className={styles.actions}><button type="button" className={styles.primary} onClick={() => void startSignIn()} disabled={busy}>{busy ? "Opening…" : "Sign in to purchase"}<ArrowUpRight size={14} /></button></div></> : <>
                  <div className={styles.packList}>{(Object.keys(CREDIT_PACKS) as CreditPackId[]).map(id => <button type="button" className={styles.pack} key={id} disabled={busy} onClick={() => void buy(id)}><span>{CREDIT_PACKS[id].name}<small>{CREDIT_PACKS[id].credits.toLocaleString()} credits</small></span><span>{formatPrice(CREDIT_PACKS[id].price)} <ArrowUpRight size={12} /></span></button>)}</div>
                  <p className={styles.help} style={{ marginTop: 12 }}>One-time payment. No subscription. 1 credit = $0.01.</p>
                  {balance !== null ? <p className={styles.status}><Coins size={14} /> {balance.toLocaleString()} credits available</p> : !balanceError ? <p className={styles.help}>Checking your balance…</p> : null}
                  {balance !== null && balance > 0 ? <button type="button" className={styles.primary} disabled={busy} onClick={() => void continueWithCredits()}>Continue with credits <ArrowRight size={14} /></button> : null}
                </>}
              </>}
              {choice === "credits" && balanceError ? <div><p role="alert" className={styles.error}>{balanceError}</p><button type="button" className={styles.textButton} onClick={() => setBalanceCheck(value => value + 1)}>Check again</button></div> : null}
              <p className={styles.requirement}><strong>Video models need a funded fal.ai key or Impractical credits.</strong> Without either, you can still upload and edit your own media, but you won’t be able to generate video.</p>
              {notice ? <p className={styles.help} role="status" style={{ marginTop: 12 }}>{notice}</p> : null}
              <div className={styles.actions}><button type="button" className={styles.textButton} disabled={busy} onClick={() => goTo(3)}>Skip <ArrowRight size={13} /></button></div>
            </> : null}
            {step === 3 ? <><div className={styles.form}><p className={styles.help}>Your first project starts with a blank canvas.</p><p className={styles.help}>Drop in a file, describe a scene to your connected agent, or switch to the editor. You can revisit setup from Account → Setup guide.</p></div><div className={styles.actions}><button type="button" className={styles.primary} onClick={() => void createProject()} disabled={busy}>{busy ? <Loader2 size={15} className="spin" /> : null}{busy ? "Creating…" : "Create my first project"}<ArrowRight size={15} /></button><button className={styles.textButton} type="button" onClick={finish} disabled={busy}>Explore first</button></div></> : null}
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
          </div>
        </section>
        <aside className={styles.right}><StudioArt step={step} /></aside>
      </main>
    </DialogContent>
  </Dialog>;
}
