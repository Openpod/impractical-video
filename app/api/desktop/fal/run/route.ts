import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isLocalAppMode } from "@/lib/app-mode";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { chargeForOp, quoteOp, refundCredits } from "@/lib/credits-service";
import {
  desktopFalBillableOp,
  sanitizeDesktopFalInput,
  type DesktopFalKind,
} from "@/lib/desktop-fal-billing";
import { runFalRequest } from "@/lib/media";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const MAX_REQUEST_BYTES = 1_000_000;

type FalRunBody = {
  endpoint?: unknown;
  input?: unknown;
  kind?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function POST(request: Request) {
  if (isLocalAppMode()) {
    return NextResponse.json({ error: "The hosted generation bridge is unavailable locally." }, { status: 404 });
  }

  try {
    const user = await ensureCurrentAppUser();
    if (!user) return NextResponse.json({ error: "Sign in to generate media." }, { status: 401 });

    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
      return NextResponse.json({ error: "Generation request is too large." }, { status: 413 });
    }
    const body = JSON.parse(text) as FalRunBody;
    const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
    const kind = body.kind;
    const input = body.input;
    if ((kind !== "audio" && kind !== "image" && kind !== "video") || !endpoint || !isRecord(input)) {
      return NextResponse.json({ error: "Invalid desktop generation request." }, { status: 400 });
    }

    const sanitizedInput = sanitizeDesktopFalInput({
      endpoint,
      input,
      kind: kind as DesktopFalKind,
    });
    const op = desktopFalBillableOp({
      endpoint,
      input: sanitizedInput,
      kind: kind as DesktopFalKind,
    });
    const required = quoteOp(op);

    // Reserve credits atomically before doing provider work. A separate balance
    // preflight is racy: two concurrent desktop requests could both pass it,
    // make paid fal calls, and leave only one chargeable afterward.
    // The server owns this key. Trusting a desktop-supplied id would let a
    // modified client repeat expensive provider calls while deduplicating only
    // the corresponding credit charge.
    const requestId = randomUUID();
    const charge = await chargeForOp({
      description: `Video FS Desktop generation via ${endpoint}`,
      idempotencyKey: `desktop:fal:${user.userId}:${requestId}`,
      op,
      userId: user.userId,
    });
    if (!charge.ok) {
      if (charge.reason === "insufficient") {
        return NextResponse.json(
          { balance: charge.balance, error: "Not enough credits.", required: charge.required },
          { status: 402 },
        );
      }
      throw new Error("Hosted credit charging is unavailable.");
    }

    const refund = () =>
      refundCredits({
        credits: charge.charged,
        description: `Refund for failed Video FS Desktop generation via ${endpoint}`,
        idempotencyKey: `desktop:fal-refund:${user.userId}:${requestId}`,
        userId: user.userId,
      });

    let generation;
    try {
      generation = await runFalRequest(kind, endpoint, sanitizedInput);
    } catch (caught) {
      await refund();
      throw caught;
    }
    if (!generation.ok) {
      await refund();
      return NextResponse.json(generation, { status: 502 });
    }

    return NextResponse.json({
      ...generation,
      credits: { charged: charge.charged, remaining: charge.balance },
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Desktop generation failed.";
    const status = /not available|not allowed/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
