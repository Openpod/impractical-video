-- Add a user-facing display image role for published references.
-- This keeps AI-facing source files/portfolio media intact while allowing the
-- Explore UI to prefer a clean 1:1 profile/cover image.

ALTER TABLE public.published_item_media
  DROP CONSTRAINT IF EXISTS published_item_media_role_check;

ALTER TABLE public.published_item_media
  ADD CONSTRAINT published_item_media_role_check
  CHECK (role IN ('display','poster','thumbnail','preview','asset'));

CREATE UNIQUE INDEX IF NOT EXISTS published_item_media_one_display_per_item
  ON public.published_item_media(item_id)
  WHERE role = 'display';
