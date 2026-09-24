import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { deleteProject, getProjectSnapshot } from "@/lib/workspace";

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to view this project." }, { status: 401 });
  }
  return NextResponse.json(await getProjectSnapshot(id, user.userId));
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to delete this project." }, { status: 401 });
  }
  return NextResponse.json({ deleted: await deleteProject(id, user.userId) });
}
