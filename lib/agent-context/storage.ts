import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { AgentContextError } from "@/lib/agent-context/errors";
import {
  publishAgentContextEvent,
} from "@/lib/agent-context/events";
import {
  ensureAgentContextRoot,
  readJsonFile,
  resolveContainedPath,
  writeJsonAtomic,
  writeJsonImmutable,
} from "@/lib/agent-context/paths";
import {
  AGENT_CONTEXT_SCHEMA,
  AGENT_CONTEXT_SCHEMA_VERSION,
  agentContextSnapshotSchema,
  agentTurnSnapshotSchema,
  attachmentManifestSchema,
  createTurnSnapshotSchema,
  emptyCanvasContext,
  emptyEditorContext,
  normalizeAgentContextAttachment,
  patchAgentContextSchema,
  type AgentContextArtifact,
  type AgentContextAttachment,
  type AgentContextSnapshot,
  type AgentTurnSnapshot,
  type CreateTurnSnapshotInput,
  type PatchAgentContextInput,
} from "@/lib/agent-context/schema";

const WRITE_LOCK_STALE_MS = 15_000;
const WRITE_LOCK_TIMEOUT_MS = 2_000;

export type StaleAgentContextEntity = {
  actualHash?: string;
  entityId: string;
  expectedHash?: string;
  reason: "hash_mismatch" | "missing" | "path_unavailable";
};

function nowIso() {
  return new Date().toISOString();
}

function hashJson(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function withContentHash(
  value: Omit<AgentContextSnapshot, "contentHash">,
): AgentContextSnapshot {
  return agentContextSnapshotSchema.parse({
    ...value,
    contentHash: hashJson(value),
  });
}

function emptyContext(projectId: string): AgentContextSnapshot {
  return withContentHash({
    activeView: "canvas",
    attachments: [],
    binding: null,
    canvas: emptyCanvasContext(),
    clearEpoch: 0,
    contextRevision: 0,
    editor: emptyEditorContext(),
    projectId,
    projectRevision: null,
    schema: AGENT_CONTEXT_SCHEMA,
    schemaVersion: AGENT_CONTEXT_SCHEMA_VERSION,
    snapshotId: "ctx_0",
    updatedAt: "1970-01-01T00:00:00.000Z",
  });
}

function visibleContextCount(snapshot: AgentContextSnapshot) {
  const ids = new Set<string>();
  if (snapshot.activeView === "canvas") {
    for (const item of [...snapshot.canvas.selected, ...snapshot.canvas.pinned]) {
      ids.add(`canvas:${item.artifactId}`);
    }
  } else if (snapshot.activeView === "editor") {
    if (snapshot.editor.focusedArtifact) {
      ids.add(
        `editor-artifact:${snapshot.editor.focusedArtifact.artifactId}:${snapshot.editor.focusedArtifact.version?.versionId ?? "record"}`,
      );
    } else {
      for (const item of snapshot.editor.selectedElements) {
        ids.add(`editor:${item.trackId}:${item.elementId}`);
      }
      for (const trackId of snapshot.editor.selectedTrackIds) {
        ids.add(`track:${trackId}`);
      }
    }
    for (const item of snapshot.editor.selectedKeyframes) {
      ids.add(`keyframe:${item.trackId}:${item.elementId}:${item.keyframeId}`);
    }
    if (snapshot.editor.selectedMaskPoints) {
      for (const pointId of snapshot.editor.selectedMaskPoints.pointIds) {
        ids.add(`mask:${snapshot.editor.selectedMaskPoints.elementId}:${pointId}`);
      }
    }
  }
  for (const attachment of snapshot.attachments) {
    ids.add(`attachment:${attachment.attachmentId}`);
  }
  return ids.size;
}

function semanticContextMatches(
  current: AgentContextSnapshot,
  input: PatchAgentContextInput,
  attachments: AgentContextAttachment[],
) {
  if (!current.binding) return false;
  return (
    hashJson({
      activeView: current.activeView,
      attachments: current.attachments,
      canvas: current.canvas,
      editor: current.editor,
    }) ===
    hashJson({
      activeView: input.activeView,
      attachments,
      canvas: input.clear ? emptyCanvasContext() : input.canvas,
      editor: input.clear ? emptyEditorContext() : input.editor,
    })
  );
}

async function withProjectWriteLock<T>(
  projectId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const { contextDirectory } = await ensureAgentContextRoot(projectId);
  const lockPath = path.join(contextDirectory, "write.lock");
  const deadline = Date.now() + WRITE_LOCK_TIMEOUT_MS;
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ at: nowIso(), pid: process.pid })}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > WRITE_LOCK_STALE_MS) {
        await rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new AgentContextError(
          "AGENT_CONTEXT_BUSY",
          "Agent context is busy; retry the request.",
          503,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

export async function readCurrentAgentContext(projectId: string) {
  const { contextDirectory } = await ensureAgentContextRoot(projectId);
  const currentPath = path.join(contextDirectory, "current.json");
  const raw = await readJsonFile(currentPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!raw) return emptyContext(projectId);
  const snapshot = agentContextSnapshotSchema.parse(raw);
  if (snapshot.projectId !== projectId) {
    throw new AgentContextError(
      "AGENT_CONTEXT_UNAVAILABLE",
      "Stored agent context belongs to a different project.",
      500,
    );
  }
  return snapshot;
}

async function readAttachmentManifests(
  projectId: string,
  attachmentIds: string[],
): Promise<AgentContextAttachment[]> {
  if (!attachmentIds.length) return [];
  const { contextDirectory } = await ensureAgentContextRoot(projectId);
  const uniqueIds = [...new Set(attachmentIds)];
  return Promise.all(
    uniqueIds.map(async (attachmentId) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(attachmentId)) {
        throw new AgentContextError(
          "ATTACHMENT_NOT_FOUND",
          "An attachment is unavailable.",
          404,
          { attachmentId },
        );
      }
      const manifestPath = resolveContainedPath(
        contextDirectory,
        path.join("attachments", `${attachmentId}.json`),
      );
      const manifest = attachmentManifestSchema.parse(
        await readJsonFile(manifestPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new AgentContextError(
              "ATTACHMENT_NOT_FOUND",
              "An attachment is unavailable.",
              404,
              { attachmentId },
            );
          }
          throw error;
        }),
      );
      return normalizeAgentContextAttachment(manifest);
    }),
  );
}

