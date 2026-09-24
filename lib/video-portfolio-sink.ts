import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  listProjectFiles,
  safeRelativePath,
  writeWorkspaceBinaryFile,
  writeWorkspaceFile,
} from "@/lib/workspace";

/**
 * Output sink for the video-portfolio pipeline. Decouples "where extracted
 * references are written" from "where the video came from", so the same
 * extraction can target either a live project workspace (Supabase
 * project_files) or a local directory on disk.
 *
 * Local-dir is the default for Explore / `ai_video_entries` runs: a DB video is
 * not owned by any project, and a batch scan should not mutate live
 * `project_files` before review.
 */
export interface VideoPortfolioSink {
  /** Human label for the destination, used in logs/manifest. */
  readonly label: string;
  writeText(relativePath: string, content: string): Promise<void>;
  writeBinary(relativePath: string, content: Buffer): Promise<void>;
  /** Existing reference ids (from references/<category>/<id>/) to avoid collisions. */
  existingReferenceIds(): Promise<string[]>;
  /** Resolve a workspace-relative media path into a referenceable URL. */
  mediaUrl(mediaPath: string): string;
}

const REFERENCE_ID_PATTERN =
  /^references\/(?:characters|environments|props|styles)\/([^/]+)\/reference\.md$/;

function workspaceMediaUrl(projectId: string, mediaPath: string) {
  const clean = safeRelativePath(mediaPath).replace(/^media\//, "");
  return `/api/projects/${encodeURIComponent(projectId)}/media/${clean
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

/** Sink that writes into a live project workspace (Supabase project_files). */
export function createWorkspaceSink(projectId: string): VideoPortfolioSink {
  return {
    label: `workspace:${projectId}`,
    async writeText(relativePath, content) {
      await writeWorkspaceFile(projectId, relativePath, content);
    },
    async writeBinary(relativePath, content) {
      await writeWorkspaceBinaryFile(projectId, relativePath, content);
    },
    async existingReferenceIds() {
      const files = await listProjectFiles(projectId, false).catch(() => []);
      return files.flatMap((file) => {
        const match = file.path.match(REFERENCE_ID_PATTERN);
        return match?.[1] ? [match[1]] : [];
      });
    },
    mediaUrl(mediaPath) {
      return workspaceMediaUrl(projectId, mediaPath);
    },
  };
}

/**
 * Sink that writes the same tree (`references/`, `media/references/`,
 * `operations/`) to a local directory. Portfolio media is referenced by its
 * portable relative path rather than an app URL, so the output is reviewable
 * in isolation.
 */
export function createLocalDirSink(outDir: string): VideoPortfolioSink {
  const root = path.resolve(outDir);
  const resolve = (relativePath: string) => path.join(root, safeRelativePath(relativePath));
  return {
    label: `local:${root}`,
    async writeText(relativePath, content) {
      const target = resolve(relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    async writeBinary(relativePath, content) {
      const target = resolve(relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    async existingReferenceIds() {
      const ids: string[] = [];
      for (const category of ["characters", "environments", "props", "styles"]) {
        const dir = path.join(root, "references", category);
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.isDirectory()) ids.push(entry.name);
        }
      }
      return ids;
    },
    mediaUrl(mediaPath) {
      return safeRelativePath(mediaPath);
    },
  };
}
