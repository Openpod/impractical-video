---
name: ugc-product-testimonial
title: UGC Product Testimonial
category: Ads
description: Authentic UGC ad — one relatable person talks to camera about your product, selfie-style, in a real setting. Hook first, punchy cuts, captions.
use_when: The user wants a user-generated-content / creator-style ad where a real-feeling person talks to camera about a product, service, or app (TikTok/Reels/Shorts testimonial, "person reviewing your product").
---

# UGC Product Testimonial

Authenticity beats polish. ONE presenter, ONE voice, arm's-length phone framing,
a real room, the product in hand. The spoken script is the spine — every clip is
generated to deliver one line, so the ad stays coherent and the product never
drifts. Keep it a little imperfect: slight sway, natural light, no studio gloss.
That imperfection IS the UGC signal.

## Inputs

Collect these before planning (askUser for anything missing — one dialog, not a
drip):

- product (required): name, what it does, who it's for. A product photo if they
  have one — upload, or searchImages + saveImageToCanvas. Default: ask.
- presenter: who's talking. Default: propose one relatable everyday person that
  matches the product's audience (age / vibe) — not a polished model. Or use an
  uploaded photo / existing character. Real person ⇒ real photos (REAL PEOPLE rule).
- script: default write a 3-beat spoken script — HOOK (scroll-stopper) → VALUE
  (the problem it solves / what they love) → CTA. Casual, contractions, ~6-9s of
  talking per beat. Confirm before generating.
- aspect_ratio: default 9:16 vertical.
- target_length: default ~20-30s (3 beats).

## Plan template

Instantiate with updatePlan (concrete names filled in):

1. Collect inputs (product, presenter, script) — this step
2. Presenter — characters reference + portfolio + voice
3. Product — reference locked from the product photo
4. Script + review gate
5. Talking clips — one per beat (selfie i2v, on-camera dialogue)
6. Assemble the vertical cut — captions + optional music bed
7. Final pass

## Method

THE ONE RULE: the presenter and the room are LOCKED to images, never to words.
A beat generated without the presenter's image in its references will invent a
new person, a new outfit and a new room every single time. Describing her in the
prompt does not make her the same woman.

This applies to the presenter and the setting only — the two things that repeat
across every beat. Incidental people (a passer-by, a barista, a blurred crowd)
need no reference at all; describe them in the prompt and let the model invent
them.

1. PRESENTER — exactly ONE. Create a single characters reference and
   generateReferencePortfolio (real photos in conditioning_image_ids if a real
   person). designVoice for their voice — casual, warm, matched to their age and
   region — so every line speaks in ONE consistent voice. If the presenter comes
   out wrong, REVISE that same reference; never create a second/alternate
   presenter mid-run (two presenters = two faces in one ad).

2. PRODUCT LOCK. Save the product photo to canvas (upload, or searchImages →
   saveImageToCanvas) and create a props/product reference from it, so the
   product's labels, colors and shape stay identical in every shot.

3. ANCHOR FRAME — the most important step. Generate ONE selfie keyframe:
   the presenter (conditioned on her portfolio) holding the product, in the exact
   room, outfit and lighting the whole ad will live in. Arm's-length phone
   framing, natural light, a plain real room. This single frame is what locks
   face + outfit + environment across every beat.

4. SCRIPT + REVIEW GATE. Write 3 beats — hook / value / CTA — as spoken lines:
   contractions, no ad-speak, how a real person actually talks. Then askUser with
   the script AND the anchor frame: approve / swap presenter / rewrite lines.
   Cheap now, expensive after generation.

5. TALKING CLIPS, one per beat, 9:16, 4-6s each (8s reads as slow for UGC).
   Preferred: generateVideoFromImage pinned from the ANCHOR FRAME
   (start_image_id) — the first frame is then pixel-locked, so the room and the
   woman cannot drift. If you use generateVideoFromReferences instead,
   reference_ids MUST lead with the presenter portfolio AND the anchor frame,
   with the product after — referencing the product alone is the failure mode
   this recipe exists to prevent. Set dialogue mode exact_dialogue with the
   beat's line carrying start_s/end_s and speaker = the presenter's reference id;
   generateSpeech in her voice for clean audio. Direct eye contact, product
   visible, handheld micro-movement.

6. ASSEMBLE. addClipToEditorTimeline in beat order — the HOOK must land in the
   first 2 seconds. Hard cuts between beats (UGC is punchy, not crossfaded). Burn
   in captions (most UGC is watched muted). Optional low, upbeat music bed via
   generateMusic + addAudioToTimeline, ducked so the talking stays clear.

7. FINAL PASS. Play the beats back to back and check it is the SAME woman, same
   outfit, same room in all three — if any beat drifted, re-pin it from the
   anchor frame rather than patching. Then watch muted (do captions carry it?)
   and with sound (voice natural, in sync?). Trim dead air so the hook hits
   instantly.
