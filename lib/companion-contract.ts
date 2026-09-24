export const COMPANION_MODELS = [
  { label: "Sonnet", value: "sonnet" },
  { label: "Opus", value: "opus" },
  { label: "Haiku", value: "haiku" },
] as const;

/** Keep persisted model names readable as the CLI evolves. The current picker
 * uses supported aliases without sending paid prompts to probe availability. */
export type CompanionModel = string;

export type CompanionReference = {
  id: string;
  kind: string;
  path: string;
  previewPath: string | null;
  title: string;
};

export type CompanionAttachmentPayload = {
  data: string;
  name: string;
  type: string;
};

type ProjectFileLike = {
  content?: string;
  path: string;
};

const PROJECT_REFERENCE_PATH =
  /^(clips|keyframes|references|uploads)\/[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/;

export function normalizeCompanionModel(
  value: unknown,
): CompanionModel | null {
  return COMPANION_MODELS.some((option) => option.value === value)
    ? (value as CompanionModel)
    : null;
}

export function resolvedCompanionModel(
  value?: unknown,
): CompanionModel {
  return normalizeCompanionModel(value) ?? "sonnet";
}

export function companionModelStorageKey(projectId: string) {
  return `video-fs-companion-model:${projectId}`;
}

function parseRecord(content: string | undefined) {
  if (!content?.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end < 0) return null;
  try {
    const value = JSON.parse(content.slice(4, end).trim()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function safeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function titleFromBody(content: string | undefined) {
  if (!content) return null;
  const end = content.startsWith("---\n")
    ? content.indexOf("\n---", 4)
    : -1;
  const body = end >= 0 ? content.slice(end + 5) : content;
  const heading = body
    .split(/\r?\n/)
    .map((line) => /^#\s+(.+)$/.exec(line)?.[1]?.trim())
    .find(Boolean);
  return heading ?? null;
}

export function companionProjectReferences(
  files: readonly ProjectFileLike[],
): CompanionReference[] {
  return files.flatMap((file): CompanionReference[] => {
    if (!PROJECT_REFERENCE_PATH.test(file.path) || file.path.includes("..")) {
      return [];
    }
    const record = parseRecord(file.content);
    const pathId = file.path.split("/").pop()?.replace(/\.md$/, "") ?? "";
    const id = safeString(record?.id) ?? pathId;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return [];
    const directory = file.path.split("/")[0] ?? "file";
    const kind = safeString(record?.kind) ?? safeString(record?.type) ?? directory.replace(/s$/, "");
    const title =
      safeString(record?.title) ??
      safeString(record?.original_name) ??
      titleFromBody(file.content) ??
      id;
    const localPath = safeString(record?.local_path);
    const previewPath =
      localPath &&
      /^media\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(localPath) &&
      !localPath.includes("..")
        ? localPath
        : null;
    return [{ id, kind, path: file.path, previewPath, title }];
  });
}

export function normalizeRequestedCompanionReferences(
  requested: readonly Pick<CompanionReference, "id" | "path">[],
  available: readonly CompanionReference[],
) {
  const byIdentity = new Map(
    available.map((entry) => [`${entry.path}\0${entry.id}`, entry]),
  );
  const unique = new Map<string, CompanionReference>();
  for (const entry of requested.slice(0, 20)) {
    const match = byIdentity.get(`${entry.path}\0${entry.id}`);
    if (match) unique.set(match.path, match);
  }
  return [...unique.values()];
}
