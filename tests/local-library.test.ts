import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { deleteLocalLibraryUpload, getLocalLibraryUpload, LIBRARY_UPLOAD_LIMIT, listLocalLibraryUploads, localLibraryFile, renameLocalLibraryUpload, uploadLocalLibraryFiles } from "@/lib/local-library";
import { GET } from "@/app/api/library/assets/[id]/route";

let temporary: string;
beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "impractical-library-test-"));
  vi.stubEnv("APP_MODE", "local");
  vi.stubEnv("VIDEO_FS_DATA_ROOT", path.join(temporary, "projects"));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(temporary, { recursive: true, force: true }); });

describe("local Library uploads", () => {
  it("stores all file types privately, preserves duplicate names and infers missing MIME types", async () => {
    const ids = await uploadLocalLibraryFiles([
      new File(["image"], "sample.png"), new File(["clip"], "sample.mp4"),
      new File(["sound"], "sample.wav"), new File(["anything"], "sample.custom"),
      new File(["second"], "sample.png"),
    ]);
    expect(new Set(ids).size).toBe(5);
    expect((await listLocalLibraryUploads()).map(asset => asset.kind).sort()).toEqual(["audio", "document", "image", "image", "video"]);
    const asset = await localLibraryFile(ids[0]);
    expect(await readFile(asset.absolutePath, "utf8")).toBe("image");
    expect((await stat(asset.absolutePath)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(asset.absolutePath))).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(await getLocalLibraryUpload(ids[0]))).not.toContain(temporary);
  });

  it("rejects oversize and empty requests before saving and rolls back interrupted batches", async () => {
    await expect(uploadLocalLibraryFiles([])).rejects.toThrow("Choose at least one");
    const large = new File([], "large.mp4");
    Object.defineProperty(large, "size", { value: LIBRARY_UPLOAD_LIMIT + 1 });
    await expect(uploadLocalLibraryFiles([large])).rejects.toMatchObject({ status: 413 });
    const broken = new File(["broken"], "broken.txt");
    vi.spyOn(broken, "arrayBuffer").mockRejectedValue(new Error("disk interruption"));
    await expect(uploadLocalLibraryFiles([new File(["ok"], "ok.txt"), broken])).rejects.toThrow("disk interruption");
    expect(await listLocalLibraryUploads()).toEqual([]);
    expect(await readdir(path.join(temporary, "library", "uploads"))).toEqual([]);
  });

  it("renames without altering bytes and removes only the chosen asset into local trash", async () => {
    const [first, second] = await uploadLocalLibraryFiles([new File(["one"], "same.txt"), new File(["two"], "same.txt")]);
    expect((await renameLocalLibraryUpload(first, "New name")).title).toBe("New name");
    expect(await readFile((await localLibraryFile(first)).absolutePath, "utf8")).toBe("one");
    await expect(renameLocalLibraryUpload(first, "  ")).rejects.toMatchObject({ status: 400 });
    await deleteLocalLibraryUpload(first);
    await expect(getLocalLibraryUpload(first)).rejects.toMatchObject({ status: 404 });
    expect((await listLocalLibraryUploads()).map(item => item.id)).toEqual([second]);
    const [trashed] = await readdir(path.join(temporary, "library", "trash"));
    expect(await readFile(path.join(temporary, "library", "trash", trashed, "file"), "utf8")).toBe("one");
  });

  it("serves full files and byte ranges for playback, rejecting invalid ranges", async () => {
    const [id] = await uploadLocalLibraryFiles([new File(["0123456789"], "sample.mp4")]);
    const get = (range?: string) => GET(new Request("http://localhost/api/library/assets/asset", { headers: range ? { range } : {} }), { params: Promise.resolve({ id }) });
    const full = await get();
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Type")).toBe("video/mp4");
    expect(await full.text()).toBe("0123456789");
    const partial = await get("bytes=2-4");
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Content-Range")).toBe("bytes 2-4/10");
    expect(await partial.text()).toBe("234");
    expect(await (await get("bytes=-3")).text()).toBe("789");
    expect(await (await get("bytes=8-")).text()).toBe("89");
    for (const range of ["bytes=40-50", "bytes=5-2", "bytes=-0", "bytes=", "bytes=0-1,4-5"]) expect((await get(range)).status).toBe(416);
  });

  it("downloads active content safely and never exposes local files in hosted mode", async () => {
    const [id] = await uploadLocalLibraryFiles([new File(["<script>bad()</script>"], "../../page.html", { type: "text/html" })]);
    const response = await GET(new Request("http://localhost/"), { params: Promise.resolve({ id }) });
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(await response.text()).toContain("<script>");
    await expect(localLibraryFile("local:library:../../etc/passwd")).rejects.toMatchObject({ status: 404 });
    vi.stubEnv("APP_MODE", "hosted");
    expect((await GET(new Request("http://localhost/"), { params: Promise.resolve({ id }) })).status).toBe(404);
    await expect(listLocalLibraryUploads()).rejects.toMatchObject({ status: 404 });
  });
});
