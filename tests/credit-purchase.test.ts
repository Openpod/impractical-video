import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CREDIT_PACKS, creditPackForId, creditsToUsd } from "@/lib/credits";
import {
  clipCredits,
  imageCredits,
  PRICING_MARKUP,
  usdToCredits,
} from "@/lib/usage-pricing";

const billing = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  createServerClient: () => ({ rpc: billing.rpc }),
}));

import { creditCheckoutParams, fulfillCreditPurchase } from "@/lib/stripe";

function checkoutSession(
  overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
  return {
    amount_total: CREDIT_PACKS.creator.price,
    currency: "usd",
    id: "cs_test_creditpack123",
    metadata: {
      checkout_kind: "credit_pack",
      clerk_user_id: "user_123",
      credits: String(CREDIT_PACKS.creator.credits),
      pack_id: "creator",
    },
    mode: "payment",
    payment_status: "paid",
    ...overrides,
  } as Stripe.Checkout.Session;
}

beforeEach(() => {
  vi.clearAllMocks();
  billing.rpc.mockResolvedValue({ data: { status: "ok" }, error: null });
});

describe("credit pack economics", () => {
  it("charges a 50% markup over provider COGS", () => {
    expect(PRICING_MARKUP).toBe(1.5);
    expect(usdToCredits(1)).toBe(150);
  });

  it("keeps the dollar-to-credit exchange exact for every pack", () => {
    for (const [id, pack] of Object.entries(CREDIT_PACKS)) {
      expect(creditsToUsd(pack.credits)).toBe(pack.price / 100);
      expect(creditPackForId(id)).toMatchObject(pack);
    }
  });

  it("offers useful generation capacity at the displayed estimates", () => {
    const fiveSecondVideo = clipCredits({ tier: "fast", resolution: "720p", seconds: 5 });
    expect(Math.floor(CREDIT_PACKS.starter.credits / fiveSecondVideo)).toBe(5);
    expect(Math.floor(CREDIT_PACKS.starter.credits / imageCredits("1K"))).toBe(83);
  });

  it("sends Stripe the exact one-time price and credit quantity shown in the UI", () => {
    const params = creditCheckoutParams({
      customerId: "cus_123",
      email: "creator@example.com",
      packId: "creator",
      userId: "user_123",
    });
    expect(params.mode).toBe("payment");
    expect(params.customer).toBe("cus_123");
    expect(params.line_items).toEqual([
      expect.objectContaining({
        price_data: expect.objectContaining({
          currency: "usd",
          unit_amount: CREDIT_PACKS.creator.price,
        }),
        quantity: 1,
      }),
    ]);
    expect(params.metadata).toMatchObject({
      checkout_kind: "credit_pack",
      credits: String(CREDIT_PACKS.creator.credits),
      pack_id: "creator",
    });
    expect(params.success_url).toContain("session_id={CHECKOUT_SESSION_ID}");
  });
});

describe("paid credit fulfillment", () => {
  it("grants the exact purchased bucket from a paid, server-authored session", async () => {
    await expect(fulfillCreditPurchase(checkoutSession())).resolves.toBe("ok");
    expect(billing.rpc).toHaveBeenCalledWith("grant_credits", {
      p_bucket: "purchased",
      p_credits: CREDIT_PACKS.creator.credits,
      p_description: "Creator credit pack",
      p_idempotency_key: "stripe:checkout:cs_test_creditpack123",
      p_metadata: {
        amount_paid: CREDIT_PACKS.creator.price,
        currency: "usd",
        pack_id: "creator",
        stripe_checkout_session_id: "cs_test_creditpack123",
      },
      p_project_id: null,
      p_type: "purchase",
      p_user_id: "user_123",
    });
  });

  it("accepts a database-level duplicate without granting twice", async () => {
    billing.rpc.mockResolvedValue({ data: { status: "duplicate" }, error: null });
    await expect(fulfillCreditPurchase(checkoutSession())).resolves.toBe("duplicate");
  });

  it("does not fulfill an unpaid session", async () => {
    await expect(
      fulfillCreditPurchase(checkoutSession({ payment_status: "unpaid" })),
    ).resolves.toBe("ignored");
    expect(billing.rpc).not.toHaveBeenCalled();
  });

  it("rejects tampered amounts and credit metadata", async () => {
    await expect(
      fulfillCreditPurchase(checkoutSession({ amount_total: 1 })),
    ).rejects.toThrow(/does not match pack pricing/);
    await expect(
      fulfillCreditPurchase(
        checkoutSession({
          metadata: {
            ...checkoutSession().metadata,
            credits: "999999",
          },
        }),
      ),
    ).rejects.toThrow(/does not match pack credits/);
    expect(billing.rpc).not.toHaveBeenCalled();
  });

  it("surfaces ledger failures so Stripe can retry the webhook", async () => {
    billing.rpc.mockResolvedValue({ data: null, error: { message: "database unavailable" } });
    await expect(fulfillCreditPurchase(checkoutSession())).rejects.toThrow(
      /Could not grant purchased credits: database unavailable/,
    );
  });
});
