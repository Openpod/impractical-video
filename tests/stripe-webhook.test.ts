import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeMocks = vi.hoisted(() => ({
  fulfillCreditPurchase: vi.fn(),
  grantSubscriptionCredits: vi.fn(),
  retrieveSubscription: vi.fn(),
  upsertSubscriptionRecord: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  assertStripeConfigured: vi.fn(),
  fulfillCreditPurchase: stripeMocks.fulfillCreditPurchase,
  grantSubscriptionCredits: stripeMocks.grantSubscriptionCredits,
  planForPriceId: () => ({ billingCycle: "monthly", tier: "standard" }),
  stripe: {
    subscriptions: { retrieve: stripeMocks.retrieveSubscription },
  },
  upsertSubscriptionRecord: stripeMocks.upsertSubscriptionRecord,
}));

import { handleStripeEvent } from "@/app/api/webhooks/stripe/route";

function event(type: string, object: object): Stripe.Event {
  return { data: { object }, type } as Stripe.Event;
}

beforeEach(() => {
  vi.clearAllMocks();
  stripeMocks.fulfillCreditPurchase.mockResolvedValue("ok");
  stripeMocks.retrieveSubscription.mockResolvedValue({
    cancel_at_period_end: false,
    customer: "cus_123",
    id: "sub_123",
    items: {
      data: [{ current_period_end: 2_000_000_000, price: { id: "price_standard" } }],
    },
    metadata: { clerk_user_id: "user_123" },
    status: "active",
  });
});

describe("Stripe webhook credit integrity", () => {
  it("fulfills one-time purchases on completed and delayed-success events", async () => {
    const session = { id: "cs_test_123", mode: "payment" };
    await handleStripeEvent(event("checkout.session.completed", session));
    await handleStripeEvent(event("checkout.session.async_payment_succeeded", session));
    expect(stripeMocks.fulfillCreditPurchase).toHaveBeenCalledTimes(2);
  });

  it("does not double-grant a subscription on checkout completion", async () => {
    await handleStripeEvent(
      event("checkout.session.completed", {
        id: "cs_test_subscription",
        mode: "subscription",
        subscription: "sub_123",
      }),
    );
    expect(stripeMocks.upsertSubscriptionRecord).toHaveBeenCalledOnce();
    expect(stripeMocks.grantSubscriptionCredits).not.toHaveBeenCalled();
  });

  it("uses the invoice id as the sole subscription period grant key", async () => {
    await handleStripeEvent(
      event("invoice.paid", {
        id: "in_123",
        parent: { subscription_details: { subscription: "sub_123" } },
      }),
    );
    expect(stripeMocks.grantSubscriptionCredits).toHaveBeenCalledWith({
      billingCycle: "monthly",
      idempotencyKey: "stripe:invoice:in_123",
      tier: "standard",
      userId: "user_123",
    });
  });
});
