import Stripe from "stripe";
import {
  CREDIT_PACKS,
  creditPackForId,
  getSubscriptionPriceForBillingCycle,
  SUBSCRIPTION_TIERS,
  type BillingCycle,
  type CreditPackId,
  type SubscriptionTier,
} from "@/lib/credits";
import { createServerClient } from "@/lib/supabase";

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("[Stripe] STRIPE_SECRET_KEY is not configured — checkout will 500.");
}

// Stripe's constructor throws for an empty key at import time. Keep route
// modules importable for builds/tests, then fail with a clear configuration
// error immediately before any network call.
export const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY || "sk_test_video_fs_not_configured",
  { typescript: true },
);

export function assertStripeConfigured(): void {
  if (!process.env.STRIPE_SECRET_KEY?.trim()) {
    throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY.");
  }
}

export type PaidSubscriptionTier = Exclude<SubscriptionTier, "free">;

/** Price ids live in env so the same code runs against test/live keys. */
export const STRIPE_SUBSCRIPTION_PRICES: Record<
  BillingCycle,
  Record<PaidSubscriptionTier, string | undefined>
> = {
  monthly: {
    standard: process.env.STRIPE_STANDARD_PRICE_ID,
    pro: process.env.STRIPE_PRO_PRICE_ID,
  },
  annual: {
    standard: process.env.STRIPE_STANDARD_ANNUAL_PRICE_ID,
    pro: process.env.STRIPE_PRO_ANNUAL_PRICE_ID,
  },
};

/** Reverse map price id → tier + cycle, so the webhook can resolve a plan. */
export function planForPriceId(
  priceId: string,
): { billingCycle: BillingCycle; tier: PaidSubscriptionTier } | null {
  for (const cycle of ["monthly", "annual"] as const) {
    for (const tier of ["standard", "pro"] as const) {
      if (STRIPE_SUBSCRIPTION_PRICES[cycle][tier] === priceId) {
        return { billingCycle: cycle, tier };
      }
    }
  }
  return null;
}

const appUrl = () =>
  (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");

/** Reuse the user's Stripe customer if we've recorded one, else create it. */
export async function getOrCreateStripeCustomer(
  userId: string,
  email?: string | null,
): Promise<string> {
  assertStripeConfigured();
  const supabase = createServerClient();
  const { data: existing, error: lookupError } = await supabase
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (lookupError) throw new Error(`Could not read the billing account: ${lookupError.message}`);
  const recorded =
    existing && typeof existing.stripe_customer_id === "string" ? existing.stripe_customer_id : null;
  if (recorded) return recorded;

  const customer = await stripe.customers.create({
    email: email ?? undefined,
    metadata: { clerk_user_id: userId },
  });
  const { error: saveError } = await supabase
    .from("subscriptions")
    .upsert(
      { stripe_customer_id: customer.id, tier: "free", user_id: userId },
      { onConflict: "user_id" },
    );
  if (saveError) throw new Error(`Could not save the billing account: ${saveError.message}`);
  return customer.id;
}

export async function createCreditCheckout(input: {
  userId: string;
  packId: CreditPackId;
  email?: string | null;
}): Promise<Stripe.Checkout.Session> {
  const customerId = await getOrCreateStripeCustomer(input.userId, input.email);
  return stripe.checkout.sessions.create(
    creditCheckoutParams({ ...input, customerId }),
  );
}

/** Pure Checkout payload builder, kept testable so displayed and charged
 * prices cannot drift apart. */
export function creditCheckoutParams(input: {
  customerId: string;
  email?: string | null;
  packId: CreditPackId;
  userId: string;
}): Stripe.Checkout.SessionCreateParams {
  const pack = CREDIT_PACKS[input.packId];
  const metadata = {
    checkout_kind: "credit_pack",
    clerk_user_id: input.userId,
    credits: String(pack.credits),
    pack_id: input.packId,
  };

  return {
    cancel_url: `${appUrl()}/projects?checkout=canceled`,
    customer: input.customerId,
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            description: "One-time generation credits. Credits do not expire.",
            metadata: { pack_id: input.packId },
            name: `${pack.credits.toLocaleString("en-US")} generation credits`,
          },
          unit_amount: pack.price,
        },
        quantity: 1,
      },
    ],
    metadata,
    mode: "payment",
    payment_intent_data: {
      description: `${pack.credits.toLocaleString("en-US")} Video FS generation credits`,
      metadata,
      receipt_email: input.email ?? undefined,
    },
    payment_method_types: ["card"],
    submit_type: "pay",
    success_url: `${appUrl()}/projects?checkout=success&credits=${pack.credits}&session_id={CHECKOUT_SESSION_ID}`,
  };
}

