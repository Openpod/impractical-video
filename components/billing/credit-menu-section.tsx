"use client";

import { Coins, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useMemo, useState, type ReactNode } from "react";
import { MenuItem, MenuSeparator } from "@/components/ui/menu";
import { useCreditContext } from "@/lib/credit-context";
import { CREDIT_PACKS, calculateUsageStats, formatPrice } from "@/lib/credits";
import { formatCredits } from "@/lib/format-credits";
import { openExternalOrNavigate } from "@/lib/open-external";

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(" ");
}

/** A value that slides up to a preview value when the purchase item is hovered. */
function SlidingMetric({
  currentValue,
  previewValue,
  reserveValue,
  isPreview,
  previewClassName,
}: {
  currentValue: string;
  previewValue: string;
  reserveValue?: string;
  isPreview: boolean;
  previewClassName?: string;
}) {
  return (
    <span className="relative inline-flex h-4 overflow-hidden leading-4 tabular-nums">
      <span className="invisible pointer-events-none">{reserveValue ?? currentValue}</span>
      <span
        className={cx(
          "absolute top-0 left-0 inline-block transition-all duration-200 ease-out",
          isPreview ? "-translate-y-full opacity-0" : "translate-y-0 opacity-100",
        )}
      >
        {currentValue}
      </span>
      <span
        className={cx(
          "absolute top-0 left-0 inline-block transition-all duration-200 ease-out",
          isPreview ? "translate-y-0 opacity-100" : "translate-y-full opacity-0",
          previewClassName,
        )}
      >
        {previewValue}
      </span>
    </span>
  );
}

export function CreditMenuSection({
  onRequestPurchase,
  showActions = true,
}: {
  onRequestPurchase?: () => void;
  /** false = just the usage bar (no purchase / manage-billing items). */
  showActions?: boolean;
}): ReactNode {
  const { credits, usage, subscription } = useCreditContext();
  const [isPreview, setIsPreview] = useState(false);

  const currentStats = useMemo(
    () => calculateUsageStats(credits.total, usage.usedThisMonth),
    [credits.total, usage.usedThisMonth],
  );

  const previewCredits = isPreview
    ? credits.total + CREDIT_PACKS.starter.credits
    : credits.total;
  const previewStats = useMemo(
    () => calculateUsageStats(previewCredits, usage.usedThisMonth),
    [previewCredits, usage.usedThisMonth],
  );

  return (
    <>
      <div className="px-2 py-2">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-[var(--text)]">Credits used</span>
            <span className="text-[var(--muted)]">
              {formatCredits(currentStats.usedThisMonth)} this month
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--control-bg)]">
            <div
              className={cx(
                "h-full rounded-full transition-all duration-200 ease",
                isPreview ? "bg-[#ef4444]" : "bg-[var(--accent)]",
              )}
              style={{ width: `${previewStats.remainingPercent}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs text-[var(--muted)]">
            <span className="inline-flex items-center gap-1">
              <SlidingMetric
                currentValue={`${currentStats.remainingPercent}%`}
                previewValue={`${previewStats.remainingPercent}%`}
                reserveValue={`${Math.max(currentStats.remainingPercent, previewStats.remainingPercent)}%`}
                isPreview={isPreview}
                previewClassName="text-[#ef4444]"
              />
              <span>remaining</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <SlidingMetric
                currentValue={formatCredits(credits.total)}
                previewValue={formatCredits(previewCredits)}
                reserveValue={
                  formatCredits(credits.total).length >= formatCredits(previewCredits).length
                    ? formatCredits(credits.total)
                    : formatCredits(previewCredits)
                }
                isPreview={isPreview}
                previewClassName="text-[#ef4444]"
              />
              <span>available</span>
            </span>
          </div>
        </div>
      </div>

      {showActions ? (
        <>
      <MenuSeparator />

      <MenuItem
        className="app-menu-item-credit"
        onBlur={() => setIsPreview(false)}
        onFocus={() => setIsPreview(true)}
        onPointerLeave={() => setIsPreview(false)}
        onPointerMove={() => setIsPreview(true)}
        onSelect={() => {
          setIsPreview(false);
          onRequestPurchase?.();
        }}
      >
        <Coins size={16} />
        <span className="flex min-w-0 flex-col gap-1">
          <span>Buy credits</span>
          <span className="text-xs text-[var(--muted)]">
            {formatCredits(CREDIT_PACKS.starter.credits)} for {formatPrice(CREDIT_PACKS.starter.price)} · one-time
          </span>
        </span>
      </MenuItem>

      {subscription.tier !== "free" ? (
        <MenuItem
          onSelect={async () => {
            try {
              const response = await fetch("/api/billing/portal", { method: "POST" });
              const data = (await response.json().catch(() => ({}))) as {
                error?: string;
                url?: string;
              };
              if (!response.ok || !data.url) throw new Error(data.error || "Could not open billing.");
              openExternalOrNavigate(data.url);
            } catch (caught) {
              toast.error(caught instanceof Error ? caught.message : "Could not open billing.");
            }
          }}
        >
          <Wallet size={16} />
          Manage billing
        </MenuItem>
      ) : null}
        </>
      ) : null}
    </>
  );
}
