import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AgentContextError, toAgentContextError } from "@/lib/agent-context/errors";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { getProjectSnapshot } from "@/lib/workspace";

export async function requireAgentContextProjectAccess(projectId: string) {
  const user = await ensureCurrentAppUser();
  if (!user) {
    throw new AgentContextError(
      "PROJECT_ACCESS_DENIED",
      "Sign in to access this project.",
      401,
    );
  }
  await getProjectSnapshot(projectId, user.userId).catch((error) => {
    if (error instanceof AgentContextError) throw error;
    throw new AgentContextError(
      "PROJECT_NOT_FOUND",
      "The requested project does not exist.",
      404,
    );
  });
  return user;
}

export function agentContextErrorResponse(error: unknown) {
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        code: "AGENT_CONTEXT_INVALID",
        error: "Invalid agent-context request.",
        issues: error.issues.map((issue) => ({
          message: issue.message,
          path: issue.path,
        })),
      },
      { status: 400 },
    );
  }
  const contextError = toAgentContextError(error);
  return NextResponse.json(
    {
      code: contextError.code,
      error: contextError.message,
      ...contextError.details,
    },
    { status: contextError.status },
  );
}
