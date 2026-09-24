---
name: prose-storyboard
description: Use Nicholas Proferes-style prose storyboard methodology to turn a scene, portfolio-approved generated film concept, or cinematic beat plan into explicit shot entries before generating video. Use for shot planning, ELS/LS/MS/CU sizing, setup counts, camera angle, camera movement, subject/action/sound, coverage, continuity, and preventing vague one-prompt video generation.
use_when_summary: "Use before expensive video generation when a cinematic scene needs designed shots, especially generated films, multi-character scenes, portfolio/keyframe workflows, action scenes, coverage planning, or when the user asks for shots, shot list, prose storyboard, camera plan, ELS, LS, MS, CU, coverage, blocking, or previs."
when_not_to_use_summary: "Skip for one-off utility edits, pure code/motion-graphics work, trivial single-image requests, or cases where the user explicitly wants a single rough prompt without shot planning."
medium: video
tags: [video, storyboard, prose-storyboard, shot-list, shots, camera, previs, coverage, blocking, proferes, ELS, LS, MLS, MS, MCU, CU, ECU, generated-video, portfolio, keyframes]
argument-hint: "[scene text, staging plan, or file path]"
---

# Prose Storyboard

## Use when

- A scene or generated-video concept needs explicit shot design before image/video generation.
- The user asks for shots, shot list, camera plan, coverage, prose storyboard, previs, ELS, LS, MS, CU, or "make the shots before the video."
- A generated film uses portfolios, character bibles, recurring locations, creatures, props, or keyframes and needs a shot-by-shot plan before expensive video generation.
- The scene has multiple characters, staging complexity, action, dialogue, reveals, or continuity risk.

## When not to use

- The user only wants a still image, a simple single prompt, or a fast rough draft with no planning.
- The task is purely code, UI, captions, overlays, trimming, or motion graphics.
- A prior prose storyboard is already approved and the current task only executes one existing shot.

## Core objective

Create a written shot-by-shot blueprint before generation. Each shot should tell the model what the audience sees, why the shot exists, and how it connects to adjacent shots. This prevents vague "cinematic scene" prompts that collapse many story beats into one generation.

For AI-generated video, use this skill after the brief/portfolio intent is known and before first video generation. If portfolios or character bibles are required, plan the prose storyboard around those approved visual anchors.

This is a craft skill, not the primary production method. If the project is an AI-generated narrative/story video with recurring characters, locations, or long-form continuity, also load `ai-generated-story-video` and record it in `execution_state` as the `Primary production method`. Use this skill as a supporting craft skill for shot design.

## Reasoning steps

1. **Identify the dramatic blocks.** Split the scene into visual beats: setup, pressure, reveal, turn, payoff, aftermath.
2. **Choose shot scale deliberately.** Use ELS/LS for geography and scale, MLS/MS for readable action and relationships, MCU/CU/ECU for emotion, detail, threat, or payoff.
3. **Design setups, not generic coverage.** A setup is a camera position; several edited shots can come from one setup. Keep the setup count realistic.
4. **Define continuity anchors.** Track screen direction, subject positions, wardrobe/portfolio references, props, eyelines, and location geography.
5. **Write each designed shot.** Include setup number, shot number, size, angle, movement, subject, action, sound, pace feel, and purpose.
6. **Mark the fulcrum.** Identify the shot where the scene turns. Change shot scale, movement, or rhythm there if useful.
7. **Convert to generation units.** For generated video, group shots into keyframes or clips only after the prose storyboard is clear. Do not generate a multi-beat video from a single vague prompt when shot planning is needed.

## Structure

```
PROSE STORYBOARD: [Scene Title]

SHOT 1 (Setup #1)
  SIZE: [ECU | CU | MCU | MS | MLS | LS | ELS]
  ANGLE: [eye level | low | high | bird's-eye | Dutch]
  MOVEMENT: [static | pan | tilt | dolly | track | crane | handheld | Steadicam]
  SUBJECT: [who/what is in frame]
  ACTION: [what changes during the shot]
  SOUND: [dialogue, sound design, silence, impacts, ambience]
  PACE FEEL: [brief | held | extended] (descriptive only; do not write a shorter playback duration)
  PURPOSE: [dramatic or informational job]

SHOT 2 (Setup #2)
  ...
```

