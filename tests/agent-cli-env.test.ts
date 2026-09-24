import { describe, expect, it } from "vitest";
import { userAgentCliEnv } from "@/lib/agent-cli-env";

describe("user agent CLI environment", () => {
  it("preserves the user environment while removing app runtime and provider credentials", () => {
    const environment = userAgentCliEnv({
      ANTHROPIC_API_KEY: "app-provider-key",
      FAL_KEY: "app-generation-key",
      OPENROUTER_API_KEY: "app-router-key",
      SUPABASE_SERVICE_ROLE_KEY: "app-database-key",
      STRIPE_SECRET_KEY: "app-billing-key",
      INTERNAL_API_SECRET: "app-internal-key",
      APP_MODE: "local",
      ELECTRON_RUN_AS_NODE: "1",
      HOME: "/Users/creator",
      NEXT_PUBLIC_APP_MODE: "local",
      NODE_ENV: "production",
      NODE_PATH: "/Applications/Video FS.app/server_modules",
      PAPER_MCP_TOKEN: "internal-bearer",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      PORT: "3210",
      VIDEO_FS_APP_URL: "http://127.0.0.1:3210",
      __NEXT_PRIVATE_ORIGIN: "http://127.0.0.1:3210",
    });

    expect(environment).toEqual({
      HOME: "/Users/creator",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    });
  });
});
