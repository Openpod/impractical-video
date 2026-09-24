import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const provider = vi.hoisted(() => ({
  subscribe: vi.fn(), upload: vi.fn(), createClient: vi.fn(), cloudFetch: vi.fn(),
}));
vi.mock("@fal-ai/client", () => ({ createFalClient: provider.createClient }));
vi.mock("@/lib/desktop-cloud", () => ({ desktopCloudFetch: provider.cloudFetch, hasDesktopCloudSession: () => false }));

import { getFalKey, getFalKeyStatus, removeFalKey, saveFalKey } from "@/lib/local-provider-settings";
import { runFalRequest, uploadToFalStorage } from "@/lib/media";
import { DELETE, GET, PUT } from "@/app/api/settings/providers/route";
import { getGenerationMode, saveGenerationMode } from "@/lib/local-generation-mode";
import { GET as getGeneration, PUT as putGeneration } from "@/app/api/settings/generation/route";

let temporary: string;
const keyA = "test-only-key:alpha";
const keyB = "test-only-key:beta";
function request(method = "GET", falKey?: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/settings/providers", {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(method === "PUT" ? { body: JSON.stringify({ falKey }) } : {}),
  });
}

beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "video-fs-provider-test-"));
  vi.stubEnv("APP_MODE", "local");
  vi.stubEnv("NEXT_PUBLIC_DESKTOP_CLOUD_ENABLED", "false");
  vi.stubEnv("FAL_KEY", "");
  vi.stubEnv("VIDEO_FS_SETTINGS_ROOT", path.join(temporary, "settings"));
  vi.stubEnv("VIDEO_FS_DATA_ROOT", path.join(temporary, "projects"));
  vi.resetAllMocks();
  provider.createClient.mockReturnValue({ subscribe: provider.subscribe, storage: { upload: provider.upload } });
  provider.subscribe.mockResolvedValue({ data: { images: [{ url: "https://fal.example/result.png" }] } });
  provider.upload.mockResolvedValue("https://fal.example/upload.png");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(temporary, { recursive: true, force: true });
});

describe("local provider settings", () => {
  it("persists private keys outside projects and returns metadata only", async () => {
    const response = await PUT(request("PUT", ` ${keyA}\n`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: true, source: "saved", environmentConfigured: false });
    const file = path.join(temporary, "settings", "providers.json");
    expect(JSON.parse(await readFile(file, "utf8")).falKey).toBe(keyA);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await getFalKey()).toBe(keyA);
    const status = await GET(request());
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.text()).not.toContain(keyA);
    expect(provider.createClient).not.toHaveBeenCalled();
    expect(provider.cloudFetch).not.toHaveBeenCalled();
  });

  it("uses the data-root sibling by default", async () => {
    vi.stubEnv("VIDEO_FS_SETTINGS_ROOT", "");
    await saveFalKey(keyA);
    expect(JSON.parse(await readFile(path.join(temporary, "settings", "providers.json"), "utf8")).falKey).toBe(keyA);
  });

  it("immediately replaces a saved key and restores the environment on removal", async () => {
    vi.stubEnv("FAL_KEY", keyA);
    expect((await getFalKeyStatus()).source).toBe("environment");
    await saveFalKey(keyB);
    expect(await getFalKey()).toBe(keyB);
    const removed = await DELETE(request("DELETE"));
    expect(await removed.json()).toEqual({ configured: true, source: "environment", environmentConfigured: true });
    expect(await getFalKey()).toBe(keyA);
    vi.stubEnv("FAL_KEY", "");
    expect(await getFalKey()).toBeNull();
  });

  it("keeps keys out of malformed-file errors and allows recovery", async () => {
    await saveFalKey(keyA);
    await writeFile(path.join(temporary, "settings", "providers.json"), `{${keyA}`);
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(keyA);
    expect((await PUT(request("PUT", keyB))).status).toBe(200);
    expect(await getFalKey()).toBe(keyB);
  });

  it.each(["", "bad key", '"quoted"', "key\nwithnewline", "x".repeat(2049), null, 123])("rejects malformed input %j", async (value) => {
    expect((await PUT(request("PUT", value))).status).toBe(400);
    expect(await getFalKey()).toBeNull();
  });

  it("rejects cross-origin reads/writes/removal and form submissions", async () => {
    const headers = { origin: "https://attacker.example" };
    expect((await GET(request("GET", undefined, headers))).status).toBe(403);
    expect((await PUT(request("PUT", keyA, headers))).status).toBe(403);
    expect((await DELETE(request("DELETE", undefined, headers))).status).toBe(403);
    expect((await GET(new Request("http://attacker.example/api/settings/providers"))).status).toBe(403);
    expect((await GET(request("GET", undefined, { host: "attacker.example" }))).status).toBe(403);
    expect((await PUT(request("PUT", keyA, { "Content-Type": "text/plain" }))).status).toBe(415);
  });

  it("accepts the packaged app's loopback Host when Next normalizes request.url", async () => {
    const response = await PUT(request("PUT", keyA, { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }));
    expect(response.status).toBe(200);
    expect(await getFalKey()).toBe(keyA);
  });

  it("isolates hosted credentials while allowing desktop users to bring a key in cloud builds", async () => {
    await saveFalKey(keyA);
    vi.stubEnv("APP_MODE", "hosted");
    expect(await getFalKey()).toBeNull();
    expect((await GET(request())).status).toBe(404);
    expect((await PUT(request("PUT", keyB))).status).toBe(404);
    expect((await DELETE(request("DELETE"))).status).toBe(404);
    vi.stubEnv("APP_MODE", "local");
    vi.stubEnv("NEXT_PUBLIC_DESKTOP_CLOUD_ENABLED", "true");
    expect((await GET(request())).status).toBe(200);
  });
});

