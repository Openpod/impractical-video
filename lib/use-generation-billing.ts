"use client";

import { useEffect, useState } from "react";
import { isBillingUiEnabled, isLocalAppModeClient } from "@/lib/app-mode";

/** Local users can opt into credits during setup without changing a build flag. */
export function useGenerationBilling() {
  const [enabled, setEnabled] = useState(isBillingUiEnabled);
  useEffect(() => {
    if (!isLocalAppModeClient()) return;
    let active = true;
    const refresh = () => {
      void fetch("/api/settings/generation", { cache: "no-store" }).then(response => response.ok ? response.json() : null).then(result => {
        if (active && result) setEnabled(result.mode === "credits");
      }).catch(() => {});
    };
    refresh();
    window.addEventListener("video-fs:generation-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("video-fs:generation-changed", refresh); window.removeEventListener("focus", refresh); };
  }, []);
  return enabled;
}
