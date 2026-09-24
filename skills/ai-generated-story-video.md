---
use_when_summary: "Use as the primary production-method skill when a user wants to turn a story, scene, script, trailer, ad, or narrative concept into AI-generated video using consistent characters, locations, objects, portfolios, prose storyboards, keyframes, and image-to-video frame pairs."
when_not_to_use_summary: "Skip for one-off still images, pure copywriting, ordinary code edits, or videos assembled only from existing footage where recurring AI-generated visual identity is not a concern."
medium: video
tags: [story, ai-video, generated-video, keyframes, storyboard, prose-storyboard, shot-list, characters, locations, portfolios, nanobanana, image-to-video]
---
# AI-Generated Story Video

## Use when

- The user wants a story, script, outline, scene, treatment, ad, trailer, music video, short film, or narrative concept turned into AI-generated video.
- The user is likely relying on AI-generated images or video clips instead of filmed footage.
- The video needs recurring characters, locations, props, products, costumes, vehicles, creatures, or branded objects to remain visually consistent.
- The workflow will use generated still frames, keyframes, Nano Banana/nanobanana image generation, or image-to-video tools such as Veo, Sora, Kling, Runway, or similar systems.
- The user asks to "make a story video", "make keyframes", "make frames", "make a sequence", "make a cinematic AI video", "turn this story into a video", or similar.

## When not to use

- The user only wants a single still image with no sequence or recurring identity.
- The user only wants a written script, outline, copy, or marketing strategy.
- The user is editing existing footage and does not need AI-generated recurring visual anchors.
- The task is primarily implementation/code/motion graphics and should use a code skill instead.

## Core principle

Portfolios are ground truth. Shot plans are the execution map.

Do not start by generating arbitrary shots. Consistency comes from approved visual portfolios first. A portfolio is not a moodboard; it is the identity reference future keyframes must copy.

Before any expensive generation, write the method into `execution_state` as a visible checklist. This skill is not complete just because it was loaded. The checklist is the working procedure the planner must follow.

Also write `Primary production method`, `Supporting craft skills`, `Active method`, and `Method contract` in `execution_state`. This is the persistent project-specific version of the skill. Later turns should be able to follow the project docs without relying on re-reading the full skill.

Use this skill as the production controller. Craft skills such as `prose-storyboard`, `camera-as-narrator`, staging, dialogue, or visual-style skills can improve the plan, but they do not replace the production method. If the project is an AI-generated narrative/story video with recurring subjects, this skill should be the primary production method and craft skills should be listed as support.

Minimum method checklist for recurring generated stories:

- Primary production method: `ai-generated-story-video`
- Supporting craft skills: `prose-storyboard`, `camera-as-narrator`, `character-consistency`, or other loaded craft skills as relevant
- [ ] Inventory recurring visual anchors
- [ ] Write portfolio prompts for recurring anchors
- [ ] Generate portfolio contact sheets
- [ ] Get explicit portfolio approval after portfolios are visible
- [ ] Write prose storyboard or shot plan
- [ ] Plan keyframes or frame pairs from approved anchors
- [ ] Generate video clips from approved references/keyframes
- [ ] Assemble and review

Forbidden shortcut: do not jump from a beat storyboard, prose summary, or single hero/reference image directly to video generation when recurring characters, locations, creatures, robots, vehicles, props, costumes, or style anchors still need portfolios. This applies to text-to-video, image-to-video, reference-to-video, and first-frame/last-frame tools.

Default approval behavior: the portfolio checkpoint is the only required user approval gate. After the user approves portfolios, continue end-to-end through prose storyboard, keyframes, video clips, and assembly unless the user explicitly asks for another checkpoint, requests revisions, or a tool failure/quality issue makes continuing unsafe. Do not invent a keyframe approval gate by default.

Default extension behavior: when the user asks to extend, make longer, add what happens next, or continue an already assembled generated story, keep using the established keyframe/frame-pair method. Update storyboard and `execution_state` `Continuation plan` first. For a seamless continuation, capture the actual final frame of the current rendered clip and use that captured frame as the next clip's `first_frame_url`. Generate only the destination/end keyframe(s), then create first-frame/last-frame or reference-based clips and append them. Do not replace the captured final frame with a regenerated "next first keyframe" unless the plan explicitly says the continuation is a cut, time jump, or stylized transition.