## AI-generated video workflow

When this skill is used inside the planner:

1. If recurring identities or long-form AI-generated narrative continuity exist, pair this with `ai-generated-story-video` and `character-consistency`. Do not let `prose-storyboard` replace the production workflow.
2. Generate/approve portfolios or character bibles before final keyframes when identity consistency matters.
   Default portfolio format is a clean 3x3 contact sheet: row 1 ELS/LS, row 2 MLS/MS, row 3 MCU/CU/ECU; columns front, 3/4, and side/action variation. Do not use loose moodboards when the portfolio will anchor generated video.
3. Pair with the `cuts` skill for the edit decisions (motivations, rhythm, what part of the action to show).
4. Write the storyboard INTO THE GRAPH, not as prose: each designed shot becomes a planned clip record (`clips/<id>.md`, `status:"planned"`) with `shot_size`, `transition_from_previous`, `cut_motivation`, and a `dialogue` contract when anyone speaks (speaker = characters reference id, timed lines), plus planned keyframe stubs (`keyframes/<id>.md`) whose bodies say exactly what each frame must show and which references it depicts. Only include `duration_seconds` when it is the actual generated/playback duration, not a shorter editorial trim.
5. Only then generate still frames or video clips — final shot's keyframes first, working backward.

## Shot size guide

- **ELS (extreme long shot):** geography, scale, armies, isolation, environment dominance.
- **LS (long shot):** full bodies and action in readable space.
- **MLS (medium long shot):** body language plus some environment.
- **MS (medium shot):** relationships, tactical exchange, readable character action.
- **MCU (medium close-up):** reaction, determination, emotional pressure.
- **CU (close-up):** face, hand, weapon, wound-free impact detail, key prop.
- **ECU (extreme close-up):** single detail, eye, trigger, warning light, alien texture.

## Heuristics

- Start wide enough for the audience to understand geography before compressing into action.
- Do not make every shot an MS. Vary image size to control attention and rhythm.
- A shot exists because it changes story information, emotion, geography, or tension.
- If a shot cannot name its purpose, cut it or merge it.
- For action, alternate geography shots with readable action shots; avoid continuous chaos.
- For multi-character scenes, keep screen direction and role clarity stable.
- For generated video, one generation should usually cover one designed shot or one continuous shot pair, not an entire complex scene.
- For generated video with audible speech, `SOUND` must name exact spoken lines and who says them. Do not use vague placeholders like "small talk" or "conversation"; if speech is only implied, mark the shot `nonverbal_only` or `no_audible_speech`.

## Common failures

- **Generated video before making shots.** This usually produces generic action and weak continuity. Make the prose storyboard first.
- **One vague hero prompt for a multi-beat scene.** Break the scene into ELS/LS/MS/CU shots or keyframes.
- **No geography.** Without an ELS/LS or equivalent establishing shot, action becomes unreadable.
- **No fulcrum.** The scene has movement but no turn.
- **Shot list ignores portfolios.** Recurring characters drift if shot prompts do not reference the approved character/location/object portfolios.
- **Coverage instead of design.** Generic wide/medium/close coverage is weaker than shots with specific dramatic jobs.

## Review the plan with the linter, not by eye

After writing the planned clip/keyframe records, run `checkProject` and read the
pacing report (shot count, mean duration, transition mix, shot-size runs,
motivations named). Fix structural errors it raises, then sanity-check:

- 2–3 key visual moments exist as designed shots, not hoped-for byproducts.
- Every recurring identity in a shot lists its portfolio in the keyframe stub.
- Continuity-critical details (props, wardrobe, screen direction) are stated in
  the keyframe stub bodies where generation will actually read them.
