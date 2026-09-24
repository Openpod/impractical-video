import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  ingestAgentContextAttachment,
  MAX_AGENT_CONTEXT_ATTACHMENT_BYTES,
} from "@/lib/agent-context";
import {
  agentContextErrorResponse,
  requireAgentContextProjectAccess,
} from "@/lib/agent-context/http";
import { publishAgentContextEvent } from "@/lib/agent-context/events";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ id: string }>;
};

function optionalNumber(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  try {
    await requireAgentContextProjectAccess(id);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        {
          code: "ATTACHMENT_INVALID",
          error: "Expected a multipart file field named `file`.",
        },
        { status: 400 },
      );
    }
    if (file.size <= 0 || file.size > MAX_AGENT_CONTEXT_ATTACHMENT_BYTES) {
      publishAgentContextEvent({
        attachmentId: `attempt_${randomUUID()}`,
        kind: "attachment.failed",
        projectId: id,
      });
      return NextResponse.json(
        {
          code: "ATTACHMENT_INVALID",
          error:
            file.size <= 0
              ? "The attachment is empty."
              : "The attachment exceeds the 64 MiB local-context limit.",
          maxBytes: MAX_AGENT_CONTEXT_ATTACHMENT_BYTES,
        },
        { status: file.size <= 0 ? 400 : 413 },
      );
    }
    const result = await ingestAgentContextAttachment({
      bytes: new Uint8Array(await file.arrayBuffer()),
      displayName: file.name,
      media: {
        durationSeconds: optionalNumber(form.get("durationSeconds")),
        height: optionalNumber(form.get("height")),
        width: optionalNumber(form.get("width")),
      },
      mimeType: file.type,
      projectId: id,
    });
    return NextResponse.json(result, { status: result.deduplicated ? 200 : 201 });
  } catch (error) {
    return agentContextErrorResponse(error);
  }
}
