import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(), trigger: vi.fn(), youtube: vi.fn(), generate: vi.fn(), tracking: vi.fn(),
  updateImport: vi.fn(), readTrack: vi.fn(), writeTrack: vi.fn(),
}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: mocks.trigger } }));
vi.mock("@/lib/canvas-youtube-worker", () => ({ runCanvasYoutubeImport: mocks.youtube, runCanvasYoutubeGenerate: mocks.generate }));
vi.mock("@/lib/video-object-tracking-worker", () => ({ runVideoObjectTracking: mocks.tracking }));
vi.mock("@/lib/canvas-youtube-import", () => ({ updateCanvasYoutubeImportRecord: mocks.updateImport }));
vi.mock("@/lib/video-object-tracking", () => ({
  readTrackingRecord: mocks.readTrack, writeTrackingRecord: mocks.writeTrack,
  updateTrackingRecord: (record: object, patch: object) => ({ ...record, ...patch }),
}));

import { queueProjectTask } from "@/lib/project-tasks";

beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("APP_MODE", "local"); });
afterEach(() => vi.unstubAllEnvs());

describe("project task execution", () => {
  it("defers local import work until after the response without contacting Trigger", async () => {
    vi.stubEnv("TRIGGER_SECRET_KEY", "unused-hosted-test-credential");
    const payload = { projectId: "demo", importId: "import-1", userId: "local", url: "https://youtu.be/demo" };
    const run = await queueProjectTask("canvas-youtube-import-v1", payload);
    expect(run.id).toMatch(/^local_/);
    expect(mocks.youtube).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0][0]();
    expect(mocks.youtube).toHaveBeenCalledWith(payload);
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it("runs generation and tracking locally with no Trigger credentials", async () => {
    vi.stubEnv("TRIGGER_SECRET_KEY", "");
    const generation = { projectId: "demo", importId: "import-1", userId: "local" };
    const tracking = { projectId: "demo", trackId: "track-1" };
    await queueProjectTask("canvas-youtube-generate-v1", generation);
    await queueProjectTask("video-object-tracking-v1", tracking);
    for (const [callback] of mocks.after.mock.calls) await callback();
    expect(mocks.generate).toHaveBeenCalledWith(generation);
    expect(mocks.tracking).toHaveBeenCalledWith(tracking);
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it("persists worker startup failures instead of leaving a job queued", async () => {
    mocks.tracking.mockRejectedValue(new Error("Python unavailable"));
    mocks.readTrack.mockResolvedValue({ id: "track-1", status: "queued" });
    await queueProjectTask("video-object-tracking-v1", { projectId: "demo", trackId: "track-1" });
    await mocks.after.mock.calls[0][0]();
    expect(mocks.writeTrack).toHaveBeenCalledWith("demo", { id: "track-1", status: "failed", error: "Python unavailable" });
  });

  it("retains the explicitly hosted queue", async () => {
    vi.stubEnv("APP_MODE", "hosted");
    mocks.trigger.mockResolvedValue({ id: "hosted-run" });
    const payload = { projectId: "demo", trackId: "track-1" };
    const options = { maxDuration: 300 };
    expect(await queueProjectTask("video-object-tracking-v1", payload, options)).toEqual({ id: "hosted-run" });
    expect(mocks.trigger).toHaveBeenCalledWith("video-object-tracking-v1", payload, options);
    expect(mocks.after).not.toHaveBeenCalled();
  });
});
