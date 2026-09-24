"use client";

import { useAuth, useClerk, useSignIn, useSignUp } from "@clerk/nextjs";
import { Loader2 } from "lucide-react";
// Loaders reuse the app's global `.spin`.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ImpracticalLogo } from "@/app/impractical-logo";
import { isLocalAppModeClient } from "@/lib/app-mode";

/**
 * Custom Clerk auth flow, styled with the app's own theme (white/surface,
 * centered, minimal) instead of Clerk's generic UI. One unified flow: email +
 * password auto-detects an existing account (sign in) vs a new one (create +
 * email-code verify), plus Google/GitHub OAuth. Mirrors the logic from the
 * marketing site's SignupPage against the same Clerk instance.
 */

type Step = "email" | "password" | "verification";
type LoadingMethod = "google" | "github" | "email" | null;
export type AuthOAuthStrategy = "oauth_google" | "oauth_github";

function clerkErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("errors" in error) || !Array.isArray(error.errors)) return null;
  const first = error.errors[0];
  return first && typeof first === "object" && "code" in first ? String(first.code) : null;
}

function clerkErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("errors" in error) || !Array.isArray(error.errors)) return null;
  const first = error.errors[0];
  if (!first || typeof first !== "object") return null;
  if ("longMessage" in first && typeof first.longMessage === "string") return first.longMessage;
  if ("message" in first && typeof first.message === "string") return first.message;
  return null;
}

export function AuthFlow({
  forceHosted = false,
  initialOAuthStrategy,
  mode = "sign-in",
  oauthHandoffUrl,
  redirectUrl = "/",
}: {
  /** Run the real Clerk flow even in local app mode — the desktop sign-in
   * gate wants actual accounts, not the local pass-through. */
  forceHosted?: boolean;
  /** Automatically begin a provider flow after the desktop app has handed
   * control to a real system browser. */
  initialOAuthStrategy?: AuthOAuthStrategy;
  mode?: "sign-in" | "sign-up";
  /** When present, provider buttons hand off to this external URL instead of
   * navigating the current (potentially embedded) renderer. */
  oauthHandoffUrl?: (strategy: AuthOAuthStrategy) => string;
  redirectUrl?: string;
}) {
  if (isLocalAppModeClient() && !forceHosted) {
    return <LocalModeAuthFlow redirectUrl={redirectUrl} />;
  }
  return (
    <HostedAuthFlow
      initialOAuthStrategy={initialOAuthStrategy}
      mode={mode}
      oauthHandoffUrl={oauthHandoffUrl}
      redirectUrl={redirectUrl}
    />
  );
}

function LocalModeAuthFlow({ redirectUrl }: { redirectUrl: string }) {
  useEffect(() => {
    window.location.replace(redirectUrl);
  }, [redirectUrl]);
  return (
    <div className="auth-loading" role="status">
      <Loader2 className="spin" size={18} />
      Opening your local workspace…
    </div>
  );
}

