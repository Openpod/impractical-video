import { NextResponse } from "next/server";
import { createAgentTurnSnapshot } from "@/lib/agent-context";
import {
  agentContextErrorResponse,
  requireAgentContextProjectAccess,
} from "@/lib/agent-context/http";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  try {
    await requireAgentContextProjectAccess(id);
    const snapshot = await createAgentTurnSnapshot(id, await request.json());
    return NextResponse.json({ snapshot }, { status: 201 });
  } catch (error) {
    return agentContextErrorResponse(error);
  }
}
