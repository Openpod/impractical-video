import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const COMPANION_COMPOSE_VERSION = 1;
export const COMPANION_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

const MODELS = new Set(["haiku", "opus", "sonnet"]);
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const REFERENCE_PATH =
  /^(clips|keyframes|references|uploads)\/[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/;

function cleanProjectId(value) {
  if (typeof value !== "string" || !PROJECT_ID.test(value)) {
    throw new Error("Invalid companion project id.");
  }
  return value;
}

function cleanName(value) {
  const base = path.basename(typeof value === "string" ? value : "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 255);
  return base || "attachment";
}

function cleanMime(value) {
  const mime =
    typeof value === "string" &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value)
      ? value.toLowerCase()
      : "application/octet-stream";
  return mime.slice(0, 160);
}

function cleanReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id =
    typeof value.id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value.id)
      ? value.id
      : null;
  const referencePath =
    typeof value.path === "string" &&
    REFERENCE_PATH.test(value.path) &&
    !value.path.includes("..")
      ? value.path
      : null;
  return id && referencePath ? { id, path: referencePath } : null;
}

function cleanAttachment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const hash = typeof value.hash === "string" && HASH.test(value.hash)
    ? value.hash
    : null;
  const size =
    Number.isSafeInteger(value.size) &&
    value.size > 0 &&
    value.size <= COMPANION_ATTACHMENT_MAX_BYTES
      ? value.size
      : null;
  return hash && size
    ? {
        hash,
        name: cleanName(value.name),
        size,
        type: cleanMime(value.type),
      }
    : null;
}

export function emptyCompanionCompose(projectId) {
  return {
    attachments: [],
    draft: "",
    model: null,
    projectId: cleanProjectId(projectId),
    references: [],
    version: COMPANION_COMPOSE_VERSION,
    workflowId: null,
  };
}

export function normalizeCompanionCompose(projectId, value) {
  const empty = emptyCompanionCompose(projectId);
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const references = [];
  const seenReferences = new Set();
  for (const candidate of Array.isArray(value.references)
    ? value.references.slice(0, 20)
    : []) {
    const reference = cleanReference(candidate);
    if (!reference || seenReferences.has(reference.path)) continue;
    seenReferences.add(reference.path);
    references.push(reference);
  }
  const attachments = [];
  const seenAttachments = new Set();
  for (const candidate of Array.isArray(value.attachments)
    ? value.attachments.slice(0, 10)
    : []) {
    const attachment = cleanAttachment(candidate);
    if (!attachment || seenAttachments.has(attachment.hash)) continue;
    seenAttachments.add(attachment.hash);
    attachments.push(attachment);
  }
  return {
    attachments,
    draft:
      typeof value.draft === "string" ? value.draft.slice(0, 20_000) : "",
    model: MODELS.has(value.model) ? value.model : null,
    projectId: empty.projectId,
    references,
    version: COMPANION_COMPOSE_VERSION,
    workflowId:
      typeof value.workflowId === "string" &&
      /^[A-Za-z0-9_-]{1,160}$/.test(value.workflowId)
        ? value.workflowId
        : null,
  };
}

function stateDirectory(root) {
  return path.join(root, "state");
}

function blobDirectory(root) {
  return path.join(root, "blobs");
}

function statePath(root, projectId) {
  return path.join(stateDirectory(root), `${cleanProjectId(projectId)}.json`);
}

function blobPath(root, hash) {
  if (!HASH.test(hash)) throw new Error("Invalid companion attachment id.");
  return path.join(blobDirectory(root), hash);
}

