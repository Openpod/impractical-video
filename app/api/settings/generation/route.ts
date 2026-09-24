import { getGenerationMode, saveGenerationMode } from "@/lib/local-generation-mode";
import { localSettingsGuard } from "@/lib/local-settings-request";
import { hasDesktopCloudSession } from "@/lib/desktop-cloud";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = localSettingsGuard(request);
  if (denied) return denied;
  try {
    return Response.json({ mode: await getGenerationMode(), connected: hasDesktopCloudSession() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Choose your generation option again to restore setup." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const denied = localSettingsGuard(request);
  if (denied) return denied;
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return Response.json({ error: "Expected JSON." }, { status: 415 });
  const body = await request.json().catch(() => null);
  if (body?.mode !== "fal" && body?.mode !== "credits") return Response.json({ error: "Choose a fal key or Video FS credits." }, { status: 400 });
  try {
    await saveGenerationMode(body.mode);
    return Response.json({ mode: body.mode }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not save your generation preference." }, { status: 500 });
  }
}
