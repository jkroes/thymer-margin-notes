# Undo crash after plugin line delete — follow-up detail

Prepared 2026-08-03 as a ready-to-paste reply if the Thymer devs ask for more detail on
the `EDITOR_TREE_CORRUPTION` report. Environment: desktop app v1.0.18 (macOS), same
behavior expected on web; workspace is E2EE, single user, two replicas (desktop + web).

---

Happy to give more detail. Full sequence:

**Setup.** A global plugin (my "Margin Notes") had deleted a line item in the document
I had open and focused, via the plugin SDK: `await lineItem.delete()` on a child line
of the focused document. The delete succeeded and the line disappeared normally.

**Trigger.** Sometime later, with the same document still open, I pressed ⌘Z. The app
immediately hard-stopped with:

```
prev_sibling not found in parent.children
Error code: EDITOR_TREE_CORRUPTION
```

**Reading of the mechanism.** The editor's undo stack only records operations made
through the editor itself. The SDK delete never entered it, so undo replayed my most
recent *editor* operation against a tree that no longer matched the state that
operation was recorded against — specifically an op whose insert/move anchor
(`prev_sibling`) was the line the plugin had deleted. The consistency check caught the
dangling anchor and halted.

**What it did NOT do** (verified over MCP afterwards): no persisted damage. After
reload, every line's `parent_guid` resolved correctly and the document rendered fine.
The only lasting trace is the usual append-only `children`-array residue, which as far
as I can tell is normal (a move never removes the guid from the old parent's
`children`; verified by a move round-trip via MCP `move_line_item` — happy to file
that separately if it's *not* intended).

**Repro** (should work with any plugin able to write):

1. Open a document with a few sibling lines; type an edit on line B so it enters the
   undo stack (e.g. append text, or create B fresh).
2. From plugin code (or MCP `trash_line_item`), delete line A, where A is the sibling
   anchor of the op recorded in step 1 (in practice: delete the line directly above B).
3. Press ⌘Z in the editor.
4. `EDITOR_TREE_CORRUPTION` dialog, reload required.

Timing between steps doesn't seem to matter; the document just has to stay open so
the undo stack survives.

**Same-tick not required.** The plugin delete happened seconds before the undo in my
case, through the normal SDK async write path — not a race within one tick.

**Suggested directions** (from the outside, take with salt):

- Cheapest: when an externally-sourced structural op (plugin/MCP/remote) touches a
  document, drop or truncate that document's local undo stack past the affected ops —
  same as many editors do on external file change.
- Nicer: rebase undo entries over external ops where anchors still resolve, and only
  drop the entries whose anchors are gone.
- Even a soft failure ("can't undo past an external change") would beat the reload
  dialog.

My plugin now avoids the trap by never doing structural ops on the open document
(content-level `setSegments` only, which undo appears to tolerate), so no urgency on
my end — reporting because any plugin that deletes/creates/moves lines can set this
trap for its users.
