import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const checkout = vi.hoisted(() => ({
  create: vi.fn(),
  currentUser: vi.fn(),
  fulfill: vi.fn(),
  getBalance: vi.fn(),
  retrieve: vi.fn(),
}));

vi.mock("@/lib/app-users", () => ({
  ensureCurrentAppUser: checkout.currentUser,
}));
vi.mock("@/lib/credits-service", () => ({
  getCreditBalance: checkout.getBalance,
}));
vi.mock("@/lib/stripe", () => ({
  assertStripeConfigured: vi.fn(),
  createCreditCheckout: checkout.create,
  fulfillCreditPurchase: checkout.fulfill,
  stripe: { checkout: { sessions: { retrieve: checkout.retrieve } } },
}));

import { POST as startCheckout } from "@/app/api/checkout/credits/route";
import { GET as confirmCheckout } from "@/app/api/checkout/credits/confirm/route";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.APP_MODE;
  checkout.currentUser.mockResolvedValue({
    email: "creator@example.com",
    name: "Creator",
    userId: "user_123",
  });
  checkout.create.mockResolvedValue({ url: "https://checkout.stripe.com/example" });
  checkout.fulfill.mockResolvedValue("ok");
  checkout.getBalance.mockResolvedValue({ total: 2_650 });
  checkout.retrieve.mockResolvedValue({
    metadata: { clerk_user_id: "user_123", credits: "2500" },
  });
});

describe("credit checkout routes", () => {
  it("rejects unknown pack identifiers before contacting Stripe", async () => {
    const response = await startCheckout(
      new Request("http://localhost/api/checkout/credits", {
        body: JSON.stringify({ packId: "unlimited" }),
        method: "POST",
      }),
    );
    expect(response.status).toBe(400);
    expect(checkout.create).not.toHaveBeenCalled();
  });

  it("starts checkout with the authenticated user and fixed pack", async () => {
    const response = await startCheckout(
      new Request("http://localhost/api/checkout/credits", {
        body: JSON.stringify({ packId: "creator" }),
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    expect(checkout.create).toHaveBeenCalledWith({
      email: "creator@example.com",
      packId: "creator",
      userId: "user_123",
    });
  });

  it("confirms and returns the balance only for the checkout owner", async () => {
    const response = await confirmCheckout(
      new Request(
        "http://localhost/api/checkout/credits/confirm?session_id=cs_test_creditpack123",
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      balance: 2_650,
      credits: 2_500,
      fulfillment: "ok",
    });
    expect(checkout.fulfill).toHaveBeenCalledOnce();
  });

  it("never fulfills another user's checkout session", async () => {
    checkout.retrieve.mockResolvedValue({
      metadata: { clerk_user_id: "user_someone_else", credits: "2500" },
    });
    const response = await confirmCheckout(
      new Request(
        "http://localhost/api/checkout/credits/confirm?session_id=cs_test_creditpack123",
      ),
    );
    expect(response.status).toBe(403);
    expect(checkout.fulfill).not.toHaveBeenCalled();
  });
});
