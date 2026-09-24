export type MediaVersionFrontmatter = {
  version: number;
  url: string | null;
  local_path: string | null;
};

export type MediaVersionWriteState = {
  active: Omit<MediaVersionFrontmatter, "version"> | null;
  status: string;
  versions: MediaVersionFrontmatter[];
  nextVersion: number;
};

function frontmatterString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function frontmatterStatus(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function frontmatterMediaVersions(value: unknown): MediaVersionFrontmatter[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): MediaVersionFrontmatter[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const version = typeof record.version === "number" ? record.version : null;
    if (version === null || !Number.isInteger(version) || version < 1) return [];
    const url = frontmatterString(record.url);
    const localPath = frontmatterString(record.local_path);
    if (!url && !localPath) return [];
    return [{ version, url, local_path: localPath }];
  });
}

export function activeMediaFromFrontmatter(
  meta: Record<string, unknown>,
): Omit<MediaVersionFrontmatter, "version"> | null {
  const url = frontmatterString(meta.url);
  const localPath = frontmatterString(meta.local_path);
  return url || localPath ? { url, local_path: localPath } : null;
}

function sameMediaVersion(
  left: Pick<MediaVersionFrontmatter, "url" | "local_path">,
  right: Pick<MediaVersionFrontmatter, "url" | "local_path">,
) {
  return Boolean(
    (left.url && right.url && left.url === right.url) ||
      (left.local_path && right.local_path && left.local_path === right.local_path),
  );
}

function versionNumberFromLocalPath(localPath: string | null) {
  if (!localPath) return null;
  const match = /\.v([1-9][0-9]*)\.[a-z0-9]+$/i.exec(localPath);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function mediaVersionState(meta: Record<string, unknown>) {
  const versions = frontmatterMediaVersions(meta.versions);
  const active = activeMediaFromFrontmatter(meta);
  if (active && !versions.some((version) => sameMediaVersion(version, active))) {
    const used = new Set(versions.map((version) => version.version));
    const parsedVersion = versionNumberFromLocalPath(active.local_path);
    const version =
      parsedVersion !== null && !used.has(parsedVersion)
        ? parsedVersion
        : Math.max(0, ...versions.map((item) => item.version)) + 1;
    versions.push({ version, ...active });
  }
  versions.sort((a, b) => a.version - b.version);
  return {
    active,
    activeStatus: frontmatterStatus(meta.status),
    versions,
    nextVersion: Math.max(0, ...versions.map((item) => item.version)) + 1,
  };
}

export function appendMediaVersion(
  versions: MediaVersionFrontmatter[],
  input: {
    version: number;
    url: string | null | undefined;
    localPath: string | null | undefined;
  },
) {
  const next = {
    version: input.version,
    url: input.url ?? null,
    local_path: input.localPath ?? null,
  };
  if (!next.url && !next.local_path) return versions;
  return [...versions.filter((version) => version.version !== next.version), next].sort(
    (a, b) => a.version - b.version,
  );
}

export function mediaVersionWriteState(
  existingMeta: Record<string, unknown>,
  input: {
    url: string | null | undefined;
    localPath: string | null | undefined;
    successStatus: string;
    emptyStatus: string;
  },
): MediaVersionWriteState {
  const state = mediaVersionState(existingMeta);
  const active = input.url
    ? { url: input.url, local_path: input.localPath ?? null }
    : state.active;
  const status = input.url
    ? input.successStatus
    : state.active
      ? state.activeStatus ?? input.successStatus
      : input.emptyStatus;
  return {
    active,
    status,
    versions: appendMediaVersion(state.versions, {
      version: state.nextVersion,
      url: input.url,
      localPath: input.localPath,
    }),
    nextVersion: state.nextVersion,
  };
}
