import { auth, currentUser } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase";
import { ensureCreditAccount } from "@/lib/credits-service";
import { isLocalAppMode, LOCAL_APP_USER_ID } from "@/lib/app-mode";

export type CurrentAppUser = {
  email: string | null;
  name: string | null;
  userId: string;
};

function displayNameFor(user: Awaited<ReturnType<typeof currentUser>>) {
  if (!user) return null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.username || null;
}

async function upsertAppUser(user: CurrentAppUser) {
  const supabase = createServerClient();
  const { error } = await supabase.from("app_users").upsert(
    {
      display_name: user.name,
      email: user.email,
      user_id: user.userId,
    },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(`Failed to sync app user: ${error.message}`);
}

export async function ensureCurrentAppUser(): Promise<CurrentAppUser | null> {
  if (isLocalAppMode()) {
    return {
      email: null,
      name: "Local workspace",
      userId: LOCAL_APP_USER_ID,
    };
  }

  const { userId } = await auth();
  if (!userId) return null;

  const user = await currentUser().catch(() => null);
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const name = displayNameFor(user);

  await upsertAppUser({ email, name, userId });

  // Deterministic credit provisioning: first login gets a row with 150 free.
  await ensureCreditAccount(userId).catch(() => {});

  return { email, name, userId };
}
