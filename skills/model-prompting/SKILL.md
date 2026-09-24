---
name: model-prompting
description: How to write prompts for the specific models behind each generation tool — Seedance 2.0 (video), Nano Banana 2 (images), the edit backends, and ElevenLabs (audio). Load before writing any generation prompt.
---

# Model prompting playbook

Every tool calls a specific model, and the app never rewrites your prompt —
what you write is what the model gets. Prompts are always plain prose, never
markdown. This file tells you what each model actually rewards.

## Images — `generate_image` → Nano Banana 2 (Gemini)

Write a brief, not a tag list. The model reads prompts like a creative
director; keyword soup ("portrait, woman, red dress, cinematic, 8k") wastes
most of its ability. Structure, as flowing sentences:

subject (in the first ~15 words) → composition and camera → action →
setting and light → style → output intent.

- Photorealism comes from naming ONE camera + lens + lighting setup, not
  from the word "realistic". "Shot on a Hasselblad X2D with a 90mm f/2.8,
  soft key light from upper left, subtle rim light from behind right."
  Stacking camera phrases confuses it — pick one.
- State the use case: "a hero shot for a luxury perfume campaign" resolves
  ambiguity better than more adjectives.
- One style family per prompt. "Photorealistic anime watercolor" smears.
- Text inside the image: exact words in quotes + font mood + position +
  size hierarchy, all in one sentence. ("A bold headline at the top reads
  'FUTURE STACK' in thick condensed sans-serif...")
- Character consistency: pick 5–7 fixed physical traits and repeat them
  verbatim in every prompt for that character. When a reference image is
  conditioning the generation, keep the face description LIGHT and let the
  image carry identity — heavy face text + a face reference produces a
  blended stranger.
- Unless you explicitly want a sheet, never say "variations", "options",
  "sheet", or "panels", and when in doubt state "ONE single image".
- Two failed regenerations means the prompt is wrong — rewrite it from
  scratch instead of tweaking words.

## Image edits and conditioning — portfolio flows, `edit_media`

Edits are instructions, not scene descriptions. Re-describing the whole
scene tells the model it may regenerate everything. Every edit pairs a
change-clause with a keep-clause:

"Replace the denim jacket with a black leather jacket. Keep everything
else exactly the same — same face, expression, pose, lighting, and
background."

- Verbs set the blast radius: "Transform" = full restyle, "Change" = one
  attribute, "Replace" = substitution, "Add"/"Remove" = elements. Never
  "improve", "enhance", or "fix" — subjective verbs fail.
- Never use pronouns; name subjects concretely ("the woman with short
  black hair", not "she").
- Multi-image conditioning: 2–4 references is the sweet spot (fidelity
  degrades as you pile on more). Give each reference one sentence of role
  — "the first image is the character's face; the second image is the
  outfit" — and put must-survive identity refs first in the list.
- One conceptual edit per call, then iterate. Re-anchor each iteration to
  the ORIGINAL image, not to an edit-of-an-edit — drift compounds.
- Text swaps: Replace 'OPEN' with 'CLOSED' while maintaining the same font
  style and color. Keep replacement text near the original length.

## Video — `generate_clip` → Seedance 2.0

Write a director's shot brief, not a novel. Seedance only CUTS when the
prompt is written as numbered shot blocks — continuous prose produces one
single take no matter how long. The working skeleton:

Style line first ("2D anime, flat cel shading, clean bold line art,
limited color palette"), then numbered shots, then one global line for
lighting and sound.

- Shot blocks: "Shot 1: [framing + ONE action + ONE camera move]. Cut to
  Shot 2: ..." — up to ~5 shots per generation, 10-15 seconds duration
  (or "auto"); a 5-second clip physically cannot cut. Re-tag references
  inside each block ("Shot 2: @Image1 looks up...").
- Length: 60-100 words for a single shot, up to ~150 for a full shot
  list. Beyond 150 the model AVERAGES the prompt — details get cherry-
  picked and mushed. The first ~25 words carry the most weight: subject
  and action first, never style.
- Max TWO characters per shot. Three or more = faces drift, bodies warp.
  A four-person scene is coverage — singles and 2-shots cut together —
  never one wide tableau directing everybody at once.
- Never write negative instructions. "No 3D", "no watermark", "no
  subtitles" make the model parse the noun and often render MORE of it.
  State the positive: "flat cel shading", "clean empty frame". Never
  write "holds perfectly still" — that reads as absent action and comes
  out stiff; the animation-native phrase is "a single held key pose,
  anime timing with held frames", or give a small continuous micro-motion
  ("hair sways gently, a slow blink").
- One camera move per shot, named precisely ("slow dolly push in",
  "smooth lateral tracking"). Camera and subject motion as separate
  sentences. Avoid the word "fast".
- Attachments: fewer is better — an anchor keyframe + at most 2 character
  refs + 1 style ref beats a six-image stack (many same-gender faces get
  AVERAGED into morphing). One short role clause per ref, then weave them
  into the action. With a style image attached, delete style adjectives —
  they fight the anchor.
- Identity anchors are WORDS as well as pixels: restate each character's
  immutable features (beard, hairline, outfit) in the text of EVERY
  generation — features named in the prompt survive; features only
  present in the reference image erode mid-clip.
- Morphing triggers to direct around: hands crossing the face, fast head
  turns, lighting changes mid-shot, walking toward camera for many
  seconds, and any shot juggling 3+ characters. Cut instead of enduring.
- The chain anchor: the first clip of a scene attaches an art-directed
  keyframe (generated from the references by the image model, kept flat
  and clean — over-rendered stills animate badly) and opens with "The
  video begins exactly on @Image1." Extensions anchor on the previous
  clip's footage: "Continue from @Video1:" describing only what happens
  NEXT — never "reference @Video1", which makes a lookalike.
- Dialogue: shot-reverse-shot as labeled blocks — a stable medium
  close-up of ONE speaker per shot, front or 3/4 angle, quoted line of
  5-10 words with a delivery note ("he says it flatly, in Japanese:
  「……来たか。」"). No head-turn directions during a line; they fight
  lip-sync. One language per scene.

## Audio — `generate_audio` → ElevenLabs

Speech (kind "speech"):
- Named premade voices (like "Rachel") run on multilingual-v2, where
  bracketed audio tags DO NOT work — they get read aloud. Convey emotion
  through the words themselves, punctuation, and narrative framing.
- Designed voices (raw voice IDs) run on eleven-v3, where audio tags DO
  work: [whispers], [sighs], [laughs], [excited], [frustrated sigh],
  [short pause]. Place a tag immediately before the words it modifies,
  and match tags to the voice's character — a stern voice won't
  [giggles] convincingly. CAPITALIZATION adds emphasis; ellipses add
  weighty pauses. Give v3 at least ~250 characters of text; very short
  requests come out unstable.

Voice design (kind "voice_design") — follow this shape:
"Native <language/regional variant>. <Gender>, <age range>. <Audio
quality>. Persona: <2–5 words>. Emotion: <2–3 adjectives>. <One or two
sentences on timbre, pacing, and delivery.>"
Be regionally specific about accents ("thick Glasgow accent", not "a
Scottish-sounding voice") and never use effects words like "reverb" or
"phone" — describe the voice, not the mix.

Music (kind "music"): genre + mood + named instruments + tempo in BPM +
key + vocal spec + use case. Say "instrumental only" unless you want
lyrics — most prompts get vocals by default. Timing cues work: "lyrics
begin at 15 seconds", "instrumental only after 1:45". Simple intent
prompts are legitimate too: "track for a high-end mascara commercial,
upbeat and polished".

Sound effects (kind "sfx"): name the material, the force, and the space —
"heavy wooden door creaking open in a stone hallway", not "door sound".
Sequence events with "then". Keep one-shots short and punchy; for
ambience, name 3–4 distinct layers ("night forest: crickets, distant owl,
light wind in leaves, occasional branch creak") and generate complex
scenes as separate layers to combine in the edit.

## When a generation misses

Diagnose before regenerating: subject buried past the opening words,
missing lighting, stacked styles, a keep-clause you forgot, an identity
reference in the wrong slot, or "reference" phrasing on an extension.
Fix the specific miss. If two rewrites in a row fail, change approach —
different method, different references — rather than rolling the dice
a third time.
