import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const bridge = vi.hoisted(() => ({
  charge: vi.fn(),
  currentUser: vi.fn(),
  refund: vi.fn(),
  runFal: vi.fn(),
}));

vi.mock("@/lib/app-users", () => ({ ensureCurrentAppUser: bridge.currentUser }));
vi.mock("@/lib/credits-service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/credits-service")>();
  return {
    ...original,
    chargeForOp: bridge.charge,
    refundCredits: bridge.refund,
  };
});
vi.mock("@/lib/media", () => ({ runFalRequest: bridge.runFal }));

import { POST } from "@/app/api/desktop/fal/run/route";

function request(body: Record<string, unknown>) {
  return new Request("https://chat.impractical.ai/api/desktop/fal/run", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.APP_MODE;
  bridge.currentUser.mockResolvedValue({
    email: "desktop@example.com",
    name: "Desktop User",
    userId: "user_desktop",
  });
  bridge.runFal.mockResolvedValue({
    endpoint: "bytedance/seedance-2.0/fast/text-to-video",
    ok: true,
    provider: "fal",
    raw: { video: { url: "https://fal.media/video.mp4" } },
    url: "https://fal.media/video.mp4",
  });
  bridge.charge.mockResolvedValue({
    balance: 810,
    charged: 190,
    duplicate: false,
    ok: true,
  });
  bridge.refund.mockResolvedValue(undefined);
});

describe("hosted desktop fal bridge", () => {
  it("requires a real hosted account", async () => {
    bridge.currentUser.mockResolvedValue(null);
    const response = await POST(request({ endpoint: "fal-ai/nano-banana-2", input: {}, kind: "image" }));
    expect(response.status).toBe(401);
    expect(bridge.runFal).not.toHaveBeenCalled();
  });

  it("rejects arbitrary provider endpoints before spending", async () => {
    const response = await POST(request({ endpoint: "attacker/free-gpu", input: {}, kind: "video" }));
    expect(response.status).toBe(400);
    expect(bridge.runFal).not.toHaveBeenCalled();
    expect(bridge.charge).not.toHaveBeenCalled();
  });

  it("atomically reserves credits before invoking fal", async () => {
    bridge.charge.mockResolvedValue({ balance: 1, ok: false, reason: "insufficient", required: 190 });
    const response = await POST(
      request({
        endpoint: "bytedance/seedance-2.0/fast/text-to-video",
        input: { duration: 5, prompt: "A quiet ocean" },
        kind: "video",
      }),
    );
    expect(response.status).toBe(402);
    expect(bridge.runFal).not.toHaveBeenCalled();
  });

  it("runs and charges an allowlisted generation with a server-owned key", async () => {
    const response = await POST(
      request({
        endpoint: "bytedance/seedance-2.0/fast/text-to-video",
        input: { duration: 5, prompt: "A quiet ocean" },
        kind: "video",
        requestId: "client_reused_free_generation_key",
      }),
    );
    expect(response.status).toBe(200);
    expect(bridge.runFal).toHaveBeenCalledOnce();
    expect(bridge.charge).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^desktop:fal:user_desktop:[0-9a-f-]{36}$/),
        userId: "user_desktop",
      }),
    );
    expect(bridge.charge.mock.calls[0][0].idempotencyKey).not.toContain("client_reused");
    await expect(response.json()).resolves.toMatchObject({
      credits: { charged: 190, remaining: 810 },
      ok: true,
    });
  });

  it("refunds a failed provider request", async () => {
    bridge.runFal.mockResolvedValue({
      endpoint: "fal-ai/nano-banana-2",
      error: "provider unavailable",
      ok: false,
      provider: "fal",
    });
    const response = await POST(
      request({ endpoint: "fal-ai/nano-banana-2", input: { prompt: "test" }, kind: "image" }),
    );
    expect(response.status).toBe(502);
    expect(bridge.charge).toHaveBeenCalledOnce();
    expect(bridge.refund).toHaveBeenCalledWith(
      expect.objectContaining({
        credits: 190,
        idempotencyKey: expect.stringMatching(/^desktop:fal-refund:user_desktop:[0-9a-f-]{36}$/),
        userId: "user_desktop",
      }),
    );
    const chargeId = bridge.charge.mock.calls[0][0].idempotencyKey.split(":").at(-1);
    const refundId = bridge.refund.mock.calls[0][0].idempotencyKey.split(":").at(-1);
    expect(refundId).toBe(chargeId);
  });
});
