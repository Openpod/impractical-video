import { NextResponse } from "next/server";
import { readAgentPresence } from "@/lib/agent-presence";

/** Whether a Claude/Codex session is connected to this desktop app, per the
 * paper MCP server's heartbeat. Read by the title-bar connection indicator. */
export function GET() {
  return NextResponse.json(readAgentPresence());
}
