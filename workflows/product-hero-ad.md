---
name: product-hero-ad
title: Product Hero Ad
category: Ads
description: Cinematic product-only ad — beauty shots of the product (reveal, macro detail, in-use, end card), music-led, no dialogue. The simplest ad recipe.
use_when: The user wants a slick product commercial with no presenter — beauty/hero shots of a physical product or app, cinematic, music-driven (a "product beauty ad" or "brand film").
---

# Product Hero Ad

The product is the star — no character to keep consistent, so this is the
simplest ad to run. Lock the product from one photo, condition every shot on it,
and let motion + music do the work. Four beats: reveal, detail, in-use, end card.

## Inputs

Collect these before planning (askUser for anything missing — one dialog):

- product (required): a product photo is strongly preferred — upload, or
  searchImages + saveImageToCanvas. Default: ask for a photo.
- mood: the brand vibe. Default: clean and premium (soft light, seamless
  backdrop). Confirm or adjust.
- beats: default 4 — REVEAL, MACRO DETAIL, IN-USE / LIFESTYLE, LOGO + CTA.
- aspect_ratio: default 9:16 vertical unless the user says otherwise.
- target_length: default ~15-20s.

## Plan template

Instantiate with updatePlan (concrete names filled in):

1. Collect product photo + mood — this step
2. Product reference locked from the photo
3. Beat keyframes (reveal, detail, in-use, end card)
4. Review gate
5. Motion — one clip per beat
6. Assemble — music-led cut + end card
7. Final pass

## Method

1. PRODUCT LOCK. Save the product photo to canvas and create a props/product
   reference from it. Every keyframe conditions on this image
   (conditioning_image_ids) so the product is pixel-true throughout.

2. BEAT KEYFRAMES. generateKeyframe for each beat in the working aspect ratio:
   hero reveal on a seamless backdrop, a macro detail shot (texture, logo,
   material), an in-use / lifestyle context, and a clean end card with room for
   a logo + CTA line. Fix composition here, not in video.

3. REVIEW GATE. askUser with the keyframes: approve / swap the mood / redraw
   specific shots.

4. MOTION, one clip per beat. generateVideoFromImage pinned from each keyframe
   (start_image_id) with a single restrained camera move — slow push, gentle
   rotate, or rack focus. 3-4s each. Dialogue mode no_audible_speech (no talking).

5. ASSEMBLE. addClipToEditorTimeline in beat order; crossfadeClipBridges between
   the beauty beats for a smooth flow, hard cut into the end card. Music-led:
   generateMusic (matched to the mood and length) + addAudioToTimeline, fade out
   under the end card.

6. FINAL PASS. Watch for product warping or label drift; re-generate any beat
   that breaks the product rather than patching. Confirm the end card holds long
   enough to read the CTA.
