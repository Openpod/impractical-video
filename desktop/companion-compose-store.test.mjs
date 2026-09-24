import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  COMPANION_ATTACHMENT_MAX_BYTES,
  emptyCompanionCompose,
  readCompanionAttachment,
  readCompanionCompose,
  removeCompanionAttachment,
  storeCompanionAttachment,
  writeCompanionCompose,
} from "./companion-compose-store.mjs";

async function root() {
  return mkdtemp(path.join(os.tmpdir(), "video-fs-compose-"));
}

test("persists a versioned per-project compose state atomically at mode 0600", async () => {
  const directory = await root();
  const state = {
    ...emptyCompanionCompose("project-a"),
    draft: "Keep this exact draft",
    model: "haiku",
    references: [{ id: "kf_one", path: "keyframes/kf_one.md" }],
    workflowId: "product-hero",
  };
  const first = await writeCompanionCompose(directory, "project-a", state);
  const file = path.join(directory, "state", "project-a.json");
  const firstMtime = (await stat(file)).mtimeMs;
  const second = await writeCompanionCompose(directory, "project-a", state);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(file)).mtimeMs, firstMtime);
  assert.deepEqual((await readCompanionCompose(directory, "project-a")).state, state);
});

test("stores private attachments by content hash without retaining source paths", async () => {
  const directory = await root();
  const stored = await storeCompanionAttachment(directory, "project-a", {
    bytes: Buffer.from("private bytes"),
    name: "/Users/person/Desktop/reference.png",
    type: "image/png",
  });
  await writeCompanionCompose(directory, "project-a", {
    ...emptyCompanionCompose("project-a"),
    attachments: [stored],
  });
  assert.equal(stored.name, "reference.png");
  const stateText = await readFile(
    path.join(directory, "state", "project-a.json"),
    "utf8",
  );
  assert.equal(stateText.includes("/Users/person"), false);
  assert.equal(
    (await stat(path.join(directory, "blobs", stored.hash))).mode & 0o777,
    0o600,
  );
  assert.equal(
    Buffer.from(
      (await readCompanionAttachment(directory, "project-a", stored.hash)).data,
      "base64",
    ).toString(),
    "private bytes",
  );
});

test("rejects oversized and empty attachments with actionable errors", async () => {
  const directory = await root();
  await assert.rejects(
    storeCompanionAttachment(directory, "project-a", {
      bytes: Buffer.alloc(COMPANION_ATTACHMENT_MAX_BYTES + 1),
      name: "large.mov",
      type: "video/quicktime",
    }),
    /too large/,
  );
  await assert.rejects(
    storeCompanionAttachment(directory, "project-a", {
      bytes: Buffer.alloc(0),
      name: "empty.txt",
      type: "text/plain",
    }),
    /empty or unreadable/,
  );
});

test("reports missing, unreadable, and stale private blobs", async () => {
  const directory = await root();
  const stored = await storeCompanionAttachment(directory, "project-a", {
    bytes: Buffer.from("original"),
    name: "brief.txt",
    type: "text/plain",
  });
  await writeCompanionCompose(directory, "project-a", {
    ...emptyCompanionCompose("project-a"),
    attachments: [stored],
  });
  const blob = path.join(directory, "blobs", stored.hash);
  await rm(blob);
  assert.match(
    (await readCompanionCompose(directory, "project-a")).issues[0].message,
    /missing/,
  );
  await writeFile(blob, "changed", { mode: 0o600 });
  assert.match(
    (await readCompanionCompose(directory, "project-a")).issues[0].message,
    /changed/,
  );
  await writeFile(blob, "original");
  await chmod(blob, 0o000);
  const issue = (await readCompanionCompose(directory, "project-a")).issues[0];
  assert.match(issue.message, /unreadable|changed/);
});

test("removes unreferenced blobs but preserves cross-project hash references", async () => {
  const directory = await root();
  const stored = await storeCompanionAttachment(directory, "project-a", {
    bytes: Buffer.from("shared"),
    name: "shared.txt",
    type: "text/plain",
  });
  for (const projectId of ["project-a", "project-b"]) {
    await writeCompanionCompose(directory, projectId, {
      ...emptyCompanionCompose(projectId),
      attachments: [stored],
    });
  }
  await removeCompanionAttachment(directory, "project-a", stored.hash);
  assert.ok(await stat(path.join(directory, "blobs", stored.hash)));
  await removeCompanionAttachment(directory, "project-b", stored.hash);
  await assert.rejects(stat(path.join(directory, "blobs", stored.hash)), /ENOENT/);
});
