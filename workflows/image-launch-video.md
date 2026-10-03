---
name: image-launch-video
title: Image → Launch Video
category: Video methods
description: Executable recipe — one tool call turns a single image (upload, reference, or keyframe) into a multi-shot launch video via the Seedance clip-chaining method, with a built-in final check.
use_when: The user has one image (product photo, character, key visual) and wants a finished multi-shot video from it — a launch teaser, promo, or reveal. Default for image → video requests longer than one clip; use generate_clip directly for a one-off.
---

# Image → Launch Video

`generate_launch_video` executes the seedance-clip-chaining method end to end:
scene creation, one clip per shot with `extends_clip_id` chaining, the source
image carried as `@Image1` into every link, stop-on-failure, and a final
`check_project`. See `seedance-clip-chaining` for the underlying method.

## How to run it

1. Identify the source image id (an upload, reference, or keyframe with
   media). If the user has no usable image yet, get one first.
2. Decompose the outcome into 1-5 beats — one camera move per beat — and call
   `generate_launch_video` with `image_id`, a run `title`, and one
   `{title, prompt, duration_seconds?}` per beat. Write each prompt as that
   beat's on-screen action; the tool prepends the chaining bindings
   ("The video begins exactly on @Image1." / "Continue from @Video1:") when
   missing.
3. Read the result: `clipIds` land on the timeline in shot order and `check`
   is the post-run continuity report. On `failedShot`, fix that beat's prompt
   and regenerate from that link forward — do not restart the chain.

Total runtime is the sum of shot durations; keep beats to 4-8s unless the
shot demands more.
