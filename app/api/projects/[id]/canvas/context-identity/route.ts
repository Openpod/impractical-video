import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureCurrentAppUser } from "@/lib/app-users";
import {
  CanvasContextIdentityError,
  canvasContextIdentityCandidateSchema,
  resolveCanvasContextIdentity,
  resolvedCanvasContextArtifactSchema,
  verifyCanvasContextIdentity,
} from "@/lib/canvas-context-identity";
import { getProjectSnapshot } from "@/lib/workspace";

type Params = {
  params: Promise<{ id: string }>;
};

const requestSchema = z.discriminatedUnion("mode", [
  z
    .object({
      artifacts: z.array(canvasContextIdentityCandidateSchema).max(400),
      mode: z.literal("resolve"),
    })
    .strict(),
  z
    .object({
      artifacts: z.array(resolvedCanvasContextArtifactSchema).max(400),
      mode: z.literal("verify"),
    })
    .strict(),
]);

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in." }, { status: 401 });
  }
  try {
    await getProjectSnapshot(id, user.userId);
  } catch (error) {
    // A queued context update can arrive just after the user deletes a project.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }
    throw error;
  }
  const parsed = requestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid Canvas context identity request." },
      { status: 400 },
    );
  }

  try {
    if (parsed.data.mode === "resolve") {
      return NextResponse.json({
        artifacts: await Promise.all(
          parsed.data.artifacts.map((artifact) =>
            resolveCanvasContextIdentity(id, artifact),
          ),
        ),
      });
    }
    const staleEntities = await verifyCanvasContextIdentity(
      id,
      parsed.data.artifacts,
    );
    return NextResponse.json(
      { ok: staleEntities.length === 0, staleEntities },
      { status: staleEntities.length ? 409 : 200 },
    );
  } catch (error) {
    if (error instanceof CanvasContextIdentityError) {
      return NextResponse.json(
        { code: error.code, error: error.message },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: "Canvas context identity could not be resolved." },
      { status: 500 },
    );
  }
}
