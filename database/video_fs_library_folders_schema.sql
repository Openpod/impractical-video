-- Video FS Agent — library folders (per-user organizational tree over assets)
-- ---------------------------------------------------------------------------
-- The Library lets a user organize their OWN published_items (characters,
-- objects, environments, styles) into a nestable folder tree. Folders are a
-- first-class concept that lives ALONGSIDE published_items — published_items is
-- intentionally left untouched so Explore / publishing never need to know
-- folders exist.
--
--   library_folders            -> the nestable tree (parent_folder_id self-ref)
--   library_item_placements    -> which folder an item sits in (<= 1 folder).
--                                 No placement row == the item lives at root.
--
-- Both tables are per-user (owner_user_id = Clerk user id) and stay deny-all to
-- client keys like the rest of the app; the Library is served server-side
-- (service-role) scoped to the current user.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- LIBRARY FOLDERS — one row per folder. parent_folder_id NULL == top level.
-- Deleting a folder cascades to its subfolders (and, via the placements FK
-- below, frees its items back to root).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.library_folders (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_user_id    text NOT NULL REFERENCES public.app_users(user_id),
  parent_folder_id uuid REFERENCES public.library_folders(id) ON DELETE CASCADE,
  name             text NOT NULL CHECK (length(btrim(name)) > 0),
  position         integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_folders_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS library_folders_owner_idx  ON public.library_folders(owner_user_id);
CREATE INDEX IF NOT EXISTS library_folders_parent_idx ON public.library_folders(parent_folder_id);

-- ===========================================================================
-- LIBRARY ITEM PLACEMENTS — maps a published_item to the folder it sits in.
-- PRIMARY KEY (item_id) enforces an item lives in at most one folder. Deleting
-- a folder cascades these rows away, which returns the items to root.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.library_item_placements (
  item_id        uuid NOT NULL REFERENCES public.published_items(id) ON DELETE CASCADE,
  owner_user_id  text NOT NULL REFERENCES public.app_users(user_id),
  folder_id      uuid NOT NULL REFERENCES public.library_folders(id) ON DELETE CASCADE,
  position       integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_item_placements_pkey PRIMARY KEY (item_id)
);
CREATE INDEX IF NOT EXISTS library_item_placements_owner_idx  ON public.library_item_placements(owner_user_id);
CREATE INDEX IF NOT EXISTS library_item_placements_folder_idx ON public.library_item_placements(folder_id);
