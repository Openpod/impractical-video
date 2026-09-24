import { auth } from "@clerk/nextjs/server";
import { AppShell } from "@/app/app-shell";
import { isLocalAppMode } from "@/lib/app-mode";

export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const userId = isLocalAppMode() ? "local-desktop-user" : (await auth()).userId;
  return (
    <AppShell
      initialCharacters={[]}
      initialEnvironments={[]}
      initialProjects={[]}
      initialSignedIn={Boolean(userId)}
    >
      {children}
    </AppShell>
  );
}
