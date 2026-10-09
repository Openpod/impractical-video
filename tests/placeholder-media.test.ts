import { describe, expect, it } from "vitest";
import {
  heldMediaReplacements,
  mediaMapSources,
  mediaSourcePath,
  type HeldArtifactMedia,
} from "../opencut/host/placeholder-media";

const MEDIA = "/api/projects/project_one/media";

function recordIdentity(artifactId: string) {
  return {
    artifactId,
    contentHash: "a".repeat(64),
    entityRevision: 0,
    path: `uploads/${artifactId}.md`,
    version: null,
  };
}

function versionIdentity(artifactId: string, index: number) {
  return {
    artifactId,
    contentHash: "b".repeat(64),
    entityRevision: index + 1,
    path: `media/clips/${artifactId}.v${index + 1}.mp4`,
    version: { index, sha256: "b".repeat(64), versionId: `v${index + 1}` },
  };
}

function scenes({
  audio = [],
  main = [],
  overlay = [],
}: {
  audio?: unknown[];
  main?: unknown[];
  overlay?: unknown[];
}) {
  return [
    {
      id: "scene_main",
      tracks: {
        audio: [{ elements: audio, id: "track_audio" }],
        main: { elements: main, id: "track_main" },
        overlay: [{ elements: overlay, id: "track_overlay" }],
      },
    },
  ];
}

const picture: HeldArtifactMedia = {
  artifactId: "upload_picture",
  hostAssetIds: ["upload_picture"],
  mediaId: "bin-picture",
  sourceKey: `${MEDIA}/uploads/upload_picture.png`,
  sourcePath: "uploads/upload_picture.md",
};

function clipVersion(index: number, current: boolean): HeldArtifactMedia {
  return {
    artifactId: "clip_intro",
    hostAssetIds: [current ? "clip_intro" : `clip_intro@v${index + 1}`],
    mediaId: `bin-clip-v${index + 1}`,
    sourceKey: `${MEDIA}/clips/clip_intro.v${index + 1}.mp4`,
    sourcePath: `media/clips/clip_intro.v${index + 1}.mp4`,
  };
}

