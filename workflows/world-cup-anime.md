---
name: world-cup-anime
title: World Cup Anime
category: Sports
description: FIFA-style anime match video — real players restyled into a locked 2D anime look, storyboard-first, per-beat motion, edited to a highlight cut.
use_when: The user wants an anime-style sports/match video featuring real athletes or teams (World Cup, Champions League, boxing, NBA — same recipe, different sport).
---

# World Cup Anime

Storyboard-first production: lock ONE style, cast the players as portfolios, draw
the match as panels, then animate each beat with the technique that fits it. The
panels are the single source of truth — every clip is generated FROM a panel, so
the film stays coherent even across dozens of generations.

## Inputs

Collect these before planning (askUser for anything missing — one dialog, not a
drip):

- players_or_teams (required): which athletes/teams appear. Real people ⇒ real
  photos (REAL PEOPLE rule): search + save 1-2 photos per player to canvas.
- style_anchor: an image that IS the target style (user upload, or search +
  save a frame of the show/style they name). Default: ask — never guess a style.
- beats: the story of the match in 5-10 beats (kickoff, duel, foul, buildup,
  goal, celebration…). Default: propose 6 beats and confirm.
- aspect_ratio: default 16:9 unless the user says shorts/vertical.
- target_length: default ~45-60s (each beat lands 4-8s of screen time).

## Plan template

Instantiate with updatePlan (concrete names filled in):

1. Collect inputs + photos + style anchor (this step)
2. Style reference — portfolio from the style anchor
3. Cast: portfolio per player (photos + style_image_ids)
4. Storyboard: one panel group, one keyframe per beat
5. Review gate: askUser on the storyboard before motion
6. Motion: animate each beat from its panel
7. Assemble the cut in the editor + audio
8. Final review

## Method

1. STYLE LOCK. Save the style anchor to canvas, create a styles reference, and
   generate its portfolio FROM the anchor (conditioning on the anchor image).
   Every later generation inherits or receives this style — one style, zero
   drift.

2. CAST. For each player: reference + portfolio with their real photos in
   conditioning_image_ids and the style anchor in style_image_ids. The face in
   the sheet must read as the player rendered in the style.

3. STORYBOARD PANELS. One keyframe per beat, all in one canvas group (the
   storyboard). Condition each panel on the relevant player portfolios; keep
   the working aspect ratio; stage each beat like a comic panel — readable
   silhouette, one clear action, scoreboard/broadcast framing where it helps.
   Panels ARE the movie: fix composition problems here, not in video.

4. REVIEW GATE. askUser with the storyboard group: approve / swap beats /
   redraw specific panels. Cheap to fix now, expensive after motion.

5. MOTION, PER BEAT — pick the lightest technique that sells the beat:
   - Static drama (standoff, close-up, crowd): the panel i2v with a small push
     or hold. 4s.
   - One continuous action (dribble, shot, save): i2v pinned from the panel
     (start_image_id), one camera move, concrete physical verbs. 4-6s.
   - Fast sequence (goal + celebration + crowd eruption): reference-to-video
     multicut — pass panels + player portfolio images as references, bind names
     to @Image tags, "Cut to:" per internal shot. 8-15s.
   Generate beats in plan order and mark plan steps as you go.

6. ASSEMBLE. addClipToEditorTimeline in beat order, crossfadeClipBridges on
   soft transitions, hard cuts on action. Music via addAudioToTimeline (epic
   anime orchestral, length-matched), fade out at the end.

7. FINAL PASS. Watch order, trim dead frames, verify style consistency across
   beats; re-panel + re-animate any beat that broke style rather than patching
   the clip.
