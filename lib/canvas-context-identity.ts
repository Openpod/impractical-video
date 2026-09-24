import { createHash } from "node:crypto";
import { z } from "zod";
import {
  parseJsonFrontmatter,
  readWorkspaceBinaryFile,
  readWorkspaceFile,
  safeRelativePath,
} from "@/lib/workspace";

const stableIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/);

const candidateVersionSchema = z
  .object({
    index: z.number().int().nonnegative(),
    path: z.string().trim().min(1).max(1_024).nullable(),
    revision: z.number().int().nonnegative().nullable(),
    versionId: stableIdSchema,
  })
  .strict();

export const canvasContextIdentityCandidateSchema = z
  .object({
    artifactId: stableIdSchema,
    kind: z.string().trim().min(1).max(80),
    sourcePath: z.string().trim().min(1).max(1_024),
    title: z.string().trim().max(500).nullable(),
    version: candidateVersionSchema.nullable(),
  })
  .strict();

const resolvedVersionSchema = z
  .object({
    index: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    versionId: stableIdSchema,
  })
  .strict();

export const resolvedCanvasContextArtifactSchema = z
  .object({
    artifactId: stableIdSchema,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    entityRevision: z.number().int().nonnegative(),
    kind: z.string().trim().min(1).max(80),
    path: z.string().trim().min(1).max(1_024),
    title: z.string().trim().max(500).nullable(),
    version: resolvedVersionSchema.nullable(),
  })
  .strict();

export type CanvasContextIdentityCandidate = z.infer<
  typeof canvasContextIdentityCandidateSchema
>;
export type ResolvedCanvasContextArtifact = z.infer<
  typeof resolvedCanvasContextArtifactSchema
>;

export class CanvasContextIdentityError extends Error {
  constructor(
    readonly code:
      "IDENTITY_CHANGED" | "IDENTITY_UNAVAILABLE" | "VERSION_NOT_FOUND",
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function integer(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function localPath(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return safeRelativePath(value);
  } catch {
    return null;
  }
}

export async function resolveCanvasContextIdentity(
  projectId: string,
  rawCandidate: CanvasContextIdentityCandidate,
): Promise<ResolvedCanvasContextArtifact> {
  const candidate = canvasContextIdentityCandidateSchema.parse(rawCandidate);
  const sourcePath = safeRelativePath(candidate.sourcePath);
  const source = await readWorkspaceFile(projectId, sourcePath).catch(
    () => null,
  );
  if (source === null) {
    throw new CanvasContextIdentityError(
      "IDENTITY_UNAVAILABLE",
      `The selected artifact record "${sourcePath}" is unavailable.`,
      404,
    );
  }

  if (!candidate.version) {
    const parsed = parseJsonFrontmatter(source);
    return resolvedCanvasContextArtifactSchema.parse({
      artifactId: candidate.artifactId,
      contentHash: sha256(Buffer.from(source, "utf8")),
      entityRevision:
        integer(parsed.meta.entity_revision) ??
        integer(parsed.meta.revision) ??
        0,
      kind: candidate.kind,
      path: sourcePath,
      title: candidate.title,
      version: null,
    });
  }

  const parsed = parseJsonFrontmatter(source);
  const requestedPath = candidate.version.path
    ? safeRelativePath(candidate.version.path)
    : null;
  if (!requestedPath) {
    throw new CanvasContextIdentityError(
      "IDENTITY_UNAVAILABLE",
      `Version ${candidate.version.versionId} has no project-relative media file.`,
      422,
    );
  }
  const versions = Array.isArray(parsed.meta.versions)
    ? parsed.meta.versions.filter((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
      )
    : [];
  const recordEntry = versions.find(
    (entry) => localPath(entry.local_path) === requestedPath,
  );
  const activePath = localPath(parsed.meta.local_path);
  if (!recordEntry && activePath !== requestedPath) {
    throw new CanvasContextIdentityError(
      "VERSION_NOT_FOUND",
      `The selected version is no longer present in "${sourcePath}".`,
    );
  }

  const recordRevision =
    integer(recordEntry?.version) ??
    integer(recordEntry?.v) ??
    integer(parsed.meta.version);
  const entityRevision =
    recordRevision ?? candidate.version.revision ?? candidate.version.index + 1;
  const canonicalVersionId = `v${entityRevision}`;
  if (
    candidate.version.revision !== null &&
    recordRevision !== null &&
    candidate.version.revision !== recordRevision
  ) {
    throw new CanvasContextIdentityError(
      "IDENTITY_CHANGED",
      "The selected version changed while its identity was being resolved.",
    );
  }
  if (
    /^v\d+$/.test(candidate.version.versionId) &&
    candidate.version.versionId !== canonicalVersionId
  ) {
    throw new CanvasContextIdentityError(
      "IDENTITY_CHANGED",
      "The selected version identifier no longer matches its project record.",
    );
  }

  const media = await readWorkspaceBinaryFile(projectId, requestedPath).catch(
    () => null,
  );
  if (!media) {
    throw new CanvasContextIdentityError(
      "IDENTITY_UNAVAILABLE",
      `The selected version file "${requestedPath}" is unavailable.`,
      404,
    );
  }
  const digest = sha256(media.content);
  return resolvedCanvasContextArtifactSchema.parse({
    artifactId: candidate.artifactId,
    contentHash: digest,
    entityRevision,
    kind: candidate.kind,
    path: requestedPath,
    title: candidate.title,
    version: {
      index: candidate.version.index,
      sha256: digest,
      versionId: canonicalVersionId,
    },
  });
}

export async function verifyCanvasContextIdentity(
  projectId: string,
  rawArtifacts: ResolvedCanvasContextArtifact[],
) {
  const artifacts = z
    .array(resolvedCanvasContextArtifactSchema)
    .max(400)
    .parse(rawArtifacts);
  const stale: Array<{
    actualHash?: string;
    entityId: string;
    expectedHash: string;
    reason: "hash_mismatch" | "missing";
  }> = [];
  for (const artifact of artifacts) {
    const media = await readWorkspaceBinaryFile(
      projectId,
      safeRelativePath(artifact.path),
    ).catch(() => null);
    if (!media) {
      stale.push({
        entityId: artifact.artifactId,
        expectedHash: artifact.contentHash,
        reason: "missing",
      });
      continue;
    }
    const actualHash = sha256(media.content);
    const expectedHash = artifact.version?.sha256 ?? artifact.contentHash;
    if (actualHash !== expectedHash || actualHash !== artifact.contentHash) {
      stale.push({
        actualHash,
        entityId: artifact.artifactId,
        expectedHash,
        reason: "hash_mismatch",
      });
    }
  }
  return stale;
}