For recurring elements, ground future frames in approved portfolios:

- Character face, body type, hair, outfit, accessories, posture, silhouette
- Location architecture, layout, materials, palette, lighting, weather, recurring props
- Object/product shape, markings, texture, logo placement, scale, wear, color
- Vehicle/creature design, proportions, distinctive markings, surface details
- Overall style references when the whole film must share a specific look

If an element will appear repeatedly, make or request a portfolio before relying on it in keyframes.

For cinematic, multi-character, action, dialogue, or visually complex scenes, do not jump from portfolios directly to video generation. Load `prose-storyboard` and make a shot-level plan first.

## Workflow

### 1. Understand the video

Capture enough to proceed:

- Story or concept
- Desired generated/playback duration
- Aspect ratio
- Visual style
- Main characters
- Primary locations
- Important recurring props/products
- Tone and pacing
- Whether the video needs narration, dialogue, sound design, captions, or silent visuals

Prefer useful assumptions over blocking questions. If the user gives only a loose concept, infer a compact plan and present it before generation.

### 2. Inventory recurring visual anchors

Before keyframes, list assets that need consistency:

- Character portfolios
- Location portfolios
- Object/product portfolios
- Wardrobe/costume portfolios when outfit changes matter
- Vehicle/creature portfolios
- Style references

For each asset, decide:

- Does it recur?
- Does it need a portfolio?
- Can it use a user-provided image?
- Does it need portfolio revision approval before keyframes?

Default: recurring visible assets need portfolios.

### 3. Generate portfolios first

Create portfolios before keyframes.

The first generation tools in a recurring-identity workflow should normally be image/portfolio generation tools, not video tools. Video generation comes after the visual anchors are approved or after the user explicitly chooses to skip portfolios after hearing the risk.

Portfolio goals:

- Make the asset reusable.
- Show multiple angles, distances, and important details.
- Lock identity, proportions, style, palette, and materials.
- Provide image references for future frame generation calls.

Portfolio types:

- Character portfolio: same character/design across multiple views and expressions
- Location portfolio: same place across multiple angles, details, and atmosphere views
- Object/product portfolio: same object across sides, closeups, scale, markings
- Style portfolio: optional, when style is not already embedded in the other portfolios

Default portfolio format:

- Generate portfolios as clean 3x3 contact sheets unless the user asks for another format.
- A single hero portrait, duo poster, reference still, or beauty image does not satisfy this step.
- Do not make loose moodboards or arbitrary design boards when the asset will anchor generated video.
- Use no labels, captions, speech bubbles, UI text, or typography inside the image.
- Keep one coherent identity/style across all 9 cells. The cells are variations in shot scale and angle, not different characters or different designs.

Character portfolio 3x3:

- Row 1: ELS/LS full-body identity in the intended environment, showing silhouette, wardrobe, and scale.
- Row 2: MLS/MS action-readable poses and body language, showing how the character moves.
- Row 3: MCU/CU/ECU identity and detail views: face, hands, outfit materials, props, distinctive marks.
- Columns: front, 3/4, and side/action variation.

Location portfolio 3x3:

- Row 1: ELS/LS geography and establishing views.
- Row 2: MLS/MS usable action spaces, paths, entrances, cover, staging zones.
- Row 3: MCU/CU/ECU texture and detail views: materials, hazards, props, atmosphere.
- Columns: different camera directions within the same place, not unrelated locations.

Object, robot, creature, or vehicle portfolio 3x3:

- Row 1: ELS/LS silhouette and scale next to environment or human reference.
- Row 2: MLS/MS functional views and action poses.
- Row 3: MCU/CU/ECU details: joints, sensors, weapons, materials, markings, wear.
- Columns: front, 3/4, and side/action variation.

Portfolio prompt pattern:

```text
Create a clean 3x3 cinematic portfolio contact sheet for [asset].
No labels, no captions, no text, no UI.
Keep one consistent identity/design across all nine cells.
Row 1: ELS/LS full-body or establishing views.
Row 2: MLS/MS readable action/body-language views.
Row 3: MCU/CU/ECU detail views.
Columns: front, 3/4, side or action variation.
[asset-specific design details]
```

### 4. Stop for portfolio approval

After portfolios are generated, stop and ask the user to approve or revise them.

Approval must happen after the user can see the generated portfolio. The user's original request, a general "go ahead," or permission given before the portfolio exists does not count as portfolio approval.

