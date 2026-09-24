-- Video FS Agent — initial database schema
-- ---------------------------------------------------------------------------
-- Target: Supabase (Postgres). Run in the Supabase SQL editor or via migration.
-- THIS FILE IS NOT EXECUTED BY THE APP. It is the source-of-truth schema for
-- the storage layer that replaces the local `data/projects/<id>` filesystem
-- (see lib/workspace.ts) when this app is deployed.
--
-- Conventions (matched to impractical-chat's existing Supabase schema):
--   * Clerk user ids are stored as `user_id text` (NOT a uuid / NOT an FK).
--   * Primary keys are `uuid DEFAULT gen_random_uuid()` unless a natural key
--     fits better (project_files uses a composite natural key).
--   * Timestamps are `timestamptz DEFAULT now()`.
--   * Enumerations are enforced with CHECK constraints, not pg enums, so they
--     can evolve without migrations.
--
-- Design driver: the source-graph engine (lib/source-graph.ts) reads the WHOLE
-- file tree of a project on every lint/snapshot/agent turn. The local impl does
-- `listProjectFiles -> buildSourceGraph(files)`. The `project_files` table below
-- is shaped so the entire tree is one cheap indexed query:
--     SELECT path, content FROM project_files WHERE project_id = $1;
-- Binary media never lives in this table — only its metadata. Bytes live in
-- object storage (Supabase Storage), referenced by `storage_path` / `url`.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- USERS
-- Clerk owns authentication. We keep a thin app-side mirror row so we can join
-- project/credit data to a stable user_id and store app-local profile bits.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.app_users (
  user_id      text PRIMARY KEY CHECK (length(btrim(user_id)) > 0), -- Clerk user id
  email        text,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- CREDITS
-- Mirrors impractical-chat's credits model so a shared Supabase project stays
-- consistent and the billing UI/ledger semantics carry over unchanged.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.user_credits (
  id                    uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id               text NOT NULL UNIQUE,
  subscription_credits  integer NOT NULL DEFAULT 0,
  purchased_credits     integer NOT NULL DEFAULT 0,
  free_credits          integer NOT NULL DEFAULT 500,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now(),
  CONSTRAINT user_credits_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS user_credits_user_id_idx ON public.user_credits(user_id);

-- Append-only audit log of every credit change. Generation tools (image/video/
-- audio) write a 'usage' row keyed by tool_name; grants/purchases/refunds too.
CREATE TABLE IF NOT EXISTS public.credit_transactions (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id     text NOT NULL,
  amount      integer NOT NULL,                 -- positive = grant, negative = usage
  type        text NOT NULL,
  tool_name   text,                             -- e.g. generateKeyframe, generateClip
  project_id  uuid,                             -- optional attribution to a project
  description text,
  metadata    jsonb,
  created_at  timestamptz DEFAULT now(),
  CONSTRAINT credit_transactions_pkey PRIMARY KEY (id),
  CONSTRAINT credit_transactions_type_check
    CHECK (type IN ('grant', 'usage', 'purchase', 'subscription', 'refund', 'reset'))
);
CREATE INDEX IF NOT EXISTS credit_transactions_user_id_idx  ON public.credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS credit_transactions_created_at_idx ON public.credit_transactions(created_at);

-- ===========================================================================
-- PROJECTS
-- One row per video project. Replaces data/projects/<id>/ as the unit of
-- ownership. `id` is the project id used throughout the source graph.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.projects (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_user_id text NOT NULL CHECK (length(btrim(owner_user_id)) > 0),
  legacy_id     text UNIQUE, -- local filesystem id from pre-Supabase projects, e.g. untitled-video-3e9b0673
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'archived', 'deleted')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),  -- mirrors touchProject()
  CONSTRAINT projects_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS projects_owner_idx        ON public.projects(owner_user_id);
CREATE INDEX IF NOT EXISTS projects_owner_status_idx ON public.projects(owner_user_id, status);
CREATE INDEX IF NOT EXISTS projects_legacy_id_idx    ON public.projects(legacy_id);

-- ===========================================================================
-- PROJECT FILES  (the source-graph backing store)
-- Every markdown/JSON node in the workspace tree: references/*, scenes/*,
-- keyframes/*, clips/*, prompts/*, findings/*, assets/*.asset.md, timeline.json,
-- brief.md, operations/*. `content` is the full UTF-8 text (frontmatter + body).
--
-- Composite natural key (project_id, path) == a filesystem path. The whole-tree
-- read that feeds buildSourceGraph() is a single index scan on project_id.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.project_files (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  path       text NOT NULL CHECK (length(btrim(path)) > 0),  -- repo-relative, e.g. scenes/01-intro/scene.md
  content    text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_files_pkey PRIMARY KEY (project_id, path)
);
-- PK already indexes (project_id, path); this covers the whole-tree read.
CREATE INDEX IF NOT EXISTS project_files_project_idx ON public.project_files(project_id);

-- ===========================================================================
-- PROJECT MEDIA  (binary asset metadata; bytes live in object storage)
-- Generated/uploaded keyframes, clips, audio, portfolios. The markdown record
-- (assets/*.asset.md, *.keyframe.md, clip.md) stays in project_files and points
-- here via url; this table is the durable handle to the actual bytes.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.project_media (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'other'
                 CHECK (kind IN ('image', 'video', 'audio', 'other')),
  storage_path text,            -- key in the Supabase Storage bucket
  url          text,            -- public/signed URL (may be derived from storage_path)
  node_id      text,            -- optional: graph node id this media backs (keyframe/clip/portfolio/asset)
  mime_type    text,
  bytes        bigint,
  width        integer,
  height       integer,
  duration_s   double precision,
  metadata     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_media_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS project_media_project_idx ON public.project_media(project_id);
CREATE INDEX IF NOT EXISTS project_media_node_idx    ON public.project_media(project_id, node_id);

-- ===========================================================================
-- CHAT MESSAGES  (replaces data/projects/<id>/chat.json — readChat/appendChat)
-- One row per turn. Tool-call summaries are stored as jsonb to match the
-- ChatToolCall[] shape (name, ok, summary, durationMs).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user', 'assistant')),
  text       text NOT NULL DEFAULT '',
  tools      jsonb,            -- ChatToolCall[]
  run_id     uuid,             -- optional link to the agent_run that produced it
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS chat_messages_project_created_idx
  ON public.chat_messages(project_id, created_at);

-- ===========================================================================
-- AGENT RUNS  (durable chat-loop runs — powers resume + abort + diagnostics)
-- One row per triggered chat run. `trigger_run_id` is the Trigger.dev run id
-- the resume/abort routes operate on; `last_stream_index` lets a reconnecting
-- client resume mid-stream (streams.read(runId, { startIndex })).
-- Replaces the in-memory `activeRuns` Set and the runs/<id>.jsonl diagnostics.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.agent_runs (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id             text NOT NULL,
  trigger_run_id      text UNIQUE,           -- Trigger.dev run id
  assistant_message_id uuid,                 -- the streaming assistant message (idempotency key)
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
  last_stream_index   integer,               -- highest stream chunk index emitted
  error               text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,
  CONSTRAINT agent_runs_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS agent_runs_project_idx ON public.agent_runs(project_id);
CREATE INDEX IF NOT EXISTS agent_runs_user_idx    ON public.agent_runs(user_id);
CREATE INDEX IF NOT EXISTS agent_runs_trigger_idx ON public.agent_runs(trigger_run_id);

-- ===========================================================================
-- updated_at maintenance
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_users_set_updated_at   ON public.app_users;
CREATE TRIGGER app_users_set_updated_at   BEFORE UPDATE ON public.app_users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS projects_set_updated_at     ON public.projects;
CREATE TRIGGER projects_set_updated_at     BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS project_files_set_updated_at ON public.project_files;
CREATE TRIGGER project_files_set_updated_at BEFORE UPDATE ON public.project_files
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS user_credits_set_updated_at  ON public.user_credits;
CREATE TRIGGER user_credits_set_updated_at  BEFORE UPDATE ON public.user_credits
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===========================================================================
-- ROW LEVEL SECURITY (notes, not enabled here)
-- Supabase exposes Postgres directly to clients, so RLS matters IF the browser
-- ever queries these tables with the anon key. This app's plan is server-only
-- access via the service-role key (Clerk auth at the route/Trigger boundary),
-- in which case RLS is bypassed and the policies below are belt-and-suspenders.
-- Enable + add Clerk-JWT policies (auth.jwt()->>'sub' = user_id) before any
-- direct client-side querying.
-- ---------------------------------------------------------------------------
-- ALTER TABLE public.projects        ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.project_files   ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.project_media   ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.chat_messages   ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.agent_runs      ENABLE ROW LEVEL SECURITY;
-- (project_files/media/chat/runs join through projects.owner_user_id.)