/** Grant a paid Checkout Session once. Session id is the ledger idempotency key. */
export async function grantPurchasedCredits(input: {
  amountPaid: number;
  packId: CreditPackId;
  sessionId: string;
  userId: string;
}): Promise<"duplicate" | "ok"> {
  const pack = CREDIT_PACKS[input.packId];
  const supabase = createServerClient();
  const { data, error } = await supabase.rpc("grant_credits", {
    p_bucket: "purchased",
    p_credits: pack.credits,
    p_description: `${pack.name} credit pack`,
    p_idempotency_key: `stripe:checkout:${input.sessionId}`,
    p_metadata: {
      amount_paid: input.amountPaid,
      currency: "usd",
      pack_id: input.packId,
      stripe_checkout_session_id: input.sessionId,
    },
    p_project_id: null,
    p_type: "purchase",
    p_user_id: input.userId,
  });
  if (error) throw new Error(`Could not grant purchased credits: ${error.message}`);
  const status = (data as { status?: string } | null)?.status;
  if (status !== "ok" && status !== "duplicate") {
    throw new Error(`Purchased-credit grant returned an unexpected status: ${status ?? "missing"}`);
  }
  return status;
}

/** Validate server-authored Checkout metadata and paid amount before granting. */
export async function fulfillCreditPurchase(
  session: Stripe.Checkout.Session,
): Promise<"duplicate" | "ignored" | "ok"> {
  if (session.mode !== "payment" || session.metadata?.checkout_kind !== "credit_pack") {
    return "ignored";
  }
  if (session.payment_status !== "paid") return "ignored";

  const pack = creditPackForId(session.metadata.pack_id);
  const userId = session.metadata.clerk_user_id;
  if (!pack || !userId) throw new Error("Paid credit checkout is missing trusted metadata.");
  if (session.currency !== "usd" || session.amount_total !== pack.price) {
    throw new Error(`Paid credit checkout ${session.id} does not match pack pricing.`);
  }
  if (session.metadata.credits !== String(pack.credits)) {
    throw new Error(`Paid credit checkout ${session.id} does not match pack credits.`);
  }

  return grantPurchasedCredits({
    amountPaid: session.amount_total,
    packId: pack.id,
    sessionId: session.id,
    userId,
  });
}

export async function createSubscriptionCheckout(input: {
  userId: string;
  tier: PaidSubscriptionTier;
  billingCycle: BillingCycle;
  email?: string | null;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<Stripe.Checkout.Session> {
  const priceId = STRIPE_SUBSCRIPTION_PRICES[input.billingCycle][input.tier];
  if (!priceId) {
    throw new Error(
      `Stripe price id not configured for ${input.tier} (${input.billingCycle}). Set STRIPE_${input.tier.toUpperCase()}_PRICE_ID.`,
    );
  }
  const customerId = await getOrCreateStripeCustomer(input.userId, input.email);
  const metadata = {
    billing_cycle: input.billingCycle,
    clerk_user_id: input.userId,
    tier: input.tier,
  };
  return stripe.checkout.sessions.create({
    allow_promotion_codes: true,
    cancel_url: input.cancelUrl || `${appUrl()}/projects?checkout=canceled`,
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata,
    mode: "subscription",
    subscription_data: { metadata },
    success_url:
      input.successUrl ||
      `${appUrl()}/projects?checkout=success&tier=${input.tier}`,
  });
}

const CREDITS_PER_TIER: Record<PaidSubscriptionTier, number> = {
  pro: SUBSCRIPTION_TIERS.pro.credits,
  standard: SUBSCRIPTION_TIERS.standard.credits,
};

/** Grant a period's subscription credits (idempotent on the invoice/session). */
export async function grantSubscriptionCredits(input: {
  userId: string;
  tier: PaidSubscriptionTier;
  billingCycle: BillingCycle;
  idempotencyKey: string;
}): Promise<void> {
  const monthly = CREDITS_PER_TIER[input.tier];
  const credits = input.billingCycle === "annual" ? monthly * 12 : monthly;
  const supabase = createServerClient();
  const { data, error } = await supabase.rpc("grant_credits", {
    p_bucket: "subscription",
    p_credits: credits,
    p_description: `${SUBSCRIPTION_TIERS[input.tier].name} plan (${input.billingCycle})`,
    p_idempotency_key: input.idempotencyKey,
    p_metadata: { billing_cycle: input.billingCycle, tier: input.tier },
    p_project_id: null,
    p_type: "subscription",
    p_user_id: input.userId,
  });
  if (error) throw new Error(`Could not grant subscription credits: ${error.message}`);
  const status = (data as { status?: string } | null)?.status;
  if (status !== "ok" && status !== "duplicate") {
    throw new Error(`Subscription-credit grant returned an unexpected status: ${status ?? "missing"}`);
  }
}

/** Record the user's current plan so the app reflects it immediately. */
export async function upsertSubscriptionRecord(input: {
  userId: string;
  tier: SubscriptionTier;
  status: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  currentPeriodEnd?: number | null;
  cancelAtPeriodEnd?: boolean;
}): Promise<void> {
  const supabase = createServerClient();
  const { error } = await supabase.from("subscriptions").upsert(
    {
      cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
      current_period_end: input.currentPeriodEnd
        ? new Date(input.currentPeriodEnd * 1000).toISOString()
        : null,
      status: input.status,
      stripe_customer_id: input.stripeCustomerId ?? undefined,
      stripe_subscription_id: input.stripeSubscriptionId ?? undefined,
      tier: input.tier,
      user_id: input.userId,
    },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(`Could not update the subscription: ${error.message}`);
}