Exception: if the user explicitly requested autonomous execution with phrases like "don't check in", "no checkpoints", "take it end to end", or "continue without asking", skip the approval stop. Record `user_autonomy_override` in `execution_state`, note that consistency risk increases if a portfolio is flawed, and continue into keyframes/clips.

Use language like:

```text
Do these portfolios look right enough to use as ground truth for the video?
```

Do not proceed to keyframes until the user approves, revises, or explicitly says to continue despite issues.

Record this approval state in `execution_state` before moving to keyframes or clips. After approval, continue end-to-end into keyframes, clips, and assembly.

After portfolio approval, do not stop again for default keyframe approval. Keyframes are an internal continuity scaffold unless the user explicitly asks to review them. Generate the planned keyframes, then continue into clip generation and assembly.

After portfolio approval, the next generation step is portfolio-conditioned keyframes. Use `nanoBananaImagesToImage` with the approved portfolio image URLs. Do not generate keyframes from text alone once portfolios exist, and do not call video-generation tools (`seedanceFirstFrameLastFrame`, `seedanceFastReferenceToVideo`, `seedanceFastImageToVideo`, `seedanceFastTextToVideo`) until at least two valid portfolio-conditioned keyframes exist.

If the user requests changes, revise the portfolio first. Do not patch around a bad portfolio with later prompts. Bad ground truth creates drift. When a portfolio or earlier keyframe needs to be replaced, regenerate it with the same `plan_output_id` when replacing the same slot, or create a new slot when changing the plan. Record the supersession in `execution_state` so subsequent steps reference the new asset and ignore the old one. Treat `execution_state` as the working ledger of which portfolio and keyframe assets are currently authoritative.

Use concrete Output plan slots for each generated asset. Prefer `portfolio_boy`, `portfolio_man`, `kf_b1_001`, `kf_b1_002`, `clip_b1_001`, etc. Do not use aggregate slots like `keyframe_set` or `clip_set` when multiple separate assets will be generated. Pass `plan_step_id` and `plan_output_id` on every generation tool call intended to fill a slot. Omit those IDs only for intentionally unplanned exploratory outputs.

When updating the Output plan, never omit prior steps. To remove or deprioritize a phase, keep the step and set `status: "skipped"` so the visible plan does not collapse or leave `current_step_id` dangling.

For clip generation between two adjacent keyframes, prefer first-frame/last-frame video generation (`seedanceFirstFrameLastFrame`) over single-frame image-to-video. Frame pairs preserve continuity across cuts; single-frame inputs discard the endpoint and produce drift between clips. Before requesting the same start frame a second time, check `asset_ledger` (via `queryAssetLedger`) to confirm you are not regenerating a clip already produced.

### 5. Plan the prose storyboard when shots matter

Use `prose-storyboard` before keyframes/video generation when the scene has complex action, multiple characters, camera choreography, coverage, geography, or a user asks for "shots."

The prose storyboard should define:

- Shot count and setup count
- Shot size: ELS, LS, MLS, MS, MCU, CU, ECU
- Camera angle and movement
- Subject/action/sound for each shot
- Which portfolios or references each shot uses
- Which shots become still keyframes vs video clips

Do not treat a "hero beat" as enough for complex cinematic generation. A hero beat still needs designed shots if the action has multiple readable moments.

### 6. Plan single keyframes

After portfolio approval, plan one frame at a time:

- Frame 1
- Frame 2
- Frame 3
- Frame 4
- Frame 5

Each adjacent frame pair should represent one clean motion interval. Calm dialogue or atmosphere can use longer pairs; action needs shorter spans and denser keyframes.

Rule of thumb:

- Calm, low-motion pair = can run longer when the endpoint change is subtle.
- Action pair = usually 4-5 seconds and one clear move.
- Complex action sequence = add intermediate keyframes every 1-2 seconds of meaningful motion.

Do not cram too many story beats into one pair. If more than one major beat happens, add another keyframe.

## Continuous vs cut decisions

For every frame pair, explicitly choose one transition type.

### Continuous

Use when the scene, camera setup, character positions, and location remain continuous.

For the next keyframe, provide:

- Approved portfolios
- The previous accepted frame
- A precise instruction for what changes next

The previous frame is the continuity anchor. The portfolios are the identity anchors.

