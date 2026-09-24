import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  clearDesktopCloudSessionToken,
  desktopCloudAppUrl,
  getDesktopCloudSessionToken,
  setDesktopCloudSessionToken,
} from "@/lib/desktop-cloud";
import {
  desktopFalBillableOp,
  isAllowedDesktopFalEndpoint,
  sanitizeDesktopFalInput,
} from "@/lib/desktop-fal-billing";
import { opCredits } from "@/lib/usage-pricing";

function token(exp: number) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp, sub: "user_desktop" })}.signature`;
}

afterEach(() => {
  clearDesktopCloudSessionToken();
  vi.unstubAllEnvs();
});

describe("desktop cloud session", () => {
  it("keeps only a non-expired local-mode token", () => {
    vi.stubEnv("APP_MODE", "local");
    const value = token(Math.floor(Date.now() / 1000) + 60);
    setDesktopCloudSessionToken(value);
    expect(getDesktopCloudSessionToken()).toBe(value);
  });

  it("rejects expired tokens and unsafe cloud origins", () => {
    vi.stubEnv("APP_MODE", "local");
    expect(() => setDesktopCloudSessionToken(token(1))).toThrow(/expired/i);
    expect(() => desktopCloudAppUrl({ NEXT_PUBLIC_DESKTOP_CLOUD_URL: "http://example.com" })).toThrow(
      /HTTPS origin/i,
    );
  });
});

describe("desktop fal billing derivation", () => {
  it("prices fast video from its actual duration", () => {
    const op = desktopFalBillableOp({
      endpoint: "bytedance/seedance-2.0/fast/image-to-video",
      input: { duration: "5" },
      kind: "video",
    });
    expect(op).toMatchObject({ kind: "clip", pinned: false, resolution: "720p", seconds: 5 });
    expect(opCredits(op)).toBeGreaterThan(0);
  });

  it("prices reference video at the standard tier", () => {
    expect(
      desktopFalBillableOp({
        endpoint: "bytedance/seedance-2.0/reference-to-video",
        input: { duration: 8, resolution: "1080p" },
        kind: "video",
      }),
    ).toMatchObject({ kind: "clip", pinned: true, resolution: "1080p", seconds: 8 });
  });

  it("derives speech and music usage from provider input", () => {
    expect(
      desktopFalBillableOp({
        endpoint: "fal-ai/elevenlabs/tts/multilingual-v2",
        input: { text: "hello" },
        kind: "audio",
      }),
    ).toMatchObject({ characters: 5, kind: "speech" });
    expect(
      desktopFalBillableOp({
        endpoint: "fal-ai/elevenlabs/music",
        input: { music_length_ms: 12_000 },
        kind: "audio",
      }),
    ).toMatchObject({ kind: "music", seconds: 12 });
  });

  it("prices the full two-minute music duration", () => {
    const op = desktopFalBillableOp({
      endpoint: "fal-ai/elevenlabs/music",
      input: { music_length_ms: 120_000 },
      kind: "audio",
    });
    expect(op).toMatchObject({ kind: "music", seconds: 120 });
  });

  it("strips provider cost multipliers and unsafe URLs", () => {
    expect(
      sanitizeDesktopFalInput({
        endpoint: "fal-ai/nano-banana-2",
        input: { aspect_ratio: "1:1", num_images: 100, prompt: "A lighthouse" },
        kind: "image",
      }),
    ).toEqual({ aspect_ratio: "1:1", prompt: "A lighthouse" });
    expect(() =>
      sanitizeDesktopFalInput({
        endpoint: "fal-ai/nano-banana-2/edit",
        input: { image_urls: ["http://127.0.0.1/private"], prompt: "Edit this" },
        kind: "image",
      }),
    ).toThrow(/HTTPS URL/i);
  });

  it("uses conservative endpoint-specific costs for premium image edits", () => {
    const op = desktopFalBillableOp({
      endpoint: "openai/gpt-image-2/edit",
      input: {},
      kind: "image",
    });
    expect(op).toMatchObject({ cogsUsd: 0.75, kind: "provider" });
    expect(opCredits(op)).toBe(113);
  });

  it("rejects arbitrary fal endpoints", () => {
    expect(isAllowedDesktopFalEndpoint("video", "attacker/unpriced-model")).toBe(false);
    expect(() =>
      desktopFalBillableOp({
        endpoint: "attacker/unpriced-model",
        input: { duration: 60 },
        kind: "video",
      }),
    ).toThrow(/not available/i);
  });
});
