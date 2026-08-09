# Margin Notes

A Thymer plugin. **Platform knowledge and workspace rules live in the `thymer` skill
(`~/.claude/skills/thymer/`) and the parent repo's `CLAUDE.md` (`~/repos/thymer`)** —
this file holds only what is specific to this plugin.

Mechanics (all repos identical): `./setup.sh` re-links `sdk/`, `bin/thymercli` and
`examples/` from the shared cache (they're gitignored symlinks — don't edit `sdk/`);
`./build.sh .` bundles to `dist/plugin.js`, the paste-ready form (committed on purpose;
`hooks/pre-push` keeps it in sync with source).

## Notes

A note is a child line whose first segment is the hashtag `#ctx`; the rest of the line is
the note text. The plugin renders these as sidenotes in the right margin (gutter ≥190px)
or as ✻ glyph + popover when narrow. Notes are edited by clicking them (clearing the
text deletes the line); lines become notes via the palette command or by typing a
`#ctx` child. The hover-`+` margin authoring shipped briefly and was removed
2026-08-03: it only handled the no-note case, appeared on every line, and was
confusable with the ✻ glyph at narrow widths. Display on/off toggles via the
status bar item or the palette command "Margin Notes: toggle display" (same
`_toggleDisplay()`, localStorage per device; a plugin can register multiple
palette commands — an earlier one-per-plugin assumption was wrong, community
plugins register up to 15). The palette command "Margin Notes:
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
- **Multi-pane (verified live 2026-08-04, web client):** the model is built per pane via
  `ui.getPanels()` → `getActiveRecord()`, and every anchor lookup is scoped to that
  pane's `getElement()` subtree — both exist on the live client. **`getElement()`
  returns an inner editor node, NOT the `.panel.panel-normal` wrapper** (verified live
  2026-08-05): fine for scoped anchor lookups, but anything that must see panel-level
  overlays (e.g. the occlusion MutationObserver) walks up with `.closest(".panel")`
  first. The same record split into two panes renders the note once
  per pane, each glyph at its own pane's row edge; navigating one pane away drops just
  that pane's notes (`panel.closed` is also subscribed now). Tree/margin mutual
  exclusion is per pane. Fallbacks: no `getPanels` → single active panel; no panel
  element → document-wide queries, and with >1 pane but a missing element only the
  active pane renders rather than mis-anchor duplicate guids.
- Native collapse/expand does NOT respond to synthetic `.click()` on
  `.line-fold-chevron` — needs a trusted event (CDP `Input.dispatchMouseEvent` works).
- Deploy loop used: `./build.sh .` then
  `./bin/thymercli plugin update code "Margin Notes" --file dist/plugin.js -w <ws>`
  (and `plugin update config ... --file plugin.json`). The web client needs a reload to
  pick up pushed code.
