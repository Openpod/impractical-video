import { ProjectList } from "@/app/project-list";

export default function ProjectsPage() {
  return (
    <div className="projects-page">
      <ProjectList initialProjects={[]} title="Projects" variant="projects" />
    </div>
  );
}
