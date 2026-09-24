import { expect, test } from "@playwright/test";

test("a fresh local install creates a project, persists media and opens canvas/editor without a cloud account", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByPlaceholder("What do you want to make?")).toBeVisible();
  const created = await request.post("/api/projects", { data: { name: "Release smoke project" } });
  expect(created.status()).toBe(200);
  const { project } = await created.json();
  try {
    const uploaded = await request.post(`/api/projects/${project.id}/canvas/upload`, {
      multipart: { files: { name: "pixel.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4WQAAAAASUVORK5CYII=", "base64") } },
    });
    expect(uploaded.status()).toBe(200);
    const body = await uploaded.json();
    expect(body.uploaded).toHaveLength(1);
    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole("tab", { name: "Editor", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Editor", exact: true }).click();
    await expect(page.locator(".opencut-scope")).toBeVisible();
    await page.reload();
    const stored = await request.get(`/api/projects/${project.id}`);
    expect(stored.status()).toBe(200);
    expect((await stored.json()).files.some((file: { path: string }) => file.path === body.uploaded[0].path)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.goto("/");
    expect((await request.delete(`/api/projects/${project.id}`)).status()).toBe(200);
    expect((await request.post(`/api/projects/${project.id}/canvas/context-identity`, { data: { mode: "resolve", artifacts: [] } })).status()).toBe(404);
  }
});

test("local HTTP boundary rejects foreign origins and network hosts", async ({ request }) => {
  expect((await request.post("/api/projects", { headers: { origin: "https://attacker.example" }, data: { name: "unwanted" } })).status()).toBe(403);
  expect((await request.get("/api/projects", { headers: { host: "attacker.example" } })).status()).toBe(403);
  expect((await request.post("/api/paper/tools", { data: { tool: "get_project_status", arguments: { projectId: "missing" } } })).status()).toBe(401);
});

test("local OAuth callback does not require a hosted Clerk provider", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/sso-callback");
  await expect(page.getByRole("link", { name: "Return to your local workspace" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("users can save, replace and remove their fal key in the app without paid requests", async ({ page, request }) => {
  const errors: string[] = [];
  const providerRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (req) => { if (/https:\/\/[^/]*fal\.(ai|run)\//.test(req.url())) providerRequests.push(req.url()); });
  await page.goto("/");
  await page.getByRole("dialog", { name: "Welcome to Impractical" }).getByRole("button", { name: "Skip setup" }).click();
  async function openSettings() {
    await page.getByRole("button", { name: "Account", exact: true }).filter({ visible: true }).click();
    await page.getByRole("menuitem", { name: "API keys", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "API keys" })).toBeVisible();
  }
  try {
    await openSettings();
    await expect(page.getByText("No fal.ai key configured", { exact: true })).toBeVisible();
    const input = page.getByLabel("fal.ai API key", { exact: true });
    await expect(input).toHaveAttribute("type", "password");
    await input.fill("smoke-only-key:alpha");
    await page.getByRole("button", { name: "Save key", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Key saved.");
    await expect(input).toHaveValue("");
    await page.reload();
    await openSettings();
    await expect(page.getByText("Using your saved key", { exact: true })).toBeVisible();
    await expect(page.getByLabel("fal.ai API key", { exact: true })).toHaveValue("");
    await page.getByLabel("fal.ai API key", { exact: true }).fill("smoke-only-key:beta");
    await page.getByRole("button", { name: "Save key", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Key saved.");
    const status = await request.get("/api/settings/providers");
    expect(await status.json()).toEqual({ configured: true, source: "saved", environmentConfigured: false });
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("smoke-only-key");
    await page.getByRole("button", { name: "Remove saved key" }).click();
    await expect(page.getByText("No fal.ai key configured", { exact: true })).toBeVisible();
    await page.reload();
    await openSettings();
    await expect(page.getByText("No fal.ai key configured", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    expect(providerRequests).toEqual([]);
  } finally {
    await request.delete("/api/settings/providers");
  }
});
