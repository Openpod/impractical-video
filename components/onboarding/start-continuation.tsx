"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { clearStartIntent, readStartIntent } from "@/lib/onboarding-intent";
import { userFacingError } from "@/lib/user-facing-error";
import { useAppAuth } from "@/lib/app-auth";

/**
 * Completes a signed-out visitor's "Start" once they're back signed in: reads
 * the stashed intent (picks + prompt), creates a project, imports the picks,
 * then navigates into it with the prompt so it auto-fires. Mounted app-wide so
 * it runs wherever sign-up drops them. One-shot per intent.
 */
export function StartContinuation() {
  const { isLoaded, isSignedIn } = useAppAuth();
  const router = useRouter();
  const ranRef = useRef(false);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || ranRef.current) return;
    const intent = readStartIntent();
    if (!intent) return;
    ranRef.current = true;
    clearStartIntent();

    void (async () => {
      const toastId = toast.loading("Setting up your project…");
      try {
        const name = intent.prompt.trim() ? intent.prompt.trim().slice(0, 64) : "Untitled video";
        const response = await fetch("/api/projects", {
          body: JSON.stringify({ name }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.project) throw new Error(data.error || "Could not create your project.");
        const projectId = data.project.id as string;

        let imported = 0;
        for (const id of intent.pickIds) {
          const used = await fetch(`/api/published-items/${encodeURIComponent(id)}/use`, {
            body: JSON.stringify({ projectId }),
            headers: { "content-type": "application/json" },
            method: "POST",
          });
          if (used.ok) imported += 1;
        }

        toast.success(imported ? `Added ${imported} to your new project.` : "Project created.", { id: toastId });
        const query = intent.prompt.trim() ? `?prompt=${encodeURIComponent(intent.prompt.trim())}` : "";
        router.push(`/projects/${projectId}${query}`);
      } catch (caught) {
        toast.error(userFacingError(caught, "Could not set up your project."), { id: toastId });
      }
    })();
  }, [isLoaded, isSignedIn, router]);

  return null;
}
