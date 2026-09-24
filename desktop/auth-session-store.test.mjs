import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearDesktopAuthSession,
  readDesktopAuthSession,
  writeDesktopAuthSession,
} from "./auth-session-store.mjs";

const refreshToken = `${"a".repeat(64)}.${"b".repeat(43)}`;
const safeStorage = {
  decryptString: (value) => Buffer.from(value.toString("utf8"), "base64").toString("utf8"),
  encryptString: (value) => Buffer.from(Buffer.from(value, "utf8").toString("base64"), "utf8"),
  isEncryptionAvailable: () => true,
};

test("desktop refresh credentials are encrypted, private, restorable, and clearable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "video-fs-auth-session-"));
  const filePath = path.join(directory, "session.bin");
  try {
    await writeDesktopAuthSession(filePath, refreshToken, safeStorage);
    const disk = await readFile(filePath);
    assert.equal(disk.includes(Buffer.from(refreshToken)), false);
    assert.notEqual(disk.toString("utf8"), refreshToken);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.equal(await readDesktopAuthSession(filePath, safeStorage), refreshToken);
    await clearDesktopAuthSession(filePath);
    assert.equal(await readDesktopAuthSession(filePath, safeStorage), null);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("desktop refresh credentials are never written without OS encryption", async () => {
  const unavailable = { ...safeStorage, isEncryptionAvailable: () => false };
  await assert.rejects(
    writeDesktopAuthSession("/tmp/video-fs-should-not-exist", refreshToken, unavailable),
    /unavailable/i,
  );
});
