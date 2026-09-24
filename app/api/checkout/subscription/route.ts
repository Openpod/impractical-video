import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { BILLING_CYCLES, type BillingCycle } from "@/lib/credits";
import { isLocalAppMode } from "@/lib/app-mode";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (isLocalAppMode()) {
    return NextResponse.json(
      { error: "Billing is disabled in local mode. Add your provider keys to generate directly." },
      { status: 404 },
    );
  }
  try {
    const user = await ensureCurrentAppUser();
    if (!user) return NextResponse.json({ error: "Sign in to upgrade." }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as {
      billingCycle?: unknown;
      tier?: unknown;
    };
    const tier = body.tier === "standard" || body.tier === "pro" ? body.tier : null;
    if (!tier) return NextResponse.json({ error: "Invalid plan." }, { status: 400 });
    const billingCycle: BillingCycle =
      typeof body.billingCycle === "string" &&
      BILLING_CYCLES.includes(body.billingCycle as BillingCycle)
        ? (body.billingCycle as BillingCycle)
        : "monthly";

    const { createSubscriptionCheckout } = await import("@/lib/stripe");
    const session = await createSubscriptionCheckout({
      billingCycle,
      email: user.email,
      tier,
      userId: user.userId,
    });
    return NextResponse.json({ url: session.url });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Checkout failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
