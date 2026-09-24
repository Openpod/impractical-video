/**
 * Environment for spawning user-owned agent CLIs (Claude Code, Codex).
 *
 * The CLIs must authenticate as the user — their own keychain login and
 * subscription — never as the app server. An inherited ANTHROPIC_API_KEY
 * outranks the CLI's stored login and silently rebills every session to the
 * app's Console org, so the server's provider credentials are stripped
 * before the child process is created. Electron/Next runtime variables are
 * also app-private: in particular, leaking ELECTRON_RUN_AS_NODE makes the
 * packaged Video FS MCP executable start in Node mode and close immediately.
 */
const APP_RUNTIME_ENV = new Set([
  "APP_MODE",
  "ELECTRON_RUN_AS_NODE",
  "HOSTNAME",
  "NEXT_DEPLOYMENT_ID",
  "NODE_ENV",
  "NODE_PATH",
  "PAPER_MCP_TOKEN",
  "PORT",
  "TURBOPACK",
]);

export function userAgentCliEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(env)) {
    if (
      key === "ANTHROPIC_API_KEY" ||
      key === "ANTHROPIC_AUTH_TOKEN" ||
      key === "ANTHROPIC_BASE_URL" ||
      key === "OPENAI_API_KEY" ||
      /^(?:FAL_|OPENROUTER_|STRIPE_|SUPABASE_|CLERK_|TRIGGER_|INTERNAL_API_|FFMPEG_AWS_|REMOTION_AWS_)/.test(key) ||
      key.startsWith("VIDEO_FS_") ||
      key.startsWith("NEXT_PUBLIC_") ||
      key.startsWith("__NEXT_PRIVATE_") ||
      APP_RUNTIME_ENV.has(key)
    ) {
      delete env[key];
    }
  }
  return env;
}
