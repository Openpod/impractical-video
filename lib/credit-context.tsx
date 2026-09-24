"use client";

import { useSyncExternalStore } from "react";
import type { SubscriptionTier } from "@/lib/credits";

export type CreditContextValue = {
  credits: { total: number };
  usage: { usedThisMonth: number };
  subscription: { tier: SubscriptionTier; tierName: string };
  isLoaded: boolean;
};

const FALLBACK: CreditContextValue = {
  credits: { total: 0 },
  usage: { usedThisMonth: 0 },
  subscription: { tier: "free", tierName: "Free" },
  isLoaded: false,
};

// Module-level store so every consumer (account menu, upgrade modal, …) shares a
// single /api/credits fetch and re-renders together when the balance changes.
let cache: CreditContextValue | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((fn) => fn());
}

async function loadCredits(): Promise<void> {
  try {
    const response = await fetch("/api/credits", { cache: "no-store" });
    if (!response.ok) return;
    const data = (await response.json()) as Partial<CreditContextValue>;
    cache = {
      credits: { total: Number(data.credits?.total ?? FALLBACK.credits.total) },
      usage: { usedThisMonth: Number(data.usage?.usedThisMonth ?? 0) },
      subscription: {
        tier: (data.subscription?.tier ?? "free") as SubscriptionTier,
        tierName: data.subscription?.tierName ?? "Free",
      },
      isLoaded: true,
    };
    emit();
  } catch {
    // keep fallback
  } finally {
    inflight = null;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!cache && !inflight) inflight = loadCredits();
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CreditContextValue {
  return cache ?? FALLBACK;
}

/** Force a refetch after a charge or purchase so balances reflect immediately. */
export function refreshCredits(): void {
  if (!inflight) inflight = loadCredits();
}

export function useCreditContext(): CreditContextValue {
  return useSyncExternalStore(subscribe, getSnapshot, () => FALLBACK);
}
