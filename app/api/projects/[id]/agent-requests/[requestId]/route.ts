import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAgentContextProjectAccess } from "@/lib/agent-context/http";
import {
  agentInteractionErrorPayload,
  resolveAgentInteraction,
} from "@/lib/agent-interactions";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ id: string; requestId: string }>;
};

const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean()]);
const resolutionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      answer: z
        .object({
          choiceId: z.string().min(1).max(80).nullable().optional(),
          value: scalar,
        })
        .strict(),
      kind: z.literal("input"),
    })
    .strict(),
  z
    .object({
      decision: z
        .object({
          approved: z.boolean(),
          note: z.string().min(1).max(500).nullable().optional(),
        })
        .strict(),
      kind: z.literal("approval"),
    })
    .strict(),
]);

export async function POST(request: Request, { params }: Params) {
  const { id, requestId } = await params;
  try {
    await requireAgentContextProjectAccess(id);
    const resolution = resolutionSchema.parse(await request.json());
    return NextResponse.json({
      request: await resolveAgentInteraction(id, requestId, resolution),
    });
  } catch (error) {
    const response = agentInteractionErrorPayload(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
