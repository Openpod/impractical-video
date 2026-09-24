import { describe, expect, it } from "vitest";
import { cleanExplorePromptText } from "@/lib/explore-prompt-cleanup";

describe("cleanExplorePromptText", () => {
  it("removes avatar markers and duplicate short lead lines", () => {
    const input = [
      "<<<avatar:ea6c745a-1a96-4ba3-bd85-f787d43e70e5>>> A vertical UGC-style video",
      "<<<avatar:ea6c745a-1a96-4ba3-bd85-f787d43e70e5>>> A vertical UGC-style video, 12 seconds long, filmed on a webcam with natural handheld energy.",
    ].join("\n");

    expect(cleanExplorePromptText(input)).toBe(
      "A vertical UGC-style video, 12 seconds long, filmed on a webcam with natural handheld energy.",
    );
  });

  it("removes marker tokens without deleting surrounding prompt text", () => {
    expect(cleanExplorePromptText("Intro <<<avatar:test-id>>> middle")).toBe("Intro middle");
  });
});
