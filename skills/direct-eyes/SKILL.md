---
name: direct-eyes
description: Design what a keyframe should LOOK like — directing the eye through contrast, value, color, shape, detail, depth, and framing. Turns a shot's dramatic job into a concrete keyframe instruction and lighting line.
use_when_summary: "Read when writing keyframe instructions and clip lighting — control where the eye goes via contrast, depth staging, and framing so generated frames read clearly."
tags: [composition, keyframe, lighting]
---

# Directing the Eyes — visual design for keyframes

Glebas' *Directing the Story*: composition is not "make it look nice," it is
controlling WHERE THE EYE GOES. Use this when authoring a keyframe `instruction`
(and a clip's `lighting` line) so the generated frame has a clear focal point.

## The master rule: the eye goes to greatest contrast

Every technique below is a way to create contrast at the focal point. Name the
ones you're using in the keyframe instruction — they become concrete generation
direction, not vibes.

- **Value** — eye goes to the brightest area. Light the subject, darken the
  background (or reverse for silhouette).
- **Color** — a warm element in a cool field pops; one saturated thing in a
  desaturated frame is instant focus.
- **Shape** — make the subject a different shape from its surroundings.
- **Detail** — render the focal area with detail, simplify the rest. The eye
  reads faces first.
- **Size** — the *differently* sized element draws the eye, not always the
  biggest.

## Depth — stage on the Z-axis

Place elements at different distances so the frame has layers: foreground (frame
context), midground (primary action), background (story context). Avoid depth
killers: subject flat against a wall, everything at one distance. Note lens feel
in the instruction — wide exaggerates depth (scope, unease); long compresses it
(intimacy, claustrophobia).

## Framing communicates

Tight = confinement/pressure; loose = isolation/vulnerability. Headroom = dignity;
none = oppression. Looking room = natural; none = trapped/tension. Pick framing
that matches the beat's emotion and state it.

## Lighting is the highest-leverage keyword (per the prompting research)

Name the SOURCE, not an adjective: "hard top-down", "neon glow from frame-left",
"golden-hour backlight", "underwater caustics", "chiaroscuro". A named source
beats "beautiful cinematic lighting" every time. This feeds the clip `lighting`
field directly.

## Output — into the keyframe instruction and clip fields

There is no separate document. Fold the decisions into:

- the keyframe `instruction` / `body`: focal point, the primary contrast driving
  it, depth layers (fg/mid/bg), and framing (tight/loose, headroom, looking room).
- the clip `lighting` field: the named light source.

Watercolor discipline: block the big value shapes first, place the subject at the
contrast point, detail only the focal area, let the rest fall off. Flag tangents
and competing focal points before generating — two equal focal points means the
eye has nowhere to land.
