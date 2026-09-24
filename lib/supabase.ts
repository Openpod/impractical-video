import { createClient } from "@supabase/supabase-js";

/**
 * Supabase clients. Ported from impractical-chat and trimmed to this app's
 * needs. The deployed storage layer (see database/video_fs_initial_schema.sql)
 * is accessed server-side with the service-role key; the browser client exists
 * only for realtime subscriptions if/when we need them.
 *
 * Server-side client using the service-role key (for API routes / Trigger
 * tasks). Bypasses RLS — auth is enforced at the Clerk route boundary.
 */
export function createServerClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      "Missing Supabase environment variables. Check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

let browserSupabaseClient: ReturnType<typeof createClient> | null = null;

/** Browser-side client for realtime subscriptions (anon key). */
export function getBrowserSupabaseClient() {
  if (typeof window === "undefined") return null;
  if (browserSupabaseClient) return browserSupabaseClient;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  browserSupabaseClient = createClient(supabaseUrl, supabaseAnonKey);
  return browserSupabaseClient;
}
