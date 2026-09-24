// Shared redirect resolution for the Clerk sign-in/sign-up pages. Ported from
// impractical-chat (lib/auth-redirect.ts) and trimmed for this app: the home
// route here is "/", not "/home".

export const DEFAULT_AUTH_REDIRECT_URL = "/";

export type SearchParamsLike = {
  get(name: string): string | null;
};

/** Only same-origin relative paths are allowed, to avoid open-redirects. */
export function normalizeRedirectCandidate(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }

  if (typeof window === "undefined") return null;

  try {
    const candidate = new URL(trimmed);
    if (candidate.origin !== window.location.origin) return null;
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch {
    return null;
  }
}

export function resolveRedirectUrl(params: SearchParamsLike): string {
  const explicitRedirect =
    params.get("redirect_url") ??
    params.get("redirectUrl") ??
    params.get("return_url") ??
    params.get("returnTo");
  const normalized = normalizeRedirectCandidate(explicitRedirect);
  return normalized ?? DEFAULT_AUTH_REDIRECT_URL;
}
