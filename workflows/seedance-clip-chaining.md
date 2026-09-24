---
name: seedance-clip-chaining
title: Seedance Clip Chaining
category: Video methods
description: The house method for multi-shot video — anchor the scene's opening on a keyframe generated from the references, generate the first clip from it with reference-to-video, then extend clip-by-clip by passing the previous clip forward as @Video1, carrying a slim reference set into every link.
use_when: Building any multi-clip video or extending an existing clip ("continue the video", "next shot", "extend this"). Default method unless the user asks for keyframe interpolation or a one-off.
---

# Seedance Clip Chaining

Videos are built as a chain of clips, each continuing from the last, and
every generation in the chain has a pixel anchor: the scene's opening is
anchored on an art-directed keyframe, and each later clip is anchored on
the previous clip's actual footage. Un-anchored reference-to-video is the
mode that morphs — avoid it.

## The chain

1. **Anchor the opening.** Generate an art-directed keyframe for the
   scene's first frame with `generate_image`, conditioned on the
   references (characters in position, environment, style). Keep it flat
   and clean — over-rendered stills animate badly. This is the chain's
   pixel anchor: the video model starts from YOUR composition instead of
   improvising one from references.
2. **Ground the first clip.** `generate_clip` with `reference_ids`
   leading with that keyframe (it becomes @Image1), then at most 2
   character displays and 1 style ref. The prompt opens "The video
   begins exactly on @Image1." and is written as numbered shot blocks
   (see `model-prompting`) so the clip actually cuts.
3. **Extend.** Each continuation: `extends_clip_id` (previous clip
   becomes @Video1) + the SAME slim reference set. Prompt starts
   "Continue from @Video1:" and describes only what happens NEXT in shot
   blocks. Never "reference @Video1" — that makes a lookalike instead of
   an extension. Restate each character's immutable features in words
   every link.
4. **Check.** `check_project` after each link; fix drift before
   extending — errors compound down a chain.

## Fallback: frame chaining

When the previous clip's footage is unavailable or unusable (rejected by
the provider, badly drifted ending), fall back to frame extraction:
`edit_media {op: "extract_frame", path: "clips/<prev>.md", at: "last"}`,
then generate with `from_keyframe_id` set to that frame and the same
continuation prompting. This loses motion continuity across the cut, so
prefer true extension when possible.

## Judgment

- Dialogue-heavy or action shots: keep clips short (5-12s); drift grows
  with duration. Lip-sync degrades past ~10s.
- If identity slips mid-chain, regenerate that link conditioned harder on
  the reference portfolio before continuing — do not chain from a drifted
  clip. When a chain has drifted repeatedly, re-anchor from the ORIGINAL
  references, not the latest clip.
- Scene cuts (new location/time) start a fresh sub-chain: no
  `extends_clip_id`, but the same `reference_ids` and style language.
