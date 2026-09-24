# Video FS — desktop agent mode

This repository is an agent-native video project. The local Next app owns the
canvas and media-generation runtime; Claude Code or Codex is the reasoner.
Never call OpenRouter for this flow. Use the `video-fs` MCP tools to execute
generation and validation through the running app.

## Start

1. Run the app with `npm run dev`.
2. Open a project in the canvas and copy its id from `/projects/<project-id>`.
3. Pass `project_id` to every MCP tool, or launch the MCP server with
   `VIDEO_FS_PROJECT_ID=<project-id>`.

Project files live at `data/projects/<project-id>/`.

## Dependency order

Work strictly in this order:

1. `references/<category>/<id>/reference.md`
2. `references/<category>/<id>/portfolio.md`
3. `scenes/<index>-<slug>/scene.md`
4. `keyframes/<id>.md`
5. `clips/<id>.md`
6. `timeline.json` (derived by the app; do not hand-author it)

Keyframes are OPTIONAL — one video method among several. The typical method
is Seedance clip chaining (pass the previous clip forward as @Video1 via
`generate_clip`'s `extends_clip_id`, references attached each link; see
`workflows/seedance-clip-chaining.md`). When the
keyframe-interpolation method IS used, the same keyframe id is a shared
continuity node: a continuous chain uses the preceding clip's `to_keyframe`
as the next clip's `from_keyframe`.

## MCP tools

- `create_scene`: create a scene before its keyframes and clips.
- `scaffold_keyframe`: create a planned keyframe record. You may also edit its
  Markdown directly; the canvas watches the project directory and refreshes.
- `generate_image`: generate pixels for a reference or keyframe id. The prompt
  must be complete because the app does not invoke another LLM.
- `generate_clip`: generate a Seedance clip for an existing scene. Pass
  `from_keyframe_id` and `to_keyframe_id` when the endpoints should be pinned.
- `generate_audio`: music, speech (TTS), sound effects, or voice design; the
  result lands on the canvas as an audio tile.
- `edit_media`: canvas media edits through the app's ffmpeg paths — trim a
  clip, bake crop/filters into an image, extract a frame.
- `editor_timeline_get`: read the Editor timeline + revision (always first).
- `editor_edit`: one timeline-element mutation per call (insert, insert_text,
  update params/speed/visibility, move, trim, split, remove, duplicate,
  separate_audio).
- `editor_structure`: tracks, scenes, bookmarks, project settings, undo, and
  `view_switch` (flip the open workbench between canvas and editor).
- `get_project_status`: inspect artifact counts, active work, and checker state.
- `check_project`: run deterministic continuity and dependency validation.

Metadata-only changes need no tool: rename tiles by editing the `# Title`
heading, delete by setting frontmatter `status: "rejected"`, group via
`canvas/groups.json`. The canvas watches the directory and refreshes.

## Required discipline

- After changing any reference, always call `check_project`. Regenerate only
  the descendants reported stale by the checker.
- After creating or editing scenes, keyframes, or clips, call `check_project`
  before declaring the task complete.
- Inspect tool results. Provider failures are still durable: prompt, operation,
  pending asset, and planned artifact records remain in the project.
- Never put API keys in project files, prompts, or chat. Configure provider keys
  in Account → API keys or the app's private environment.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
