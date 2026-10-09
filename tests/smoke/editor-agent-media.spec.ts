import { deflateSync } from "node:zlib";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

// scripts/smoke-server.mjs starts the app with this tool token; an agent's
// MCP server reaches the same route with the project's own token.
const MCP_TOKEN = "smoke-only-token-not-a-production-credential";
const TICKS_PER_SECOND = 120_000;
const PICTURE_COLOUR = [230, 40, 200] as const;

type Upload = { id: string; kind: string; path: string };
type EditorDoc = {
  mediaMap?: Record<string, unknown>;
  project?: unknown;
  revision?: number;
} | null;

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), body.length + 4);
  return chunk;
}

/** A picture of one colour, so the preview can be checked for that colour. */
function solidPng(width: number, height: number, colour: readonly number[]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(colour, 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function createProject(request: APIRequestContext, name: string) {
  const created = await request.post("/api/projects", { data: { name } });
  expect(created.status()).toBe(200);
  return ((await created.json()) as { project: { id: string } }).project;
}

async function uploadPicture(
  request: APIRequestContext,
  projectId: string,
  name: string,
) {
  const response = await request.post(
    `/api/projects/${projectId}/canvas/upload`,
    {
      multipart: {
        files: {
          buffer: solidPng(960, 540, PICTURE_COLOUR),
          mimeType: "image/png",
          name,
        },
      },
    },
  );
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { uploaded: Upload[] };
  expect(body.uploaded).toHaveLength(1);
  return body.uploaded[0]!;
}

async function readEditorDoc(
  request: APIRequestContext,
  projectId: string,
): Promise<EditorDoc> {
  const response = await request.get(`/api/projects/${projectId}/editor-doc`);
  expect(response.status()).toBe(200);
  return (await response.json()) as EditorDoc;
}

function elementMediaId(project: unknown, elementId: string) {
  type Track = { elements?: Array<{ id?: unknown; mediaId?: unknown }> };
  const scenes =
    (
      project as {
        scenes?: Array<{
          tracks?: { audio?: Track[]; main?: Track; overlay?: Track[] };
        }>;
      } | null
    )?.scenes ?? [];
  for (const scene of scenes) {
    const tracks = scene.tracks;
    for (const track of [
      tracks?.main,
      ...(tracks?.overlay ?? []),
      ...(tracks?.audio ?? []),
    ]) {
      for (const element of track?.elements ?? []) {
        if (element.id !== elementId) continue;
        return typeof element.mediaId === "string" ? element.mediaId : null;
      }
    }
  }
  return null;
}

/** What the Editor in the page works from: its own copy of the project and
 * the ids of the media in its bin, as it stores them in the browser. */
async function editorStorage(page: Page, hostProjectId: string) {
  return page.evaluate(async (hostProjectId) => {
    const projectMap = JSON.parse(
      localStorage.getItem("host-project-map") ?? "{}",
    ) as Record<string, unknown>;
    const opencutId = projectMap[hostProjectId];
    if (typeof opencutId !== "string") {
      return {
        binMediaIds: [] as string[],
        hostMediaMap: {} as Record<string, { mediaId?: string }>,
        project: null as unknown,
      };
    }
    const existing = new Set(
      (await indexedDB.databases()).map((database) => database.name),
    );
    const settle = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    // Opens only databases the app created, so reading never creates one.
    const readStore = async (dbName: string, storeName: string, key?: string) => {
      if (!existing.has(dbName)) return null;
      const database = await settle(indexedDB.open(dbName));
      try {
        if (!database.objectStoreNames.contains(storeName)) return null;
        const store = database
          .transaction(storeName, "readonly")
          .objectStore(storeName);
        return key === undefined
          ? await settle(store.getAllKeys())
          : await settle(store.get(key));
      } finally {
        database.close();
      }
    };
    const keys = (await readStore(
      `video-editor-media-${opencutId}`,
      "media-metadata",
    )) as IDBValidKey[] | null;
    return {
      binMediaIds: (keys ?? []).filter(
        (key): key is string => typeof key === "string",
      ),
      hostMediaMap: JSON.parse(
        localStorage.getItem(`host-media-map-${opencutId}`) ?? "{}",
      ) as Record<string, { mediaId?: string }>,
      project: (await readStore("video-editor-projects", "projects", opencutId)) as unknown,
    };
  }, hostProjectId);
}

/** Share of the preview drawn in the test picture's colour. */
async function previewColourShare(page: Page) {
  const shot = await page
    .getByRole("application", { name: "Preview canvas" })
    .screenshot();
  return page.evaluate(
    async ({ base64, colour }) => {
      const bytes = Uint8Array.from(atob(base64), (character) =>
        character.charCodeAt(0),
      );
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (!context) return 0;
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      let matching = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (
          Math.abs(data[index] - colour[0]) <= 40 &&
          Math.abs(data[index + 1] - colour[1]) <= 40 &&
          Math.abs(data[index + 2] - colour[2]) <= 40
        ) {
          matching += 1;
        }
      }
      return matching / (bitmap.width * bitmap.height);
    },
    { base64: shot.toString("base64"), colour: PICTURE_COLOUR },
  );
}

async function showEditor(page: Page) {
  await page.getByRole("tab", { name: "Editor", exact: true }).click();
  // The first visit compiles the Editor in dev mode.
  await expect(page.locator(".opencut-scope")).toBeVisible({ timeout: 30_000 });
}

async function showCanvas(page: Page) {
  await page.getByRole("tab", { name: "Canvas", exact: true }).click();
  await expect(page.locator(".opencut-scope")).toHaveCount(0);
}

/** The edit document exists once the Editor has pushed its first state. */
async function waitForEditDocument(request: APIRequestContext, projectId: string) {
  await expect
    .poll(async () => typeof (await readEditorDoc(request, projectId))?.revision, {
      timeout: 60_000,
    })
    .toBe("number");
}

/** The exact identity the Canvas resolves for an uploaded picture: what an
 * agent's context hands it to place the file. */
async function resolveIdentity(
  request: APIRequestContext,
  projectId: string,
  upload: Upload,
  title: string,
) {
  const resolved = await request.post(
    `/api/projects/${projectId}/canvas/context-identity`,
    {
      data: {
        artifacts: [
          {
            artifactId: upload.id,
            kind: upload.kind,
            sourcePath: upload.path,
            title,
            version: null,
          },
        ],
        mode: "resolve",
      },
    },
  );
  expect(resolved.status()).toBe(200);
  const [artifact] = ((await resolved.json()) as { artifacts: unknown[] })
    .artifacts;
  return artifact;
}

/** The insert an agent sends through its MCP server (editor_edit). Like an
 * agent, it reads the edit document again and retries when an Editor push
 * made its revision stale. */
async function placeByAgent(
  request: APIRequestContext,
  projectId: string,
  upload: Upload,
  artifact: unknown,
  elementId: string,
) {
  for (let attempt = 1; ; attempt += 1) {
    const doc = await readEditorDoc(request, projectId);
    // The server writes a placeholder id only for a file its media map lacks.
    // An open Editor sends its whole map with each push, so a push that lands
    // between the import and this insert leaves nothing to test.
    test.skip(
      Object.keys(doc?.mediaMap ?? {}).includes(upload.id),
      "the Editor pushed its media map, picture included, before the insert",
    );
    const response = await request.post("/api/paper/tools", {
      data: {
        arguments: {
          action: "insert",
          actor: { id: "smoke-agent", type: "agent" },
          artifact,
          baseEditorRevision: doc?.revision,
          commandId: `insert-${elementId}`,
          durationTicks: 4 * TICKS_PER_SECOND,
          elementId,
          idempotencyKey: `insert-${elementId}`,
          origin: "mcp",
          placement: { mode: "auto", trackType: "video" },
          projectId,
          startTimeTicks: 0,
        },
        tool: "editor_edit",
      },
      headers: { authorization: `Bearer ${MCP_TOKEN}` },
    });
    const body = await response.text();
    if (
      response.status() === 409 &&
      body.includes("EDITOR_REVISION_CONFLICT") &&
      attempt < 3
    ) {
      continue;
    }
    expect(response.status(), body).toBe(200);
    break;
  }
  const placed = elementMediaId(
    (await readEditorDoc(request, projectId))?.project,
    elementId,
  );
  expect(placed, "the insert carries the server's placeholder id").toMatch(
    /^videofs-/,
  );
}

/** The Editor draws a block from its own media bin: the block must end up
 * pointing at media the bin holds, in the page and in the server copy the
 * agent reads next, and the preview must show the picture. */
async function expectEditorDrawsPlacement(
  page: Page,
  request: APIRequestContext,
  projectId: string,
  elementId: string,
) {
  try {
    await expect
      .poll(
        async () => {
          const storage = await editorStorage(page, projectId);
          const mediaId = elementMediaId(storage.project, elementId);
          if (!mediaId) return "the block is not in the Editor's project";
          return storage.binMediaIds.includes(mediaId)
            ? "held"
            : `the block points at ${mediaId}, which the Editor's media bin does not hold`;
        },
        { timeout: 30_000 },
      )
      .toBe("held");
    await expect
      .poll(
        async () => {
          const storage = await editorStorage(page, projectId);
          const doc = await readEditorDoc(request, projectId);
          const mediaId = elementMediaId(doc?.project, elementId);
          return mediaId && storage.binMediaIds.includes(mediaId)
            ? "held"
            : `the server copy points the block at ${mediaId}`;
        },
        { timeout: 30_000 },
      )
      .toBe("held");
    await expect
      .poll(() => previewColourShare(page), { timeout: 30_000 })
      .toBeGreaterThan(0.05);
  } finally {
    await page
      .getByRole("application", { name: "Preview canvas" })
      .screenshot({ path: test.info().outputPath("preview.png") })
      .catch(() => undefined);
  }
}

test.describe("pictures an agent places on the Editor timeline", () => {
  test.beforeEach(async ({ page }) => {
    // The setup guide and the project tour dim the page, preview included.
    await page.addInitScript(() =>
      localStorage.setItem(
        "impractical-onboarding-v1",
        JSON.stringify({ "studio-setup": true, "project-tour": true }),
      ),
    );
  });

  test("show when the Editor already holds the picture", async ({ page, request }) => {
    // The first visit compiles the project page and the Editor in dev mode.
    test.slow();
    const project = await createProject(request, "Agent placement, picture in the bin");
    try {
      await page.goto(`/projects/${project.id}`);
      await showEditor(page);
      await waitForEditDocument(request, project.id);
      const upload = await uploadPicture(request, project.id, "in-the-bin.png");
      const artifact = await resolveIdentity(request, project.id, upload, "agent-picture-in-bin");
      // Insert as soon as the import lands, before the Editor's next push.
      await expect
        .poll(
          async () => {
            const storage = await editorStorage(page, project.id);
            const mediaId = storage.hostMediaMap[upload.id]?.mediaId;
            return Boolean(mediaId && storage.binMediaIds.includes(mediaId));
          },
          {
            intervals: [100],
            message: "the Editor imports the uploaded picture",
            timeout: 60_000,
          },
        )
        .toBe(true);
      await placeByAgent(request, project.id, upload, artifact, "agent-picture-in-bin");
      await expectEditorDrawsPlacement(page, request, project.id, "agent-picture-in-bin");
    } finally {
      await page.goto("/");
      expect((await request.delete(`/api/projects/${project.id}`)).status()).toBe(200);
    }
  });

  test("show when the Editor opens after the agent placed the picture", async ({ page, request }) => {
    test.slow();
    const project = await createProject(request, "Agent placement, Editor opened later");
    try {
      await page.goto(`/projects/${project.id}`);
      await showEditor(page);
      await waitForEditDocument(request, project.id);
      await showCanvas(page);
      const upload = await uploadPicture(request, project.id, "placed-first.png");
      const artifact = await resolveIdentity(request, project.id, upload, "agent-picture-placed-first");
      await placeByAgent(request, project.id, upload, artifact, "agent-picture-placed-first");
      await showEditor(page);
      await expectEditorDrawsPlacement(page, request, project.id, "agent-picture-placed-first");
    } finally {
      await page.goto("/");
      expect((await request.delete(`/api/projects/${project.id}`)).status()).toBe(200);
    }
  });
});