### Cut

Use when changing location, camera setup, time, scale, angle, or story beat.

For the next keyframe, provide:

- Approved portfolios
- Style reference if needed
- Previous frame only if it helps match style or action

Do not tell the image model to continue the exact prior frame if the shot is a cut.

### Hard cut with same assets

Use when the same characters or location appear, but the camera setup changes.

Examples:

- Wide shot to close-up
- Exterior storefront to product insert
- Hero running, then cut to shoes hitting pavement

Use portfolios as identity anchors. Use the previous frame only when screen direction or action continuity matters.

## Keyframe prompt patterns

### First keyframe in a shot or scene

Use:

- Approved character portfolios
- Approved location portfolio
- Approved object/product portfolios
- Style reference if available
- A clear frame-specific prompt

Define:

- Frame number
- Story beat
- Shot type and camera angle
- Character placement and action
- Environment/location
- Lighting, mood, and style
- Any dialogue/audio context that affects expression or staging

### Next keyframe in a continuous scene

```text
Use the attached portfolios as exact identity references for the recurring characters, location, and objects.

The attached previous frame is the last accepted frame of the current shot.

Generate Frame N, the next necessary keyframe for the next single readable motion. Keep the same scene continuous unless explicitly changed. Preserve character identity, wardrobe, location layout, lighting direction, color palette, and screen geography.

Change only what the story beat requires:
[describe what happens next]

Frame N should show:
- Shot type:
- Camera position:
- Character action:
- Emotional state:
- Environment changes:
- Important props:

No text overlays, no captions, no speech bubbles, no extra characters, no invented props.
```

### Seamless extension from an existing rendered clip

Use when the user asks to continue, extend, make longer, or add what happens next without requesting a cut or time jump.

Process:

- Capture the actual final frame of the current rendered clip.
- Treat that captured frame as the canonical continuation anchor.
- Use the captured frame directly as the next `first_frame_url`.
- Generate the next destination/end keyframe from approved portfolios plus the captured frame.
- Use `seedanceFirstFrameLastFrame` from captured final frame -> generated destination keyframe.
- Append the generated clip after the existing clip.

Do not regenerate a replacement first keyframe for a seamless extension. The extracted frame is already the first frame. If you intentionally do not use it as `first_frame_url`, record the reason in `execution_state.Continuation plan` as a cut, time jump, camera reset, or stylized transition.

### Keyframe after a cut

```text
Use the attached portfolios as exact identity references.

Generate Frame N as a new shot after a cut. This is not a continuation of the previous camera setup.

The shot should show:
[new shot description]

Preserve all recurring asset identities from the portfolios. Match the approved visual style. Do not add unmentioned characters, props, logos, captions, speech bubbles, or text overlays.
```

## Frame pair timing

Each frame pair should represent one clean, interpolable motion. Do not default to 10-second spans for action. Fight, chase, race, dance, stunt, and complex blocking need denser keyframes: usually one keyframe every 1-2 seconds of meaningful motion and short 4-5s image-to-video clips.

Use this to control density:

- Small gesture or emotional shift: one pair can cover it, often as a longer quiet shot.
- Full action beat: one pair only if it is a single simple motion.
- Dialogue-heavy moment: one pair per major line or emotional turn.
- Chase, fight, race, dance, stunt, or complex blocking: use more keyframes because spatial continuity matters. Never ask one first/last-frame clip to perform multiple technical moves.
- Location change: usually a cut and a new pair.

For a calm 30-second video, roughly 4 keyframes / 3 pairs can work:

- Frame 1 -> Frame 2: 0-10s
- Frame 2 -> Frame 3: 10-20s
- Frame 3 -> Frame 4: 20-30s

For a 30-second action sequence, expect many more keyframes. Plan 6-12 short frame pairs depending on how many distinct moves must be readable.

For a calm 60-second video, roughly 7 keyframes / 6 pairs can work, then adjust for pacing. For action, scale keyframes by motion complexity, not total duration.

## Output planning format

