---
name: vertical-story-episode
title: Vertical Story Episode
category: Storytelling
description: Build a recurring 60–180 second vertical story episode in 9:16 — reusable series bible, five-to-eight dramatic beats, locked cast/world/voices, and a cliffhanger handoff.
use_when: The user wants a serialized vertical fiction episode for TikTok, Reels, Shorts, or another phone-first series, especially when characters, locations, props, voices, and unresolved story threads must continue across episodes.
---

# Vertical Story Episode

Make one complete phone-first episode that rewards the current view and leaves
one precise reason to watch the next. The episode is 60–180 seconds in 9:16,
contains 5–8 dramatic beats, and belongs to a repeatable series rather than
resetting its characters and world every time.

## Inputs

Collect missing decisions together in one user-input request. Propose sensible
defaults instead of asking a sequence of small questions.

- series premise and audience (required)
- episode number or position in the series; default: episode 1
- episode story goal: what changes by the end (required)
- target length within 60–180 seconds; default: 90 seconds
- aspect ratio: fixed at 9:16
- tone, content boundaries, and intended platform
- recurring cast, locations, hero props, and visual style
- dialogue language, voice direction, music/SFX needs, and caption style
- existing series bible, prior episode, script, references, or ending frame

When continuing a series, read its bible and prior handoff before planning. Do
not silently redesign an established character, voice, location, prop, caption
system, or visual grammar.

## Reusable series bible

Create or update `series-bible.md` as durable project source, not disposable
chat context. Preserve user-authored decisions. It contains:

- series logline, audience promise, tone, format, 9:16 frame, and episode range
- cast reference IDs, identity traits, relationships, wardrobe rules, current
  state, and bound voice IDs
- recurring location, prop, and style reference IDs with continuity rules
- dialogue, caption, music, sound-design, pacing, and camera conventions
- episode ledger: number, premise, ending state, unresolved thread, and status
- latest approved artifact/version IDs and any reusable boundary frame

If no bible exists, make the minimum useful version before generating. If one
exists, append the new episode ledger entry and revise established facts only
when the user explicitly changes canon.

## Story shape

Plan 5–8 beats. Each beat records its dramatic job, visible action, dialogue or
sound, intended duration, cast/location/prop dependencies, and transition.
Together they must cover:

1. HOOK — a legible surprise, danger, desire, or question in the first 1–3s.
2. CONFLICT — the protagonist wants something and meets immediate resistance.
3. ESCALATION — pressure, cost, or uncertainty increases.
4. TURN — new information or action changes the viewer's understanding.
5. PAYOFF — deliver a meaningful result from the episode's central promise.
6. CLIFFHANGER — end on a specific unresolved choice, reveal, threat, or goal.

Five-beat episodes may combine escalation with the turn. Six-to-eight-beat
episodes may add setup, complication, reaction, or aftermath, but never pad the
runtime with repeated information. A beat may need multiple short shots; beats
are story units, not a requirement for long generated clips.

## Plan template

Instantiate a concrete plan with names, durations, and episode-specific assets:

1. Intake + prior-episode continuity — this step
2. Series bible and episode beat sheet
3. Style, cast, location, prop, and voice continuity lock
4. Canvas storyboard — one readable panel per beat, grouped in order
5. Storyboard review gate
6. Motion — shot chains and exact-boundary shots
7. Dialogue, voiceover, music, SFX, and captions
8. Editor assembly
9. Project check + final QC
10. Next-episode continuity handoff

## Skill dependencies

Load these project skills before the step they govern:

- `reference-first-production` before creating recurring visual assets
- `model-prompting` before writing any generation prompt
- `directors-notebook` before the beat sheet, shot plan, or storyboard
- `cuts` when turning beats into a motivated cut map
- `storyboard-image-direction` and `direct-eyes` for every storyboard panel
- `film-grammar` when reviewing spatial and temporal continuity

## Capability dependencies

Resolve each capability to its current equivalent on the active agent surface;
these labels describe required behavior, not literal tool names.

- **User input and approval:** collect missing inputs once and present the
  storyboard review as one clear approve/revise decision.
- **Plan management:** publish the concrete episode plan and keep its state
  current as work completes or changes.
- **Project source read/write:** maintain the series bible, references, scenes,
  planned artifacts, and next-episode handoff without losing user edits.
