import "server-only";

import { createServerClient } from "@/lib/supabase";
import { isLocalAppMode } from "@/lib/app-mode";
import { opCogsUsd, opCredits, type BillableOp } from "@/lib/usage-pricing";

/**
 * Credit ledger service. All deductions go through the atomic `spend_credits` /
 * `grant_credits` Postgres functions (see database/video_fs_credit_functions.sql)
 * so the 3-bucket balance and the ledger row move together and retries are
 * idempotent. Charges happen at the generation boundary (charge-on-success), so
 * this is correct whether the agent loop runs in the API route or a Trigger task.
 */

export type CreditBalance = {
  total: number;
  free: number;
  subscription: number;
  purchased: number;
};

export type ChargeResult =
  | { ok: true; charged: number; balance: number | null; duplicate: boolean }
  | { ok: false; reason: "insufficient"; balance: number; required: number }
  | { ok: false; reason: "disabled" };

const DEFAULT_FREE_CREDITS = 150;

/** Billing is off in local filesystem/test mode (no real Clerk user / Supabase). */
export function billingEnabled(): boolean {
  if (isLocalAppMode()) return false;
  if (process.env.NODE_ENV === "production") return true;
  return !process.env.VIDEO_FS_DATA_ROOT;
}

/** Ensure the user has a credit row (free default = 150). Safe to call often. */
export async function ensureCreditAccount(userId: string): Promise<void> {
  if (!billingEnabled()) return;
  const supabase = createServerClient();
  const { error } = await supabase
    .from("user_credits")
    .upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
  if (error) throw new Error(`Could not provision the credit account: ${error.message}`);
}

export async function getCreditBalance(userId: string): Promise<CreditBalance> {
  if (!billingEnabled()) {
    return { total: DEFAULT_FREE_CREDITS, free: DEFAULT_FREE_CREDITS, subscription: 0, purchased: 0 };
  }
  const supabase = createServerClient();
  const readBalance = () =>
    supabase
      .from("user_credits")
      .select("free_credits, subscription_credits, purchased_credits")
      .eq("user_id", userId)
      .maybeSingle();
  let { data, error } = await readBalance();
  if (error) throw new Error(`Could not read the credit balance: ${error.message}`);
  if (!data) {
    await ensureCreditAccount(userId);
    ({ data, error } = await readBalance());
    if (error) throw new Error(`Could not read the credit balance: ${error.message}`);
    if (!data) throw new Error("Credit account provisioning did not create a balance.");
  }
  const free = Number(data.free_credits);
  const subscription = Number(data?.subscription_credits ?? 0);
  const purchased = Number(data?.purchased_credits ?? 0);
  return { total: free + subscription + purchased, free, subscription, purchased };
}

/** Credits an op will cost (so callers can pre-flight / quote without charging). */
export function quoteOp(op: BillableOp): number {
  return opCredits(op);
}

/**
 * Charge for a successful generation. `idempotencyKey` must be stable for the
 * one generation it bills (e.g. the fal request id) so a retried RPC can't
 * double-charge. Provisions the credit row on first use.
 */
export async function chargeForOp(input: {
  userId: string;
  op: BillableOp;
  projectId?: string | null;
  idempotencyKey: string;
  description?: string;
  /** What the charge produced — powers ledger thumbnails. Prefer a workspace
   * media path (re-signable forever) over a remote URL (may expire). */
  artifact?: { path?: string | null; title?: string | null; url?: string | null };
}): Promise<ChargeResult> {
  if (!billingEnabled()) return { ok: false, reason: "disabled" };

  const credits = opCredits(input.op);
  const cogsUsd = opCogsUsd(input.op);
  const supabase = createServerClient();

  const spend = async () =>
    supabase.rpc("spend_credits", {
      p_user_id: input.userId,
      p_credits: credits,
      p_tool_name: input.op.tool,
      p_project_id: input.projectId ?? null,
      p_description: input.description ?? null,
      p_cogs_usd: cogsUsd,
      p_metadata: { op: input.op, ...(input.artifact ? { artifact: input.artifact } : {}) },
      p_idempotency_key: input.idempotencyKey,
    });

  let { data, error } = await spend();
  if (error) throw new Error(`Could not charge credits: ${error.message}`);
  let result = (data ?? {}) as { status?: string; balance?: number; transaction_id?: string };

  // Self-heal: first-ever charge before any row exists.
  if (result.status === "no_account") {
    await ensureCreditAccount(input.userId);
    ({ data, error } = await spend());
    if (error) throw new Error(`Could not charge credits: ${error.message}`);
    result = (data ?? {}) as typeof result;
  }

  if (result.status === "ok") {
    return { ok: true, charged: credits, balance: result.balance ?? null, duplicate: false };
  }
  if (result.status === "duplicate") {
    return { ok: true, charged: credits, balance: null, duplicate: true };
  }
  if (result.status === "insufficient") {
    return { ok: false, reason: "insufficient", balance: result.balance ?? 0, required: credits };
  }
  throw new Error(`Credit charge returned an unexpected status: ${result.status ?? "missing"}`);
}

/** Refund a previously-charged op back to the free bucket (idempotent). */
export async function refundCredits(input: {
  userId: string;
  credits: number;
  projectId?: string | null;
  idempotencyKey: string;
  description?: string;
}): Promise<void> {
  if (!billingEnabled()) return;
  const supabase = createServerClient();
  const { data, error } = await supabase.rpc("grant_credits", {
    p_user_id: input.userId,
    p_credits: input.credits,
    p_bucket: "free",
    p_type: "refund",
    p_description: input.description ?? null,
    p_project_id: input.projectId ?? null,
    p_metadata: {},
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw new Error(`Could not refund credits: ${error.message}`);
  const status = (data as { status?: string } | null)?.status;
  if (status !== "ok" && status !== "duplicate") {
    throw new Error(`Credit refund returned an unexpected status: ${status ?? "missing"}`);
  }
}
