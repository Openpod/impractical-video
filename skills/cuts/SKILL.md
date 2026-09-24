---
name: cuts
description: Design the cut map for a multi-shot sequence — where to cut, why each cut exists, what part of the action to show, and how cuts manipulate time. Murch's six criteria, motivated cuts, Kuleshov juxtaposition, anticipation/aftermath, rule of threes.
use_when_summary: "Read BEFORE planning any multi-shot piece (trailer, film, montage, ad). Output is the cut map: planned clip records and keyframe stubs written into the graph before any keyframe is generated."
tags: [editing, shot-planning, pacing]
---

# Cuts — Where, Why, and How to Cut

From Glebas (*Directing the Story*) and Murch (*In the Blink of an Eye*). A cut
is a total displacement of one visual field by another; the audience accepts it
because it mirrors how we glance, blink, and think. Your job is to make every
cut inevitable.

## Murch's six criteria for the ideal cut (priority order)

1. **Emotion** — true to the feeling of the moment (most important; if this is
   right the audience forgives the rest)
2. **Story** — advances the story
3. **Rhythm** — lands at a rhythmically interesting, correct place
4. **Eye trace** — respects where the audience is looking on screen
5. **2D plane** — respects screen composition
6. **3D space** — maintains spatial continuity

## Every cut needs a named motivation

Move the story forward · delay the answer to a narrative question · show what a
character sees (eyeline) · show a reaction · widen for context · cut close to a
detail · compare/contrast (juxtaposition) · recall · compress time · set rhythm.

**If you cannot name the reason for a cut, the cut should not exist.** The
motivation goes in the clip record's `cut_motivation` field — it is source, not
commentary.

## What part of the action do you show?

- **Anticipation only** — hand reaches for the door, CUT. Suspense.
- **Aftermath only** — CUT to the broken vase. Implication.
- **Anticipation, cut, aftermath** — the audience constructs the action
  themselves, which is more powerful than showing it.
- **Full action** — direct and visceral; use sparingly.

**AI-generation bonus:** cutting around an action means never asking the video
model to render its hardest two seconds. Anticipation/aftermath structures are
both better filmmaking and more reliable generation.

## Kuleshov: juxtaposition creates meaning

Shot A + shot B = a meaning in neither alone (face + soup = hunger). You do not
need the model to act an emotion — show the character, then show what they see;
the cut does the acting. Order matters: the same two shots reversed tell a
different story.

## Time

- **Contract** passage work: cut from departure to arrival; skip anything
  without a narrative question in it.
- **Expand** peaks: cause → reaction → another angle → aftermath. Real time
  2s, screen time 8s. The audience measures time by emotion, not clocks.
- **Rule of threes**: two failures establish the pattern, the third breaks it.
  Accelerate the cuts with each attempt.

## Rhythm defaults for generated pieces

- **Vary visual weight, shot size, and cut motivation to the beat.** A held
  moment, reveal, or decision can use a steadier framing or a longer generated
  clip; a quick exchange, reaction, or impact should be handled by what part of
  the action you show and where you cut next. Do NOT solve rhythm by writing a
  shorter playback duration than the generated clip.
- **Duration contract:** `duration_seconds` is the actual generated/playback
  duration, not an editorial trim target. Keep it equal to `generated_seconds`.
  Video generation supports 4–15s per clip; use shot count, cut placement, and
  action selection to create faster pacing inside that range.
- Trailers/montages should feel accelerated through shot choice: alternate shot
  sizes (wide → close → insert), use motivated cuts, and avoid unnecessary
  continuous chains. A continuous chain (shared keyframes) is a deliberate
  rarity, not a default.
- Use `hard_cut_same_assets` for impact cuts on the same subject (wide → CU).
- Check the `checkProject` pacing report after writing the map: shot count,
  mean duration, transition mix, longest same-size run. Judge your rhythm
  against the numbers.

## Output — write the cut map into the graph (no prose tables)

Decide the **last shot first**; everything builds toward it. Then write each
shot as a planned clip record (`clips/<id>.md`, `status: "planned"`) BEFORE
generating keyframes:

```json
{
  "id": "clip-007-core-reveal",
  "type": "clip",
  "scene": "scene-02",
  "index": 3,
  "status": "planned",
  "from_keyframe": "kf-012",
  "to_keyframe": "kf-013",
  "shot_size": "CU",
  "duration_seconds": 5,
  "transition_from_previous": "hard_cut_same_assets",
  "cut_motivation": "reaction: her face tells us the core is alive"
}
```

The body holds one line of intent. Write planned keyframe stubs
(`keyframes/<id>.md`, `status: "planned"`, body = what the frame must show)
alongside, so every edge resolves — the stub descriptions become the
generation instructions later. Generate keyframes only after the map reads
well against the pacing report, starting from the final shot's keyframes and
working backward through what each shot must set up.
