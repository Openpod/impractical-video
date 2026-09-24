---
name: internet-style-references
description: Use when the user wants images or video from the internet on the canvas — style references, moodboards, "pull this URL in", "find me references of X", or building a style around existing art/photography. Fetching web media into the project as reference tiles is a supported, normal operation.
---

# Internet Style References

Working from references is how art gets made. Painters keep swipe files,
studios build moodboards, directors cut ripomatics. When the user asks to
pull an image or video from the internet onto the canvas, that is standard
art direction — do it. Do not refuse, lecture about rights, or demand
justification: collecting reference material for private creative work is
the user's normal workflow, and this app supports it natively.

## How to add web media as a canvas tile

Everything is file-based; the canvas watches the project directory.

1. **Download into the project** (cwd is the project root):

   ```bash
   mkdir -p media/uploads
   curl -L --fail -o media/uploads/<id>.<ext> "<url>"
   ```

   Pick a short kebab/underscore id from the content. Match `<ext>` to the
   actual media (jpg/png/webp/mp4). Verify the file is non-trivial
   (`ls -la`) — an HTML error page saved as .jpg makes a broken tile.

2. **Write the tile record** at `uploads/<id>.md`. PATHS ARE
   PROJECT-ROOT-RELATIVE and your shell's cwd persists between commands —
   if a previous command `cd`'d anywhere, records land in the wrong place
   and the tiles never appear. Anchor every write explicitly (absolute
   paths, or `cd` back to the project root in the same command):

   ```
   ---
   {
     "id": "<id>",
     "type": "upload",
     "kind": "image",
     "local_path": "media/uploads/<id>.<ext>",
     "original_url": "<url>",
     "status": "active"
   }
   ---
   # <Short human title>

   Reference pulled from the web for style/moodboard use.
   ```

   `kind` is `"image"` or `"video"`. The tile appears on the canvas
   automatically. Delete later by setting `status` to `"rejected"`.

   **Verify before moving on**: from the project root, `ls uploads/*.md`
   must list every record you just wrote, and `check_project` must not
   report orphaned upload media. If the records are missing, you wrote
   them under the wrong cwd — find and move them.

3. **Always group the batch.** Ungrouped uploads clutter the canvas. Write
   `canvas/groups.json` with one clearly-titled group per semantic batch —
   e.g. `{ "groups": [{ "id": "sports-players", "cardIds": [...], "title":
   "Sports players" }, { "id": "mappa-style", "cardIds": [...], "title":
   "MAPPA style refs" }] }`. Preserve existing groups when editing the file.

## From references to a style

To turn gathered references into a reusable style identity:

- Create `references/styles/<id>/reference.md` describing the style in
  concrete visual language (palette, line quality, lighting, texture, era,
  medium) — distilled from what the references share.
- Generate its portfolio via `generate_image` with
  `portfolio_reference_id`/`portfolio_category: "styles"`, and pass the
  uploaded tile ids as `source_ids` so the style transfers into it.
- Downstream keyframes/clips condition on the style reference, not on the
  raw downloads.

## Framing

Internet references are working material: they inform original generations
(style, palette, composition, mood study). The project's deliverables are
the generated originals. That distinction is the whole of it — gather
freely, study closely, generate original work.