describe("placeholder media adoption", () => {
  it("points an agent placeholder at the bin's copy of the file its map entry names", () => {
    const replacements = heldMediaReplacements({
      heldMedia: [picture],
      knownMediaIds: new Set(["bin-picture"]),
      placeholderSources: new Map([
        ["videofs-1", `${MEDIA}/uploads/upload_picture.png`],
      ]),
      scenes: scenes({
        main: [
          {
            id: "element_agent",
            mediaId: "videofs-1",
            videoFsArtifact: recordIdentity("upload_picture"),
          },
        ],
      }),
    });
    expect([...replacements]).toEqual([["videofs-1", "bin-picture"]]);
  });

  it("waits for the exact file a placeholder names instead of using another version", () => {
    const element = {
      id: "element_agent",
      mediaId: "videofs-2",
      videoFsArtifact: versionIdentity("clip_intro", 1),
    };
    const placeholderSources = new Map([
      ["videofs-2", `${MEDIA}/clips/clip_intro.v2.mp4`],
    ]);
    const onlyFirstVersion = heldMediaReplacements({
      heldMedia: [clipVersion(0, false)],
      knownMediaIds: new Set(["bin-clip-v1"]),
      placeholderSources,
      scenes: scenes({ main: [element] }),
    });
    expect(onlyFirstVersion.size).toBe(0);

    const bothVersions = heldMediaReplacements({
      heldMedia: [clipVersion(0, false), clipVersion(1, true)],
      knownMediaIds: new Set(["bin-clip-v1", "bin-clip-v2"]),
      placeholderSources,
      scenes: scenes({ main: [element] }),
    });
    expect([...bothVersions]).toEqual([["videofs-2", "bin-clip-v2"]]);
  });

  it("adopts an id that left every map through the element's identity", () => {
    const element = {
      id: "element_agent",
      mediaId: "minted-by-another-profile",
      videoFsArtifact: recordIdentity("upload_picture"),
    };
    const replacements = heldMediaReplacements({
      heldMedia: [picture],
      knownMediaIds: new Set(["bin-picture"]),
      placeholderSources: new Map(),
      scenes: scenes({ main: [element] }),
    });
    expect([...replacements]).toEqual([
      ["minted-by-another-profile", "bin-picture"],
    ]);
  });

  it("gives a record placement only the record's current file", () => {
    const element = {
      id: "element_agent",
      mediaId: "videofs-lost",
      videoFsArtifact: recordIdentity("clip_intro"),
    };
    const olderVersionOnly = heldMediaReplacements({
      heldMedia: [clipVersion(0, false)],
      knownMediaIds: new Set(["bin-clip-v1"]),
      placeholderSources: new Map(),
      scenes: scenes({ main: [element] }),
    });
    expect(olderVersionOnly.size).toBe(0);

    const withCurrent = heldMediaReplacements({
      heldMedia: [clipVersion(0, false), clipVersion(1, true)],
      knownMediaIds: new Set(["bin-clip-v1", "bin-clip-v2"]),
      placeholderSources: new Map(),
      scenes: scenes({ main: [element] }),
    });
    expect([...withCurrent]).toEqual([["videofs-lost", "bin-clip-v2"]]);
  });

  it("gives a version placement only its own version", () => {
    const element = {
      id: "element_agent",
      mediaId: "videofs-lost",
      videoFsArtifact: versionIdentity("clip_intro", 0),
    };
    const replacements = heldMediaReplacements({
      heldMedia: [clipVersion(1, true), clipVersion(0, false)],
      knownMediaIds: new Set(["bin-clip-v1", "bin-clip-v2"]),
      placeholderSources: new Map(),
      scenes: scenes({ main: [element] }),
    });
    expect([...replacements]).toEqual([["videofs-lost", "bin-clip-v1"]]);
  });

  it("never touches ids the bin holds, elements without media, or elements it cannot place", () => {
    const replacements = heldMediaReplacements({
      heldMedia: [picture],
      knownMediaIds: new Set(["bin-picture"]),
      placeholderSources: new Map(),
      scenes: scenes({
        main: [
          {
            id: "element_held",
            mediaId: "bin-picture",
            videoFsArtifact: recordIdentity("upload_picture"),
          },
          { id: "element_text", type: "text" },
          { id: "element_by_hand", mediaId: "lost-without-identity" },
          {
            id: "element_other_artifact",
            mediaId: "videofs-other",
            videoFsArtifact: recordIdentity("upload_other"),
          },
        ],
      }),
    });
    expect(replacements.size).toBe(0);
  });

  it("does not use a file the bin no longer holds", () => {
    const replacements = heldMediaReplacements({
      heldMedia: [picture],
      knownMediaIds: new Set(),
      placeholderSources: new Map([
        ["videofs-1", `${MEDIA}/uploads/upload_picture.png`],
      ]),
      scenes: scenes({
        main: [
          {
            id: "element_agent",
            mediaId: "videofs-1",
            videoFsArtifact: recordIdentity("upload_picture"),
          },
        ],
      }),
    });
    expect(replacements.size).toBe(0);
  });

  it("reads overlay and audio tracks and maps a shared placeholder once", () => {
    const placeholderSources = new Map([
      ["videofs-1", `${MEDIA}/uploads/upload_picture.png`],
    ]);
    const replacements = heldMediaReplacements({
      heldMedia: [picture],
      knownMediaIds: new Set(["bin-picture"]),
      placeholderSources,
      scenes: scenes({
        audio: [{ id: "element_audio", mediaId: "videofs-1" }],
        overlay: [{ id: "element_overlay", mediaId: "videofs-1" }],
      }),
    });
    expect([...replacements]).toEqual([["videofs-1", "bin-picture"]]);
  });

  it("compares source keys the way the server does", () => {
    expect(mediaSourcePath(`${MEDIA}/uploads/a%20b.png?v=3`)).toBe(
      `${MEDIA}/uploads/a b.png`,
    );
    expect(mediaSourcePath(undefined)).toBeNull();
    const replacements = heldMediaReplacements({
      heldMedia: [
        { ...picture, sourceKey: `${MEDIA}/uploads/upload%20picture.png?t=1` },
      ],
      knownMediaIds: new Set(["bin-picture"]),
      placeholderSources: new Map([
        ["videofs-1", `${MEDIA}/uploads/upload picture.png`],
      ]),
      scenes: scenes({ main: [{ id: "element_agent", mediaId: "videofs-1" }] }),
    });
    expect([...replacements]).toEqual([["videofs-1", "bin-picture"]]);
  });

  it("lists every media map entry that has a media id and a source key", () => {
    const sources = mediaMapSources({
      upload_picture: {
        mediaId: "videofs-1",
        sourceKey: `${MEDIA}/uploads/upload_picture.png`,
      },
      "videofs:upload_picture": { mediaId: "videofs-2" },
      broken: null,
    });
    expect([...sources]).toEqual([
      ["videofs-1", `${MEDIA}/uploads/upload_picture.png`],
    ]);
    expect(mediaMapSources(undefined).size).toBe(0);
  });
});
