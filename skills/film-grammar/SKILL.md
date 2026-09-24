---
name: film-grammar
description: Audit a keyframe sequence for spatial/temporal continuity errors — 180-degree rule, 30-degree rule, screen direction, film-time. The checklist for keyframe self-review; catches locational inconsistencies that are relations BETWEEN frames.
use_when_summary: "Read during keyframe self-review to find continuity errors across consecutive frames — screen direction, 180-degree line, jump cuts, geography breaks. Output is recordFinding records."
tags: [continuity, review, film-grammar]
---

# Film Grammar — the keyframe review checklist

Proferes' four foundational rules from *Film Directing Fundamentals*, applied to
self-review of generated keyframes. A "locational inconsistency" is almost never
a flaw in one frame — it is a broken RELATION between consecutive frames. View
frames in chain context (each beside its neighbors), check the four rules, and
`recordFinding` for each real break.

## Rule 1 — the 180-degree line

An imaginary axis runs between two characters facing each other; cuts that read
together must stay on one side. **Check across frames:** if character A is
frame-left looking right in one frame, are they still frame-left in the next
(unless a move on screen reset the axis)? A flip where both characters suddenly
face the same way, or left/right positions swap with no motivated move, is a
violation.

## Rule 2 — the 30-degree rule

Consecutive frames of the same subject must differ by ≥30° of angle OR a clear
size change, or the cut stutters. **Check:** two near-identical angles/sizes of
the same subject back to back = an accidental jump cut.

## Rule 3 — screen direction

Movement holds direction across cuts unless a turn is shown. **Check:** a subject
exiting frame-right should enter the next frame from frame-left; a chase or
travel beat should keep consistent direction. A subject that appears to reverse
with no on-screen motivation is a break.

## Rule 4 — film-time / geography

**Check:** does the world stay consistent — same props in the same places, same
architecture, same lighting direction — except where the action explains a
change? Objects that appear, vanish, or teleport between frames are the most
common generated-image failure and the highest-value thing to catch here.

## Output — recordFinding, not a prose audit

For each break, write a finding implicating the frames involved:

```
recordFinding({
  id: "find_kf04_kf05_direction",
  severity: "issue",            // blocker if it would break the cut outright
  implicates: ["kf_04", "kf_05"],
  summary: "Screen direction flips: Tovak exits frame-right in kf_04 but enters frame-right in kf_05.",
  detail: "Either mirror kf_05 so he enters frame-left, or add a neutral head-on frame to reset direction."
})
```

Severity: `blocker` = the sequence reads as broken (regenerate before clips);
`issue` = should fix; `note` = minor, worth flagging. Intentional rule breaks
(a deliberate disorienting flip) are fine — record them as `note` so the user
confirms intent rather than silently passing. After recording, present the
numbered findings to the user and ask whether they agree before fixing accepted
ones with `generateKeyframe(revises=...)`.
