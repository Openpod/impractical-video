import { localSettingsGuard as guard } from "@/lib/local-settings-request";
import { saveGenerationMode } from "@/lib/local-generation-mode";
import { getFalKeyStatus, removeFalKey, saveFalKey, validFalKey } from "@/lib/local-provider-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  try {
    return json(await getFalKeyStatus());
  } catch {
    return json({ error: "Could not read API settings. Try replacing or removing the saved key." }, 500);
  }
}

export async function PUT(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    return json({ error: "Expected JSON." }, 415);
  }
  const body = await request.json().catch(() => null);
  if (!validFalKey(body?.falKey)) {
    return json({ error: "Paste the complete fal.ai key without spaces or quotes." }, 400);
  }
  try {
    await saveFalKey(body.falKey);
    await saveGenerationMode("fal");
    return json(await getFalKeyStatus());
  } catch {
    return json({ error: "Could not save the API key. Check that the local settings directory is writable." }, 500);
  }
}

export async function DELETE(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  try {
    await removeFalKey();
    return json(await getFalKeyStatus());
  } catch {
    return json({ error: "Could not remove the saved API key. Check the local settings directory permissions." }, 500);
  }
}