async function writePrivateAtomic(filePath, contents) {
  const existing = await readFile(filePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing === contents) {
    await chmod(filePath, 0o600);
    return false;
  }
  await mkdir(path.dirname(filePath), { mode: 0o700, recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return true;
}

export async function readCompanionCompose(root, projectId) {
  const normalizedProjectId = cleanProjectId(projectId);
  const raw = await readFile(statePath(root, normalizedProjectId), "utf8")
    .then((value) => JSON.parse(value))
    .catch(() => null);
  const state = normalizeCompanionCompose(normalizedProjectId, raw);
  const issues = [];
  for (const attachment of state.attachments) {
    const issue = await validateCompanionAttachment(root, attachment).catch(
      (error) =>
        error instanceof Error
          ? error.message
          : `"${attachment.name}" is unavailable.`,
    );
    if (issue) issues.push({ hash: attachment.hash, message: issue });
  }
  return { issues, state };
}

export async function writeCompanionCompose(root, projectId, value) {
  const previous = await readCompanionCompose(root, projectId);
  const state = normalizeCompanionCompose(projectId, value);
  const contents = `${JSON.stringify(state, null, 2)}\n`;
  const changed = await writePrivateAtomic(
    statePath(root, state.projectId),
    contents,
  );
  for (const attachment of previous.state.attachments) {
    if (
      !state.attachments.some((entry) => entry.hash === attachment.hash) &&
      !(await hashReferencedByAnotherProject(root, state.projectId, attachment.hash))
    ) {
      await rm(blobPath(root, attachment.hash), { force: true });
    }
  }
  return { changed, state };
}

export async function storeCompanionAttachment(root, projectId, input) {
  cleanProjectId(projectId);
  const bytes = Buffer.from(input?.bytes ?? []);
  const name = cleanName(input?.name);
  if (!bytes.byteLength) throw new Error(`"${name}" is empty or unreadable.`);
  if (bytes.byteLength > COMPANION_ATTACHMENT_MAX_BYTES) {
    throw new Error(`"${name}" is too large (maximum 25 MB).`);
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  const target = blobPath(root, hash);
  await mkdir(blobDirectory(root), { mode: 0o700, recursive: true });
  const existing = await readFile(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (
      existing.byteLength !== bytes.byteLength ||
      createHash("sha256").update(existing).digest("hex") !== hash
    ) {
      throw new Error(`"${name}" could not be safely stored.`);
    }
    await chmod(target, 0o600);
  } else {
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
      await chmod(target, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  return {
    hash,
    name,
    size: bytes.byteLength,
    type: cleanMime(input?.type),
  };
}

async function validateCompanionAttachment(root, attachment) {
  const target = blobPath(root, attachment.hash);
  const info = await stat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!info?.isFile()) return `"${attachment.name}" is missing. Remove it and attach it again.`;
  if (info.size !== attachment.size) {
    return `"${attachment.name}" changed in private storage. Remove it and attach it again.`;
  }
  const bytes = await readFile(target).catch(() => null);
  if (!bytes) return `"${attachment.name}" is unreadable. Check app storage permissions.`;
  if (createHash("sha256").update(bytes).digest("hex") !== attachment.hash) {
    return `"${attachment.name}" changed in private storage. Remove it and attach it again.`;
  }
  return null;
}

export async function readCompanionAttachment(root, projectId, hash) {
  const { state } = await readCompanionCompose(root, projectId);
  const attachment = state.attachments.find((entry) => entry.hash === hash);
  if (!attachment) throw new Error("The attachment is no longer selected.");
  const issue = await validateCompanionAttachment(root, attachment);
  if (issue) throw new Error(issue);
  const bytes = await readFile(blobPath(root, attachment.hash));
  return {
    ...attachment,
    data: bytes.toString("base64"),
  };
}

async function hashReferencedByAnotherProject(root, projectId, hash) {
  const entries = await readdir(stateDirectory(root), {
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const otherProjectId = entry.name.slice(0, -5);
    if (otherProjectId === projectId || !PROJECT_ID.test(otherProjectId)) continue;
    const { state } = await readCompanionCompose(root, otherProjectId);
    if (state.attachments.some((attachment) => attachment.hash === hash)) {
      return true;
    }
  }
  return false;
}

export async function garbageCollectCompanionAttachments(root) {
  const referenced = new Set();
  const states = await readdir(stateDirectory(root), {
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of states) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const projectId = entry.name.slice(0, -5);
    if (!PROJECT_ID.test(projectId)) continue;
    const { state } = await readCompanionCompose(root, projectId);
    state.attachments.forEach((attachment) => referenced.add(attachment.hash));
  }
  const blobs = await readdir(blobDirectory(root), {
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of blobs) {
    if (entry.isFile() && HASH.test(entry.name) && !referenced.has(entry.name)) {
      await rm(path.join(blobDirectory(root), entry.name), { force: true });
    }
  }
}

export async function removeCompanionAttachment(root, projectId, hash) {
  const cleanId = cleanProjectId(projectId);
  const current = await readCompanionCompose(root, cleanId);
  const next = {
    ...current.state,
    attachments: current.state.attachments.filter(
      (attachment) => attachment.hash !== hash,
    ),
  };
  await writeCompanionCompose(root, cleanId, next);
  if (!(await hashReferencedByAnotherProject(root, cleanId, hash))) {
    await rm(blobPath(root, hash), { force: true });
  }
  return next;
}