```markdown
## Visual Anchors
- Character portfolios:
- Location portfolios:
- Object/product portfolios:
- Style references:

## Portfolio Approval Gate
Generate these portfolios first, then wait for approval:
1. ...
2. ...

## Prose Storyboard / Shot Plan
Use prose-storyboard when the scene needs designed shots before generation.

SHOT 1 (Setup #1)
- Size:
- Angle:
- Movement:
- Subject:
- Action:
- Uses portfolios:
- Purpose:

SHOT 2 (Setup #2)
- ...

## Keyframe Plan
Frame 1:
- Time: 0s
- Shot:
- Uses portfolios:
- Description:

Frame 2:
- Time: ~10s
- Transition from previous: Continuous | Cut
- Uses portfolios:
- Previous frame reference: Yes | No
- Description:

Frame 3:
- Time: ~20s
- Transition from previous: Continuous | Cut
- Uses portfolios:
- Previous frame reference: Yes | No
- Description:

## Video Pair Plan
- Pair 1: Frame 1 -> Frame 2, ~10s, Continuous | Cut
- Pair 2: Frame 2 -> Frame 3, ~10s, Continuous | Cut

## Dialogue Contract
- Mode: no_audible_speech | nonverbal_only | exact_dialogue | voiceover_exact
- Continuity topic:
- Speakers:
  - Speaker:
    - Speaker description:
    - Exact line(s):
    - Delivery:
    - Timing:

## Endpoint Verification
- Planned endpoint for each generated clip:
- First-frame/last-frame outputs to inspect:
- If last frame is incomplete: extend | regenerate | use partial intentionally
```

## Generation order

1. Asset inventory
2. Portfolio prompts
3. Portfolio generation
4. User approval or revision
5. Prose storyboard / shot plan when the scene needs designed shots
6. Keyframe plan derived from the shot plan, with concrete per-keyframe Output plan slot IDs
7. Generate Frame 1 with `nanoBananaImagesToImage`, conditioned on approved portfolio images
8. Generate Frame 2 with `nanoBananaImagesToImage`, conditioned on Frame 1 and any relevant portfolios
9. Continue frame-by-frame using the previous frame and portfolios as references
10. Generate video clips from adjacent frame pairs with `seedanceFirstFrameLastFrame` (frame N as `first_frame_url`, frame N+1 as `last_frame_url`)
11. Inspect generated clip first/last frame outputs; verify the clip actually reached the intended endpoint
12. If endpoint is incomplete, extend/regenerate or deliberately accept the partial result before marking the pair complete
13. Stitch clips in sequence
14. Present the assembled draft for review

Do not add a keyframe review gate between steps 8 and 10 unless the user explicitly requested keyframe approval. The default workflow should take the project end-to-end after portfolio approval.

## Dialogue contract

If a generated story clip contains audible speech or voiceover, pass the video generation tool's typed `dialogue` object instead of leaving speech vague in the prompt.

Use:

- `mode: "exact_dialogue"` for in-scene audible speech.
- `mode: "voiceover_exact"` for narration.
- `mode: "no_audible_speech"` or `mode: "nonverbal_only"` when there should be no intelligible speech.

Each spoken line needs:

- `speaker`: short label
- `speaker_description`: visual description that identifies who is speaking in frame
- `text`: exact audible words
- optional `delivery`
- optional `timing`

Never write "small talk", "they discuss", "arguing", "conversation", or "explains the plan" as the only speech direction. Exact words are required when audible speech matters. Do not set `allow_captions` unless the user explicitly asked for visible captions/subtitles.

## Endpoint verification

After successful video generation, inspect the returned first-frame and last-frame images before marking the video-pair milestone complete.

- If the last frame matches the planned endpoint, record completion in `execution_state`.
- If the last frame is mid-action or wrong, record the mismatch and decide whether to extend, regenerate, or use the partial clip deliberately.
- For a continuous next clip, use the actual generated last frame as the next continuity anchor.
- Do not assume the prompt endpoint happened just because the generation call succeeded.

## Extension mode

Use this when the project already has an assembled generated story and the user asks for more.

1. Read the current `execution_state` and storyboard.
2. Update the storyboard with the new continuation beat(s).
3. Update `execution_state`:
   - `Current phase`: extension_planning or extension_generation
   - `Active method`: ai-generated-story-video
   - `Method contract`: continue the approved portfolio/keyframe/frame-pair workflow
   - `Continuation plan`: existing last frame, new story beat, new keyframes, new clip pairs, append/assembly target
