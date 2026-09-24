import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { isLocalAppMode } from "@/lib/app-mode";
import { cloneCloudResponse, desktopCloudFetch } from "@/lib/desktop-cloud";

export const dynamic = "force-dynamic";

/** Stripe billing portal: manage/cancel subscription, update card, invoices. */
export async function POST() {
  if (isLocalAppMode()) {
    try {
      return cloneCloudResponse(
        await desktopCloudFetch("/api/billing/portal", { method: "POST" }),
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Sign in to manage billing.";
      return NextResponse.json({ error: message }, { status: 401 });
    }
  }
  try {
    const user = await ensureCurrentAppUser();
    if (!user) return NextResponse.json({ error: "Sign in." }, { status: 401 });

    const [{ assertStripeConfigured, stripe }, { createServerClient }] = await Promise.all([
      import("@/lib/stripe"),
      import("@/lib/supabase"),
    ]);
    assertStripeConfigured();
    const supabase = createServerClient();
    const { data } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", user.userId)
      .maybeSingle();
    const customerId =
      data && typeof data.stripe_customer_id === "string" ? data.stripe_customer_id : null;
    if (!customerId) {
      return NextResponse.json(
        { error: "No billing account yet — subscribe first." },
        { status: 400 },
      );
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}/projects`,
    });
    return NextResponse.json({ url: session.url });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not open billing.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
