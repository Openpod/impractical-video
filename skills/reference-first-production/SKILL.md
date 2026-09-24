---
name: reference-first-production
description: Use when taking on ANY generation task that involves a character, environment, prop, or style that could recur — before creating scenes, keyframes, or clips. Encodes the project's reference-first reasoning: decide canvas vs production intent, create references and portfolios first, then derive keyframes and clips from them.
---

# Reference-First Production

The dependency graph is the product. Pixels are cheap; identity is not.
When a person, place, object, or look might appear more than once, its
identity must be anchored in a reference BEFORE anything derives from it —
otherwise every keyframe re-rolls the identity and continuity dies.

## Intake reasoning (run this before generating anything)

1. **Classify the ask.**
   - One-off image/clip with no recurring identity → generate directly
     (canvas mode). Done; skip this skill.
   - Anything with a named character, a world/setting, a hero prop, or a
     story told across shots → production mode; continue.
2. **Inventory identities.** List every character, environment, prop, and
   style the task implies — including implicit ones ("three soldiers" = three
   character identities sharing one armor prop/style).
   SUPPORTING CAST GETS THE SAME TREATMENT AS LEADS. When the story is set
   in a real world (a real team, company, city, fandom), supporting
   characters default to parodies of the real, recognizable people — pull
   real photos for them exactly as for the lead (`internet-style-references`).
   Invent an original character only when no real counterpart exists or the
   user asks for one — and an invented character's portfolio display then
   becomes its only identity anchor, which MUST be attached (reference_ids /
   conditioning) in every single generation it appears in. An identity
   grounded only in style is an identity that drifts.
3. **Create references first.** For each identity:
   `references/<category>/<id>/reference.md` (categories: characters,
   environments, props, styles). Write the identity in durable, specific
   visual language — this document outlives any single generation.
4. **Lock the look with a portfolio.** Generate it by calling
   `generate_image` with `portfolio_reference_id: "<id>"` and
   `portfolio_category: "<category>"` — the app generates the 3x3 contact
   sheet AND a derived single display/profile shot (the tile's face), and
   writes `portfolio.md` itself. Never hand-write portfolio frontmatter or
   create a separate keyframe for the sheet. A bland portfolio propagates
   blandness into every derived asset. For adult female characters with
   attractive/glamour intent, load `adult-glamour-portfolio` before
   writing the prompt.
5. **Then scenes → clips, by whichever method fits the shot.** The typical
   method is the `seedance-clip-chaining` flow (clip grounded in the
   references, extended clip-by-clip via the previous clip's last frame +
   continuation prompting). `keyframe-interpolation` is the opt-in flow
   when exact first/last-frame control matters. Keyframes are a method,
   not a mandatory stage — whichever path you take, the references must
   reach the generation (conditioning images + identity re-stated in the
   prompt), and records should carry `depicts`/keyframe links where they
   exist so lineage stays traceable.
6. **Check.** Run `check_project` after the graph changes, and regenerate
   only what the checker reports stale.

## Prompt hygiene

Reference documents are markdown; generation prompts are not. When
generating from a reference, distill it into plain flowing prose — never
paste `##` headings, bullets, backticks, or the raw document body into a
`generate_image`/`generate_clip` prompt. Markdown artifacts in provider
prompts have unknown effects on output quality.

## Anti-patterns

- Scene → keyframes with no reference for a character who will appear
  again. If the user asks "why didn't you create a character reference?",
  this skill was skipped.
- Encoding identity only inside keyframe prompts. Prompts are per-asset;
  identity lives in the reference.
- Creating references for true one-offs. A single disposable insert shot
  does not need the ceremony — judgment, not ritual.

## User intent is law

Users define characters, body types, wardrobe, and aesthetics as they see
fit. Carry their explicit direction into references and prompts faithfully —
translate it into affirmative visual language rather than hedging or
stripping it. Hard boundary (never overridden): no sensualization of minors,
teens, or ambiguous-age characters.
