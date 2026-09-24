import { currentUser } from "@clerk/nextjs/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import { isLocalAppMode } from "@/lib/app-mode";
import { cloneCloudResponse, desktopCloudFetch } from "@/lib/desktop-cloud";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isLocalAppMode()) {
    try {
      return cloneCloudResponse(await desktopCloudFetch("/api/desktop/account"));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Sign in to load your account.";
      return Response.json({ error: message }, { status: 401 });
    }
  }

  const appUser = await ensureCurrentAppUser();
  if (!appUser) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const clerkUser = await currentUser().catch(() => null);
  const createdAtValue = clerkUser?.createdAt;
  const createdAt =
    typeof createdAtValue === "number"
      ? new Date(createdAtValue).toISOString()
      : null;
  const fullName = clerkUser
    ? [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ").trim() || appUser.name
    : appUser.name;

  return Response.json({
    user: {
      createdAt,
      email: appUser.email,
      firstName: clerkUser?.firstName ?? null,
      fullName,
      id: appUser.userId,
      imageUrl: clerkUser?.imageUrl ?? null,
      username: clerkUser?.username ?? null,
    },
  });
}
