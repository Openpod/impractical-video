---
name: talking-explainer
title: Talking Explainer
category: Marketing
description: A spokesperson explains your product or topic to camera in a clean setting, with b-roll cutaways over a continuous voice. Clear, credible, on-brand.
use_when: The user wants a single host/spokesperson explaining a product, feature, or topic to camera — an explainer, demo narration, or founder/announcement video — polished rather than raw UGC.
---

# Talking Explainer

One credible host, one voice, explaining clearly to camera — with b-roll
cutaways that both illustrate the point AND hide the seams between talking
segments. The voice is continuous; the picture cuts between the host and the
visuals. Cleaner and more authoritative than raw UGC.

## Inputs

Collect these before planning (askUser for anything missing — one dialog):

- topic (required): the product / feature / message to explain, and who it's for.
- presenter: the host. Default: propose a credible, on-brand presenter (or use
  an uploaded photo / existing character). Real person ⇒ real photos.
- key_points: default 3-4 points to cover. Propose them and confirm.
- aspect_ratio: default 16:9 (ask if they want vertical for social).
- target_length: default ~30-45s.

## Plan template

Instantiate with updatePlan (concrete names filled in):

1. Collect topic, presenter, key points — this step
2. Presenter — reference + portfolio + voice
3. Script from the key points + review gate
4. Talking segments (A-roll)
5. B-roll cutaways illustrating each point
6. Assemble — A-roll + B-roll over one continuous voice
7. Final pass

## Method

1. PRESENTER. Create a characters reference for the host and
   generateReferencePortfolio (real photos in conditioning_image_ids if a real
   person). designVoice for a clear, credible, on-brand voice — every line speaks
   in this one voice.

2. SCRIPT. Turn the key points into a spoken script: quick intro → one crisp
   sentence per point → a one-line wrap / CTA. Natural spoken phrasing, no jargon
   walls. This is the spine.

3. REVIEW GATE. askUser with the script + presenter portfolio: approve / swap
   presenter / tighten points.

4. TALKING SEGMENTS (A-roll). For each section, generate a clean framing of the
   host (simple studio or on-brand backdrop) then generateVideoFromImage from it
   with dialogue mode exact_dialogue, the section's lines carrying start_s/end_s,
   speaker = the host's reference id. generateSpeech in the host's voice so the
   audio is one continuous, clean track.

5. B-ROLL. For each point, generate a short cutaway clip that shows what the host
   is describing (the product in use, a UI, an example) — generateKeyframe then
   generateVideoFromImage, or generateVideoFromReferences. These play OVER the
   voice and cover the cuts between talking segments.

6. ASSEMBLE. Lay the continuous voice track first (addAudioToTimeline), then
   addClipToEditorTimeline: open on the host, cut to b-roll over each point, cut
   back to the host for the wrap. A quiet music bed under the voice, ducked.
   Captions on.

7. FINAL PASS. Check that b-roll lands on the point it illustrates, the voice
   never drops, and the host reads as consistent across segments. Re-generate any
   segment where the face drifts rather than patching.
