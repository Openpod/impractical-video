---
name: storyboard-image-direction
description: >-
  Turn a story beat into a single, clearly-readable storyboard frame and the
  image prompt that produces it. Use this skill ANY time you are generating,
  describing, or prompting storyboard panels, shot frames, key frames,
  pre-viz images, or per-shot visuals for a film, ad, animation, or AI video —
  even when the user just says "draw this scene," "make a panel for X," or
  "show this shot." Apply it whenever the goal is a picture that has to TELL
  something, not merely look pretty. It covers shot choice, camera angle, lens,
  composition, light, depth, gesture/emotion, significant objects, a
  ready-to-use prompt template with worked examples, and how to design
  keyframes as seed frames for image-to-video models so generated clips do not
  drift or warp by the end.
license: Internal use. Concepts adapted from Francis Glebas, *Directing the Story* (Focal Press, 2009); all wording original.
---

# Storyboard Image Direction

A storyboard frame is not an illustration. It is a **sentence spoken in pictures**.
Every frame must do three jobs at once:

1. **Say exactly one thing** — one idea per frame, like one clause in a sentence.
2. **Direct the eye** — the viewer must know *where to look* and then *what they're looking at*.
3. **Ask a question** — a good frame makes the viewer want the next one ("what happens now?").

If a frame does not do all three, it is decoration, not direction. Fix it before generating.