4. For seamless continuation, capture the current rendered clip's actual final frame and make it the next clip's `first_frame_url`.
5. Generate or plan the next destination keyframe(s) from approved portfolios plus the captured final frame.
6. Generate clips from captured final frame -> destination keyframe, or from adjacent generated keyframes after that.
7. Append clips to the existing sequence and update `execution_state`.

Do not do this for extensions:

- Do not call image-to-video directly from the captured final frame as the first extension generation.
- Do not generate a replacement first keyframe for a seamless continuation.
- Do not discard the existing keyframe plan.
- Do not make a new unrelated standalone video.
- Do not ask for keyframe approval unless the user explicitly requested it.

Exception: if the continuation should intentionally jump in time, change camera setup, or hard-cut to a new shot, record that in `Continuation plan`. In that case, the captured frame can be style/context reference instead of `first_frame_url`.

## Revision logic

If a portfolio is wrong:

- Revise the portfolio.
- Do not continue to keyframes.

If a keyframe is wrong but portfolios are right:

- Regenerate or edit that keyframe using the same portfolios.
- If it is a continuous frame, include the prior accepted frame again.

If continuity drifts:

- Re-anchor with portfolios.
- Include the last accepted frame.
- Use narrower change instructions.
- Mention exact screen geography, pose, lighting, and camera continuity.

If identity drifts repeatedly:

- Stop and improve the portfolio.
- The portfolio is probably not specific enough or not visually stable.

## Prompting rules

Use concrete visual language.

Prefer:

- "Maya remains on frame-left, turned three-quarters toward the blue-lit doorway"
- "Same red jacket, same short black bob, same silver ear cuff"
- "The motel room layout remains identical: bed on right, window behind, green lamp on desk"
- "Only her expression changes from guarded to alarmed"

Avoid:

- "Make it cinematic"
- "Continue the story"
- "Same vibe"
- "More dramatic"
- "Improve it"

Always say what should not change:

- Character identity
- Wardrobe
- Location layout
- Time of day
- Color palette
- Camera direction, if continuous
- Important props

Always forbid common failures:

- No text overlays
- No captions
- No speech bubbles
- No extra characters
- No invented props
- No logo changes unless requested
- No costume changes unless requested

## Example mini workflow

User asks:

```text
Make a 30-second video of a cyberpunk courier delivering a glowing package through a neon market.
```

Reasoning:

- Recurring character: courier
- Recurring location: neon market
- Recurring object: glowing package
- Need portfolios first
- 30 seconds can use 4 keyframes / 3 frame pairs for calm material; action needs more.

Response plan:

```markdown
## Visual Anchors
- Courier character portfolio
- Neon market location portfolio
- Glowing package object portfolio

## Portfolio Approval Gate
I will generate those three portfolios first. After you approve them, I will make the keyframes.

## Keyframe Plan
Frame 1, 0s:
Wide shot. Courier enters the neon market holding the package.

Frame 2, ~8-10s:
Continuous. Courier moves through the crowd, package glow reflecting on their jacket.
Use Frame 1 as previous-frame reference.

Frame 3, ~18-20s:
Cut. Close shot at the delivery door, courier raising the package toward scanner.
Use portfolios, not strict Frame 2 continuity.

Frame 4, ~28-30s:
Continuous. Door opens with blue light spilling over courier and package.
Use Frame 3 as previous-frame reference.

## Video Pairs
- Frame 1 -> Frame 2, ~8-10s, continuous calm movement
- Frame 2 -> Frame 3, ~8-10s, cut
- Frame 3 -> Frame 4, ~8-10s, continuous calm movement
```

## User-facing behavior

Be explicit with the user:

- "I’ll make the portfolios first and stop for approval."
- "Once you approve these, I’ll use them as ground truth for every keyframe."
- "Calm frame pairs may run longer; action will use denser keyframes and shorter clips."
- "For continuous pairs, I’ll include the previous frame. For cuts, I’ll use the portfolios without forcing the previous composition."

If the user asks to skip approval, continue but state the risk:

```text
I can skip the approval gate, but consistency failures become more likely because bad portfolios will propagate into every frame.
```

## Success criteria

- Clear asset inventory
- Portfolio-first plan
- Explicit approval checkpoint
- Single-frame keyframe sequence
- Frame-pair length chosen by motion complexity, with dense short pairs for action
- Continuous/cut decision for each pair
- Previous-frame reference only when continuity needs it
- Portfolios used as exact references throughout
- No unapproved recurring visual drift
