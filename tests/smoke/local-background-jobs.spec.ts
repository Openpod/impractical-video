import { expect, test } from "@playwright/test";

test("local tracking queues and records failures without a hosted worker", async ({ request }) => {
  const response = await request.post("/api/projects", { data: { name: "Local background task" } });
  expect(response.ok()).toBe(true);
  const { project } = await response.json();
  try {
    const queued = await request.post(`/api/projects/${project.id}/tracks`, {
      data: {
        source: { id: "missing-video", kind: "video", title: "Missing video" },
        media: { src: "/missing-tracking-input.mp4" },
        frame: { naturalWidth: 640, naturalHeight: 360 },
        annotations: [{ type: "rect", x: 0.1, y: 0.1, width: 0.3, height: 0.3 }],
      },
    });
    expect(queued.ok()).toBe(true);
    const { runId, track } = await queued.json();
    expect(runId).toMatch(/^local_/);
    // The deliberately missing input fails locally before Python or any provider runs.
    await expect.poll(async () => {
      const snapshot = await (await request.get(`/api/projects/${project.id}`)).json();
      const file = snapshot.files.find((entry: { path: string }) => entry.path === `tracking/${track.id}.json`);
      return file ? JSON.parse(file.content) : null;
    }).toMatchObject({ status: "failed", error: "Failed to download video (404)." });

    expect(await (await request.get(`/api/projects/${project.id}/chat/stream`)).json()).toEqual({ activeRun: null });
    expect((await request.post(`/api/projects/${project.id}/chat/stream`, { data: {} })).status()).toBe(404);
    expect((await request.post(`/api/projects/${project.id}/chat/resumable-stream`, { data: {} })).status()).toBe(404);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});
