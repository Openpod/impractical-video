"use client";

import { Coins, Image as ImageIcon, Loader2, Video } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCreditContext } from "@/lib/credit-context";
import {
  CREDIT_PACKS,
  formatPrice,
  type CreditPackId,
} from "@/lib/credits";
import { formatCredits } from "@/lib/format-credits";
import { clipCredits, imageCredits } from "@/lib/usage-pricing";
import { openExternalOrNavigate } from "@/lib/open-external";

const PACK_IDS = Object.keys(CREDIT_PACKS) as CreditPackId[];
const FIVE_SECOND_VIDEO_CREDITS = clipCredits({
  resolution: "720p",
  seconds: 5,
  tier: "fast",
});
const IMAGE_CREDITS = imageCredits("1K");

function estimatedOutputs(credits: number) {
  return {
    images: Math.floor(credits / IMAGE_CREDITS),
    videos: Math.floor(credits / FIVE_SECOND_VIDEO_CREDITS),
  };
}

export function BuyCreditsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { credits } = useCreditContext();
  const [checkoutPack, setCheckoutPack] = useState<CreditPackId | null>(null);

  const startCheckout = async (packId: CreditPackId) => {
    setCheckoutPack(packId);
    try {
      const response = await fetch("/api/checkout/credits", {
        body: JSON.stringify({ packId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; url?: string };
      if (!response.ok || !data.url) throw new Error(data.error || "Could not start checkout.");
      const destination = openExternalOrNavigate(data.url);
      if (destination === "external") {
        setCheckoutPack(null);
        onOpenChange(false);
        toast.success("Checkout opened in your browser. Your desktop balance will refresh after payment.");
      }
    } catch (caught) {
      setCheckoutPack(null);
      toast.error(caught instanceof Error ? caught.message : "Could not start checkout.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="upgrade-dialog credit-purchase-dialog">
        <DialogHeader>
          <DialogTitle>Buy generation credits</DialogTitle>
          <DialogDescription>
            Pay once and add credits to your balance. 1 credit = $0.01 USD.
          </DialogDescription>
        </DialogHeader>

        <div className="credit-purchase-balance">
          <span>
            <Coins aria-hidden size={15} /> Current balance
          </span>
          <strong>{formatCredits(credits.total)} credits</strong>
        </div>

        <div className="upgrade-plans">
          {PACK_IDS.map((packId) => {
            const pack = CREDIT_PACKS[packId];
            const estimate = estimatedOutputs(pack.credits);
            const featured = packId === "creator";
            const loading = checkoutPack === packId;
            return (
              <div className={`upgrade-plan${featured ? " is-featured" : ""}`} key={packId}>
                <div className="upgrade-plan-top">
                  <span className="upgrade-plan-icon is-accent">
                    <Coins size={15} />
                  </span>
                  <div className="upgrade-plan-id">
                    <div className="upgrade-plan-name">
                      {pack.name}
                      {featured ? <span className="upgrade-plan-tag">Popular</span> : null}
                    </div>
                    <p>{formatCredits(pack.credits)} credits, added after payment</p>
                  </div>
                  <div className="upgrade-plan-price">
                    <strong>{formatPrice(pack.price)}</strong>
                    <span>once</span>
                  </div>
                </div>

                <div className="credit-purchase-estimates" aria-label="Estimated generations">
                  <span>
                    <Video aria-hidden size={13} /> about {estimate.videos} five-second 720p videos
                  </span>
                  <span>
                    <ImageIcon aria-hidden size={13} /> about {estimate.images} 1K images
                  </span>
                </div>

                <button
                  className={`upgrade-plan-cta${featured ? " is-primary" : ""}`}
                  disabled={checkoutPack !== null}
                  onClick={() => void startCheckout(packId)}
                  type="button"
                >
                  {loading ? (
                    <>
                      <Loader2 aria-hidden className="animate-spin" size={14} /> Redirecting…
                    </>
                  ) : (
                    `Buy ${formatCredits(pack.credits)} credits for ${formatPrice(pack.price)}`
                  )}
                </button>
              </div>
            );
          })}
        </div>

        <p className="upgrade-foot">
          One-time payment. Purchased credits do not expire. Estimates vary by model and settings.
        </p>
      </DialogContent>
    </Dialog>
  );
}
