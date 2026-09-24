import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import {
  getProjectSnapshot,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "@/lib/workspace";

// Mirrors the user's canvas organization (their hand-made groups) into the
// workspace so the agents can see it — user grouping is intent, and the
// agents should reason about it the same way they reason about frontmatter
// groups.

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) return NextResponse.json({ error: "Sign in." }, { status: 401 });
  await getProjectSnapshot(id, user.userId);

  const body = await request.json().catch(() => null);
  const groups = Array.isArray(body?.groups) ? body.groups : null;
  if (!groups) {
    return NextResponse.json({ error: "Expected { groups: [...] }." }, { status: 400 });
  }
  const sanitized = groups
    .filter(
      (group: unknown): group is { cardIds: string[]; id: string; title: string } =>
        Boolean(
          group &&
            typeof group === "object" &&
            typeof (group as { id?: unknown }).id === "string" &&
            Array.isArray((group as { cardIds?: unknown }).cardIds),
        ),
    )
    .map((group: { cardIds: string[]; id: string; title: string }) => ({
      cardIds: group.cardIds.filter((cardId: unknown) => typeof cardId === "string"),
      id: group.id,
      title: typeof group.title === "string" ? group.title : group.id,
    }));
  const existing = await readWorkspaceFile(id, "canvas/groups.json")
    .then((value) => JSON.parse(value) as { groups?: unknown })
    .catch(() => null);
  if (
    JSON.stringify(Array.isArray(existing?.groups) ? existing.groups : []) ===
    JSON.stringify(sanitized)
  ) {
    return NextResponse.json({ changed: false, ok: true });
  }
  await writeWorkspaceFile(
    id,
    "canvas/groups.json",
    JSON.stringify({ groups: sanitized, updatedAt: new Date().toISOString() }),
  );
  return NextResponse.json({ changed: true, ok: true });
}