export async function patchCurrentAgentContext(
  projectId: string,
  rawInput: PatchAgentContextInput,
) {
  const input = patchAgentContextSchema.parse(rawInput);
  if (input.projectId !== projectId) {
    throw new AgentContextError(
      "AGENT_CONTEXT_BINDING_MISMATCH",
      "Agent context is bound to a different project.",
      409,
      { projectId },
    );
  }

  const result = await withProjectWriteLock(projectId, async () => {
    const current = await readCurrentAgentContext(projectId);
    if (current.contextRevision !== input.baseContextRevision) {
      throw new AgentContextError(
        "AGENT_CONTEXT_REVISION_CONFLICT",
        "Agent context changed before this update was applied.",
        409,
        {
          currentContextRevision: current.contextRevision,
          expectedContextRevision: input.baseContextRevision,
        },
      );
    }
    const attachments = input.clear
      ? []
      : await readAttachmentManifests(projectId, input.attachmentIds);
    if (semanticContextMatches(current, input, attachments)) {
      return { changed: false, context: current };
    }
    const contextRevision = current.contextRevision + 1;
    const context = withContentHash({
      activeView: input.activeView,
      attachments,
      binding: {
        appSessionId: input.appSessionId,
        windowId: input.windowId,
      },
      canvas: input.clear ? emptyCanvasContext() : input.canvas,
      clearEpoch: current.clearEpoch + (input.clear ? 1 : 0),
      contextRevision,
      editor: input.clear ? emptyEditorContext() : input.editor,
      projectId,
      projectRevision: input.projectRevision,
      schema: AGENT_CONTEXT_SCHEMA,
      schemaVersion: AGENT_CONTEXT_SCHEMA_VERSION,
      snapshotId: `ctx_${contextRevision}`,
      updatedAt: nowIso(),
    });
    const { contextDirectory } = await ensureAgentContextRoot(projectId);
    await writeJsonImmutable(
      path.join(contextDirectory, "revisions", `${contextRevision}.json`),
      context,
    );
    await writeJsonAtomic(path.join(contextDirectory, "current.json"), context);
    return { changed: true, context };
  });

  if (result.changed) {
    publishAgentContextEvent({
      clearEpoch: result.context.clearEpoch,
      contextRevision: result.context.contextRevision,
      kind: input.clear ? "agent_context.cleared" : "agent_context.changed",
      projectId,
      visibleCount: visibleContextCount(result.context),
      windowId: result.context.binding?.windowId ?? input.windowId,
    });
  }
  return result.context;
}