- **Reference and voice continuity:** create or reuse style, cast, location,
  prop, portfolio, and voice identities before dependent shots.
- **Storyboard image generation:** create versioned, reference-conditioned
  panels and arrange them as one ordered Canvas group.
- **Video generation:** animate an exact image boundary when required, or make
  a reference-grounded shot/continuation when exact endpoints are unnecessary.
- **Media inspection and frame extraction:** inspect generated media and retain
  the real last frame needed to continue a shot safely.
- **Audio generation and placement:** create or import speech, music, ambience,
  and SFX, then place and mix them against the picture.
- **Editor timeline read and mutation:** read current revision first, assemble
  picture/audio/text, and refresh/retry rather than overwriting a newer edit.
- **Deterministic project validation:** run `check_project` after graph changes
  and before completion; fix errors and report unresolved warnings plainly.

## Method

1. CONTINUITY INTAKE. Read `series-bible.md`, the previous episode handoff,
   authoritative user materials, and current project state. Identify canon that
   must remain fixed and the one story change this episode will deliver.

2. LOCK RECURRING IDENTITIES. Reuse approved references and voices. Create
   missing style, cast, location, prop, and voice identities before story panels
   depend on them. Real people require real source photos. Revise an established
   reference only when the user changes canon; otherwise preserve it.

3. BEAT SHEET AND CUT MAP. Write 5–8 episode beats using the required story
   shape. Budget their durations to the target runtime, then turn each beat into
   the fewest shots that make the action and emotional change readable. Compose
   for phone viewing: a clear subject, legible faces/actions, safe caption room,
   and no critical information hidden at the frame edges.

4. CANVAS STORYBOARD. Generate one representative panel per beat from the
   locked references and place all panels in one ordered Canvas group titled
   `Episode <number> storyboard`. Panels show anticipation or a readable state,
   not motion blur or the action apex. Keep recurring wardrobe, props, geography,
   lighting logic, and screen direction consistent.

5. REVIEW GATE. Present the ordered storyboard plus a compact beat list. Ask for
   one decision: approve, revise named beats, or change continuity. Do not begin
   expensive motion until approval, unless the user explicitly requested an
   autonomous no-checkpoint run; record that override in the plan and bible.

6. MOTION. Use clip chaining as the default within a continuous shot or moment:
   ground the first clip in approved references, retain its actual final frame,
   and use that frame to continue the next clip while restating identity and
   world essentials. Start a fresh chain for a cut, new camera setup, location,
   or time jump. Use first/last-frame interpolation only when the exact ending
   matters—for example a match cut, loop, prop reveal, precise choreography, or
   a boundary that must become the next shot's shared frame. Check continuity
   after every risky link; never continue from a visibly drifted clip.

7. DIALOGUE AND SOUND. Bind every recurring speaker to the established voice.
   Keep spoken lines natural, timed, and short enough for their shots. Build a
   restrained music arc under dialogue; add motivated ambience and SFX. Captions
   reproduce the spoken words accurately, use the series style, stay inside
   vertical safe areas, and remain readable with sound off.

8. EDITOR ASSEMBLY. Read the current timeline and revision before writing. Cut
   picture in beat order, then place dialogue/voiceover, music, ambience, SFX,
   and captions. Prefer motivated hard cuts for hooks, turns, and cliffhangers;
   use soft transitions only when story time and tone support them. If the
   timeline revision changes, refresh and retry against the new state.

9. PROJECT CHECK AND FINAL QC. Run `check_project`; fix graph, stale-reference,
   duration, or continuity errors before declaring completion. Watch the full
   episode once muted and once with sound. Confirm 9:16 framing; a comprehensible
   first-three-second hook; consistent faces, wardrobe, locations, props, and
   voices; dialogue sync; caption accuracy and safe placement; intentional audio
   levels; no dead air, black frames, or accidental drift; a delivered payoff;
   and one unmistakable cliffhanger.

10. NEXT-EPISODE HANDOFF. Update `series-bible.md` with the episode's final canon:
    character and relationship states, location/prop changes, unresolved thread,
    exact approved reference/voice/version IDs, final Editor state, and the real
    ending frame if it can anchor a continuation. Add a short `Next episode seed`
    containing the opening question, the fact that must remain hidden or reveal,
    and the first plausible conflict. The next episode starts by reading this
    handoff; it never reconstructs continuity from memory alone.
