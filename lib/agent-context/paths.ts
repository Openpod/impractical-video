import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  link,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { AgentContextError } from "@/lib/agent-context/errors";
import { projectRoot } from "@/lib/workspace";

export const AGENT_CONTEXT_DIRECTORY = ".video-fs/agent-context";

export function assertAgentContextProjectId(projectId: string) {
  if (
    !projectId ||
    projectId.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(projectId)
  ) {
    throw new AgentContextError(
      "PROJECT_NOT_FOUND",
      "The requested project does not exist.",
      404,
    );
  }
  return projectId;
}

export async function resolveAgentContextProjectRoot(projectId: string) {
  assertAgentContextProjectId(projectId);
  const candidate = projectRoot(projectId);
  await access(path.join(candidate, "project.json")).catch(() => {
    throw new AgentContextError(
      "PROJECT_NOT_FOUND",
      "The requested project does not exist.",
      404,
    );
  });
  const resolved = await realpath(candidate);
  if (path.basename(resolved) !== projectId) {
    throw new AgentContextError(
      "PROJECT_NOT_FOUND",
      "The requested project does not exist.",
      404,
    );
  }
  return resolved;
}

export async function ensureAgentContextRoot(projectId: string) {
  const projectDirectory = await resolveAgentContextProjectRoot(projectId);
  const contextDirectory = path.join(projectDirectory, AGENT_CONTEXT_DIRECTORY);
  await mkdir(contextDirectory, { mode: 0o700, recursive: true });
  const resolvedContext = await realpath(contextDirectory);
  assertContainedPath(projectDirectory, resolvedContext);
  return { contextDirectory: resolvedContext, projectDirectory };
}

export function assertContainedPath(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return candidate;
  }
  throw new AgentContextError(
    "AGENT_CONTEXT_UNAVAILABLE",
    "Agent context storage is unavailable.",
    500,
  );
}

export function resolveContainedPath(root: string, relativePath: string) {
  const target = path.resolve(root, relativePath);
  return assertContainedPath(root, target);
}

export async function readJsonFile(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

export async function writeJsonAtomic(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { mode: 0o700, recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function writeJsonImmutable(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { mode: 0o700, recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await link(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}