function HostedAuthFlow({
  initialOAuthStrategy,
  mode,
  oauthHandoffUrl,
  redirectUrl,
}: {
  initialOAuthStrategy?: AuthOAuthStrategy;
  mode: "sign-in" | "sign-up";
  oauthHandoffUrl?: (strategy: AuthOAuthStrategy) => string;
  redirectUrl: string;
}) {
  const { isLoaded: isAuthLoaded, isSignedIn } = useAuth();
  const { isLoaded: isSignInLoaded, signIn } = useSignIn();
  const { isLoaded: isSignUpLoaded, signUp } = useSignUp();
  const clerk = useClerk();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>("email");
  const [loading, setLoading] = useState(false);
  const [method, setMethod] = useState<LoadingMethod>(null);
  const [error, setError] = useState<string | null>(null);
  const autoOAuthStartedRef = useRef(false);

  function redirectToApp() {
    window.location.assign(redirectUrl);
  }

  // If a session already exists (e.g. an OAuth callback finished but landed the
  // user back on this page), forward to the app instead of stranding them here.
  useEffect(() => {
    if (isAuthLoaded && isSignedIn) redirectToApp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthLoaded, isSignedIn]);

  async function handleOAuth(strategy: AuthOAuthStrategy) {
    if (isAuthLoaded && isSignedIn) return redirectToApp();
    if (!isSignInLoaded || !signIn) {
      setError("Auth is still loading — try again in a moment.");
      return;
    }
    setError(null);
    setLoading(true);
    setMethod(strategy === "oauth_google" ? "google" : "github");
    try {
      if (oauthHandoffUrl) {
        window.open(oauthHandoffUrl(strategy), "_blank", "noopener,noreferrer");
        setLoading(false);
        setMethod(null);
        return;
      }
      await signIn.authenticateWithRedirect({
        strategy,
        redirectUrl: "/sso-callback",
        redirectUrlComplete: redirectUrl,
      });
    } catch (caught) {
      const message = caught && typeof caught === "object" && "message" in caught ? String(caught.message).toLowerCase() : "";
      if (message.includes("already signed in")) return redirectToApp();
      setLoading(false);
      setMethod(null);
      setError("Could not start that sign-in. Please try again.");
    }
  }

  useEffect(() => {
    if (
      !initialOAuthStrategy ||
      !isAuthLoaded ||
      !isSignInLoaded ||
      isSignedIn ||
      autoOAuthStartedRef.current
    ) {
      return;
    }
    autoOAuthStartedRef.current = true;
    void handleOAuth(initialOAuthStrategy);
    // The provider is intentionally selected once from the signed desktop
    // handoff URL; subsequent Clerk state changes must not restart OAuth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOAuthStrategy, isAuthLoaded, isSignInLoaded, isSignedIn]);

  async function handlePassword() {
    if (isAuthLoaded && isSignedIn) return redirectToApp();
    if (!email.trim()) {
      setError("Please enter an email address.");
      setStep("email");
      return;
    }
    if (!password.trim()) {
      setError("Please enter your password.");
      return;
    }
    if (!isSignInLoaded || !signIn || !isSignUpLoaded || !signUp) {
      setError("Auth is still loading — try again in a moment.");
      return;
    }
    setError(null);
    setLoading(true);
    setMethod("email");
    try {
      const result = await signIn.create({ identifier: email.trim(), password });
      if (result.status === "complete" && result.createdSessionId) {
        await clerk.setActive({ session: result.createdSessionId });
        return redirectToApp();
      }
      setError("Your account needs another sign-in step — try Google or GitHub.");
    } catch (caught) {
      const code = clerkErrorCode(caught);
      const isNewUser =
        code === "form_identifier_not_found" || code === "strategy_for_user_invalid" || code === "identifier_not_found";
      if (isNewUser) {
        try {
          await signUp.create({ emailAddress: email.trim(), password });
          await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
          setStep("verification");
          setCode("");
          setError(null);
          return;
        } catch (signUpError) {
          setError(clerkErrorMessage(signUpError) ?? "Could not create your account. Please try again.");
          return;
        }
      }
      setError(clerkErrorMessage(caught) ?? "Could not sign in with that email and password.");
    } finally {
      setLoading(false);
      setMethod(null);
    }
  }

  async function handleVerification() {
    if (!code.trim()) {
      setError("Enter the code we emailed you.");
      return;
    }
    if (!isSignUpLoaded || !signUp) {
      setError("Auth is still loading — try again in a moment.");
      return;
    }
    setError(null);
    setLoading(true);
    setMethod("email");
    try {
      const result = await signUp.attemptEmailAddressVerification({ code: code.trim() });
      if (result.status === "complete" && result.createdSessionId) {
        await clerk.setActive({ session: result.createdSessionId });
        return redirectToApp();
      }
      setError("That didn't complete — try the code again.");
    } catch (caught) {
      setError(clerkErrorMessage(caught) ?? "Could not verify that code.");
    } finally {
      setLoading(false);
      setMethod(null);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step === "email") {
      if (!email.trim()) {
        setError("Please enter an email address.");
        return;
      }
      setError(null);
      setStep("password");
      return;
    }
    if (step === "password") void handlePassword();
    else void handleVerification();
  }

  const title = mode === "sign-up" ? "Create your account" : "Welcome back";
  const submitLabel = step === "verification" ? "Verify and continue" : "Continue";

  return (
    <div className="auth-card">
      <span className="auth-logo" aria-hidden="true">
        <ImpracticalLogo />
      </span>
      <h1 className="auth-title">{title}</h1>

      <div className="auth-oauth">
        <button
          type="button"
          className="auth-oauth-btn"
          disabled={loading || !isSignInLoaded}
          onClick={() => void handleOAuth("oauth_google")}
        >
          {loading && method === "google" ? (
            <Loader2 className="spin" size={16} />
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
              <path d="M12.545 10.239v3.821h5.445c-.712 2.315-2.647 3.972-5.445 3.972a6.033 6.033 0 1 1 0-12.064c1.498 0 2.866.549 3.921 1.453l2.814-2.814A9.97 9.97 0 0 0 12.545 2C7.021 2 2.543 6.477 2.543 12s4.478 10 10.002 10c8.396 0 10.249-7.85 9.426-11.748z" />
            </svg>
          )}
          <span>Continue with Google</span>
        </button>
        <button
          type="button"
          className="auth-oauth-btn"
          disabled={loading || !isSignInLoaded}
          onClick={() => void handleOAuth("oauth_github")}
        >
          {loading && method === "github" ? (
            <Loader2 className="spin" size={16} />
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
              <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.523 2 12 2z" />
            </svg>
          )}
          <span>Continue with GitHub</span>
        </button>
      </div>

      <div className="auth-divider">
        <span>or</span>
      </div>

      <form className="auth-form" onSubmit={handleSubmit}>
        <label className="auth-field">
          <span className="auth-label">Email</span>
          <input
            className="auth-input"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="you@example.com"
            value={email}
            disabled={loading || step === "verification"}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        {step !== "email" ? (
          <label className="auth-field">
            <span className="auth-label">{step === "verification" ? "Verification code" : "Password"}</span>
            <input
              className="auth-input"
              type={step === "verification" ? "text" : "password"}
              inputMode={step === "verification" ? "numeric" : undefined}
              autoComplete={step === "verification" ? "one-time-code" : "current-password"}
              placeholder={step === "verification" ? "6-digit code" : "Password"}
              value={step === "verification" ? code : password}
              disabled={loading}
              onChange={(event) => (step === "verification" ? setCode(event.target.value) : setPassword(event.target.value))}
            />
            {step === "verification" ? (
              <span className="auth-hint">
                We sent a code to <strong>{email}</strong>.
              </span>
            ) : null}
          </label>
        ) : null}

        <button type="submit" className="auth-submit" disabled={loading}>
          {loading && method === "email" ? <Loader2 className="spin" size={16} /> : null}
          <span>{submitLabel}</span>
        </button>

        {step !== "email" ? (
          <button
            type="button"
            className="auth-textlink"
            onClick={() => {
              setStep("email");
              setPassword("");
              setCode("");
              setError(null);
            }}
          >
            Use a different email
          </button>
        ) : null}

        {error ? <p className="auth-error">{error}</p> : null}
      </form>

      <p className="auth-terms">
        By continuing, you agree to our <a href="/terms" rel="noreferrer" target="_blank">Terms</a> and <a href="/privacy" rel="noreferrer" target="_blank">Privacy Policy</a>.
      </p>
    </div>
  );
}
