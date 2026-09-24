import { completeDesktopAuthAttempt } from "@/lib/desktop-auth-attempt";
import { isLocalAppMode } from "@/lib/app-mode";

export const dynamic = "force-dynamic";

function page(title: string, detail: string, ok: boolean, status = 200) {
  const color = ok ? "#ed1d24" : "#b42318";
  const escapeHtml = (value: string) =>
    value.replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    })[character] || character);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background-color:#ed1d24;background-image:radial-gradient(rgba(255,255,255,.35) 1px,transparent 1px),linear-gradient(168deg,#f8555c 0%,#ed1d24 52%,#c9151b 100%);background-size:18px 18px,100% 100%;color:#171717;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(400px,100%);padding:32px 30px;border-radius:18px;background:#fff;box-shadow:0 24px 70px rgba(80,4,6,.45)}.mark{display:inline-block;width:38px;height:38px;margin-bottom:22px;border-radius:12px;background:${color};box-shadow:inset 0 0 0 11px #fff;border:1px solid ${color}}h1{margin:0 0 8px;font-size:24px;letter-spacing:-.03em}p{margin:0;color:#68645e}</style></head><body><main class="card"><span class="mark"></span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`;
  return new Response(html, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "content-type": "text/html; charset=utf-8",
    },
    status,
  });
}

export async function GET(request: Request) {
  if (!isLocalAppMode()) return page("Not available", "Open this link from Video FS Desktop.", false, 404);
  const url = new URL(request.url);
  try {
    await completeDesktopAuthAttempt({
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
    });
    return page("You’re signed in", "Video FS will come forward automatically. You can close this tab.", true);
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : "Return to Video FS and try again.";
    return page("Sign-in didn’t finish", detail, false, 400);
  }
}
