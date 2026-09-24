import {
  parseJsonFrontmatter,
  readWorkspaceFile,
  withJsonFrontmatter,
  writeWorkspaceBinaryFile,
  writeWorkspaceFile,
} from "@/lib/workspace";
import { cropImageToAspect } from "@/lib/media";

// Versioned redo for canvas artifacts: a retry of an existing tile appends a
// new version to its record instead of minting a sibling tile. Same id, same
// canvas position, same group — only the pixels advance.

export async function appendArtifactVersion(
  projectId: string,
  input: {
    /** Crop downloaded image media to this exact ratio before storing. */
    exactAspect?: string | null;
    id: string;
    kind: "clip" | "keyframe";
    /** Extra frontmatter to merge (e.g. duration_seconds for clips). */
    metaPatch?: Record<string, unknown>;
    /** Provenance note appended to the record body (prompt, inputs). */
    note?: string | null;
    /** Remote media to download for the new version. */
    url: string;
  },
): Promise<{ localPath: string; ok: true; path: string; version: number } | { error: string; ok: false }> {
  const dir = input.kind === "clip" ? "clips" : "keyframes";
  const recordPath = `${dir}/${input.id}.md`;
  let raw: string;
  try {
    raw = await readWorkspaceFile(projectId, recordPath);
  } catch {
    return { error: `No existing ${input.kind} record "${input.id}" to revise.`, ok: false };
  }
  const parsed = parseJsonFrontmatter(raw);
  const versions = Array.isArray(parsed.meta.versions)
    ? (parsed.meta.versions as Array<{ version?: number }>)
    : [];
  const nextVersion =
    versions.reduce((max, entry) => Math.max(max, entry.version ?? 0), 0) + 1;
  const extension = input.kind === "clip" ? "mp4" : "png";
  const localPath = `media/${dir}/${input.id}.v${nextVersion}.${extension}`;

  const download = await fetch(input.url);
  if (!download.ok) {
    return { error: `Failed to download new version media (${download.status}).`, ok: false };
  }
  let bytes: Buffer = Buffer.from(await download.arrayBuffer());
  if (input.kind === "keyframe" && input.exactAspect) {
    bytes = await cropImageToAspect(bytes, input.exactAspect);
  }
  await writeWorkspaceBinaryFile(projectId, localPath, bytes);

  await writeWorkspaceFile(
    projectId,
    recordPath,
    withJsonFrontmatter(
      {
        ...parsed.meta,
        ...(input.metaPatch ?? {}),
        local_path: localPath,
        url: input.url,
        versions: [...versions, { local_path: localPath, url: input.url, version: nextVersion }],
      },
      input.note
        ? `${parsed.body.trimEnd()}\n\n## v${nextVersion}\n\n${input.note}\n`
        : parsed.body,
    ),
  );
  return { localPath, ok: true, path: recordPath, version: nextVersion };
}