describe("fal generation with user credentials", () => {
  it("protects generation preference changes and preserves the last valid selection", async () => {
    const put = (mode: unknown, headers: Record<string, string> = {}) => putGeneration(new Request("http://localhost:3000/api/settings/generation", {
      method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ mode }),
    }));
    expect((await put("credits", { origin: "https://attacker.example" })).status).toBe(403);
    expect((await put("credits", { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await put("invalid")).status).toBe(400);
    expect(await getGenerationMode()).toBe("fal");
    expect((await put("credits")).status).toBe(200);
    const status = await getGeneration(request());
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.json()).toEqual({ mode: "credits", connected: false });
    expect((await put("invalid")).status).toBe(400);
    expect(await getGenerationMode()).toBe("credits");
    vi.stubEnv("APP_MODE", "hosted");
    expect((await getGeneration(request())).status).toBe(404);
    expect((await put("fal")).status).toBe(404);
  });

  it("recovers a corrupted generation preference through setup", async () => {
    await saveGenerationMode("credits");
    await writeFile(path.join(temporary, "settings", "generation-mode.json"), "corrupt");
    expect((await getGeneration(request())).status).toBe(500);
    const restored = await putGeneration(new Request("http://localhost:3000/api/settings/generation", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "fal" }),
    }));
    expect(restored.status).toBe(200);
    expect(await getGenerationMode()).toBe("fal");
  });

  it("uses credits only after an explicit choice and switches back when a key is saved", async () => {
    expect(await getGenerationMode()).toBe("fal");
    await saveGenerationMode("credits");
    provider.cloudFetch.mockResolvedValueOnce(Response.json({ ok: true, provider: "fal", url: "https://fal.example/cloud.png" }));
    expect((await runFalRequest("video", "fal-ai/example", {})).ok).toBe(true);
    expect(provider.cloudFetch).toHaveBeenCalledTimes(1);
    expect((await PUT(request("PUT", keyA))).status).toBe(200);
    expect(await getGenerationMode()).toBe("fal");
    expect((await runFalRequest("image", "fal-ai/example", {})).ok).toBe(true);
    expect(provider.createClient).toHaveBeenLastCalledWith({ credentials: keyA });
    expect(provider.cloudFetch).toHaveBeenCalledTimes(1);
  });
  it("reports missing keys for generation and uploads without any cloud fallback", async () => {
    expect(await runFalRequest("image", "fal-ai/example", {})).toMatchObject({ ok: false, error: expect.stringContaining("Account → API keys") });
    expect(await uploadToFalStorage(Buffer.from("image"), "image.png")).toMatchObject({ ok: false, error: expect.stringContaining("Account → API keys") });
    expect(provider.cloudFetch).not.toHaveBeenCalled();
    expect(provider.createClient).not.toHaveBeenCalled();
  });

  it("uses the latest saved key for image, video, audio and storage, without restarting", async () => {
    await saveFalKey(keyA);
    expect((await runFalRequest("image", "fal-ai/example", {})).ok).toBe(true);
    expect(provider.createClient).toHaveBeenLastCalledWith({ credentials: keyA });
    await saveFalKey(keyB);
    for (const kind of ["video", "audio"] as const) {
      expect((await runFalRequest(kind, "fal-ai/example", {})).ok).toBe(true);
      expect(provider.createClient).toHaveBeenLastCalledWith({ credentials: keyB });
    }
    expect(await uploadToFalStorage(Buffer.from("image"), "image.png")).toEqual({ ok: true, url: "https://fal.example/upload.png" });
    expect(provider.createClient).toHaveBeenLastCalledWith({ credentials: keyB });
    await removeFalKey();
    expect((await runFalRequest("image", "fal-ai/example", {})).ok).toBe(false);
    expect(provider.cloudFetch).not.toHaveBeenCalled();
  });

  it("continues to support FAL_KEY for local and hosted generation", async () => {
    vi.stubEnv("FAL_KEY", keyA);
    for (const mode of ["local", "hosted"]) {
      vi.stubEnv("APP_MODE", mode);
      expect((await runFalRequest("image", "fal-ai/example", {})).ok).toBe(true);
      expect(provider.createClient).toHaveBeenLastCalledWith({ credentials: keyA });
    }
  });

  it.each([401, 403, 402])("returns actionable provider errors (%i)", async (status) => {
    await saveFalKey(keyA);
    provider.subscribe.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status }));
    const result = await runFalRequest("image", "fal-ai/example", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain(status === 402 ? "Add credits to your own fal.ai account" : "Account → API keys");
    expect(provider.subscribe).toHaveBeenCalledTimes(1);
  });

  it("redacts credentials from unexpected generation and upload errors", async () => {
    await saveFalKey(keyA);
    const error = new Error(`Request failed with ${keyA}`);
    provider.subscribe.mockRejectedValue(error);
    provider.upload.mockRejectedValue(error);
    const generated = await runFalRequest("image", "fal-ai/example", {});
    const uploaded = await uploadToFalStorage(Buffer.from("image"), "image.png");
    expect(JSON.stringify([generated, uploaded])).not.toContain(keyA);
    expect(generated.error).toContain("[redacted]");
  });

  it("preserves explicitly enabled cloud generation and uploads", async () => {
    vi.stubEnv("NEXT_PUBLIC_DESKTOP_CLOUD_ENABLED", "true");
    provider.cloudFetch.mockResolvedValueOnce(Response.json({ ok: true, provider: "fal", url: "https://fal.example/cloud.png" }));
    expect((await runFalRequest("image", "fal-ai/example", {})).ok).toBe(true);
    provider.cloudFetch.mockResolvedValueOnce(Response.json({ error: "Sign in required" }, { status: 401 }));
    expect(await uploadToFalStorage(Buffer.from("image"), "image.png")).toMatchObject({ ok: false, error: "Sign in required" });
    expect(provider.cloudFetch).toHaveBeenCalledTimes(2);
    expect(provider.createClient).not.toHaveBeenCalled();
  });
});
