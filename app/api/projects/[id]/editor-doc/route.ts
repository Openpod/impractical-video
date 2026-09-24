import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import {
  getProjectSnapshot,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "@/lib/workspace";

// The edit-document mirror: the in-process OpenCut editor pushes its
// serialized project (plus the host→editor media map) here, and the agent's
// editor tools read/write the same document. `source` + `revision` let the
// client know when an agent edit needs to be loaded back into the editor.

const EDITOR_DOC_PATH = "editor/opencut-project.json";

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) return NextResponse.json({ error: "Sign in." }, { status: 401 });
  await getProjectSnapshot(id, user.userId);
  try {
    const raw = await readWorkspaceFile(id, EDITOR_DOC_PATH);
    return new NextResponse(raw, {
      headers: { "content-type": "application/json" },
    });
  } catch {
    return NextResponse.json(null);
  }
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) return NextResponse.json({ error: "Sign in." }, { status: 401 });
  await getProjectSnapshot(id, user.userId);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || !body.project) {
    return NextResponse.json({ error: "Expected { project, mediaMap? }." }, { status: 400 });
  }
  let revision = 1;
  let existingHistory: unknown[] = [];
  let existingPending: unknown[] = [];
  try {
    const existing = JSON.parse(await readWorkspaceFile(id, EDITOR_DOC_PATH));
    if (typeof existing?.revision === "number") revision = existing.revision + 1;
    if (Array.isArray(existing?.commandHistory)) {
      existingHistory = existing.commandHistory;
    }
    if (Array.isArray(existing?.pendingPlacements)) existingPending = existing.pendingPlacements;
    // Compare-and-set against AGENT edits: a client push whose state does not
    // derive from the current agent revision would silently erase the agent's
    // work (the "agent says done, editor shows nothing" bug). Reject it — the
    // client's next pull applies the agent doc and pushes on top of it.
    if (
      existing?.source === "agent" &&
      typeof existing.revision === "number" &&
      body.baseRevision !== existing.revision
    ) {
      return NextResponse.json(
        {
          error: "Stale editor state — an agent edit landed after your last sync.",
          revision: existing.revision,
          stale: true,
        },
        { status: 409 },
      );
    }
  } catch {
    /* first write */
  }
  const doc = {
    commandHistory: existingHistory,
    mediaMap: body.mediaMap && typeof body.mediaMap === "object" ? body.mediaMap : {},
    // The client sends pendingPlacements when draining the queue; a push that
    // omits it must not wipe placements queued by the agent in the meantime.
    pendingPlacements: Array.isArray(body.pendingPlacements)
      ? body.pendingPlacements
      : existingPending,
    project: body.project,
    revision,
    source: "client",
    updatedAt: new Date().toISOString(),
  };
  await writeWorkspaceFile(id, EDITOR_DOC_PATH, JSON.stringify(doc));
  return NextResponse.json({ ok: true, revision });
}
