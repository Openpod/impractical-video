import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { isLocalAppMode } from "@/lib/app-mode";
import {
  COMPANION_MODELS,
  normalizeCompanionModel,
} from "@/lib/companion-contract";
import {
  companionCapabilities,
  companionState,
  sendCompanionMessage,
  stopCompanionSession,
} from "@/lib/companion-session";
import { getProjectSnapshot } from "@/lib/workspace";
import { isWorkflowLookupError } from "@/lib/workflows";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Companion chat state + transcript for the floating window's first paint. */
export async function GET(_request: Request, { params }: Params) {
  if (!isLocalAppMode(process.env)) {
    return NextResponse.json(
      { error: "The companion chat is desktop-only." },
      { status: 404 },
    );
  }
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to use Companion." }, { status: 401 });
  }
  await getProjectSnapshot(id, user.userId);
  return NextResponse.json({
    ...(await companionState(id)),
    ...(await companionCapabilities()),
  });
}

const attachmentSchema = z.object({
  data: z.string().min(1).max(35_000_000),
  name: z.string().trim().min(1).max(255),
  type: z.string().trim().max(160).default("application/octet-stream"),
});

const referenceSchema = z.object({
  id: z.string().trim().min(1).max(200),
  path: z.string().trim().min(1).max(500),
});

const messageSchema = z.object({
  attachments: z.array(attachmentSchema).max(10).default([]),
  model: z.string().trim().min(1).max(80),
  references: z.array(referenceSchema).max(20).default([]),
  text: z.string().trim().min(1).max(20000),
  workflowId: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).nullable().optional(),
});

/** Sends one user message into the project's persistent Claude session,
 * spawning it on first use. */
export async function POST(request: Request, { params }: Params) {
  if (!isLocalAppMode(process.env)) {
    return NextResponse.json(
      { error: "The companion chat is desktop-only." },
      { status: 404 },
    );
  }
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to use Companion." }, { status: 401 });
  }
  await getProjectSnapshot(id, user.userId);
  const parsed = messageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A message, supported model, and valid attachments are required." },
      { status: 400 },
    );
  }
  try {
    const result = await sendCompanionMessage(id, parsed.data);
    return NextResponse.json({ accepted: true, sessionId: result.sessionId });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The companion session could not start.",
      },
      { status: isWorkflowLookupError(error) ? 400 : 502 },
    );
  }
}

/** Stops the project's companion session. */
export async function DELETE(_request: Request, { params }: Params) {
  if (!isLocalAppMode(process.env)) {
    return NextResponse.json(
      { error: "The companion chat is desktop-only." },
      { status: 404 },
    );
  }
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to use Companion." }, { status: 401 });
  }
  await getProjectSnapshot(id, user.userId);
  return NextResponse.json({ stopped: stopCompanionSession(id) });
}
