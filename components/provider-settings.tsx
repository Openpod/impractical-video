"use client";

import { useEffect, useId, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { FalKeyStatus } from "@/lib/local-provider-settings";
import styles from "./provider-settings.module.css";

export function ProviderSettings({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const inputId = useId();
  const [status, setStatus] = useState<FalKeyStatus | null>(null);
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings/providers", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not load API settings.");
        setStatus(result);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Could not load API settings.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  async function update(method: "PUT" | "DELETE") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/settings/providers", {
        method,
        ...(method === "PUT" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ falKey: key.trim() }) } : {}),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not update API settings.");
      setStatus(result);
      setKey("");
      window.dispatchEvent(new Event("video-fs:generation-changed"));
      setMessage(method === "PUT"
        ? "Key saved. Your next generation will use it; no restart needed."
        : result.configured ? "Saved key removed. Using FAL_KEY from the environment." : "Saved key removed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update API settings.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>API keys</DialogTitle>
          <DialogDescription>Use your own fal.ai account for image, video, speech, and music generation.</DialogDescription>
        </DialogHeader>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void update("PUT"); }}>
          <p className={styles.help}>
            <a href="https://fal.ai/dashboard/keys" target="_blank" rel="noopener noreferrer">Create a fal.ai API key ↗</a>
            {" "}with API scope, then paste the complete key below. Generation is billed directly to your fal.ai account.
          </p>
          <p className={styles.status} aria-live="polite">
            {loading ? "Loading settings…" : !status ? "Settings unavailable" : status.source === "saved" ? "Using your saved key" : status.source === "environment" ? "Using FAL_KEY from the environment" : "No fal.ai key configured"}
          </p>
          <label htmlFor={inputId}>fal.ai API key</label>
          <input
            id={inputId}
            className={styles.input}
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={2048}
            placeholder={status?.configured ? "Paste a replacement key" : "Paste your fal.ai key"}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            disabled={loading || busy}
          />
          <p className={styles.help}>Stored on this computer outside your projects. Saving does not make a paid API call; fal.ai checks the key when you generate.</p>
          {status?.environmentConfigured ? <p className={styles.help}>A saved key takes priority over FAL_KEY. Removing it restores the environment key.</p> : null}
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          {message ? <p className={styles.help} role="status">{message}</p> : null}
          <DialogFooter>
            {status?.source === "saved" || (!loading && !status) ? (
              <button className="dialog-btn" type="button" disabled={busy} onClick={() => void update("DELETE")}>Remove saved key</button>
            ) : null}
            <button className="dialog-btn" type="submit" disabled={loading || busy || !key.trim()}>{busy ? "Saving…" : "Save key"}</button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
