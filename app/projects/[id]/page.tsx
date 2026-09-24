import { redirect } from "next/navigation";
import { ProjectWorkbench } from "@/app/projects/[id]/project-workbench";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { getProjectSnapshot } from "@/lib/workspace";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function ProjectPage({ params }: Props) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    redirect(`/sign-in?redirect_url=${encodeURIComponent(`/projects/${id}`)}`);
  }
  const snapshot = await getProjectSnapshot(id, user.userId);
  return (
    <main className="project-page-shell flex h-dvh flex-col overflow-hidden px-2 pb-2">
      <ProjectWorkbench initialSnapshot={snapshot} />
    </main>
  );
}
