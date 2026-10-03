import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mediaMocks = vi.hoisted(() => ({
  generateFalReferenceVideo: vi.fn(),
  prepareClipForExtension: vi.fn(),
  uploadToFalStorage: vi.fn(),
}));

vi.mock("@/lib/media", () => ({
  cropImageToAspect: vi.fn(async (buffer: Buffer) => buffer),
  extractVideoFrame: vi.fn(),
  generateFalAudio: vi.fn(),
  generateFalImage: vi.fn(),
  generateFalMaskedImageEdit: vi.fn(),
  generateFalMusic: vi.fn(),
  generateFalReferenceVideo: mediaMocks.generateFalReferenceVideo,
  generateFalSpeech: vi.fn(),
  generateFalVideo: vi.fn(),
  generateFalVoiceDesign: vi.fn(),
  prepareClipForExtension: mediaMocks.prepareClipForExtension,
  uploadToFalStorage: mediaMocks.uploadToFalStorage,
}));

const originalEnvironment = { ...process.env };
let dataRoot = "";

function launchVideoRequest(
  projectId: string,
  overrides: Record<string, unknown> = {},
) {
  return new Request("http://127.0.0.1/api/paper/tools", {
    body: JSON.stringify({
      arguments: {
        imageId: "up_1",
        projectId,
        shots: [
          { prompt: "Slow push on the product as light sweeps past.", title: "Reveal" },
          { prompt: "The product rotates to face camera.", title: "Detail" },
        ],
        title: "Launch Teaser",
        ...overrides,
      },
      tool: "generate_launch_video",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function generatedClip(url: string) {
  return {
    endpoint: "bytedance/seedance-2.0/reference-to-video",
    ok: true as const,
    provider: "fal" as const,
    url,
  };
}

beforeEach(async () => {
  process.env = { ...originalEnvironment };
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "video-fs-launch-video-"));
  process.env.APP_MODE = "local";
  delete process.env.PAPER_MCP_TOKEN;
  process.env.VIDEO_FS_DATA_ROOT = dataRoot;
  vi.resetModules();
  vi.clearAllMocks();
  // clearAllMocks leaves mock*Once queues behind (a leftover .Once from one
  // test would answer another test's calls), so reset the generation mocks
  // and re-seed the defaults this suite relies on.
  mediaMocks.generateFalReferenceVideo.mockReset();
  mediaMocks.prepareClipForExtension.mockReset();
  mediaMocks.uploadToFalStorage.mockReset();
  mediaMocks.prepareClipForExtension.mockResolvedValue({
    buffer: Buffer.from("prepared-extension-input"),
    ok: true,
  });
  mediaMocks.uploadToFalStorage.mockResolvedValue({
    ok: true,
    url: "https://fal.example/extend-input.mp4",
  });
  // saveRemoteMedia downloads the provider URL through global fetch.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "video/mp4" },
        status: 200,
      }),
    ),
  );
});

afterEach(async () => {
  process.env = { ...originalEnvironment };
  vi.unstubAllGlobals();
  vi.resetModules();
  if (dataRoot) await rm(dataRoot, { force: true, recursive: true });
  dataRoot = "";
});

async function seedProject() {
  const { createProject, writeWorkspaceFile, withJsonFrontmatter } =
    await import("@/lib/workspace");
  const project = await createProject("Launch");
  await writeWorkspaceFile(
    project.id,
    "uploads/up_1.md",
    withJsonFrontmatter(
      {
        id: "up_1",
        kind: "image",
        status: "active",
        type: "upload",
        url: "https://m.example/product.png",
      },
      "# Product photo\n",
    ),
  );
  return project.id;
}

