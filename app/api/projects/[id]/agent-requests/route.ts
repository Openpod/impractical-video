import { NextResponse } from "next/server";
import { requireAgentContextProjectAccess } from "@/lib/agent-context/http";
import {
  agentInteractionErrorPayload,
  listAgentInteractions,
} from "@/lib/agent-interactions";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  try {
    await requireAgentContextProjectAccess(id);
    return NextResponse.json(
      { requests: await listAgentInteractions(id) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const response = agentInteractionErrorPayload(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
