/// <reference path="./sdk/types.d.ts" />
// Margin Notes — Tufte-style contextual content for Thymer.
//
// A note is a real child line tagged #ctx under the annotated line. This plugin renders
// those notes OUTSIDE the editor: as serif sidenotes in the right margin when the panel
// is wide enough, or as click-to-open popovers behind a small glyph when it isn't.
// Notes are edited by clicking them; lines become notes via the palette command
// ("toggle #ctx on current line") or by typing a #ctx child directly. The editor DOM
// is never mutated — the overlay is our own layer in document.body, positioned by
// reading row geometry (.listitem[data-guid]).

const CTX_TAG = "#ctx";
const SIDENOTE_MIN_GUTTER = 190; // px of free margin needed to render sidenotes
const NOTE_WIDTH_MAX = 260;
const STYLE_ID = "margin-notes-style";
const MUTE_STYLE_ID = "margin-notes-mute";
const CSS = `
  .mn-root { position: fixed; inset: 0 auto auto 0; width: 0; height: 0; z-index: 480; pointer-events: none; }
  .mn-root > * { pointer-events: auto; }
  .mn-note { position: fixed; font: italic 12.5px/1.5 Georgia, "Times New Roman", serif;
    color: #c29c68; cursor: pointer; }
  .mn-note:hover { color: #e0b87d; }
  .mn-glyph { position: fixed; width: 16px; height: 16px; border-radius: 50%;
    border: 1px solid #8d7549; color: #c29c68; font: italic 700 10px Georgia, serif;
    display: flex; align-items: center; justify-content: center; cursor: pointer;
    background: transparent; padding: 0; }
  .mn-glyph:hover { background: rgba(194, 156, 104, .18); }
  .mn-pop { position: fixed; width: 270px; background: #282d37; border: 1px solid #3d4350;
    border-radius: 8px; padding: 9px 11px; font: 12.5px/1.5 Georgia, serif; font-style: italic;
    color: #d3b586; box-shadow: 0 8px 28px rgba(0,0,0,.5); }
  .mn-edit { position: fixed; min-height: 20px; background: rgba(40,45,55,.96);
    border: 1px solid #8d7549; border-radius: 6px; padding: 6px 9px;
    font: italic 12.5px/1.5 Georgia, serif; color: #e0c08a; outline: none;
    box-shadow: 0 6px 20px rgba(0,0,0,.4); }
  .mn-edit:empty::before { content: "context\\2026"; color: #8d7549; }
  body.mn-light .mn-note { color: #97743d; }
  body.mn-light .mn-note:hover { color: #7a5c2e; }
  body.mn-light .mn-pop { background: #f6f2ea; border-color: #d8c9ad; color: #6b5327; }
  body.mn-light .mn-edit { background: #f6f2ea; color: #5c4720; }
`;

export class Plugin extends AppPlugin {
    onLoad() {
        this._enabled = localStorage.getItem("mn-enabled") !== "0";
        this._model = [];            // [{anchorGuid, notes: [{guid, text, item}]}]
        this._items = new Map();     // lineGuid -> PluginLineItem (anchors)
        this._noteGuids = new Set(); // guids of #ctx lines themselves
        this._rendered = [];         // [{el, anchorGuid, kind, index}]
        this._editing = null;        // open editor card, if any
        this._pop = null;            // open popover, if any
        this._handlers = [];

        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);

        this._muteStyle = document.createElement("style");
        this._muteStyle.id = MUTE_STYLE_ID;
        document.head.appendChild(this._muteStyle);

        this._root = document.createElement("div");
        this._root.className = "mn-root";
        document.body.appendChild(this._root);

        // One palette command per plugin, so display on/off lives on the status bar
        // and the palette slot goes to the per-line toggle.
        this.ui.addStatusBarItem({
            label: "Margin Notes",
            icon: "ti-notes",
            tooltip: "Toggle margin notes display",
            onClick: () => {
                this._enabled = !this._enabled;
                localStorage.setItem("mn-enabled", this._enabled ? "1" : "0");
                this._enabled ? this._refreshSoon(0) : this._clear();
                this.ui.addToaster({ title: "Margin Notes", message: "Margin notes " + (this._enabled ? "on" : "off"), dismissible: true, autoDestroyTime: 2000 });
            },
        });

