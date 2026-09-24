-- Video FS Agent — RLS baseline + storage notes
-- ---------------------------------------------------------------------------
-- Run AFTER database/video_fs_initial_schema.sql, against the dedicated
-- Supabase project (Openpod / video-fs-agent, ref yypkkinxshovindiawic).
--
-- POSTURE: deny-all to client keys; all app access is server-side via the
-- service-role key (which has BYPASSRLS). We intentionally add NO policies for
-- the anon/authenticated roles, so once RLS is enabled those roles can read and
-- write NOTHING. This is the safe baseline because NEXT_PUBLIC_SUPABASE_ANON_KEY
-- ships to the browser — without RLS the anon key could read/write every row.
--
-- Auth is Clerk, NOT Supabase Auth, so `auth.uid()` / `auth.jwt()->>'sub'`
-- policies do NOT work yet. Adding owner-scoped client policies REQUIRES wiring
-- Clerk as a Supabase third-party auth provider first. Until that exists, do not
-- grant any direct client access — keep everything behind server routes.
--
-- We use ENABLE (not FORCE) ROW LEVEL SECURITY: FORCE would also subject the
-- table owner/service paths to RLS. ENABLE leaves service-role's BYPASSRLS
-- intact, which is exactly what the server adapter relies on.
-- ---------------------------------------------------------------------------

ALTER TABLE public.app_users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_credits       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_files      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_media      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_runs         ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.app_users           FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.user_credits        FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.credit_transactions FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.projects            FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.project_files       FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.project_media       FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.chat_messages       FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.agent_runs          FROM anon, authenticated;

-- No CREATE POLICY statements by design — deny-all for anon/authenticated.
-- When Clerk→Supabase JWT is configured, owner policies would look like:
--
--   CREATE POLICY projects_owner_select ON public.projects
--     FOR SELECT TO authenticated
--     USING (owner_user_id = auth.jwt()->>'sub');
--
-- and child tables would join through projects.owner_user_id. Do NOT add these
-- until the JWT integration is live, or they will silently deny/allow wrongly.

-- ---------------------------------------------------------------------------
-- STORAGE (applied via the Storage API, documented here for the record):
--   * Bucket: "project-media", PRIVATE (public = false).
--   * Uploads: server-side only, via the service-role key.
--   * Reads: short-lived signed URLs minted server-side; no public read policy.
--   * storage.objects also has RLS enabled by Supabase default; with no client
--     policies, anon/authenticated cannot list/read/write — matching the table
--     posture above.
-- ---------------------------------------------------------------------------