describe("generate_launch_video", () => {
  it("creates a scene, chains one clip per shot, and checks the project", async () => {
    const projectId = await seedProject();
    mediaMocks.generateFalReferenceVideo
      .mockResolvedValueOnce(generatedClip("https://media.example/shot-1.mp4"))
      .mockResolvedValueOnce(generatedClip("https://media.example/shot-2.mp4"));
    const route = await import("@/app/api/paper/tools/route");

    const response = await route.POST(
      launchVideoRequest(projectId, {
        aspectRatio: "9:16",
        durationSeconds: 7,
        // The agent's own continuation binding must pass through untouched.
        shots: [
          { prompt: "Slow push on the product as light sweeps past.", title: "Reveal" },
          {
            prompt: "Continue from @Video1: the product rotates to face camera.",
            title: "Detail",
          },
        ],
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.sceneId).toMatch(/^scene_launch_teaser_/);
    expect(body.clipIds).toHaveLength(2);
    expect(body.check).toMatchObject({ issues: expect.any(Array) });

    // Both links run reference-to-video carrying the source image as @Image1.
    expect(mediaMocks.generateFalReferenceVideo).toHaveBeenCalledTimes(2);
    for (const call of mediaMocks.generateFalReferenceVideo.mock.calls) {
      expect(call[0].referenceImageUrls).toEqual([
        "https://m.example/product.png",
      ]);
      expect(call[0].aspectRatio).toBe("9:16");
      // The run-level duration default applies to every shot.
      expect(call[0].duration).toBe("7");
    }
    expect(mediaMocks.generateFalReferenceVideo.mock.calls[0]?.[0].prompt).toBe(
      "The video begins exactly on @Image1. Slow push on the product as light sweeps past.",
    );
    // Shot 2 extends shot 1's actual footage as @Video1.
    expect(mediaMocks.prepareClipForExtension).toHaveBeenCalledTimes(1);
    expect(
      mediaMocks.generateFalReferenceVideo.mock.calls[1]?.[0]
        .referenceVideoUrls,
    ).toEqual(["https://fal.example/extend-input.mp4"]);
    // A prompt that already binds @Video1 is passed through verbatim.
    expect(mediaMocks.generateFalReferenceVideo.mock.calls[1]?.[0].prompt).toBe(
      "Continue from @Video1: the product rotates to face camera.",
    );

    const { readWorkspaceFile, parseJsonFrontmatter } =
      await import("@/lib/workspace");
    const [firstClipId, secondClipId] = body.clipIds as string[];
    const firstClip = parseJsonFrontmatter(
      await readWorkspaceFile(projectId, `clips/${firstClipId}.md`),
    );
    expect(firstClip.meta.scene).toBe(body.sceneId);
    expect(firstClip.meta.extends_clip).toBeNull();
    expect(firstClip.meta.aspect_ratio).toBe("9:16");
    expect(firstClip.meta.status).toBe("active");
    expect(firstClip.body).toContain("The video begins exactly on @Image1.");

    const secondClip = parseJsonFrontmatter(
      await readWorkspaceFile(projectId, `clips/${secondClipId}.md`),
    );
    expect(secondClip.meta.extends_clip).toBe(firstClipId);
    expect(secondClip.meta.aspect_ratio).toBe("9:16");
    expect(secondClip.meta.transition_from_previous).toBe("continuous");
    expect(secondClip.body).toContain(
      "## Prompt\n\nContinue from @Video1: the product rotates to face camera.",
    );

    // The derived timeline lists the chain in shot order.
    const timeline = JSON.parse(
      await readWorkspaceFile(projectId, "timeline.json"),
    ) as Array<{ clip_id: string }>;
    expect(timeline.map((item) => item.clip_id)).toEqual(body.clipIds);

    // The scene references the anchor image.
    const scene = parseJsonFrontmatter(
      await readWorkspaceFile(
        projectId,
        "scenes/01-launch-teaser/scene.md",
      ),
    );
    expect(scene.meta.id).toBe(body.sceneId);
    expect(scene.meta.references).toEqual(["up_1"]);
  });

  it("stops the chain at the first failed link and reports the failure", async () => {
    const projectId = await seedProject();
    mediaMocks.generateFalReferenceVideo
      .mockResolvedValueOnce(generatedClip("https://media.example/shot-1.mp4"))
      .mockResolvedValueOnce({
        endpoint: "bytedance/seedance-2.0/reference-to-video",
        error: "provider boom",
        ok: false,
        provider: "fal",
        url: null,
      });
    const route = await import("@/app/api/paper/tools/route");

    const response = await route.POST(launchVideoRequest(projectId));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.failedShot).toBe(1);
    expect(body.error).toContain("provider boom");
    expect(body.clipIds).toHaveLength(1);
    expect(mediaMocks.generateFalReferenceVideo).toHaveBeenCalledTimes(2);
    expect(body.check).toMatchObject({ issues: expect.any(Array) });
  });

  it("reports a mid-chain throw as a failure instead of erasing completed shots", async () => {
    const projectId = await seedProject();
    mediaMocks.generateFalReferenceVideo
      .mockResolvedValueOnce(generatedClip("https://media.example/shot-1.mp4"))
      .mockResolvedValueOnce(generatedClip("https://media.example/shot-2.mp4"));
    // Shot 2 cannot prepare its extension input (e.g. ffmpeg missing).
    mediaMocks.prepareClipForExtension.mockResolvedValue({
      error: "ffmpeg missing",
      ok: false,
    });
    const route = await import("@/app/api/paper/tools/route");

    const response = await route.POST(launchVideoRequest(projectId));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.failedShot).toBe(1);
    expect(body.error).toContain("ffmpeg missing");
    expect(body.clipIds).toHaveLength(1);
    expect(body.sceneId).toMatch(/^scene_launch_teaser_/);
    // Shot 2 throws during extension-input preparation, before any provider
    // call — the throw still lands as a failure record, not an erased run.
    expect(mediaMocks.generateFalReferenceVideo).toHaveBeenCalledTimes(1);
  });

  it("rejects a second run with the same title while one is in flight", async () => {
    const projectId = await seedProject();
    let release!: (value: unknown) => void;
    mediaMocks.generateFalReferenceVideo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const route = await import("@/app/api/paper/tools/route");

    const first = route.POST(launchVideoRequest(projectId));
    await vi.waitFor(() => {
      expect(mediaMocks.generateFalReferenceVideo).toHaveBeenCalledTimes(1);
    });

    const second = await route.POST(launchVideoRequest(projectId));
    expect(second.status).toBe(500);
    expect((await second.json()).error).toContain(
      'Launch video "Launch Teaser" is already running',
    );

    release({
      endpoint: "bytedance/seedance-2.0/reference-to-video",
      error: "aborted",
      ok: false,
      provider: "fal",
      url: null,
    });
    const firstBody = await (await first).json();
    expect(firstBody.ok).toBe(false);
    expect(firstBody.clipIds).toHaveLength(0);
  });

  it("rejects a video source as the anchor image", async () => {
    const projectId = await seedProject();
    const { writeWorkspaceFile, withJsonFrontmatter } =
      await import("@/lib/workspace");
    await writeWorkspaceFile(
      projectId,
      "uploads/up_footage.md",
      withJsonFrontmatter(
        {
          id: "up_footage",
          kind: "video",
          status: "active",
          type: "upload",
          url: "https://m.example/footage.mp4",
        },
        "# Footage\n",
      ),
    );
    const route = await import("@/app/api/paper/tools/route");

    const response = await route.POST(
      launchVideoRequest(projectId, { imageId: "up_footage" }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error:
        '"up_footage" is video footage; generate_launch_video anchors on a still image. Extract a frame first (edit_media op=extract_frame) and pass the frame\'s id.',
    });
    expect(mediaMocks.generateFalReferenceVideo).not.toHaveBeenCalled();
  });

  it("reuses an existing scene instead of creating one", async () => {
    const projectId = await seedProject();
    const route = await import("@/app/api/paper/tools/route");
    const sceneResponse = await route.POST(
      new Request("http://127.0.0.1/api/paper/tools", {
        body: JSON.stringify({
          arguments: {
            body: "Existing scene.",
            index: 1,
            projectId,
            sceneId: "scene_existing",
            title: "Existing",
          },
          tool: "create_scene",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(sceneResponse.status).toBe(200);

    mediaMocks.generateFalReferenceVideo.mockResolvedValueOnce(
      generatedClip("https://media.example/only.mp4"),
    );
    const response = await route.POST(
      launchVideoRequest(projectId, {
        sceneId: "scene_existing",
        shots: [{ prompt: "One beat.", title: "Only" }],
      }),
    );
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.sceneId).toBe("scene_existing");
    expect(body.clipIds).toHaveLength(1);

    const { getProjectSnapshot } = await import("@/lib/workspace");
    const snapshot = await getProjectSnapshot(projectId);
    expect(
      snapshot.files.filter((file) => file.path.endsWith("/scene.md")),
    ).toHaveLength(1);
  });

  it("fails before any writes when the source image has no usable media", async () => {
    const { createProject } = await import("@/lib/workspace");
    const project = await createProject("No media");
    const route = await import("@/app/api/paper/tools/route");

    const response = await route.POST(launchVideoRequest(project.id));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: 'Image "up_1" has no usable media to anchor a launch video on.',
    });
    expect(mediaMocks.generateFalReferenceVideo).not.toHaveBeenCalled();

    const { getProjectSnapshot } = await import("@/lib/workspace");
    const snapshot = await getProjectSnapshot(project.id);
    expect(
      snapshot.files.some(
        (file) =>
          (file.path.startsWith("scenes/") ||
            file.path.startsWith("clips/")) &&
          !file.path.endsWith("_README.md"),
      ),
    ).toBe(false);
  });
});
