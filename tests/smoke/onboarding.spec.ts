import { expect, test, type Page } from "@playwright/test";

async function toBilling(page: Page) {
  await page.route("**/api/agent-connect?**", route => route.fulfill({ json: { agent: new URL(route.request().url()).searchParams.get("agent"), installed: true, signedIn: true, stage: "connected" } }));
  await page.goto("/?setup=1");
  await page.getByRole("button", { name: "Let’s get started" }).click();
  await expect(page.getByText("Installed and signed in", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Video models need a funded fal.ai key or Impractical credits.", { exact: true })).toBeVisible();
}

test("first-run setup can be skipped, creates a project and stays completed", async ({ page, request }) => {
  const calls: string[] = [];
  page.on("request", req => { if (req.method() === "POST") calls.push(req.url()); });
  await toBilling(page);
  const option = page.getByRole("button", { name: /I’ve got a fal API key/ });
  const box = await option.boundingBox();
  expect(Math.abs(box!.width - box!.height)).toBeLessThan(2);
  await expect(page.getByRole("button", { name: /Purchase credits/ })).toBeVisible();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.getByRole("button", { name: "Create my first project" }).click();
  await expect(page).toHaveURL(/\/projects\/[a-z0-9-]+$/);
  const projectId = new URL(page.url()).pathname.split("/").pop();
  expect(calls.some(url => /checkout|\/fal\/|agent-connect/.test(url))).toBe(false);
  await page.goto("/");
  await expect(page.getByPlaceholder("What do you want to make?")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Welcome to Impractical" })).toHaveCount(0);
  await request.delete(`/api/projects/${projectId}`);
});

test("onboarding saves a fal key, handles invalid input and never stores it in the browser", async ({ page, request }) => {
  try {
    await toBilling(page);
    await page.getByRole("button", { name: /I’ve got a fal API key/ }).click();
    await expect(page.getByRole("button", { name: "Save & continue" })).toBeDisabled();
    await page.getByLabel("Your fal.ai API key").fill("invalid key");
    await page.getByRole("button", { name: "Save & continue" }).click();
    await expect(page.getByRole("alert")).toContainText("complete fal.ai key");
    await page.getByLabel("Your fal.ai API key").fill("onboarding-test-only:fal-key");
    await page.getByRole("button", { name: "Save & continue" }).click();
    await expect(page.getByRole("button", { name: "Create my first project" })).toBeVisible();
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("onboarding-test-only");
    expect((await (await request.get("/api/settings/providers")).json()).configured).toBe(true);
    expect((await (await request.get("/api/settings/generation")).json()).mode).toBe("fal");
    await page.getByRole("button", { name: "Explore first" }).click();
    await page.getByRole("button", { name: "Account", exact: true }).filter({ visible: true }).click();
    await page.getByRole("menuitem", { name: "Setup guide" }).click();
    await expect(page.getByRole("button", { name: "Let’s get started" })).toBeVisible();
  } finally { await request.delete("/api/settings/providers"); }
});

test("checkout errors stay recoverable and opening checkout does not imply paid credits", async ({ page, request }) => {
  let balance = 0;
  let attempts = 0;
  await page.addInitScript(() => {
    Object.defineProperty(window, "videoFsDesktopEnvironment", { value: { platform: "darwin", authSessionConnected: async () => true } });
    window.open = () => null;
  });
  await page.route("**/api/desktop/cloud-session", route => route.fulfill({ json: { connected: true } }));
  await page.route("**/api/credits", route => route.fulfill({ json: { credits: { total: balance }, isLoaded: true } }));
  await page.route("**/api/checkout/credits", route => {
    attempts++;
    expect(route.request().postDataJSON()).toEqual({ packId: "starter" });
    return route.fulfill(attempts === 1 ? { status: 503, json: { error: "Checkout is temporarily unavailable." } } : { json: { url: "https://checkout.stripe.com/test-only" } });
  });
  try {
    await toBilling(page);
    await page.getByRole("button", { name: /Purchase credits/ }).click();
    await expect(page.getByText("0 credits available", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Starter/ }).click();
    await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
    await page.getByRole("button", { name: /Starter/ }).click();
    await expect(page.getByRole("status")).toContainText("Checkout opened");
    await expect(page.getByRole("button", { name: "Continue with credits" })).toHaveCount(0);
    balance = 1000;
    await expect(page.getByRole("button", { name: "Continue with credits" })).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "Continue with credits" }).click();
    await expect(page.getByRole("button", { name: "Create my first project" })).toBeVisible();
    expect((await (await request.get("/api/settings/generation")).json()).mode).toBe("credits");
  } finally { await request.put("/api/settings/generation", { data: { mode: "fal" } }); }
});

test("credit sign-in requires a click and failed balance checks can be retried", async ({ page, request }) => {
  let connected = false;
  let balanceAvailable = false;
  let authStarts = 0;
  await page.addInitScript(() => {
    Object.defineProperty(window, "videoFsDesktopEnvironment", { value: { platform: "darwin", authSessionConnected: async () => true } });
    window.open = () => null;
  });
  await page.route("**/api/desktop/cloud-session", route => route.fulfill({ json: { connected } }));
  await page.route("**/api/desktop/auth/start", route => {
    authStarts++;
    return route.fulfill({ json: { url: "https://chat.impractical.ai/desktop-auth/test-only" } });
  });
  await page.route("**/api/credits", route => route.fulfill(balanceAvailable
    ? { json: { credits: { total: 0 } } }
    : { status: 503, json: { error: "Unavailable" } }));
  try {
    await toBilling(page);
    await page.getByRole("button", { name: /Purchase credits/ }).click();
    await expect(page.getByRole("button", { name: "Sign in to purchase" })).toBeVisible();
    expect(authStarts).toBe(0);
    await page.getByRole("button", { name: "Sign in to purchase" }).click();
    await expect(page.getByRole("status")).toContainText("Finish signing in");
    expect(authStarts).toBe(1);
    connected = true;
    await expect(page.getByRole("alert")).toContainText("Could not check your balance", { timeout: 10000 });
    await expect(page.getByRole("button", { name: /Starter/ })).toBeVisible();
    balanceAvailable = true;
    await page.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByText("0 credits available", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally { await request.put("/api/settings/generation", { data: { mode: "fal" } }); }
});

test("local-browser credit limitations are explained", async ({ page }) => {
  await toBilling(page);
  await page.getByRole("button", { name: /Purchase credits/ }).click();
  await expect(page.getByText(/Open Impractical Desktop to purchase and use credits/)).toBeVisible();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create my first project" })).toBeVisible();
});
