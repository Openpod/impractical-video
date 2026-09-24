import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { createProject, listProjects } from "@/lib/workspace";

export async function GET() {
  const user = await ensureCurrentAppUser();
  return NextResponse.json({ projects: await listProjects(user?.userId) });
}

export async function POST(request: Request) {
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to create projects." }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name : "Untitled video";
  const project = await createProject(name, user.userId);
  return NextResponse.json({ project });
}
