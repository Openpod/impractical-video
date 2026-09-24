import { NextResponse } from "next/server";
import { readAgentContextAttachment } from "@/lib/agent-context";
import {
  agentContextErrorResponse,
  requireAgentContextProjectAccess,
} from "@/lib/agent-context/http";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ attachmentId: string; id: string }>;
};

export async function GET(_request: Request, { params }: Params) {
  const { attachmentId, id } = await params;
  try {
    await requireAgentContextProjectAccess(id);
    return NextResponse.json(
      { manifest: await readAgentContextAttachment(id, attachmentId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return agentContextErrorResponse(error);
  }
}
