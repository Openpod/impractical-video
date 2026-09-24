import { describe, expect, it } from "vitest";
import { mediaVersionState, mediaVersionWriteState } from "@/lib/media-versions";

describe("media version state", () => {
  it("folds an existing active render into version history", () => {
    const state = mediaVersionState({
      status: "active",
      url: "https://m.example/clip.v2.mp4",
      local_path: "media/clips/clip_1.v2.mp4",
      versions: [
        {
          version: 1,
          url: "https://m.example/clip.v1.mp4",
          local_path: "media/clips/clip_1.v1.mp4",
        },
      ],
    });

    expect(state.nextVersion).toBe(3);
    expect(state.versions).toEqual([
      {
        version: 1,
        url: "https://m.example/clip.v1.mp4",
        local_path: "media/clips/clip_1.v1.mp4",
      },
      {
        version: 2,
        url: "https://m.example/clip.v2.mp4",
        local_path: "media/clips/clip_1.v2.mp4",
      },
    ]);
  });

  it("preserves the previous active render and status when regeneration fails", () => {
    const writeState = mediaVersionWriteState(
      {
        status: "active",
        url: "https://m.example/clip.v2.mp4",
        local_path: "media/clips/clip_1.v2.mp4",
        versions: [
          {
            version: 1,
            url: "https://m.example/clip.v1.mp4",
            local_path: "media/clips/clip_1.v1.mp4",
          },
        ],
      },
      {
        url: null,
        localPath: null,
        successStatus: "active",
        emptyStatus: "pending",
      },
    );

    expect(writeState.status).toBe("active");
    expect(writeState.active).toEqual({
      url: "https://m.example/clip.v2.mp4",
      local_path: "media/clips/clip_1.v2.mp4",
    });
    expect(writeState.versions).toHaveLength(2);
    expect(writeState.versions.at(-1)).toMatchObject({ version: 2 });
  });

  it("appends a successful render as the new active version", () => {
    const writeState = mediaVersionWriteState(
      {
        status: "generated",
        url: "https://m.example/kf.v1.png",
        local_path: "media/keyframes/kf_1.v1.png",
      },
      {
        url: "https://m.example/kf.v2.png",
        localPath: "media/keyframes/kf_1.v2.png",
        successStatus: "generated",
        emptyStatus: "planned",
      },
    );

    expect(writeState.status).toBe("generated");
    expect(writeState.active).toEqual({
      url: "https://m.example/kf.v2.png",
      local_path: "media/keyframes/kf_1.v2.png",
    });
    expect(writeState.versions).toEqual([
      {
        version: 1,
        url: "https://m.example/kf.v1.png",
        local_path: "media/keyframes/kf_1.v1.png",
      },
      {
        version: 2,
        url: "https://m.example/kf.v2.png",
        local_path: "media/keyframes/kf_1.v2.png",
      },
    ]);
  });
});
