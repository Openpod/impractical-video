import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { buildLineageIndex } from "@/lib/canvas-lineage";
import { getProjectSnapshot } from "@/lib/workspace";

// Dependency edges for the canvas arrow overlay. The graph is derived, never
// stored — buildLineageIndex recomputes it from the provenance frontmatter the
// artifacts already carry, so this stays correct without any extra bookkeeping.

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) return NextResponse.json({ error: "Sign in." }, { status: 401 });
  const snapshot = await getProjectSnapshot(id, user.userId);
  const index = buildLineageIndex(snapshot.files);
  // group_sibling is co-location, not a dependency — drawing it would turn the
  // overlay into a spiderweb across every storyboard row.
  const edges = index.edges
    .filter((edge) => edge.via !== "group_sibling")
    .map((edge) => ({ from: edge.from, to: edge.to, via: edge.via }));
  return NextResponse.json({ edges });
}
