import { ensureCurrentAppUser } from "@/lib/app-users";
import { billingEnabled, getCreditBalance } from "@/lib/credits-service";
import { SUBSCRIPTION_TIERS, type SubscriptionTier } from "@/lib/credits";
import { createServerClient } from "@/lib/supabase";
import { cloneCloudResponse, desktopCloudFetch } from "@/lib/desktop-cloud";
import { isLocalAppMode } from "@/lib/app-mode";

export const dynamic = "force-dynamic";

function tierName(tier: SubscriptionTier): string {
  return SUBSCRIPTION_TIERS[tier]?.name ?? "Free";
}

export async function GET() {
  if (isLocalAppMode()) {
    try {
      return cloneCloudResponse(await desktopCloudFetch("/api/credits"));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Sign in to load credits.";
      return Response.json({ error: message }, { status: 401 });
    }
  }
  const user = await ensureCurrentAppUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const balance = await getCreditBalance(user.userId);

  let tier: SubscriptionTier = "free";
  let usedThisMonth = 0;

  // Tier + month-to-date usage are best-effort; default gracefully in local mode.
  if (billingEnabled()) {
    const supabase = createServerClient();

    const { data: sub } = await supabase
      .from("subscriptions")
      .select("tier, status")
      .eq("user_id", user.userId)
      .maybeSingle();
    const subTier = typeof sub?.tier === "string" ? sub.tier : null;
    if (subTier && subTier in SUBSCRIPTION_TIERS) tier = subTier as SubscriptionTier;

    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const { data: usage } = await supabase
      .from("credit_transactions")
      .select("amount")
      .eq("user_id", user.userId)
      .eq("type", "usage")
      .gte("created_at", monthStart.toISOString());
    usedThisMonth = (usage ?? []).reduce((sum, row) => sum + Math.abs(Number(row.amount) || 0), 0);
  }

  return Response.json({
    credits: { total: balance.total },
    usage: { usedThisMonth },
    subscription: { tier, tierName: tierName(tier) },
    isLoaded: true,
  });
}