export async function readAgentContextRevision(
  projectId: string,
  revision: number,
) {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new AgentContextError(
      "AGENT_CONTEXT_NOT_FOUND",
      "The requested context revision does not exist.",
      404,
    );
  }
  if (revision === 0) return emptyContext(projectId);
  const { contextDirectory } = await ensureAgentContextRoot(projectId);
  const revisionPath = path.join(contextDirectory, "revisions", `${revision}.json`);
  const snapshot = agentContextSnapshotSchema.parse(
    await readJsonFile(revisionPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AgentContextError(
          "AGENT_CONTEXT_NOT_FOUND",
          "The requested context revision does not exist.",
          404,
        );
      }
      throw error;
    }),
  );
  if (snapshot.projectId !== projectId || snapshot.contextRevision !== revision) {
    throw new AgentContextError(
      "AGENT_CONTEXT_UNAVAILABLE",
      "The stored context revision is invalid.",
      500,
    );
  }
  return snapshot;
}

async function hashFile(filePath: string) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function inspectArtifact(
  projectDirectory: string,
  artifact: AgentContextArtifact,
  verifyHashes: boolean,
): Promise<StaleAgentContextEntity | null> {
  if (!artifact.path) return null;
  const candidate = resolveContainedPath(projectDirectory, artifact.path);
  const resolved = await realpath(candidate).catch(() => null);
  if (!resolved) {
    return { entityId: artifact.artifactId, reason: "missing" };
  }
  const relative = path.relative(projectDirectory, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { entityId: artifact.artifactId, reason: "path_unavailable" };
  }
  const expectedHash = artifact.contentHash ?? artifact.version?.sha256 ?? null;
  if (!verifyHashes || !expectedHash) return null;
  const actualHash = await hashFile(resolved);
  if (actualHash !== expectedHash) {
    return {
      actualHash,
      entityId: artifact.artifactId,
      expectedHash,
      reason: "hash_mismatch",
    };
  }
  return null;
}

export async function inspectAgentContextEntities(
  snapshot: AgentContextSnapshot,
  options: { verifyHashes?: boolean } = {},
) {
  const { projectDirectory } = await ensureAgentContextRoot(snapshot.projectId);
  const artifacts = [
    ...snapshot.canvas.selected,
    ...snapshot.canvas.pinned,
    ...(snapshot.canvas.focused ? [snapshot.canvas.focused] : []),
  ];
  const stale = (
    await Promise.all(
      artifacts.map((artifact) =>
        inspectArtifact(projectDirectory, artifact, Boolean(options.verifyHashes)),
      ),
    )
  ).filter((entry): entry is StaleAgentContextEntity => Boolean(entry));

  for (const attachment of snapshot.attachments) {
    const candidate = resolveContainedPath(projectDirectory, attachment.path);
    const resolved = await realpath(candidate).catch(() => null);
    if (!resolved) {
      stale.push({
        entityId: attachment.attachmentId,
        reason: "missing",
      });
      continue;
    }
    const relative = path.relative(projectDirectory, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      stale.push({
        entityId: attachment.attachmentId,
        reason: "path_unavailable",
      });
      continue;
    }
    if (options.verifyHashes) {
      const actualHash = await hashFile(resolved);
      if (actualHash !== attachment.sha256) {
        stale.push({
          actualHash,
          entityId: attachment.attachmentId,
          expectedHash: attachment.sha256,
          reason: "hash_mismatch",
        });
      }
    }
  }
  return [...new Map(stale.map((entry) => [entry.entityId, entry])).values()];
}

