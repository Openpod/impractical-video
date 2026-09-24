import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  eq: vi.fn(),
  from: vi.fn(),
  maybeSingle: vi.fn(),
  rpc: vi.fn(),
  select: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase", () => ({
  createServerClient: () => ({ from: database.from, rpc: database.rpc }),
}));

import { chargeForOp, getCreditBalance } from "@/lib/credits-service";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.APP_MODE;
  delete process.env.VIDEO_FS_DATA_ROOT;
  database.maybeSingle.mockResolvedValue({ data: null, error: null });
  database.eq.mockReturnValue({ maybeSingle: database.maybeSingle });
  database.select.mockReturnValue({ eq: database.eq });
  database.upsert.mockResolvedValue({ error: null });
  database.from.mockReturnValue({ select: database.select, upsert: database.upsert });
  database.rpc.mockResolvedValue({ data: { status: "ok", balance: 140 }, error: null });
});

describe("credit service fail-closed behavior", () => {
  it("does not invent a free balance when the database read fails", async () => {
    database.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: "database unavailable" },
    });
    await expect(getCreditBalance("user_123")).rejects.toThrow(
      /Could not read the credit balance: database unavailable/,
    );
  });

  it("surfaces debit RPC failures instead of silently allowing usage", async () => {
    database.rpc.mockResolvedValue({
      data: null,
      error: { message: "ledger unavailable" },
    });
    await expect(
      chargeForOp({
        idempotencyKey: "generation_123",
        op: { kind: "image", resolution: "1K", tool: "generateImage" },
        userId: "user_123",
      }),
    ).rejects.toThrow(/Could not charge credits: ledger unavailable/);
  });
});
