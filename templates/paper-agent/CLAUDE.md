# Video FS project — desktop agent mode

This directory is the source of truth for Video FS project
`{{VIDEO_FS_PROJECT_ID}}`. The local app owns the canvas and media runtime;
Claude Code or Codex is the reasoner. Use the `video-fs` MCP tools for
generation and validation. Do not call a second LLM through the app.

## Dependency order

Work strictly in this order:

1. `references/<category>/<id>/reference.md`
2. `references/<category>/<id>/portfolio.md`
3. `scenes/<index>-<slug>/scene.md`
4. `keyframes/<id>.md`
5. `clips/<id>.md`
6. `timeline.json` (derived by the app; do not hand-author it)

The same keyframe id is a shared continuity node. A continuous clip chain uses
the preceding clip's `to_keyframe` as the next clip's `from_keyframe`.

## MCP tools

- `create_scene`: create a scene before its keyframes and clips.
- `scaffold_keyframe`: create a planned keyframe record. Direct Markdown edits
  also appear live on the open canvas.
- `generate_image`: generate pixels for a reference or keyframe. Supply the
  final prompt; the app does not invoke another LLM.
- `generate_clip`: generate a Seedance clip for an existing scene. Pass
  `from_keyframe_id` and `to_keyframe_id` to pin endpoints.
- `get_project_status`: inspect artifact counts, active work, and checker state.
- `check_project`: run deterministic continuity and dependency validation.

## Required discipline

- After changing any reference, always call `check_project`. Regenerate only
  descendants reported stale by the checker.
- After changing scenes, keyframes, or clips, call `check_project` before
  declaring the task complete.
- Provider failures are durable: inspect the prompt, operation, pending asset,
  and planned artifact records rather than retrying blindly.
- Never put API keys in project files. Configure provider keys in the app's
  Account → API keys dialog or its private process environment.