The two enemies you are always fighting: **confusion** (the viewer can't tell what to look at) and **boredom** (nothing pulls them forward). Almost every weak frame fails on one of these.

---

## The core workflow: beat → frame → prompt

For each story beat, decide these in order. Don't skip to the prompt.

1. **What is the ONE idea?** State it as a short active sentence: "She finds the ring." "He realizes he's been followed." If you can't say it in one clause, it's two frames, not one.
2. **Whose attention / whose POV?** Every shot is a close-up *of what you want to say* — even a shot as wide as a galaxy. Frame for the idea, not for the scenery.
3. **Stage the action** — where is the subject in the frame, where does the eye enter, where does it exit (block that exit), what is the eye-path.
4. **Pick the grammar** — framing (how wide), angle (eye level / high / low), lens (wide vs. telephoto).
5. **Light it** — key/back/fill or a theatrical scheme; light *is* where you point the eye.
6. **Build depth** — overlapping planes, value ranges, contrast in foreground.
7. **Add the significant object / gesture / expression** that carries the meaning.
8. **Write the prompt** using the template at the bottom.

Then run the **Enemies Check** before you finalize.

---

## 1. Shot grammar — frame the idea

**Every shot is a close-up of the idea.** Shot-size labels are a way to communicate scope, not a goal in themselves. Choose the framing that isolates the one thing the frame is about.

| Framing | Use it to say |
|---|---|
| Extreme wide / establishing | "Here is the world / the scale / where we are." Show this only when location *is* the idea. |
| Wide / full | "Here is the action and the space it needs." Good for staging movement. |
| Medium | "Here is who, doing what." The workhorse for beats with bodies + intent. |
| Close-up | "Look HERE — this is important." The face, the hand, the object. This is where emotion and decisions live. |
| Extreme close-up | "This detail is everything." The eye, the trigger finger, the cracked photo. |

Rule of thumb: when in doubt, get **closer**. Beginners shoot too wide and bury the point. If you can't see the expression that carries the beat, you're too far away.

**Camera angle** is a statement, not a flourish:
- **Eye level** — neutral, we relate as an equal. Default unless you have a reason.
- **Low angle (up-shot)** — subject is powerful, looming, threatening, or the space is vast.
- **High angle (down-shot)** — subject is small, trapped, vulnerable, observed.
- Do **not** pick a dramatic angle "because it's dynamic." A tricky angle that doesn't serve the idea just makes the frame ambiguous. Choose the angle that supports the story.

**Characteristic view:** show objects and people from the angle that makes them instantly recognizable (usually front or 3/4, not from directly above/below). The mind fills in the rest from a few identifying traits — give it those traits.

---

## 2. Lens — wide vs. telephoto

The lens changes the *feeling* of space. Specify it.

**Wide-angle:**
- Expands and exaggerates space; near things loom, far things race away.
- Deep depth of field (everything sharp).
- Verticals/horizontals bend into dynamic diagonals; faces distort up close.
- Use for: action, energy, immersion, disorientation, "you are inside it."

**Telephoto:**
- Compresses/flattens space; layers stack on top of each other.
- Shallow depth of field — subject sharp, background a soft wash of color (strong figure/ground pop).
- Little distortion; flattering to faces.
- Use for: beauty shots, isolation, "watching from a distance," romantic close-ups.

---

## 3. Compose to direct the eye

Composition has one purpose: **keep the eye on the focal point, let it travel the frame, but never let it leave.**

**Create ONE focal point.** The eye goes to the area of **greatest contrast** and the **most dominant** element. Make exactly one thing win. Ways to do it:
- Contrast of value (light figure on dark ground, or dark on light).
- Selective focus (sharp subject, blurred surroundings).
- Light (a pool of light, backlight/rim light to "halo" the subject off the background).
- Convergence (lines/arrows pointing at it).
- Isolation (give it clean negative space while everything else clusters).
- The small thing can still win if everything points to it.

**Give the eye a path, then close the exits.** Use lines, edges, gazes, and shapes as arrows that lead to the focal point and ideally **loop back** to it. Then make sure no line or bright edge leads the eye *out* of the frame — block the exits.

**Look where I look.** The single most powerful eye-director is a character's gaze. The viewer follows eyelines. The standard cinematic beat is: someone looks → cut to what they see. Use gaze direction deliberately within a single frame too.

**Reading direction.** Eyes scan left→right, top→bottom (in Western contexts). Put the "punch line" of the frame on the right / lower so it's discovered last. For travel/maps, keep west-left, east-right (a plane flying east points right). Flip for right-to-left reading cultures (e.g. manga).

**Build on simple shapes.** Fast-reading compositions are built on a clear underlying shape: **C, S, L, T, X, Z**, triangles, spirals, sunbursts, U-shapes. Triangles are especially strong and stable. Interlock shapes like puzzle pieces. Use **partial** circles — full circles are too self-closing to integrate.

**Thirds, not halves.** Place the focal point on a third. Dividing the frame in half is usually boring. To center a subject without dead symmetry, add counterweight elements on each side.

**Figure/ground.** Always ensure the subject separates cleanly from its background. If the silhouette merges with the background, the frame fails — change the value, the focus, or the light.

---

## 4. Light — the eye's flashlight

Light fights confusion (lets us see clearly) **and** creates mood. Specify a lighting intent.

- **Three-point (naturalistic):** key (main, sun-like), back/rim (separates subject from ground), fill (softens shadows). The default for a believable sense of volume.
- **Film-noir / low-key:** drop the fill → stark, hard shadows. Tension, threat, mystery.
- **Silhouette / high-contrast:** subject as a black shape against a bright field. Powerful, graphic, anonymous, ominous.
- **Theatrical / pools of light:** light only what matters; let the rest fall into dark. The lit area *is* the focal point — a literal stage for the action.
- **Chromatic light:** a color cast carries mood (overcast blue = rain/melancholy; warm amber = safety/nostalgia; sickly green = unease).
- **Shadows** are composition tools — they define shapes and direct the eye. Cast shadows can carry the story (a shadow answers "where is he?").

State the **light direction and quality** in the prompt (e.g. "hard low key light from frame-left, deep falloff into shadow, rim light on the shoulders").

---

## 5. Depth — keep the frame from going flat

Build space in **overlapping planes**, like stage flats: **foreground / midground(s) / background**, with shapes overlapping each other.

**Atmospheric perspective via value ranges** — assign each plane a value band so the eye reads depth:
- **Foreground:** greatest contrast (near-black up to white).
- **Midground:** medium band (roughly 70%→15% gray).
- **Background:** narrowest band, lowest contrast (roughly 40%→20% gray).

Other depth cues: overlapping shapes, diminishing size with distance, converging lines, a sharp-focus plane against soft ones.

**Depth killers — avoid unless you want flatness on purpose:**
- Lines parallel to the frame edge (flatten space).
- Wrong relative sizes (breaks size constancy → surreal/flat).
- Pure-black shadows that read as holes, or blown-white highlights that look pasted on.
- Elements that don't share a consistent horizon (they feel cut-and-pasted).

(Flatness is a legitimate *choice* for posters/graphic moments — just make it deliberate, and contrast it against deep-space frames for storytelling punch.)

---

## 6. Character, gesture, and emotion

**Line of action.** Every figure pose is built on one strong curved line (an S-curve or C-curve) expressing the main thrust of the action. Pose to that line first; the body is subordinate to it. A clear line of action reads instantly even in silhouette.

**Clear silhouette.** You should be able to fill the figure in solid black and still read what's happening. Keep telling detail *inside* the outline; keep the outline itself interesting and unambiguous. If the silhouette is unclear, change the pose or the camera.

**Action verbs, not nouns.** Draw what the figure is *doing* — reaching, recoiling, shoving, hiding — not a static portrait. Hands especially: render the action (poke, grab, claw, point), not anatomy.

**Asymmetry = life.** Avoid symmetrical, square-on, rigid poses; they look cut-out and dead. Offset the shoulders against the hips (counter-angles). Play straight lines against curves.

**The four emotion groups** read primarily from **eyebrows + mouth** (eyes/lids for nuance), reinforced by whole-body language:
- **Happy/up:** raised, open, lifted shapes, expansive posture.
- **Sad/down:** drooping, collapsed, inward, lowered shapes.
- **Angry:** sharp, downward, converging, forward-driving shapes.
- **Fear/surprise:** wide, raised, recoiling, contracted shapes.

A *change* of expression across frames shows the character **thinking** — use it to dramatize a realization.

**Comic / motion icons** (use sparingly, mainly for animation or comedic boards): speed lines for motion, impact bursts for collisions, sweat drops, etc. They graphically state motion and emotion.

---

## 7. Make the image speak — significant objects & questions

Images can refer to what isn't on screen. Use **significant objects** to carry meaning without dialogue:
- Time: clocks, calendars, seasons, weathering, a rising tide.
- Character/class: uniforms, medals, masks, costume.
- Love & its changes: flowers, letters, a ring put on — or a ring taken off, a crib bought.
- Death: skull-and-crossbones at one end, a flatlining monitor at the other.
- Transition / state of mind: doors, windows, mirrors (passage between places or mental states).
- An object's meaning can *shift* across the story (a gift → a clue → a horror) as the audience learns more. Stage the same object differently as its meaning changes.

**Frames ask questions.** Build the frame so a viewer naturally asks: *What is it? What's going on? Why should I care? What does she want? What happens next?* Pose the question with the image (a desire, a threat, a mystery) and **delay** the answer to the next frame. That delay is what keeps them watching.

---

## The Enemies Check (run before finalizing every frame)

**Confusion:**
- [ ] Is there exactly **one** clear focal point? (If two things compete, you have two frames.)
- [ ] Does the subject separate cleanly from the background (figure/ground)?
- [ ] Is the silhouette/pose readable?
- [ ] Did I block the exits (no line/gaze/edge leading the eye out)?
- [ ] No bad tangents (edges kissing in a way that flattens space)?
- [ ] No crowding — is there breathing room / negative space?

**Boredom:**
- [ ] Is there a dominant element, or is everything the same size/value?
- [ ] Did I avoid dead-center symmetry and the half-split?
- [ ] Are there counter-angles / diagonals giving energy?
- [ ] Does the frame ask a question that pulls to the next beat?

If any box fails, revise the composition — don't just re-roll the generator.

---

## Designing keyframes for video generation (seed frames)

If the frame will be fed to an image-to-video model as a seed, it has a second job: it must still tell the beat, but it also must give the model a stable state to animate from or toward.

**The rule: all generated video keyframes are anticipation frames, not apex frames.** Every action has three stages: anticipation (wind-up), action (peak), aftermath (follow-through). Static hero art may read best at the action stage, but video keyframes work better at the anticipation stage: energy as potential, not spent. Weight loaded, pose ready, subject about to move. Let the video model deliver the apex naturally between keyframes.

For keyframe generation, always default to:

```text
beat-stage: anticipation
```

Do **not** use `beat-stage: action` for generated video keyframes, including destination/end frames. Use `action` only for non-video hero stills that will not be used as clip endpoints.

**Seed-frame design rules:**

1. **Anchor both ends as anticipation poses by default.** Seed = wind-up, end = the next wind-up. Let the model invent the apex in the middle; an invented peak is lower-risk when constrained to arrive at a known low-energy pose right after. This is the right default for chained or continuous sequences: the end frame of clip N becomes the seed of clip N+1, so every junction is simultaneously a clean end and a clean next seed.
2. **Compose every generated keyframe at lower energy.** Planted feet, clear center of mass, a softer line of action. Reserve the extreme apex for static hero art only, not generated video keyframes.
3. **Tame chaos elements.** Flowing cloth, particles, glowing beams, wet reflective surfaces, and dense high-contrast backgrounds degrade first. Quiet the background and reduce unstable micro-detail.
4. **Match the motion prompt to what the pose can plausibly do.** Name a specific small action, not generic "dynamic action."
5. **Generate short and chain.** Error accumulates with clip length; short segments stay closer to their anchors.
6. **Lower motion strength or guidance a notch** so the model does not over-amplify the dynamism already visible in the image.

Annotate every generated keyframe prompt with its `beat-stage` and intended `motion` so the seed frame and any hero still can diverge on purpose.

---

## Continuation prompts (reference-to-video, no new keyframe)

Once the opening clip exists, most beats should extend it with Seedance 2.0
reference-to-video instead of a new seed frame. There is no still to design here —
the prior clip's footage is the seed (`@Video1`) and recurring portfolios are
`@Image1`, `@Image2`, … So the craft shifts from image composition to **action
prose**:

- Open with `Show what happens after @Video1.` (added for you by
  `composeContinuationClipPrompt`).
- Write 1-3 beats of Steven Spielberg-style action, separated by hard `Cut.`
  breaks — momentum, urgency, clear cause-and-effect. Each action visibly leads to
  the next.
- Reference recurring subjects with `@ImageN`, using visual descriptors, never
  project ids: "the courier breaks toward @Image2 (the red maintenance hatch)."
- Keep screen direction, eyelines, and geography consistent; do not cross the
  180-degree line without a visible turn or neutral reset. The footer and `No
  music` are appended automatically.

Only fall back to a designed keyframe pair when the next beat is a hard reset the
prior video cannot imply (new location, large time jump, brand-new subject).

---

## Prompt template for an image agent

Generate each panel from a structured spec, then render it as one flowing natural-language prompt. Fill every field; an unfilled field is an un-made decision.

```
PANEL <scene.shot>
  idea:        <the one clause this frame says>
  question:    <the story question it raises>
  framing:     <ECU | CU | MS | WS | EWS> of <subject>
  angle:       <eye-level | low/up-shot | high/down-shot> — because <reason>
  lens:        <wide-angle | normal | telephoto>, DOF <deep | shallow>
  focal point: <the one thing the eye lands on> via <contrast | focus | light | convergence | isolation>
  eye-path:    <how the eye travels and loops back; what blocks the exit>
  composition: <underlying shape: C/S/L/T/X/Z/triangle/U/spiral>, subject on <left/right/upper/lower third>
  light:       <scheme>, direction <from where>, quality <hard/soft>, color cast <if any>
  depth:       FG <what + value> / MG <what> / BG <what>; planes overlap
  gesture:     <line of action + action verb> ; expression <emotion group>
  signif.obj:  <object carrying meaning, if any>
  palette/mood:<color + emotional tone>
  beat-stage:  <anticipation | action | aftermath>  # generated video keyframes = anticipation, including end frames
  motion:      <intended motion vector + specific small action, if this seeds a video>
```

For storyboard stills, `beat-stage` may be `action`. For generated keyframes that seed image-to-video, set `beat-stage: anticipation` for **every** keyframe, including destination/end frames. Fill `motion` with the specific small action the model should perform between anticipation poses.

**Rendering the prompt:** translate the spec into one prose paragraph, leading with framing + subject + action, then angle/lens, then composition + light + depth, then mood. Keep it concrete and visual. Example renderings below.

---

## Worked examples

**Beat:** *A princess pines for her lost love at her tower window, at dusk.*

> Storyboard panel, medium close-up of a young princess leaning on a stone tower window, eye level, telephoto with shallow depth of field so the distant town below melts into soft warm bokeh. She is framed on the right third, her gaze led off-frame-left toward the horizon — her eyeline is the eye-path, and the heavy window frame on the left blocks the exit and loops the eye back to her face. Soft low-key dusk light rakes from frame-left, warm amber key with a cool blue fill, a faint rim separating her from the dark interior behind her. Foreground: dark window stone (high contrast); midground: her lit face and shoulders; background: low-contrast hazy town. Line of action is a gentle forward S-curve of longing; sad emotion group — lowered brows, soft downturned mouth. Significant object: a wilting flower on the sill. Melancholy, romantic. Asks: who is she waiting for, and will they come?

**Beat:** *A thief realizes he's been spotted.*

> Storyboard panel, close-up of a hunched figure mid-theft, low up-shot to make him feel cornered and exposed, wide-angle for tension and a touch of looming distortion, deep focus. Focal point is his face snapping toward camera, set on the left third, lit by a hard single key from frame-right with deep noir falloff — pure pools of light and shadow. A diagonal shaft of light is the arrow to his eyes; the dark mass of the pedestal in the foreground blocks the lower exit. Triangle composition: pedestal base wide, figure at the apex. Foreground: near-black pedestal edge; midground: the lit, recoiling figure; background: dim vault, low contrast. Line of action is a sharp recoiling C-curve; fear/surprise group — wide eyes, raised brows, body pulling back. Significant object: the jewel still in his gloved hand. Tense, criminal. Asks: who saw him — and what will they do?

---

## Anti-patterns (do not do)

- **Two ideas in one frame.** Split into two frames. If two things must coexist, stage them so only one reads at a time (entrances/exits, obscuring, framing within the frame).
- **Dramatic angle for its own sake.** A canted/extreme angle that doesn't serve the idea = ambiguity.
- **No dominant element.** Everything equal in size/value = the eye has nowhere to land = confusion + boredom.
- **Dead-center symmetry / half-split.** Flat and lifeless unless deliberately stylized.
- **Merged figure/ground.** Subject lost against its background.
- **Open exits.** A bright edge or leading line that walks the eye out of the frame.
- **Crowding.** No negative space; the subject can't breathe.
- **Pretty but mute.** A frame that looks nice but doesn't say its one thing or ask its question.
- **Seeding or ending on the apex in a video keyframe.** A peak-energy action pose has nowhere coherent to animate from or into; the clip drifts or warps at the seam. Use `beat-stage: anticipation` for every generated video keyframe, including end frames.
