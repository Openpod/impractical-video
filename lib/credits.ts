// Credits and legacy subscription pricing. New purchases use one-time packs:
// users should always be able to see the exact dollars -> credits exchange.

export const CREDIT_PACKS = {
  starter: {
    credits: 1_000,
    name: "Starter",
    price: 1_000,
  },
  creator: {
    credits: 2_500,
    name: "Creator",
    price: 2_500,
  },
  studio: {
    credits: 5_000,
    name: "Studio",
    price: 5_000,
  },
} as const;

export type CreditPackId = keyof typeof CREDIT_PACKS;

export function creditPackForId(value: unknown) {
  if (typeof value !== "string" || !(value in CREDIT_PACKS)) return null;
  return { id: value as CreditPackId, ...CREDIT_PACKS[value as CreditPackId] };
}

export function creditsToUsd(credits: number): number {
  return credits / 100;
}

// Credit grants are in the $0.01 credit unit (see lib/usage-pricing.ts), so the
// plan value equals price: Standard $20 = 2,000 cr, Pro $200 = 20,000 cr. At
// ~150 cr per 5s clip that's ~13 / ~130 clips per month respectively.
export const SUBSCRIPTION_TIERS = {
  free: { name: "Free", price: 0, credits: 150 },
  standard: { name: "Standard", price: 2000, credits: 2000 }, // $20.00 in cents
  pro: { name: "Pro", price: 20000, credits: 20000 }, // $200.00 in cents
} as const;

export type SubscriptionTier = keyof typeof SUBSCRIPTION_TIERS;

export const SUBSCRIPTION_TIER_FEATURES: Record<SubscriptionTier, string[]> = {
  free: ["150 credits each month", "Basic access"],
  standard: [
    "2,000 credits each month",
    "No watermark",
    "Pro tools available",
    "AI images, AI music, and AI videos included",
    "Purchase extra credits",
  ],
  pro: [
    "20,000 credits each month",
    "1M context window",
    "Everything in Standard",
    "Ultra thinking",
    "Up to 60fps videos",
    "Priority customer support",
  ],
};

export const BILLING_CYCLES = ["monthly", "annual"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];
export const ANNUAL_DISCOUNT_PERCENT = 20;
const MONTHS_PER_YEAR = 12;

export function getAnnualPriceFromMonthly(monthlyPriceInCents: number): number {
  return Math.round(monthlyPriceInCents * MONTHS_PER_YEAR * ((100 - ANNUAL_DISCOUNT_PERCENT) / 100));
}

export function getAnnualSavingsFromMonthly(monthlyPriceInCents: number): number {
  return monthlyPriceInCents * MONTHS_PER_YEAR - getAnnualPriceFromMonthly(monthlyPriceInCents);
}

export function getSubscriptionPriceForBillingCycle(
  monthlyPriceInCents: number,
  billingCycle: BillingCycle,
): number {
  if (billingCycle === "annual") return getAnnualPriceFromMonthly(monthlyPriceInCents);
  return monthlyPriceInCents;
}

export function getSubscriptionCreditsForBillingCycle(monthlyCredits: number): number {
  return monthlyCredits;
}

export function formatPrice(priceInCents: number): string {
  return `$${(priceInCents / 100).toFixed(priceInCents % 100 === 0 ? 0 : 2)}`;
}

export function calculateRemainingPercent(currentCredits: number, usedThisMonth: number): number {
  const startingCredits = currentCredits + usedThisMonth;
  return startingCredits > 0
    ? Math.min(100, Math.round((currentCredits / startingCredits) * 100))
    : 0;
}

export function calculateUsageStats(currentCredits: number, usedThisMonth: number) {
  return {
    usedThisMonth,
    remainingPercent: calculateRemainingPercent(currentCredits, usedThisMonth),
  };
}
