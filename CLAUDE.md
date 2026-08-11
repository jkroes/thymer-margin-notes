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
or as a dog-ear (folded corner at the row's top-right, `color-mix` of
`--ed-text-color` so it theme-adapts; replaced the hardcoded-gold ✻ glyph 2026-08-10)
+ popover when narrow. BOTH visuals live in a per-pane `.mn-ear-layer` — an
own-node absolutely positioned in the rows' container — so they scroll natively
with the content (a fixed overlay always lags compositor scrolling; sidenotes
moved in 2026-08-10, same pass that dropped the occlusion check + panel
MutationObserver: the scroller clips in-layer notes itself, and panel overlays
paint above the scroller anyway). Sidenotes sit in the gutter no row overlaps,
so they're directly clickable — the layer swallows raw mouse events like the
overlay root does. The dog-ear paints BEHIND the row text, so it alone keeps a
transparent fixed `.mn-glyph` in the overlay as its click/hover target (hover
relayed via a class). Behind-the-text painting is DOM order, NOT negative
z-index (that sinks below the panel's opaque ancestor bg — verified live): rows
are `position:relative` z-auto, so the `.mn-ear-layer` is kept FIRST child of
the rows' parent and later rows paint over it. Thymer re-renders dropping the
layer, or prepending rows before it, are healed each `_reposition` pass.
KNOWN LIMITATION (accepted 2026-08-10): on a FOLDED row, Thymer's collapsed-box
background (`--ed-folded-bg-color`, ~50% alpha) paints over the ear like
everything else on the row, so the overlap corner shows both tints compounded —
a slightly different shade than either alone. The ear's top-right corner
carries the same `--ed-radius-normal` rounding as the collapsed box (triangle
drawn via diagonal gradient, since border-radius doesn't clip `clip-path`
shapes) so at least the corner curves match. Putting the ear above the box
would put it above the row's text too — not worth it.
Notes are edited by clicking them (clearing the
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
- **Margin wins** (reworked 2026-08-10; the original tree-wins mutual exclusion meant
  notes never showed while reading, since reading requires the parent expanded): a
  `#ctx` line with a note is collapsed out of the tree via guid-targeted CSS
  (`height:0 !important` + padding/margin zeroed, second injected style tag) and the
  note renders regardless of expansion. **NOT `display:none`** — Thymer's caret
  movement is geometry-based and a display:none row traps the caret at the end of the
  previous line, blocking keyboard nav past it (verified live). A zero-height row
  stays navigable: caret lands on it, the `.listitem-with-caret` escape in the same
  rule expands it (muted `opacity:.55; font-style:italic`) and `_reposition` hides
  that note while the caret sits there (next tick); leaving re-collapses it. Empty
  `#ctx` lines keep the old visible-but-muted treatment (no note stands in for them,
  and the user must be able to see them to delete them). Toggle-off clears the mute
  stylesheet explicitly (`_toggleDisplay`), else lines would stay collapsed.
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
  overlays walks up with `.closest(".panel")` first (the occlusion MutationObserver
  that needed this was removed 2026-08-10 with the move to in-scroller notes).
  The same record split into two panes renders the note once
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
