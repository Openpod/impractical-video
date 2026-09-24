---
name: directors-notebook
description: Comprehensive pre-production pass for a narrative scene — Proferes' full method (detective work, dramatic blocks, fulcrum, staging, camera plan, actor direction) written into the project graph. The hub skill that ties together cuts, camera-narrator, direct-eyes, and prose-storyboard for a complex scene.
use_when_summary: "Read FIRST when planning essentially any story or world video — a film, trailer, ad, montage, or 'what if' concept, with or without explicit dialogue. The default comprehensive planning pass; pulls in cuts, camera-narrator, direct-eyes, film-grammar and outputs scene/clip/keyframe records. Skip only for a single isolated clip with no story."
tags: [planning, scene, directing, hub]
---

# Director's Notebook — the comprehensive planning pass

Nicholas Proferes' full pre-production method from *Film Directing Fundamentals*,
applied to a generated narrative scene. Use this for a scene that has real
dramatic content — characters with wants, a turn, staging, dialogue — where a
bare cut map isn't enough. It is the HUB: it directs you to load the supporting
craft skills at the right step and synthesizes them into the project graph.

Do NOT write a prose notebook document. Every section below produces SOURCE —
scene records, the planned cut map (clips), and keyframe stubs — that the rest
of the pipeline consumes.

## 1. Detective work → the scene record

Decide and write into `scenes/<idx>-<slug>/scene.md` (frontmatter + body):
- Whose scene is it (who drives it).
- Per character: core trait, scene want (active infinitive), expectation, secret.
- The tone in one sentence.
- Where it sits in the story; what the audience must learn/feel here.
Recurring characters/locations/props each need a `references/` entry + portfolio
before keyframes rely on them.

## 2. Dramatic structure → the beat list

In the scene body, break the scene into 2–4 **dramatic blocks** (title, dominant
dynamic, escalation) and name the **fulcrum** — the irreversible turn. List the
**narrative beats** (what the audience must receive). This is what each shot has
to deliver; it drives the cut map.

## 3. Camera + cuts → the cut map (planned clips)

Load **`cuts`** (where/why to cut, what part of the action, pacing) and
**`camera-narrator`** (objective/subjective, reveal, shot size, the single
camera move). Together they produce the cut map: write each shot as a planned
clip record (`clips/<id>.md`, `status:"planned"`) with `shot_size`,
`camera_move`, `cut_motivation`, and `transition_from_previous`. Only set
`duration_seconds` when it is the actual generated/playback duration; never use
it as a shorter editorial trim. Give the fulcrum the strongest camera choice.
Decide the LAST shot first.

## 4. Staging + composition → the keyframe stubs

Load **`storyboard-image-direction`** first (one clear picture-sentence,
anticipation-frame keyframes for video, readable staging), then **`direct-eyes`**
(focal point via contrast/value/depth/framing + the named lighting source).
For each clip, write planned keyframe stubs
(`keyframes/<id>.md`, `status:"planned"`) whose bodies state staging (positions,
blocking, screen direction), composition (focal point, depth layers, framing),
and which references they depict. Continuous shots share a keyframe node; cuts
do not. Keep screen direction and the 180-degree line consistent across the
chain.

## 5. Dialogue + actor direction

For shots with speech, set the clip `dialogue` contract (mode + timed lines,
speakers = characters reference ids). In the keyframe/clip bodies, note the
actable verb and delivery for each beat — direction the generation prompt can use
("pleading, not arguing"; "withdrawn, eyes down").

## 6. Review

After keyframes generate, the independent review (`reviewKeyframes`) + the
`film-grammar` checklist catch identity drift, geography/180-line breaks, and
near-static pairs. Read **`film-grammar`** for the checklist.

## Output check

When the pass is done you should have: one scene.md with the dramatic analysis,
a planned cut map of clips (named motivations, one aspect ratio, deliberate shot
sizes), and planned keyframe stubs with staging/composition. Run `checkProject`
and judge pacing/structure against the report. Then generate portfolios →
keyframes → review → clips. The notebook is the plan in the graph, not a
document.
