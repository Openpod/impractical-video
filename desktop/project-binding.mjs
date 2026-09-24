import { createHmac, timingSafeEqual } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import path from "node:path";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PROJECT_BEARER_DOMAIN = "video-fs-project-binding:v1";

export function validateProjectId(value, label = "project_id") {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed !== value || !trimmed || !PROJECT_ID_PATTERN.test(trimmed)) {
    throw new Error(
      `${label} must exactly contain only letters, numbers, underscores, and hyphens; paths and surrounding whitespace are not allowed.`,
    );
  }
  return trimmed;
}

export function resolveBoundProjectId(input, binding) {
  const boundProjectId = binding ? validateProjectId(binding, "VIDEO_FS_PROJECT_ID") : null;
  if (input == null) {
    if (boundProjectId) return boundProjectId;
    throw new Error(
      "project_id is required (or set VIDEO_FS_PROJECT_ID for this MCP server).",
    );
  }

  const requestedProjectId = validateProjectId(input);
  if (boundProjectId && requestedProjectId !== boundProjectId) {
    throw new Error(
      `This MCP bridge is bound to project "${boundProjectId}" and rejects project "${requestedProjectId}".`,
    );
  }
  return requestedProjectId;
}

export function deriveProjectBearerToken(masterToken, dataRoot, projectId) {
  const validatedProjectId = validateProjectId(projectId);
  if (typeof masterToken !== "string" || masterToken.length < 32) {
    throw new Error("Desktop project binding has an invalid master token.");
  }
  if (
    typeof dataRoot !== "string" ||
    !path.isAbsolute(dataRoot) ||
    !dataRoot.trim()
  ) {
    throw new Error("Desktop project binding has an invalid data root.");
  }
  return createHmac("sha256", masterToken)
    .update(PROJECT_BEARER_DOMAIN)
    .update("\0")
    .update(path.resolve(dataRoot))
    .update("\0")
    .update(validatedProjectId)
    .digest("hex");
}

export function isProjectBearerAuthorized(
  authorization,
  masterToken,
  dataRoot,
  projectId,
) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return false;
  }
  let expected;
  try {
    expected = deriveProjectBearerToken(masterToken, dataRoot, projectId);
  } catch {
    return false;
  }
  const supplied = authorization.slice("Bearer ".length);
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export async function resolveBoundProjectRoot(dataRoot, projectId) {
  const validatedProjectId = validateProjectId(projectId);
  if (
    typeof dataRoot !== "string" ||
    !path.isAbsolute(dataRoot) ||
    !dataRoot.trim()
  ) {
    throw new Error("Desktop project binding has an invalid data root.");
  }
  const root = await realpath(path.resolve(dataRoot));
  const candidate = path.join(root, validatedProjectId);
  await access(path.join(candidate, "project.json"));
  const resolved = await realpath(candidate);
  if (
    path.dirname(resolved) !== root ||
    path.basename(resolved) !== validatedProjectId
  ) {
    throw new Error("Desktop project binding resolved outside its data root.");
  }
  return resolved;
}
