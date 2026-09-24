import { streams, task } from "@trigger.dev/sdk";
import { VIDEO_FS_AGENT_CHAT_TASK_ID } from "@/lib/video-fs-agent-chat-task";
import { runVideoFsAgentChatStreamRequest } from "@/src/trigger/video-fs-agent-chat-runner";

export type VideoFsAgentChatTaskPayload = {
  body: unknown;
  projectId: string;
  requestCookieHeader?: string | null;
  requestUrl: string;
  userId: string;
};

export const videoFsAgentChatTask = task({
  id: VIDEO_FS_AGENT_CHAT_TASK_ID,
  machine: {
    preset: "small-1x",
  },
  maxDuration: 36000,
  run: async (payload: VideoFsAgentChatTaskPayload, { signal, ctx }) => {
    const triggerRunId =
      typeof ctx?.run?.id === "string" && ctx.run.id.trim()
        ? ctx.run.id.trim()
        : null;
    const response = await runVideoFsAgentChatStreamRequest({
      body: payload.body,
      projectId: payload.projectId,
      requestCookieHeader: payload.requestCookieHeader,
      requestUrl: payload.requestUrl,
      signal,
      triggerRunId,
      userId: payload.userId,
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => "");
      const message = errorText.trim() || `Chat stream failed (${response.status}).`;
      await streams.append(JSON.stringify({ type: "error", error: message }));
      return { ok: false as const, error: message };
    }

    const textStream = response.body.pipeThrough(new TextDecoderStream());
    const { waitUntilComplete } = streams.pipe(textStream);
    await waitUntilComplete();
    return { ok: true as const };
  },
});
