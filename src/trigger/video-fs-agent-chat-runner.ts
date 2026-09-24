export type VideoFsAgentChatStreamRequest = {
  body: unknown;
  projectId: string;
  requestCookieHeader?: string | null;
  requestUrl: string;
  signal?: AbortSignal;
  triggerRunId?: string | null;
  userId: string;
};

function projectChatUrl(requestUrl: string, projectId: string) {
  const url = new URL(requestUrl);
  url.pathname = `/api/projects/${encodeURIComponent(projectId)}/chat`;
  url.search = "";
  return url;
}

/**
 * Transitional bridge: Trigger owns the durable run + resumable stream, while
 * the existing Next route still owns the agent loop. The later production
 * refactor should move the loop itself into this runner so abort cancels model
 * and generation work directly instead of only cancelling the bridge request.
 */
export async function runVideoFsAgentChatStreamRequest({
  body,
  projectId,
  requestCookieHeader,
  requestUrl,
  signal,
  triggerRunId,
  userId,
}: VideoFsAgentChatStreamRequest): Promise<Response> {
  const url = projectChatUrl(requestUrl, projectId);
  return fetch(url, {
    body: JSON.stringify({
      ...(body && typeof body === "object" && !Array.isArray(body) ? body : {}),
      triggerRunId,
      triggerUserId: userId,
    }),
    headers: {
      "content-type": "application/json",
      ...(process.env.INTERNAL_API_SECRET
        ? { "x-internal-secret": process.env.INTERNAL_API_SECRET }
        : {}),
      ...(requestCookieHeader ? { cookie: requestCookieHeader } : {}),
    },
    method: "POST",
    signal,
  });
}
