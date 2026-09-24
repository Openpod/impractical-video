// In-process rendezvous for the chat agent's askUser tool: the tool's
// execute() blocks on a promise keyed by toolCallId; the answer endpoint
// resolves it with the user's choices and the SAME run continues with the
// answer as the tool result. (Single-process by design — the run and the
// answer POST share the server. A multi-instance deploy would need a
// datastore + polling here.)

export type UserAnswer = {
  answers: Array<{
    custom_text?: string | null;
    question: string;
    selected?: string | string[] | null;
    /** Canvas tile ids of files the user uploaded as (part of) this answer. */
    uploaded_ids?: string[] | null;
  }>;
  dismissed?: boolean;
};

type Pending = {
  createdAt: number;
  projectId: string;
  resolve: (answer: UserAnswer) => void;
};

const globalStore = globalThis as unknown as {
  __pendingUserQuestions?: Map<string, Pending>;
};

function store() {
  globalStore.__pendingUserQuestions ??= new Map();
  return globalStore.__pendingUserQuestions;
}

export const ASK_USER_TIMEOUT_MS = 15 * 60 * 1000;

export function waitForUserAnswer(
  projectId: string,
  toolCallId: string,
): Promise<UserAnswer | { timed_out: true }> {
  return new Promise((resolve) => {
    const key = `${projectId}:${toolCallId}`;
    const timer = setTimeout(() => {
      store().delete(key);
      resolve({ timed_out: true });
    }, ASK_USER_TIMEOUT_MS);
    store().set(key, {
      createdAt: Date.now(),
      projectId,
      resolve: (answer) => {
        clearTimeout(timer);
        store().delete(key);
        resolve(answer);
      },
    });
  });
}

export function resolveUserAnswer(
  projectId: string,
  toolCallId: string,
  answer: UserAnswer,
): boolean {
  const key = `${projectId}:${toolCallId}`;
  const pending = store().get(key);
  if (!pending) return false;
  pending.resolve(answer);
  return true;
}
