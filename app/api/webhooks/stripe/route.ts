import type Stripe from "stripe";
import { NextResponse } from "next/server";
import { isLocalAppMode } from "@/lib/app-mode";

export const dynamic = "force-dynamic";

/** Stripe events → credit grants + subscription records. Signature-verified. */
export async function POST(request: Request) {
  if (isLocalAppMode()) {
    return NextResponse.json(
      { error: "Stripe webhooks are disabled in local mode." },
      { status: 404 },
    );
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhook not configured." }, { status: 500 });

  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing signature." }, { status: 400 });

  const { stripe } = await import("@/lib/stripe");
  let event: Stripe.Event;
  try {
    const payload = await request.text();
    event = stripe.webhooks.constructEvent(payload, signature, secret);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Invalid signature.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    await handleStripeEvent(event);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Webhook handler failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === "payment") {
        const { fulfillCreditPurchase } = await import("@/lib/stripe");
        await fulfillCreditPurchase(session);
        break;
      }
      if (session.mode === "subscription" && session.subscription) {
        // The first invoice.paid event is the sole credit grant for the
        // initial period. Checkout completion only syncs plan state; granting
        // here as well would double-credit a new subscription.
        await applySubscription(String(session.subscription), null);
      }
      break;
    }
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      const { fulfillCreditPurchase } = await import("@/lib/stripe");
      await fulfillCreditPurchase(session);
      break;
    }
    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = subscriptionIdForInvoice(invoice);
      if (subscriptionId) await applySubscription(subscriptionId, invoice.id ?? subscriptionId);
      break;
    }
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const userId = subscription.metadata?.clerk_user_id;
      if (userId) {
        const { upsertSubscriptionRecord } = await import("@/lib/stripe");
        await upsertSubscriptionRecord({
          status: "canceled",
          stripeSubscriptionId: subscription.id,
          tier: "free",
          userId,
        });
      }
      break;
    }
    default:
      break;
  }
}

function subscriptionIdForInvoice(invoice: Stripe.Invoice): string | null {
  const modern = invoice.parent?.subscription_details?.subscription;
  if (typeof modern === "string") return modern;
  if (modern && typeof modern === "object" && "id" in modern) return modern.id;

  // Stripe API versions before invoice.parent exposed this at the top level.
  const legacy = (invoice as Stripe.Invoice & {
    subscription?: string | Stripe.Subscription | null;
  }).subscription;
  if (typeof legacy === "string") return legacy;
  return legacy?.id ?? null;
}

async function applySubscription(subscriptionId: string, idempotencyBase: string | null) {
  const {
    assertStripeConfigured,
    grantSubscriptionCredits,
    planForPriceId,
    stripe,
    upsertSubscriptionRecord,
  } = await import("@/lib/stripe");
  assertStripeConfigured();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const userId = subscription.metadata?.clerk_user_id;
  const priceId = subscription.items.data[0]?.price?.id;
  if (!userId || !priceId) return;
  const plan = planForPriceId(priceId);
  if (!plan) return;

  await upsertSubscriptionRecord({
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    currentPeriodEnd: subscription.items.data[0]?.current_period_end ?? null,
    status: subscription.status,
    stripeCustomerId:
      typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
    stripeSubscriptionId: subscription.id,
    tier: plan.tier,
    userId,
  });

  if (idempotencyBase) {
    // Invoice id is the canonical period grant key. Replayed invoice events
    // and an out-of-order checkout completion can never add credits twice.
    await grantSubscriptionCredits({
      billingCycle: plan.billingCycle,
      idempotencyKey: `stripe:invoice:${idempotencyBase}`,
      tier: plan.tier,
      userId,
    });
  }
}
