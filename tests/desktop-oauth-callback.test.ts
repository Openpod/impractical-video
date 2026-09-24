import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");

describe("desktop OAuth callback", () => {
  it("keeps the hosted OAuth callback and guards local builds without Clerk", () => {
    const callback = fs.readFileSync(path.join(root, "app/sso-callback/page.tsx"), "utf8");

    expect(callback).toContain("AuthenticateWithRedirectCallback");
    expect(callback.indexOf("if (isLocalAppModeClient())")).toBeLessThan(callback.indexOf("<AuthenticateWithRedirectCallback"));
    expect(callback).toContain("Return to your local workspace");
  });

  it("keeps OAuth on the hosted domain and starts desktop auth through the handoff", () => {
    const authFlow = fs.readFileSync(path.join(root, "components/auth/auth-flow.tsx"), "utf8");
    const desktopGate = fs.readFileSync(path.join(root, "app/desktop-auth-gate.tsx"), "utf8");

    expect(authFlow).toContain('redirectUrl: "/sso-callback"');
    expect(desktopGate).toContain('fetch("/api/desktop/auth/start"');
    expect(desktopGate).toContain('searchParams.set("surface", "desktop")');
    expect(authFlow).toContain("oauthHandoffUrl");
    expect(desktopGate).not.toContain("useAuth");
  });

  it("keeps provider OAuth in the secured app surface with explicit browser fallbacks", () => {
    const main = fs.readFileSync(path.join(root, "desktop/main.mjs"), "utf8");
    const handoff = fs.readFileSync(path.join(root, "components/desktop-auth-handoff.tsx"), "utf8");

    expect(main).toContain("openDesktopAuthView");
    expect(main).toContain("new WebContentsView");
    expect(main).toContain("isAuthFlowUrl(next)");
    expect(main).toContain("openExternalFocused(handoff.href, ownerWindow)");
    expect(main).toContain("shell.openExternal(url, { activate: true })");
    expect(handoff).toContain("desktop-auth-fallback");
    expect(handoff).toContain("Copy link");
    expect(handoff).not.toContain("oauthHandoffUrl=");
    expect(handoff).toContain('surface === "browser" && method === "google"');
  });
});