export async function createAgentTurnSnapshot(
  projectId: string,
  rawInput: CreateTurnSnapshotInput,
) {
  const input = createTurnSnapshotSchema.parse(rawInput);
  if (input.projectId !== projectId) {
    throw new AgentContextError(
      "AGENT_CONTEXT_BINDING_MISMATCH",
      "Agent context is bound to a different project.",
      409,
      { projectId },
    );
  }
  const current = await readCurrentAgentContext(projectId);
  if (!current.binding || current.binding.windowId !== input.windowId) {
    throw new AgentContextError(
      "AGENT_CONTEXT_BINDING_MISMATCH",
      "The connected agent is bound to a different app window.",
      409,
      {
        currentWindowId: current.binding?.windowId ?? null,
        requestedWindowId: input.windowId,
      },
    );
  }
  if (
    input.expectedContextRevision !== undefined &&
    input.expectedContextRevision !== current.contextRevision
  ) {
    throw new AgentContextError(
      "AGENT_CONTEXT_REVISION_CONFLICT",
      "Agent context changed before the turn snapshot was created.",
      409,
      {
        currentContextRevision: current.contextRevision,
        expectedContextRevision: input.expectedContextRevision,
      },
    );
  }
  const staleEntities = await inspectAgentContextEntities(current, {
    verifyHashes: true,
  });
  if (staleEntities.length) {
    throw new AgentContextError(
      "AGENT_CONTEXT_STALE",
      "One or more selected items changed or are unavailable.",
      409,
      {
        contextRevision: current.contextRevision,
        staleEntities,
      },
    );
  }

  const snapshot: AgentTurnSnapshot = agentTurnSnapshotSchema.parse({
    agent: input.agent,
    agentSessionId: input.agentSessionId,
    context: current,
    createdAt: nowIso(),
    projectId,
    schema: "AgentContextTurnSnapshot@1",
    snapshotId: `turn_${randomUUID()}`,
    turnId: input.turnId,
    windowId: input.windowId,
  });
  const { contextDirectory } = await ensureAgentContextRoot(projectId);
  await writeJsonImmutable(
    path.join(contextDirectory, "turns", `${snapshot.snapshotId}.json`),
    snapshot,
  );
  publishAgentContextEvent({
    agent: snapshot.agent,
    agentSessionId: snapshot.agentSessionId,
    contextRevision: snapshot.context.contextRevision,
    kind: "agent_context.turn_snapshot",
    projectId,
    snapshotId: snapshot.snapshotId,
  });
  return snapshot;
}

export async function readAgentTurnSnapshot(
  projectId: string,
  snapshotId: string,
) {
  if (!/^turn_[A-Za-z0-9-]+$/.test(snapshotId)) {
    throw new AgentContextError(
      "AGENT_CONTEXT_NOT_FOUND",
      "The requested turn snapshot does not exist.",
      404,
    );
  }
  const { contextDirectory } = await ensureAgentContextRoot(projectId);
  const turnPath = resolveContainedPath(
    contextDirectory,
    path.join("turns", `${snapshotId}.json`),
  );
  const snapshot = agentTurnSnapshotSchema.parse(
    await readJsonFile(turnPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AgentContextError(
          "AGENT_CONTEXT_NOT_FOUND",
          "The requested turn snapshot does not exist.",
          404,
        );
      }
      throw error;
    }),
  );
  if (snapshot.projectId !== projectId || snapshot.snapshotId !== snapshotId) {
    throw new AgentContextError(
      "AGENT_CONTEXT_UNAVAILABLE",
      "The stored turn snapshot is invalid.",
      500,
    );
  }
  return snapshot;
}

async function countJsonFiles(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
}

export async function readAgentContextStatus(projectId: string) {
  const current = await readCurrentAgentContext(projectId);
  const { contextDirectory } = await ensureAgentContextRoot(projectId);
  const [revisionCount, turnSnapshotCount, staleEntities] = await Promise.all([
    countJsonFiles(path.join(contextDirectory, "revisions")),
    countJsonFiles(path.join(contextDirectory, "turns")),
    inspectAgentContextEntities(current),
  ]);
  return {
    binding: current.binding,
    clearEpoch: current.clearEpoch,
    contextRevision: current.contextRevision,
    currentSnapshotId: current.snapshotId,
    projectId,
    revisionCount,
    schema: AGENT_CONTEXT_SCHEMA,
    staleEntities,
    turnSnapshotCount,
    visibleCount: visibleContextCount(current),
  };
}
