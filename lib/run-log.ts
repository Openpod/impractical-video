import "server-only";

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Local chat-run timing drain. Writes a copy of each run's timing to a repo-local
 * `logs/chat-runs/` dir (always the local filesystem, even when the workspace is
 * Supabase-backed) so an agent can read run timing directly without querying the
 * database. Best-effort: failures never affect a run.
 */

const LOG_ROOT = path.join(process.cwd(), "logs", "chat-runs");

export type ToolTiming = {
  name: string;
  durationMs: number;
  ok: boolean | null;
  segment: number;
};

export type RunTiming = {
  runId: string;
  projectId: string;
  model: string;
  startedAt: string;
  endedAt: string;
  totalMs: number;
  timeToFirstTextMs: number | null;
  segments: number;
  status: "completed" | "paused" | "failed" | "cancelled";
  toolCount: number;
  tools: ToolTiming[];
  error?: string;
};

export async function writeRunTimingLocal(timing: RunTiming): Promise<void> {
  try {
    const dir = path.join(LOG_ROOT, timing.projectId);
    await mkdir(dir, { recursive: true });
    // Full per-run timing.
    await writeFile(path.join(dir, `${timing.runId}.json`), JSON.stringify(timing, null, 2), "utf8");
    // Rolling one-line summary for quick tailing (newest at the bottom).
    const summary = {
      at: timing.endedAt,
      projectId: timing.projectId,
      runId: timing.runId,
      status: timing.status,
      totalMs: timing.totalMs,
      ttftMs: timing.timeToFirstTextMs,
      segments: timing.segments,
      tools: timing.tools.map(
        (tool) => `${tool.name}:${tool.durationMs}ms${tool.ok === false ? "✗" : ""}`,
      ),
      ...(timing.error ? { error: timing.error } : {}),
    };
    await appendFile(path.join(LOG_ROOT, "latest.jsonl"), `${JSON.stringify(summary)}\n`, "utf8");
  } catch {
    // best-effort diagnostics
  }
}
