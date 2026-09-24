import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { isLocalAppMode } from "@/lib/app-mode";

// All routes are public by default — users can use the workbench without
// signing in. Auth unlocks persistence (projects, credits, durable runs).
// Mirrors the impractical-chat model: clerkMiddleware attaches auth state to
// every request, but does not force a redirect. Individual routes/Server
// Components decide what to gate by calling `auth()` and checking `userId`.
const hostedMiddleware = clerkMiddleware();

export default function middleware(request: NextRequest, event: NextFetchEvent) {
  if (isLocalAppMode()) {
    // Local mode has one trusted user. Reject network hosts (including DNS
    // rebinding) and browser writes from other origins before accessing disk.
    const host = request.headers.get("host") || new URL(request.url).host;
    let target: URL;
    try {
      target = new URL(`http://${host}`);
    } catch {
      return new NextResponse("Invalid local host.", { status: 403 });
    }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
      return new NextResponse("Local mode is available on loopback only.", { status: 403 });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.get("origin");
      if (origin) {
        try {
          if (new URL(origin).host !== target.host) throw new Error("Cross-origin write");
        } catch {
          return new NextResponse("Cross-origin local requests are not allowed.", { status: 403 });
        }
      }
      if (request.headers.get("sec-fetch-site") === "cross-site") {
        return new NextResponse("Cross-site local requests are not allowed.", { status: 403 });
      }
    }
    return NextResponse.next();
  }
  return hostedMiddleware(request, event);
}

export const config = {
  matcher: [
    // Skip Next internals and static files, unless found in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
