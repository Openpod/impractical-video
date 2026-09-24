import { NextResponse } from "next/server";
import { readAgentTurnSnapshot } from "@/lib/agent-context";
import {
  agentContextErrorResponse,
  requireAgentContextProjectAccess,
} from "@/lib/agent-context/http";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ id: string; snapshotId: string }>;
};

export async function GET(_request: Request, { params }: Params) {
  const { id, snapshotId } = await params;
  try {
    await requireAgentContextProjectAccess(id);
    return NextResponse.json(
      { snapshot: await readAgentTurnSnapshot(id, snapshotId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return agentContextErrorResponse(error);
  }
}
