import { expect, test, type Page } from "@playwright/test";

async function desktop(page: Page, skipTour = false) {
  await page.addInitScript(({ skipTour }) => {
    Object.defineProperty(window, "videoFsDesktopEnvironment", { value: {
      platform: "macos",
      companionToggle: async () => { document.body.dataset.chatToggles = String(Number(document.body.dataset.chatToggles || 0) + 1); },
    } });
    if (skipTour) localStorage.setItem("impractical-onboarding-v1", JSON.stringify({ "studio-setup": true, "project-tour": true }));
  }, { skipTour });
}

async function expectSpotlightAligned(page: Page) {
  await expect(page.locator("[data-project-tour-backdrop]")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const target = document.querySelector('[data-project-tour-active="true"]');
    const spotlight = document.querySelector("[data-project-tour-spotlight]");
    if (!target || !spotlight) return Infinity;
    const a = target.getBoundingClientRect(); const b = spotlight.getBoundingClientRect();
    return Math.max(Math.abs(a.x - b.x - 4), Math.abs(a.y - b.y - 4), Math.abs(a.width + 8 - b.width), Math.abs(a.height + 8 - b.height));
  })).toBeLessThan(1);
}

test("project tour follows the controls, can be skipped and replayed, and opens browser chat", async ({ page, request }) => {
  const { project } = await (await request.post("/api/projects", { data: { name: "Project tour proof" } })).json();
  const card = page.locator("[data-project-tour-card]");
  try {
    await page.goto(`/projects/${project.id}`);
    await expect(card).toContainText("Add footage and references to your canvas");
    await expect(page.locator('[data-project-tour="canvas"][data-project-tour-active="true"]')).toBeVisible();
    await expectSpotlightAligned(page);
    await card.getByRole("button", { name: "Skip tour" }).click();
    await page.reload();
    await expect(page.getByRole("tab", { name: "Canvas", exact: true })).toBeVisible();
    await expect(card).toHaveCount(0);
    await expect(page.locator("[data-project-tour-backdrop]")).toHaveCount(0);
    await page.getByRole("toolbar", { name: "Project tools" }).getByRole("button", { name: "Account", exact: true }).click();
    await page.getByRole("menuitem", { name: "Project tour", exact: true }).click();
    await expect(card).toContainText("Add footage and references to your canvas");
    await card.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator('[data-project-tour="editor"][data-project-tour-active="true"]')).toBeVisible();
    await page.locator('[data-project-tour="editor"][data-project-tour-active="true"]').click();
    await expect(page.locator(".opencut-scope")).toBeVisible();
    await expect(card).toBeVisible();
    await expectSpotlightAligned(page);
    await page.screenshot({ path: "/tmp/impractical-project-tour.png" });
    await card.getByRole("button", { name: "Next", exact: true }).click();
    await expect(card).toContainText("separate tab");
    const popupPromise = page.waitForEvent("popup");
    await page.locator('[data-project-tour="chat"][data-project-tour-active="true"]').click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(new RegExp(`/companion\\?project=${project.id}$`));
    await popup.close();
    await card.getByRole("button", { name: "Got it" }).click();
    await expect(card).toHaveCount(0);
    await expect(page.locator("[data-project-tour-backdrop]")).toHaveCount(0);
    expect(await page.locator("[data-project-tour-active]").count()).toBe(0);
  } finally { await page.goto("/library"); await request.delete(`/api/projects/${project.id}`); }
});

test("desktop tour points to the native chat toggle and remembers Escape dismissal", async ({ page, request }) => {
  await desktop(page);
  const { project } = await (await request.post("/api/projects", { data: { name: "Desktop tour proof" } })).json();
  const card = page.locator("[data-project-tour-card]");
  try {
    await page.goto(`/projects/${project.id}`);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Next", exact: true }).click();
    await card.getByRole("button", { name: "Next", exact: true }).click();
    await expect(card).toContainText("Option + Space");
    await expectSpotlightAligned(page);
    await page.setViewportSize({ width: 900, height: 720 });
    await expectSpotlightAligned(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => page.locator("[data-project-tour-spotlight]").evaluate(node => getComputedStyle(node, "::after").animationName)).toBe("none");
    await page.screenshot({ path: "/tmp/impractical-project-tour-900.png" });
    await expect(page.locator('.desktop-titlebar-actions [data-project-tour="chat"][data-project-tour-active="true"]')).toBeVisible();
    await page.locator('[data-project-tour="chat"][data-project-tour-active="true"]').click();
    await expect(page.locator("body")).toHaveAttribute("data-chat-toggles", "1");
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(page.locator("[data-project-tour-backdrop]")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("tab", { name: "Canvas", exact: true })).toBeVisible();
    await expect(card).toHaveCount(0);
    await expect(page.locator("[data-project-tour-backdrop]")).toHaveCount(0);
  } finally { await page.goto("/library"); await request.delete(`/api/projects/${project.id}`); }
});

test("closing inactive, active and final project tabs keeps exactly the remaining tabs across reloads", async ({ page, request }) => {
  await desktop(page, true);
  const projects: Array<{ id: string; name: string }> = [];
  try {
    for (const name of ["Tab Alpha", "Tab Beta", "Tab Gamma"]) {
      const { project } = await (await request.post("/api/projects", { data: { name } })).json();
      projects.push(project);
      await page.goto(`/projects/${project.id}`);
      await expect(page.getByRole("tab", { name, exact: true })).toBeVisible({ timeout: 30_000 });
    }
    await page.getByRole("button", { name: "Close Tab Beta tab", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Tab Beta", exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/projects/${projects[2].id}$`));
    await page.getByRole("button", { name: "Close Tab Gamma tab", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projects[0].id}$`));
    await expect(page.getByRole("tab", { name: "Tab Gamma", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("tab", { name: "Tab Alpha", exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("video-fs.desktop.open-project-tabs.v1") || "[]"))).toEqual([projects[0].id]);
    await page.getByRole("button", { name: "Close Tab Alpha tab", exact: true }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await page.reload();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("video-fs.desktop.open-project-tabs.v1") || "[]"))).toEqual([]);
    for (const project of projects) expect((await request.get(`/api/projects/${project.id}`)).status()).toBe(200);
  } finally { await page.goto("/library"); for (const project of projects) await request.delete(`/api/projects/${project.id}`); }
});
