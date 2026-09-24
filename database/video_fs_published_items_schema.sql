-- Video FS Agent — published items (Explore / Featured library)
-- ---------------------------------------------------------------------------
-- A published item is an IMMUTABLE snapshot of a slice of the source graph
-- (a character, environment, clip, video, template) that other users can
-- discover and "Use in project". The snapshot mirrors project_files /
-- project_media so the existing source-graph engine reads it unchanged.
--
-- Extensibility: new concept types are new `kind` VALUES, not new tables.
-- New interactions are new `interactions.kind` VALUES, not new tables.
--
-- Visibility / access: these tables stay deny-all to client keys like the rest
-- of the app; the public Explore gallery is served server-side (service-role)
-- filtering visibility='public'/'featured'. The only truly public surface is
-- the published-media storage bucket (created public), so a browser can load
-- preview images/video on the gallery without signed URLs.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- PUBLISHED ITEMS — one row per discoverable thing.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.published_items (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  kind             text NOT NULL,              -- character|environment|clip|video|template|... (open by design)
  publisher_id     text NOT NULL REFERENCES public.app_users(user_id),
  source_project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL, -- snapshot is independent of the source
  source_node_id   text,                       -- graph node id that was published (e.g. character_founder)
  title            text NOT NULL,
  description      text,
  visibility       text NOT NULL DEFAULT 'draft'
                     CHECK (visibility IN ('draft','unlisted','public','featured','hidden')),
  tags             text[] NOT NULL DEFAULT '{}',
  metadata         jsonb,                      -- type-specific details (the extensibility lever)
  like_count       integer NOT NULL DEFAULT 0, -- denormalized; kept in sync by trigger below
  use_count        integer NOT NULL DEFAULT 0, -- denormalized; kept in sync by trigger below
  view_count       bigint  NOT NULL DEFAULT 0, -- fire-and-forget; NOT backed by interaction rows (volume)
  featured_rank    integer,                    -- null = not curated; lower = higher on Featured shelves
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT published_items_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS published_items_kind_vis_idx   ON public.published_items(kind, visibility);
CREATE INDEX IF NOT EXISTS published_items_publisher_idx  ON public.published_items(publisher_id);
CREATE INDEX IF NOT EXISTS published_items_featured_idx   ON public.published_items(featured_rank) WHERE featured_rank IS NOT NULL;
CREATE INDEX IF NOT EXISTS published_items_tags_idx       ON public.published_items USING gin(tags);

-- ===========================================================================
-- PUBLISHED ITEM FILES — frozen source-graph slice (mirrors project_files).
-- Read with buildSourceGraph() exactly like a project tree.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.published_item_files (
  item_id uuid NOT NULL REFERENCES public.published_items(id) ON DELETE CASCADE,
  path    text NOT NULL CHECK (length(btrim(path)) > 0),
  content text NOT NULL DEFAULT '',
  CONSTRAINT published_item_files_pkey PRIMARY KEY (item_id, path)
);

-- ===========================================================================
-- PUBLISHED ITEM MEDIA — preview + importable media (mirrors project_media).
-- Bytes live in the PUBLIC published-media bucket.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.published_item_media (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id      uuid NOT NULL REFERENCES public.published_items(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'asset'   -- display|poster|thumbnail|preview|asset
                 CHECK (role IN ('display','poster','thumbnail','preview','asset')),
  kind         text NOT NULL DEFAULT 'image' CHECK (kind IN ('image','video','audio','other')),
  storage_path text,
  url          text,
  node_id      text,
  mime_type    text,
  bytes        bigint,
  width        integer,
  height       integer,
  duration_s   double precision,
  metadata     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT published_item_media_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS published_item_media_item_idx ON public.published_item_media(item_id);
CREATE UNIQUE INDEX IF NOT EXISTS published_item_media_one_display_per_item
  ON public.published_item_media(item_id)
  WHERE role = 'display';

-- ===========================================================================
-- PUBLISHED ITEM INTERACTIONS — ONE generic table for all interaction kinds.
--   like/save  -> idempotent toggle, one per (item,user) via partial unique idx
--   use/remix  -> append-only events (same item used in N projects = N rows)
--   report     -> append-only moderation signal
-- Passive VIEWS are intentionally NOT stored here (volume) — bump view_count.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.published_item_interactions (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id           uuid NOT NULL REFERENCES public.published_items(id) ON DELETE CASCADE,
  user_id           text,  -- nullable so anonymous interactions are possible later
  kind              text NOT NULL CHECK (kind IN ('like','save','use','remix','report')),
  target_project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL, -- for use/remix: where it landed
  metadata          jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT published_item_interactions_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS published_item_interactions_item_kind_idx
  ON public.published_item_interactions(item_id, kind);
-- Toggle semantics for like/save only; use/remix/report stay append-only.
CREATE UNIQUE INDEX IF NOT EXISTS published_item_interactions_toggle_uniq
  ON public.published_item_interactions(item_id, user_id, kind)
  WHERE kind IN ('like','save');

-- ===========================================================================
-- Counter integrity via trigger (cannot drift like app-side increments).
-- like -> like_count, use -> use_count. Others (save/remix/report) are not
-- surfaced as headline counts; query the interactions table on demand.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.bump_published_item_counts()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delta int; k text; item uuid;
BEGIN
  IF (TG_OP = 'INSERT') THEN delta := 1;  k := NEW.kind; item := NEW.item_id;
  ELSE                       delta := -1; k := OLD.kind; item := OLD.item_id;
  END IF;
  IF k = 'like' THEN
    UPDATE public.published_items SET like_count = GREATEST(0, like_count + delta) WHERE id = item;
  ELSIF k = 'use' THEN
    UPDATE public.published_items SET use_count = GREATEST(0, use_count + delta) WHERE id = item;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS published_item_interactions_counts ON public.published_item_interactions;
CREATE TRIGGER published_item_interactions_counts
  AFTER INSERT OR DELETE ON public.published_item_interactions
  FOR EACH ROW EXECUTE FUNCTION public.bump_published_item_counts();

-- updated_at touch on published_items (set_updated_at() from initial schema).
DROP TRIGGER IF EXISTS published_items_set_updated_at ON public.published_items;
CREATE TRIGGER published_items_set_updated_at BEFORE UPDATE ON public.published_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===========================================================================
-- Security: deny-all to client keys (consistent with the rest of the app).
-- Public Explore reads are served server-side with the service-role key,
-- filtering visibility IN ('public','featured'). Public media is the bucket.
-- ===========================================================================
ALTER TABLE public.published_items              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.published_item_files         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.published_item_media         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.published_item_interactions  ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.published_items             FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.published_item_files        FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.published_item_media        FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.published_item_interactions FROM anon, authenticated;
