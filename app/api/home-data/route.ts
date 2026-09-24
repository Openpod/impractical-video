import { NextResponse } from "next/server";
import { buildHomePageData } from "@/app/home-data";
import { listActiveProjectIdsForUser } from "@/lib/agent-runs";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { listProjects } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await ensureCurrentAppUser();
  const projects = await listProjects(user?.userId);
  const [homeData, activeProjectIds] = await Promise.all([
    buildHomePageData(projects),
    listActiveProjectIdsForUser(user?.userId),
  ]);

  return NextResponse.json({
    ...homeData,
    projects: homeData.projects.map((project) => ({
      ...project,
      isWorking: activeProjectIds.has(project.id),
    })),
  });
}
