import "server-only";

import { createServerClient } from "@/lib/supabase";
import { resolveSupabaseProjectId } from "@/lib/workspace";
import { isLocalAppMode } from "@/lib/app-mode";

/**
 * agent_runs lifecycle — the durable record that ties a Trigger run to a project
 * + the assistant message it produces. Its `status` is the reconnect-discovery
 * flag (a cold client finds a `running` run and resumes its stream); best-effort
 * so a write failure never breaks a run.
 */

export type AgentRunStatus = "queued" | "running" | "completed" | "cancelled" | "failed";

export type ActiveRun = {
  triggerRunId: string;
  assistantMessageId: string | null;
  status: AgentRunStatus;
};

function disabled() {
  return isLocalAppMode() || Boolean(process.env.VIDEO_FS_DATA_ROOT);
}

export async function createAgentRun(input: {
  legacyProjectId: string;
  userId: string;
  triggerRunId: string;
  assistantMessageId?: string | null;
}): Promise<void> {
  if (disabled()) return;
  try {
    const supabase = createServerClient();
    const projectId = await resolveSupabaseProjectId(input.legacyProjectId, input.userId);
    await supabase.from("agent_runs").insert({
      project_id: projectId,
      user_id: input.userId,
      trigger_run_id: input.triggerRunId,
      assistant_message_id: input.assistantMessageId ?? null,
      status: "queued",
    });
  } catch {
    // best-effort
  }
}

export async function setAgentRunStatus(
  triggerRunId: string,
  status: AgentRunStatus,
  extra?: { error?: string | null; lastStreamIndex?: number },
): Promise<void> {
  if (disabled() || !triggerRunId) return;
  try {
    const supabase = createServerClient();
    const patch: Record<string, unknown> = { status };
    if (extra?.error) patch.error = extra.error;
    if (typeof extra?.lastStreamIndex === "number") patch.last_stream_index = extra.lastStreamIndex;
    if (status === "completed" || status === "failed" || status === "cancelled") {
      patch.ended_at = new Date().toISOString();
    }
    await supabase.from("agent_runs").update(patch).eq("trigger_run_id", triggerRunId);
  } catch {
    // best-effort
  }
}

export async function isAgentRunCancelled(triggerRunId?: string | null): Promise<boolean> {
  if (disabled() || !triggerRunId) return false;
  try {
    const supabase = createServerClient();
    const { data } = await supabase
      .from("agent_runs")
      .select("status")
      .eq("trigger_run_id", triggerRunId)
      .maybeSingle();
    return data?.status === "cancelled";
  } catch {
    return false;
  }
}

export async function listActiveProjectIdsForUser(userId?: string | null): Promise<Set<string>> {
  if (disabled() || !userId) return new Set();
  try {
    const supabase = createServerClient();
    const { data } = await supabase
      .from("agent_runs")
      .select("project_id")
      .eq("user_id", userId)
      .in("status", ["queued", "running"]);

    return new Set(
      (data ?? [])
        .map((row) => (typeof row.project_id === "string" ? row.project_id : null))
        .filter((projectId): projectId is string => Boolean(projectId)),
    );
  } catch {
    return new Set();
  }
}

/** The run a returning client should reconnect to, if any. */
export async function getActiveRunForProject(
  legacyProjectId: string,
  userId: string,
): Promise<ActiveRun | null> {
  if (disabled()) return null;
  try {
    const supabase = createServerClient();
    const projectId = await resolveSupabaseProjectId(legacyProjectId, userId);
    const { data } = await supabase
      .from("agent_runs")
      .select("trigger_run_id, assistant_message_id, status")
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .in("status", ["queued", "running"])
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data?.trigger_run_id) return null;
    return {
      triggerRunId: data.trigger_run_id as string,
      assistantMessageId: (data.assistant_message_id as string | null) ?? null,
      status: data.status as AgentRunStatus,
    };
  } catch {
    return null;
  }
}
