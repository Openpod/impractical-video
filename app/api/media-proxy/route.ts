const ALLOWED_HOSTS = [
  "cdn.lumiying.com",
  "cdn.seedance-v2.app",
  "cms-assets.youmind.com",
  "pbs.twimg.com",
];
const ALLOWED_HOST_SUFFIXES = [".fal.media", ".fal.ai", ".fal.run"];

function isAllowed(url: URL) {
  return (
    url.protocol === "https:" &&
    (ALLOWED_HOSTS.includes(url.hostname) ||
      ALLOWED_HOST_SUFFIXES.some(
        (suffix) =>
          url.hostname.endsWith(suffix) || url.hostname === suffix.slice(1),
      ))
  );
}

/**
 * Same-origin passthrough for generated media so the WebCodecs player can
 * fetch+demux clip bytes regardless of the CDN's CORS policy. Host-allowlisted
 * to generation providers only.
 */
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("url");
  if (!raw) return new Response("Missing url.", { status: 400 });
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new Response("Invalid url.", { status: 400 });
  }
  if (!isAllowed(target)) {
    return new Response("Host not allowed.", { status: 403 });
  }
  const upstream = await fetch(target, {
    headers: { accept: "video/*,image/*,audio/*,*/*" },
  });
  if (!upstream.ok || !upstream.body) {
    return new Response(`Upstream ${upstream.status}.`, { status: 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "public, max-age=86400, immutable",
    },
  });
}
