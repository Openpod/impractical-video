import { NextResponse } from "next/server";
import {
  inspectAgentContextEntities,
  readAgentContextRevision,
} from "@/lib/agent-context";
import {
  agentContextErrorResponse,
  requireAgentContextProjectAccess,
} from "@/lib/agent-context/http";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ id: string; revision: string }>;
};

export async function GET(_request: Request, { params }: Params) {
  const { id, revision: rawRevision } = await params;
  try {
    await requireAgentContextProjectAccess(id);
    const revision = Number(rawRevision);
    const context = await readAgentContextRevision(id, revision);
    return NextResponse.json(
      {
        context,
        staleEntities: await inspectAgentContextEntities(context),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return agentContextErrorResponse(error);
  }
}
