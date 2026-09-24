---
name: keyframe-interpolation
title: Keyframe Interpolation
category: Video methods
description: Precision method — pin a clip's exact first and last frames with generated keyframes and interpolate between them. Strongest continuity guarantees, most setup.
use_when: The user wants exact control over how a shot starts and ends (match cuts, loops, precise choreography), or explicitly asks for the keyframe method. Not the default — see seedance-clip-chaining.
---

# Keyframe Interpolation

The original pipeline: generate the boundary frames first, then have the
video model interpolate between them. Maximum control over composition at
the cost of extra generations.

1. Derive keyframes from the references (`generate_image` conditioned on
   the relevant portfolios; keyframes declare `depicts`).
2. Generate the clip with both `from_keyframe_id` and `to_keyframe_id`
   pinned.
3. Continuous chains reuse the previous clip's `to_keyframe` as the next
   clip's `from_keyframe` — the shared node is the continuity guarantee.
4. `check_project` validates the chain structurally.

Use it deliberately, per shot, wherever exact boundaries matter; mix freely
with seedance-clip-chaining in the same project.