        this.ui.addCommandPaletteCommand({
            label: "Margin Notes: toggle #ctx on current line",
            icon: "ti-notes",
            onSelected: () => this._toggleCaretLine(),
        });

        for (const ev of ["panel.navigated", "panel.focused"])
            this._handlers.push(this.events.on(ev, () => this._refreshSoon(150)));
        for (const ev of ["lineitem.created", "lineitem.updated", "lineitem.moved", "lineitem.deleted", "lineitem.undeleted"])
            this._handlers.push(this.events.on(ev, () => this._refreshSoon(300)));

        this._onScroll = () => this._reposition();
        this._onResize = () => this._refreshSoon(150);
        document.addEventListener("scroll", this._onScroll, { capture: true, passive: true });
        window.addEventListener("resize", this._onResize);

        // Catch re-renders, collapses, and virtualization the events don't cover.
        this._tick = setInterval(() => this._reposition(), 1200);

        this._refreshSoon(400);
    }

    onUnload() {
        for (const h of this._handlers) this.events.off(h);
        clearInterval(this._tick);
        document.removeEventListener("scroll", this._onScroll, { capture: true });
        window.removeEventListener("resize", this._onResize);
        this._root?.remove();
        document.getElementById(STYLE_ID)?.remove();
        document.getElementById(MUTE_STYLE_ID)?.remove();
    }

    // ---- data ----

    _refreshSoon(ms) {
        clearTimeout(this._refreshTimer);
        this._refreshTimer = setTimeout(() => this._refresh(), ms);
    }

    async _refresh() {
        if (!this._enabled) return;
        if (this._editing) { this._refreshSoon(1000); return; } // don't kill an open editor card
        const rec = this.ui.getActivePanel()?.getActiveRecord();
        if (!rec) { this._clear(); return; }
        const recGuid = rec.guid;
        let model = [];
        const items = new Map();
        const allItems = new Map();
        const noteGuids = new Set();
        try {
            // Live client (0.0.18): getLineItems returns a FLAT list of all items, and
            // `children` is a prototype getter returning child item objects; the
            // getChildren() documented in types.d.ts does not exist yet. Walk with a
            // visited-set so flat list + recursion can't double-count.
            const top = await rec.getLineItems();
            const visited = new Set();
            const walk = async (list) => {
                for (const item of list || []) {
                    if (!item || visited.has(item.guid)) continue;
                    visited.add(item.guid);
                    allItems.set(item.guid, item);
                    const kids = await this._childrenOf(item);
                    const notes = [];
                    for (const kid of kids || []) {
                        const segs = kid.segments || [];
                        const first = segs[0];
                        if (first && first.type === "hashtag" && String(first.text).toLowerCase() === CTX_TAG) {
                            noteGuids.add(kid.guid);
                            const text = this._segText(segs.slice(1));
                            if (text) notes.push({ guid: kid.guid, item: kid, text });
                        }
                    }
                    if (notes.length) {
                        items.set(item.guid, item);
                        model.push({ anchorGuid: item.guid, notes });
                    }
                    await walk(kids);
                }
            };
            await walk(top);
        } catch (e) {
            console.warn("[margin-notes] read failed", e);
            return;
        }
        // Stale-response guard: panel may have navigated while we were reading.
        if (this.ui.getActivePanel()?.getActiveRecord()?.guid !== recGuid) return;
        this._model = model;
        this._items = items;
        this._allItems = allItems;
        this._noteGuids = noteGuids;
        this._render();
    }

    // Toggle the #ctx marker on the line that has the caret. The caret line is
    // identified by Thymer's own row class .listitem-with-caret (read-only DOM).
    async _toggleCaretLine() {
        const toast = (message) => this.ui.addToaster({ title: "Margin Notes", message, dismissible: true, autoDestroyTime: 2500 });
        const guid = document.querySelector(".listitem.listitem-with-caret")?.getAttribute("data-guid");
        if (!guid) { toast("Put the cursor on a line first"); return; }
        let item = this._allItems?.get(guid);
        if (!item) { await this._refresh(); item = this._allItems?.get(guid); }
        if (!item) { toast("Couldn't resolve the line"); return; }
        const rec = this.ui.getActivePanel()?.getActiveRecord();
        const segs = (item.segments || []).map((s) => ({ type: s.type, text: s.text }));
        const first = segs[0];
        const isCtx = first && first.type === "hashtag" && String(first.text).toLowerCase() === CTX_TAG;
        try {
            if (isCtx) {
                const rest = segs.slice(1);
                if (rest[0] && rest[0].type === "text" && typeof rest[0].text === "string")
                    rest[0].text = rest[0].text.replace(/^\s+/, "");
                await item.setSegments(rest.length ? rest : [{ type: "text", text: "" }]);
                toast("Line is normal content again");
            } else {
                if (rec && item.parent_guid === rec.guid) { toast("Top-level lines have no parent line to annotate"); return; }
                if (first && first.type === "text" && typeof first.text === "string") {
                    segs[0] = { type: "text", text: " " + first.text.replace(/^\s+/, "") };
                    await item.setSegments([{ type: "hashtag", text: CTX_TAG }, ...segs]);
                } else {
                    await item.setSegments([{ type: "hashtag", text: CTX_TAG }, { type: "text", text: " " }, ...segs]);
                }
                toast("Line is now contextual content of its parent");
            }
        } catch (e) {
            console.warn("[margin-notes] toggle failed", e);
            toast("Toggle failed");
        }
        this._refreshSoon(350);
    }

    async _childrenOf(item) {
        if (typeof item.getChildren === "function") return (await item.getChildren()) || [];
        return Array.isArray(item.children) ? item.children : [];
    }

    _segText(segs) {
        return (segs || []).map((s) => {
            const t = s.text;
            if (t && typeof t === "object") return t.title || "";
            return typeof t === "string" ? t : "";
        }).join("").trim();
    }

    // ---- rendering ----

    _clear() {
        this._closeEditor();
        this._closePop();
        this._root.replaceChildren();
        this._rendered = [];
    }

    _anchorEl(guid) {
        return document.querySelector(`.listitem[data-guid="${guid}"]`);
    }

    _gutterFor(el) {
        const scroller = el.closest(".panel-scroller-y");
        if (!scroller) return 0;
        return scroller.getBoundingClientRect().right - el.getBoundingClientRect().right;
    }

    _render() {
        this._clear();
        if (!this._enabled) { this._muteStyle.textContent = ""; return; }
        // Mute expanded #ctx lines in the tree: CSS-only (no DOM mutation), scoped to
        // exact guids, so an annotation reads as marginalia even when its source shows.
        this._muteStyle.textContent = [...this._noteGuids]
            .map((g) => `.listitem[data-guid="${g}"] { opacity: .55; font-style: italic; }`)
            .join("\n");
        for (const entry of this._model) {
            entry.notes.forEach((note, i) => {
                const el = document.createElement("div");
                el.dataset.anchor = entry.anchorGuid;
                el.addEventListener("click", (e) => { e.stopPropagation(); this._onNoteClick(entry, note, el); });
                this._root.appendChild(el);
                this._rendered.push({ el, anchorGuid: entry.anchorGuid, note, index: i });
            });
        }
        this._reposition();
    }

    _reposition() {
        if (!this._rendered.length && !this._editing) return;
        let lastBottom = -1e9;
        for (const r of this._rendered) {
            const anchor = this._anchorEl(r.anchorGuid);
            if (!anchor) { r.el.style.display = "none"; continue; }
            // Mutual exclusion: if the #ctx line itself is rendered (parent expanded),
            // the user is looking at the source — keep the margin quiet.
            if (this._anchorEl(r.note.guid)) { r.el.style.display = "none"; continue; }
            const rect = anchor.getBoundingClientRect();
            if (rect.bottom < -40 || rect.top > innerHeight + 40) { r.el.style.display = "none"; continue; }
            const gutter = this._gutterFor(anchor);
            const side = gutter >= SIDENOTE_MIN_GUTTER;
            r.el.style.display = "";
            if (side) {
                r.el.className = "mn-note";
                r.el.textContent = r.note.text || "(empty note)";
                r.el.style.width = Math.min(gutter - 30, NOTE_WIDTH_MAX) + "px";
                r.el.style.left = rect.right + 14 + "px";
                let top = rect.top + r.index * 18;
                if (top < lastBottom + 8) top = lastBottom + 8;
                r.el.style.top = top + "px";
                lastBottom = top + r.el.offsetHeight;
            } else {
                r.el.className = "mn-glyph";
                r.el.textContent = "✻"; // ✻
                r.el.style.width = "";
                r.el.style.left = rect.right + 4 + r.index * 20 + "px";
                r.el.style.top = rect.top + (rect.height - 16) / 2 + "px";
            }
        }
    }

    // ---- popover (narrow mode) ----

    _onNoteClick(entry, note, el) {
        if (el.classList.contains("mn-note")) {
            this._openEditor(entry.anchorGuid, note);
        } else {
            if (this._pop?.dataset.note === note.guid) { this._closePop(); return; }
            this._closePop();
            const anchor = this._anchorEl(entry.anchorGuid);
            if (!anchor) return;
            const rect = anchor.getBoundingClientRect();
            const pop = document.createElement("div");
            pop.className = "mn-pop";
            pop.dataset.note = note.guid;
            pop.textContent = note.text || "(empty note)";
            pop.style.left = Math.min(rect.left + 150, innerWidth - 300) + "px";
            pop.style.top = rect.bottom + 4 + "px";
            pop.addEventListener("click", (e) => { e.stopPropagation(); this._closePop(); this._openEditor(entry.anchorGuid, note); });
            this._root.appendChild(pop);
            this._pop = pop;
            this._outside = (e) => { if (!pop.contains(e.target)) this._closePop(); };
            setTimeout(() => document.addEventListener("click", this._outside), 0);
        }
    }

    _closePop() {
        if (!this._pop) return;
        document.removeEventListener("click", this._outside);
        this._pop.remove();
        this._pop = null;
    }

    // ---- authoring ----

    _openEditor(anchorGuid, note) {
        this._closeEditor();
        this._closePop();
        const anchor = this._anchorEl(anchorGuid);
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        const gutter = this._gutterFor(anchor);
        const side = gutter >= SIDENOTE_MIN_GUTTER;
        const card = document.createElement("div");
        card.className = "mn-edit";
        card.contentEditable = "true";
        card.textContent = note ? note.text : "";
        if (side) {
            card.style.left = rect.right + 14 + "px";
            card.style.top = rect.top + "px";
            card.style.width = Math.min(gutter - 30, NOTE_WIDTH_MAX) + "px";
        } else {
            card.style.left = Math.min(rect.left + 150, innerWidth - 300) + "px";
            card.style.top = rect.bottom + 4 + "px";
            card.style.width = "270px";
        }
        card.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this._saveEditor(); }
            if (e.key === "Escape") { e.preventDefault(); this._closeEditor(); }
        });
        card.addEventListener("blur", () => this._saveEditor());
        this._root.appendChild(card);
        this._editing = { card, anchorGuid, note };
        card.focus();
        // place caret at end
        const sel = getSelection(), range = document.createRange();
        range.selectNodeContents(card);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    _closeEditor() {
        if (!this._editing) return;
        const { card } = this._editing;
        this._editing = null;
        card.remove();
    }

    async _saveEditor() {
        if (!this._editing) return;
        const { card, note } = this._editing;
        const text = card.innerText.replace(/\s+/g, " ").trim();
        this._editing = null;
        card.remove();
        try {
            // Never delete the line: a structural write the editor's undo stack can't
            // see makes a later ⌘Z crash the app (EDITOR_TREE_CORRUPTION, 2026-08-03).
            // Clearing leaves a bare #ctx line for the user to delete in the outline.
            if (!text) {
                await note.item.setSegments([{ type: "hashtag", text: CTX_TAG }]);
                this.ui.addToaster({ title: "Margin Notes", message: "Note cleared — delete the empty #ctx line in the outline to remove it", dismissible: true, autoDestroyTime: 4000 });
            } else if (text !== note.text)
                await note.item.setSegments([{ type: "hashtag", text: CTX_TAG }, { type: "text", text: " " + text }]);
        } catch (e) {
            console.warn("[margin-notes] save failed", e);
            this.ui.addToaster({ title: "Margin Notes", message: "Note save failed", dismissible: true, autoDestroyTime: 3000 });
        }
        this._refreshSoon(350); // lineitem event usually beats this; harmless either way
    }

}
