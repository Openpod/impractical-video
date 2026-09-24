import { NextResponse } from "next/server";
import {
  inspectAgentContextEntities,
  patchCurrentAgentContext,
  readCurrentAgentContext,
} from "@/lib/agent-context";
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
    const context = await readCurrentAgentContext(id);
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

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  try {
    await requireAgentContextProjectAccess(id);
    const context = await patchCurrentAgentContext(
      id,
      await request.json(),
    );
    return NextResponse.json(
      { context, staleEntities: await inspectAgentContextEntities(context) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return agentContextErrorResponse(error);
  }
}
