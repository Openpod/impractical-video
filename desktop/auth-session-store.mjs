import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_ENCRYPTED_SESSION_BYTES = 16 * 1024;

function assertRefreshToken(value) {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 4096 ||
    !/^[A-Za-z0-9_.-]+$/.test(value)
  ) {
    throw new Error("The desktop refresh credential is invalid.");
  }
  return value;
}

function assertSafeStorage(safeStorage) {
  if (
    !safeStorage?.isEncryptionAvailable?.() ||
    typeof safeStorage.encryptString !== "function" ||
    typeof safeStorage.decryptString !== "function"
  ) {
    throw new Error("Secure operating-system credential storage is unavailable.");
  }
  return safeStorage;
}

export async function readDesktopAuthSession(filePath, safeStorage) {
  const storage = assertSafeStorage(safeStorage);
  let encrypted;
  try {
    encrypted = await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!encrypted.length || encrypted.length > MAX_ENCRYPTED_SESSION_BYTES) {
    throw new Error("The saved desktop session is invalid.");
  }
  return assertRefreshToken(storage.decryptString(encrypted));
}

export async function writeDesktopAuthSession(filePath, refreshToken, safeStorage) {
  const storage = assertSafeStorage(safeStorage);
  const encrypted = storage.encryptString(assertRefreshToken(refreshToken));
  if (!encrypted.length || encrypted.length > MAX_ENCRYPTED_SESSION_BYTES) {
    throw new Error("The encrypted desktop session is invalid.");
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, encrypted, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
}

export async function clearDesktopAuthSession(filePath) {
  await unlink(filePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
