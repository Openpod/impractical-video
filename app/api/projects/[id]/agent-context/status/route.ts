import { NextResponse } from "next/server";
import { readAgentContextStatus } from "@/lib/agent-context";
import { readAgentOnboardingStatus } from "@/lib/agent-onboarding-status";
import {
  agentContextErrorResponse,
  requireAgentContextProjectAccess,
} from "@/lib/agent-context/http";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  try {
    await requireAgentContextProjectAccess(id);
    const [context, setup] = await Promise.all([
      readAgentContextStatus(id),
      readAgentOnboardingStatus(id),
    ]);
    return NextResponse.json({ ...context, setup }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return agentContextErrorResponse(error);
  }
}
