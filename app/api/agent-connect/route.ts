import { NextResponse } from "next/server";
import { z } from "zod";
import {
  agentConnectStatus,
  cancelAgentConnect,
  startAgentConnect,
} from "@/lib/agent-connect";
import { isLocalAppMode } from "@/lib/app-mode";

export const dynamic = "force-dynamic";

const agentSchema = z.enum(["claude", "codex"]);

function gated() {
  return isLocalAppMode(process.env)
    ? null
    : NextResponse.json(
        { error: "Agent connect is only available in the desktop app." },
        { status: 403 },
      );
}

/** Current connect/sign-in state for one agent. */
export async function GET(request: Request) {
  const denied = gated();
  if (denied) return denied;
  const agent = agentSchema.safeParse(
    new URL(request.url).searchParams.get("agent"),
  );
  if (!agent.success) {
    return NextResponse.json({ error: "Unknown agent." }, { status: 400 });
  }
  return NextResponse.json(await agentConnectStatus(agent.data));
}

/** Starts the quiet install + sign-in pilot for one agent. */
export async function POST(request: Request) {
  const denied = gated();
  if (denied) return denied;
  const parsed = z
    .object({ agent: agentSchema })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Unknown agent." }, { status: 400 });
  }
  return NextResponse.json(await startAgentConnect(parsed.data.agent));
}

/** Cancels an in-flight connect. */
export async function DELETE(request: Request) {
  const denied = gated();
  if (denied) return denied;
  const agent = agentSchema.safeParse(
    new URL(request.url).searchParams.get("agent"),
  );
  if (!agent.success) {
    return NextResponse.json({ error: "Unknown agent." }, { status: 400 });
  }
  return NextResponse.json({ cancelled: cancelAgentConnect(agent.data) });
}
