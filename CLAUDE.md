# Margin Notes

A Thymer plugin. Thymer is alpha and moves fast — verify behavior against the live app
before relying on it.

**General Thymer knowledge lives in the `thymer` skill, not here.** The data model, the
plugin SDK surface and its timing gotchas, MCP write safety, the Markdown Mirror,
diagnostics and theming are all documented there. This file is only for what is specific
to this plugin.

## Layout

- `plugin.js` + `plugin.json` — the plugin source and its configuration
- `./build.sh .` — bundle to `dist/plugin.js` (paste into Thymer → Edit Code → Custom Code,
  and `plugin.json` into the Configuration field)
- `./setup.sh` — re-link third-party deps after a fresh clone

`sdk/`, `bin/thymercli` and `examples/` are **symlinks into a shared cache** owned by the
`thymer-plugin-init` skill, and are gitignored. One cache update refreshes every plugin
repo at once — which also means an SDK refresh moves this repo underneath you. Run
`./setup.sh --refresh` deliberately rather than as a habit.

**Don't edit `sdk/`** — it's a vendored upstream snapshot shared with every other plugin
repo. Edits vanish on the next refresh and affect everything else in the meantime.

## Dev loop

```bash
./setup.sh                    # first time, or after a fresh clone
cd sdk && npm run dev         # esbuild bundles + pushes over CDP on save
```

For hot reload, run Chrome with remote debugging and enable it in the app:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug-profile \
  --no-first-run https://<yoursite>.thymer.com
# In Thymer: Cmd+P → Plugins → create/select → Edit Code → Developer Tools → Enable Hot Reload
```

## Rules that override convenience

- **Never let plugin code touch the editor DOM.** A community plugin corrupted an
  encrypted workspace beyond repair. Only `this.ui.*`.
- **Never create pages or collections casually** — including for throwaway tests. Reuse
  what exists and clean up. If a task seems to require a genuinely new page or collection,
  ask first.
- **No `export` keyword** in code pasted into the Custom Code editor. `./build.sh` strips
  it; hand-pasting `plugin.js` does not.
- **Never override the constructor.** Initialize in `onLoad()`.

## Notes

A note is a child line whose first segment is the hashtag `#ctx`; the rest of the line is
the note text. The plugin renders these as sidenotes in the right margin (gutter ≥190px)
or as ✻ glyph + popover when narrow. Notes are edited by clicking them (clearing the
text deletes the line); lines become notes via the palette command or by typing a
`#ctx` child. The hover-`+` margin authoring shipped briefly and was removed
2026-08-03: it only handled the no-note case, appeared on every line, and was
confusable with the ✻ glyph at narrow widths. Toggle via the
status bar item (localStorage per device). The palette command "Margin Notes:
toggle #ctx on current line" converts the caret line to/from contextual content —
the caret line is found via Thymer's own row class `.listitem.listitem-with-caret`
(read-only DOM; fills the SDK's missing `getFocusedLineItem()`). Top-level lines are
refused (no parent line to annotate).

Verified live on the web client, 0.0.18 / desktop v1.0.18 era (2026-08-03):

- **The overlay never touches editor DOM** — it anchors by reading
  `.listitem[data-guid]` geometry. The selectors it depends on (`.listitem`,
  `.panel-scroller-y`) are documented in the thymer skill's plugins.md ("Read-only
  overlay anchoring").
- **`PluginLineItem.getChildren()` does NOT exist on the live client**, despite
  types.d.ts documenting it. `children` is a prototype GETTER returning child item
  objects. `_childrenOf()` handles both; `getLineItems()` returns a FLAT list of all
  items, so the tree walk dedups with a visited-set.
- `rec.getGuid()` also doesn't exist — use `rec.guid`.
- End-to-end verified over CDP: sidenote rendering + alignment, hover-`+` authoring,
  click-to-edit prefill, clear-to-delete. Popover (narrow) mode logic shipped but only
  exercised in a mockup, not live.
- **Tree/margin mutual exclusion + muting** (verified live both directions): when a
  `#ctx` line's own `.listitem` is in the DOM (parent expanded), its margin note hides
  and the tree line is muted via guid-targeted CSS (`opacity:.55; font-style:italic`,
  second injected style tag). Collapse removes the line from the DOM → the sidenote
  returns within one 1200ms tick (collapse fires no lineitem event; the tick catches it).
- **Plugins must not delete lines in the open document.** The margin editor originally
  deleted the `#ctx` line when its text was cleared; a subsequent ⌘Z crashed the app
  with `EDITOR_TREE_CORRUPTION: prev_sibling not found in parent.children` (2026-08-03)
  — the editor's undo stack can't see SDK structural writes. Persisted data was fine
  (in-memory guard only; reload rebuilt cleanly). Clearing now empties the line's
  segments instead (`setSegments`, a content op), and empty notes aren't rendered.
- **`children` arrays are append-only membership history** (proved by move round-trip
  2026-08-03): a move never removes the guid from the old parent's array, moving back
  never duplicates it, and trash lingers the same way. Any ever-moved line (a
  Tab-indent counts) is listed under every parent it ever had. `parent_guid` is the
  sole authority; the walk filters `kid.parent_guid === item.guid`, else a note
  renders once per historical parent.
- **`getActiveRecord()` can be null when the window/panel is unfocused** — treat null
  as "don't know", not "no document"; clearing on null wipes the overlay in background
  windows.
- Native collapse/expand does NOT respond to synthetic `.click()` on
  `.line-fold-chevron` — needs a trusted event (CDP `Input.dispatchMouseEvent` works).
- Deploy loop used: `./build.sh .` then
  `./bin/thymercli plugin update code "Margin Notes" --file dist/plugin.js -w <ws>`
  (and `plugin update config ... --file plugin.json`). The web client needs a reload to
  pick up pushed code.
