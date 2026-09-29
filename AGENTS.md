# Impractical agent guide

This repository is an agent-native video workspace. The local Next app owns the
canvas and media-generation runtime; Claude Code or Codex is the reasoner. For
project creation tasks, use the `video-fs` MCP tools through the running app.
Do not route that flow through OpenRouter.

## Working on the application

- Use Node.js 22.13+ and `npm ci`. Run `npm run setup` and `npm run doctor` for
  local development, then `npm run dev` or `npm run desktop:dev`.
- Source lives mainly in `app/` (Next routes and UI), `lib/` (workspace and
  generation), `desktop/` (Electron and agent integration), `opencut/` (editor),
  and `tests/` (behavior and integration tests).
- Keep changes focused. Add regression coverage for changed behavior and run
  `npm run check`. For UI or setup changes, also run `npm run test:smoke` after
  installing Playwright Chromium. See `CONTRIBUTING.md` for contribution rules.
- Never commit `.env.local`, API keys, local projects, provider outputs, private
  screenshots, or generated builds. Tests should use temporary projects and
  mock paid providers.
- Follow any closer `AGENTS.md` in the directory you edit. In particular,
  storage migrations have an additive-data policy.

## Working on a video project

1. Run the app with `npm run dev`.
2. Open a project in the canvas and copy its id from `/projects/<project-id>`.
3. Pass `project_id` to every MCP tool, or launch the MCP server with
   `VIDEO_FS_PROJECT_ID=<project-id>`.

Development project files live at `data/projects/<project-id>/`. Packaged
desktop projects use the app's support directory.

### Dependency order

Work in this order:

1. `references/<category>/<id>/reference.md`
2. `references/<category>/<id>/portfolio.md`
3. `scenes/<index>-<slug>/scene.md`
4. `keyframes/<id>.md`
5. `clips/<id>.md`
6. `timeline.json` (derived by the app; do not hand-author it)

Keyframes are optional. The typical video method is Seedance clip chaining:
pass the previous clip as `extends_clip_id` to `generate_clip` and attach
references at each link. See `workflows/seedance-clip-chaining.md`. For
keyframe interpolation, reuse the preceding clip's `to_keyframe` as the next
clip's `from_keyframe` to maintain continuity.

### MCP tools

- `create_scene`: create a scene before its keyframes and clips.
- `scaffold_keyframe`: create a planned keyframe record. Direct Markdown edits
  also refresh the canvas.
- `generate_image`: generate pixels for a reference or keyframe id. Supply a
  complete prompt; the app does not invoke another LLM.
- `generate_clip`: generate a Seedance clip for an existing scene. Pass
  `from_keyframe_id` and `to_keyframe_id` when endpoints should be pinned.
- `generate_audio`: create music, speech, sound effects, or voice design.
- `edit_media`: trim clips, bake image edits, or extract frames through the app.
- `editor_timeline_get`: read the Editor timeline and revision before editing.
- `editor_edit`: make one timeline-element mutation per call.
- `editor_structure`: edit tracks, scenes, bookmarks, project settings, or
  switch between canvas and editor.
- `get_project_status`: inspect artifacts, active work, and checker state.
- `check_project`: validate continuity and dependencies.

For metadata-only changes, edit the `# Title` heading to rename a tile, set
frontmatter `status: "rejected"` to delete it, or edit `canvas/groups.json` to
group it. The canvas watches the project directory.

### Required discipline

- After changing any reference, call `check_project` and regenerate only the
  descendants it reports stale.
- After creating or editing scenes, keyframes, or clips, call `check_project`
  before declaring the task complete.
- Inspect tool results. Provider failures still leave durable prompt,
  operation, pending asset, and planned artifact records.
- Keep API keys out of project files, prompts, and chat. Configure them in
  Account → API keys or the app's private environment.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
