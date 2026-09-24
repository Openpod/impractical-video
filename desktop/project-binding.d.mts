export function validateProjectId(value: unknown, label?: string): string;

export function resolveBoundProjectId(
  input: unknown,
  binding: { projectId?: unknown },
): string;

export function deriveProjectBearerToken(
  masterToken: unknown,
  dataRoot: unknown,
  projectId: unknown,
): string;

export function isProjectBearerAuthorized(
  authorization: unknown,
  masterToken: unknown,
  dataRoot: unknown,
  projectId: unknown,
): boolean;

export function resolveBoundProjectRoot(
  dataRoot: unknown,
  projectId: unknown,
): Promise<string>;
