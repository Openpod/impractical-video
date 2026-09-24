import { auth } from "@clerk/nextjs/server";
import { HomePageClient } from "@/app/home-page-client";
import { isLocalAppMode } from "@/lib/app-mode";

export default async function HomePage() {
  const userId = isLocalAppMode() ? "local-desktop-user" : (await auth()).userId;
  return <HomePageClient initialSignedIn={Boolean(userId)} />;
}
