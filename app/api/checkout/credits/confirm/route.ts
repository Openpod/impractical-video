import { NextResponse } from "next/server";
import { isLocalAppMode } from "@/lib/app-mode";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { getCreditBalance } from "@/lib/credits-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (isLocalAppMode()) {
    return NextResponse.json({ error: "Billing is disabled in local mode." }, { status: 404 });
  }

  try {
    const user = await ensureCurrentAppUser();
    if (!user) return NextResponse.json({ error: "Sign in to confirm checkout." }, { status: 401 });

    const sessionId = new URL(request.url).searchParams.get("session_id");
    if (!sessionId || !/^cs_(test_|live_)?[A-Za-z0-9]+$/.test(sessionId)) {
      return NextResponse.json({ error: "Invalid checkout session." }, { status: 400 });
    }

    const { assertStripeConfigured, fulfillCreditPurchase, stripe } = await import("@/lib/stripe");
    assertStripeConfigured();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.metadata?.clerk_user_id !== user.userId) {
      return NextResponse.json({ error: "Checkout session does not belong to this user." }, { status: 403 });
    }
    const fulfillment = await fulfillCreditPurchase(session);
    if (fulfillment === "ignored") {
      return NextResponse.json({ error: "Payment is not complete." }, { status: 409 });
    }
    const balance = await getCreditBalance(user.userId);
    return NextResponse.json({
      balance: balance.total,
      credits: Number(session.metadata.credits),
      fulfillment,
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not confirm checkout.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
