import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { AgentContextError } from "@/lib/agent-context/errors";
import { publishAgentContextEvent } from "@/lib/agent-context/events";
import {
  assertContainedPath,
  ensureAgentContextRoot,
  readJsonFile,
  resolveContainedPath,
  writeJsonAtomic,
} from "@/lib/agent-context/paths";
import {
  attachmentManifestSchema,
  normalizeAgentContextAttachment,
  type AttachmentManifest,
} from "@/lib/agent-context/schema";

export const MAX_AGENT_CONTEXT_ATTACHMENT_BYTES = 64 * 1024 * 1024;

const MIME_EXTENSION = new Map<string, string>([
  ["application/json", ".json"],
  ["application/pdf", ".pdf"],
  ["audio/m4a", ".m4a"],
  ["audio/mp4", ".m4a"],
  ["audio/mpeg", ".mp3"],
  ["audio/wav", ".wav"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["text/csv", ".csv"],
  ["text/markdown", ".md"],
  ["text/plain", ".txt"],
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
  ["video/webm", ".webm"],
]);

export function sanitizeAgentContextAttachmentName(value: string) {
  const base = path.basename(value || "attachment")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[^A-Za-z0-9._ ()@+-]/g, "_")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 160);
  return base || "attachment";
}

export type IngestAgentContextAttachmentInput = {
  bytes: Uint8Array;
  displayName: string;
  media?: {
    durationSeconds?: number | null;
    height?: number | null;
    width?: number | null;
  };
  mimeType: string;
  projectId: string;
};

function validateAttachmentInput(input: IngestAgentContextAttachmentInput) {
  const mimeType = input.mimeType.trim().toLowerCase();
  const extension = MIME_EXTENSION.get(mimeType);
  if (!extension) {
    throw new AgentContextError(
      "ATTACHMENT_INVALID",
      "This attachment type is not supported.",
      415,
      { allowedMimeTypes: [...MIME_EXTENSION.keys()] },
    );
  }
  if (input.bytes.byteLength <= 0) {
    throw new AgentContextError(
      "ATTACHMENT_INVALID",
      "The attachment is empty.",
      400,
    );
  }
  if (input.bytes.byteLength > MAX_AGENT_CONTEXT_ATTACHMENT_BYTES) {
    throw new AgentContextError(
      "ATTACHMENT_INVALID",
      "The attachment exceeds the 64 MiB local-context limit.",
      413,
      { maxBytes: MAX_AGENT_CONTEXT_ATTACHMENT_BYTES },
    );
  }
  return { extension, mimeType };
}

export async function ingestAgentContextAttachment(
  input: IngestAgentContextAttachmentInput,
) {
  const attemptId = `attempt_${randomUUID()}`;
  let eventAttachmentId = attemptId;
  try {
    const { extension, mimeType } = validateAttachmentInput(input);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const attachmentId = `att_${sha256.slice(0, 32)}`;
    eventAttachmentId = attachmentId;
    publishAgentContextEvent({
      attachmentId,
      kind: "attachment.processing",
      projectId: input.projectId,
    });

    const { contextDirectory, projectDirectory } =
      await ensureAgentContextRoot(input.projectId);
    const mediaDirectory = path.join(projectDirectory, "media", "agent-context");
    const manifestDirectory = path.join(contextDirectory, "attachments");
    await Promise.all([
      mkdir(mediaDirectory, { mode: 0o700, recursive: true }),
      mkdir(manifestDirectory, { mode: 0o700, recursive: true }),
    ]);
    const [resolvedMediaDirectory, resolvedManifestDirectory] = await Promise.all([
      realpath(mediaDirectory),
      realpath(manifestDirectory),
    ]);
    assertContainedPath(projectDirectory, resolvedMediaDirectory);
    assertContainedPath(projectDirectory, resolvedManifestDirectory);

    const relativeMediaPath = path.posix.join(
      "media",
      "agent-context",
      `${sha256}${extension}`,
    );
    const destination = resolveContainedPath(projectDirectory, relativeMediaPath);
    const manifestPath = resolveContainedPath(
      contextDirectory,
      path.join("attachments", `${attachmentId}.json`),
    );
    const existingManifest = await readJsonFile(manifestPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (existingManifest) {
      const manifest = attachmentManifestSchema.parse(existingManifest);
      const existingHash = createHash("sha256")
        .update(await readFile(destination))
        .digest("hex");
      if (existingHash !== sha256) {
        throw new AgentContextError(
          "ATTACHMENT_INVALID",
          "The stored attachment failed its integrity check.",
          409,
          { attachmentId },
        );
      }
      publishAgentContextEvent({
        attachmentId,
        kind: "attachment.ready",
        projectId: input.projectId,
        sha256,
      });
      return {
        attachment: normalizeAgentContextAttachment(manifest),
        deduplicated: true,
        manifest,
      };
    }

    const temporaryPath = resolveContainedPath(
      resolvedMediaDirectory,
      `.${sha256}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, input.bytes, {
        flag: "wx",
        mode: 0o600,
      });
      const writtenHash = createHash("sha256")
        .update(await readFile(temporaryPath))
        .digest("hex");
      if (writtenHash !== sha256) {
        throw new AgentContextError(
          "ATTACHMENT_INVALID",
          "The attachment failed its integrity check.",
          400,
        );
      }
      const destinationExists = await access(destination)
        .then(() => true)
        .catch(() => false);
      if (!destinationExists) await rename(temporaryPath, destination);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }

    const manifest: AttachmentManifest = attachmentManifestSchema.parse({
      attachmentId,
      createdAt: new Date().toISOString(),
      displayName: sanitizeAgentContextAttachmentName(input.displayName),
      media: {
        durationSeconds: input.media?.durationSeconds ?? null,
        height: input.media?.height ?? null,
        width: input.media?.width ?? null,
      },
      mimeType,
      path: relativeMediaPath,
      schema: "AgentContextAttachment@1",
      sha256,
      size: input.bytes.byteLength,
    });
    await writeJsonAtomic(manifestPath, manifest);
    publishAgentContextEvent({
      attachmentId,
      kind: "attachment.ready",
      projectId: input.projectId,
      sha256,
    });
    return {
      attachment: normalizeAgentContextAttachment(manifest),
      deduplicated: false,
      manifest,
    };
  } catch (error) {
    publishAgentContextEvent({
      attachmentId: eventAttachmentId,
      kind: "attachment.failed",
      projectId: input.projectId,
    });
    throw error;
  }
}

export async function readAgentContextAttachment(
  projectId: string,
  attachmentId: string,
) {
  if (!/^att_[a-f0-9]{32}$/.test(attachmentId)) {
    throw new AgentContextError(
      "ATTACHMENT_NOT_FOUND",
      "The requested attachment does not exist.",
      404,
    );
  }
  const { contextDirectory } = await ensureAgentContextRoot(projectId);
  const manifestPath = resolveContainedPath(
    contextDirectory,
    path.join("attachments", `${attachmentId}.json`),
  );
  return attachmentManifestSchema.parse(
    await readJsonFile(manifestPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AgentContextError(
          "ATTACHMENT_NOT_FOUND",
          "The requested attachment does not exist.",
          404,
        );
      }
      throw error;
    }),
  );
}

export async function readAgentContextAttachmentContext(
  projectId: string,
  attachmentId: string,
) {
  return normalizeAgentContextAttachment(
    await readAgentContextAttachment(projectId, attachmentId),
  );
}
