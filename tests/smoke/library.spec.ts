import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

function sound() {
  const buffer = Buffer.alloc(44 + 1600);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(1600, 40);
  return buffer;
}

test("Library uploads, previews, imports and manages local files without a cloud account", async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem("impractical-onboarding-v1", JSON.stringify({ "studio-setup": true, "project-tour": true })));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const ids: string[] = [];
  const { project } = await (await request.post("/api/projects", { data: { name: "Library import proof" } })).json();
  const titles = ["library-image.png", "library-video.mp4", "library-sound.wav", "library-notes.txt", "library-bundle.custom"];
  try {
    await page.goto("/library");
    await expect(page.getByRole("button", { name: "Upload files", exact: true })).toBeVisible();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload files", exact: true }).click();
    await (await chooser).setFiles([
      { name: titles[0], mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4WQAAAAASUVORK5CYII=", "base64") },
      { name: titles[1], mimeType: "video/mp4", buffer: await readFile("tests/smoke/fixtures/clip.mp4") },
      { name: titles[2], mimeType: "audio/wav", buffer: sound() },
      { name: titles[3], mimeType: "text/plain", buffer: Buffer.from("A library script for the project agent.") },
      { name: titles[4], mimeType: "application/octet-stream", buffer: Buffer.from([0, 12, 32, 255]) },
    ]);
    for (const title of titles) await expect(page.locator(".library-card-title").getByText(title, { exact: true })).toBeVisible();
    const { localItems } = await (await request.get("/api/library/tree")).json();
    const uploads = localItems.filter((item: { title: string }) => titles.includes(item.title));
    ids.push(...uploads.map((item: { id: string }) => item.id));
    expect(ids).toHaveLength(5);
    await page.reload();
    for (const title of titles) await expect(page.locator(".library-card-title").getByText(title, { exact: true })).toBeVisible();
    await page.screenshot({ path: "/tmp/impractical-library-uploads.png" });

    for (const [title, tag] of [[titles[0], "img"], [titles[1], "video"], [titles[2], "audio"]]) {
      await page.locator(".library-card-title").getByText(title, { exact: true }).click();
      const preview = page.getByRole("dialog").locator(`.explore-reference-dialog-media-frame ${tag}`).first();
      await expect(preview).toBeVisible();
      if (tag === "img") await expect.poll(() => preview.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      else {
        await expect.poll(() => preview.evaluate(node => (node as HTMLMediaElement).readyState)).toBeGreaterThanOrEqual(2);
        await preview.evaluate(node => (node as HTMLMediaElement).play());
        await expect.poll(() => preview.evaluate(node => (node as HTMLMediaElement).currentTime)).toBeGreaterThan(0);
      }
      await page.getByRole("button", { name: `Close ${title}`, exact: true }).click();
    }
    await page.locator(".library-card-title").getByText(titles[4], { exact: true }).click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Open file", exact: true }).click();
    expect((await downloadPromise).suggestedFilename()).toBe(titles[4]);
    await page.getByRole("button", { name: `Close ${titles[4]}`, exact: true }).click();

    await page.locator(".library-card-title").getByText(titles[0], { exact: true }).click();
    await page.getByRole("button", { name: "Use", exact: true }).click();
    await page.getByRole("menuitem", { name: project.name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
    const snapshot = await (await request.get(`/api/projects/${project.id}`)).json();
    const record = snapshot.files.find((file: { path: string }) => /^uploads\/.+\.md$/.test(file.path));
    expect(record).toBeTruthy();
    expect(record.content).toContain(titles[0]);
    const mediaPath = JSON.parse(record.content.split("---")[1]).local_path;
    expect(mediaPath).toMatch(/^media\/uploads\/[^/]+\.png$/);
    const projectMedia = await request.get(`/api/projects/${project.id}/${mediaPath}`);
    expect(projectMedia.status()).toBe(200);

    const document = uploads.find((item: { title: string }) => item.title === titles[3]);
    expect((await request.post(`/api/published-items/${encodeURIComponent(document.id)}/use`, { data: { projectId: project.id } })).status()).toBe(200);
    const updated = await (await request.get(`/api/projects/${project.id}`)).json();
    expect(updated.files.some((file: { path: string; content: string }) => file.path.startsWith("documents/") && file.path.endsWith("content.md") && file.content.includes("A library script"))).toBe(true);

    await page.goto("/library");
    const card = page.locator(".library-card").filter({ has: page.locator(".library-card-title").getByText(titles[0], { exact: true }) });
    await card.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await page.locator(".library-inline-input").fill("Renamed image");
    await page.locator(".library-inline-input").press("Enter");
    await expect(page.locator(".library-card-title").getByText("Renamed image", { exact: true })).toBeVisible();
    const renamed = page.locator(".library-card").filter({ has: page.locator(".library-card-title").getByText("Renamed image", { exact: true }) });
    await renamed.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await expect(page.locator(".library-card-title").getByText("Renamed image", { exact: true })).toHaveCount(0);
    expect((await request.get(`/api/projects/${project.id}/${mediaPath}`)).status()).toBe(200);
    expect(errors).toEqual([]);
  } finally {
    await page.goto("/library");
    for (const id of ids) await request.delete(`/api/library/items/${encodeURIComponent(id)}`);
    await request.delete(`/api/projects/${project.id}`);
  }
});

test("Library accepts dropped files and reports failed uploads while preserving successful files", async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem("impractical-onboarding-v1", JSON.stringify({ "studio-setup": true })));
  const ids: string[] = [];
  try {
    await page.goto("/library");
    const data = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["dropped asset"], "dropped-note.txt", { type: "text/plain" }));
      return transfer;
    });
    await page.getByRole("region", { name: "Library assets" }).dispatchEvent("drop", { dataTransfer: data });
    await data.dispose();
    await expect(page.locator(".library-card-title").getByText("dropped-note.txt", { exact: true })).toBeVisible();
    await page.route("**/api/library/upload", async route => {
      if (route.request().postDataBuffer()?.includes(Buffer.from("fails.txt"))) await route.fulfill({ status: 500, json: { error: "Not enough disk space." } });
      else await route.continue();
    });
    await page.getByLabel("Upload library files").setInputFiles([
      { name: "fails.txt", mimeType: "text/plain", buffer: Buffer.from("fail") },
      { name: "succeeds.txt", mimeType: "text/plain", buffer: Buffer.from("success") },
    ]);
    await expect(page.getByRole("alert").filter({ hasText: "fails.txt" })).toContainText("fails.txt: Not enough disk space.");
    await expect(page.locator(".library-card-title").getByText("succeeds.txt", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload files", exact: true })).toBeEnabled();
    const { localItems } = await (await request.get("/api/library/tree")).json();
    ids.push(...localItems.filter((item: { title: string }) => ["dropped-note.txt", "succeeds.txt"].includes(item.title)).map((item: { id: string }) => item.id));
    expect(ids).toHaveLength(2);
  } finally { for (const id of ids) await request.delete(`/api/library/items/${encodeURIComponent(id)}`); }
});

test("Library preserves multipart uploads larger than the middleware's default buffer", async ({ request }) => {
  const bytes = Buffer.alloc(12 * 1024 * 1024, 42);
  const response = await request.post("/api/library/upload", { multipart: { file: { name: "large-library-file.bin", mimeType: "application/octet-stream", buffer: bytes } } });
  expect(response.status()).toBe(200);
  const { createdIds: [id] } = await response.json();
  try {
    const download = await request.get(`/api/library/assets/${encodeURIComponent(id)}`);
    expect(download.status()).toBe(200);
    expect(await download.body()).toEqual(bytes);
    expect((await request.post("/api/library/upload", { headers: { origin: "https://attacker.example" }, multipart: { file: { name: "blocked.txt", mimeType: "text/plain", buffer: Buffer.from("blocked") } } })).status()).toBe(403);
  } finally { await request.delete(`/api/library/items/${encodeURIComponent(id)}`); }
});
