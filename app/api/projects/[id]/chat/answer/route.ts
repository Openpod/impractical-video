import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { resolveUserAnswer, type UserAnswer } from "@/lib/pending-questions";
import { getProjectSnapshot } from "@/lib/workspace";

// Delivers the user's answer to a blocked askUser tool call, letting the
// paused chat run continue.

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) return NextResponse.json({ error: "Sign in." }, { status: 401 });
  await getProjectSnapshot(id, user.userId);

  const body = await request.json().catch(() => null);
  const toolCallId = typeof body?.tool_call_id === "string" ? body.tool_call_id : null;
  if (!toolCallId) {
    return NextResponse.json({ error: "Expected { tool_call_id, answers }." }, { status: 400 });
  }
  const answer: UserAnswer = {
    answers: Array.isArray(body.answers)
      ? body.answers.filter(
          (entry: unknown): entry is UserAnswer["answers"][number] =>
            Boolean(entry && typeof entry === "object" && typeof (entry as { question?: unknown }).question === "string"),
        )
      : [],
    dismissed: body.dismissed === true,
  };
  const delivered = resolveUserAnswer(id, toolCallId, answer);
  if (!delivered) {
    return NextResponse.json(
      { error: "No pending question for that tool call (it may have timed out)." },
      { status: 410 },
    );
  }
  return NextResponse.json({ ok: true });
}
