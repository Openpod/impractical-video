import { NextResponse } from "next/server";
import { isLocalAppMode } from "@/lib/app-mode";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { creditPackForId } from "@/lib/credits";
import { cloneCloudResponse, desktopCloudFetch } from "@/lib/desktop-cloud";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (isLocalAppMode()) {
    try {
      return cloneCloudResponse(
        await desktopCloudFetch("/api/checkout/credits", {
          body: await request.text(),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Sign in to buy credits.";
      return NextResponse.json({ error: message }, { status: 401 });
    }
  }

  try {
    const user = await ensureCurrentAppUser();
    if (!user) return NextResponse.json({ error: "Sign in to buy credits." }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as { packId?: unknown };
    const pack = creditPackForId(body.packId);
    if (!pack) return NextResponse.json({ error: "Invalid credit pack." }, { status: 400 });

    const { createCreditCheckout } = await import("@/lib/stripe");
    const session = await createCreditCheckout({
      email: user.email,
      packId: pack.id,
      userId: user.userId,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL.");
    return NextResponse.json({ url: session.url });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Checkout failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
