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
//
// Multi-pane: every open editor panel gets its own notes. Each record is walked once,
// then rendered per pane, with anchor lookups scoped to that pane's element — the same
// guid can have a row in several panes at once.

const CTX_TAG = "#ctx";
const SIDENOTE_MIN_GUTTER = 190; // px of free margin needed to render sidenotes
const NOTE_WIDTH_MAX = 260;
const STYLE_ID = "margin-notes-style";
const MUTE_STYLE_ID = "margin-notes-mute";
const CSS = `
  .mn-root { position: fixed; inset: 0 auto auto 0; width: 0; height: 0; z-index: 480; pointer-events: none; }
  .mn-root > * { pointer-events: auto; }
  .mn-note { position: absolute; font: italic 12.5px/1.5 Georgia, "Times New Roman", serif;
    color: #c29c68; cursor: pointer; pointer-events: auto; }
  .mn-note:hover { color: #e0b87d; }
  .mn-glyph { position: fixed; width: 24px; height: 24px; padding: 0; border: 0;
    background: transparent; cursor: pointer; }
  .mn-ear-layer { position: relative; width: 100%; height: 0; pointer-events: none; }
  .mn-ear { position: absolute; width: 20px; height: 20px;
    background: color-mix(in srgb, var(--ed-text-color, #888) 16%, transparent);
    clip-path: polygon(100% 0, 0 0, 100% 100%);
    transition: width .15s, height .15s, background .15s; }
  .mn-ear.mn-ear-hover { width: 26px; height: 26px;
    background: color-mix(in srgb, var(--ed-text-color, #888) 30%, transparent); }
  @media (prefers-reduced-motion: reduce) { .mn-ear { transition: none; } }
  .mn-pop { position: fixed; width: 270px; background: #282d37; border: 1px solid #3d4350;
    border-radius: 8px; padding: 4px 0; font: 12.5px/1.5 Georgia, serif; font-style: italic;
    color: #d3b586; box-shadow: 0 8px 28px rgba(0,0,0,.5); }
  .mn-pop-row { padding: 5px 11px; cursor: pointer; }
  .mn-pop-row:hover { background: rgba(194, 156, 104, .12); }
  .mn-pop-row + .mn-pop-row { border-top: 1px solid #343945; }
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
        this._panes = [];            // [{rec, recGuid, el}] — el is the panel's DOM element (or null → document)
        this._models = new Map();    // recGuid -> [{anchorGuid, notes: [{guid, text, item}]}]
        this._allItems = new Map();  // lineGuid -> PluginLineItem, merged across all panes' records
        this._recGuids = new Set();  // record guids currently shown in some pane
        this._noteGuids = new Set(); // guids of #ctx lines themselves
        this._rendered = [];         // [{el, paneEl, anchorGuid, note, index}]
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
        // Swallow raw mouse events so Thymer's document-level coordinate handlers
        // (caret placement, block selection) never react to clicks on the overlay.
        // preventDefault on mousedown also keeps focus in the editor — except in
        // the edit card, which needs focus to type.
        for (const evName of ["mousedown", "mouseup", "dblclick"]) {
            this._root.addEventListener(evName, (e) => {
                e.stopPropagation();
                if (evName === "mousedown" && !e.target.closest(".mn-edit")) e.preventDefault();
            });
        }
        document.body.appendChild(this._root);

        this.ui.addStatusBarItem({
            label: "Margin Notes",
            icon: "ti-notes",
            tooltip: "Toggle margin notes display",
            onClick: () => this._toggleDisplay(),
        });

        this.ui.addCommandPaletteCommand({
            label: "Margin Notes: toggle #ctx on current line",
            icon: "ti-notes",
            onSelected: () => this._toggleCaretLine(),
        });

        this.ui.addCommandPaletteCommand({
            label: "Margin Notes: toggle display",
            icon: "ti-notes",
            onSelected: () => this._toggleDisplay(),
        });

        for (const ev of ["panel.navigated", "panel.focused", "panel.closed"])
            this._handlers.push(this.events.on(ev, () => this._refreshSoon(150)));
        for (const ev of ["lineitem.created", "lineitem.updated", "lineitem.moved", "lineitem.deleted", "lineitem.undeleted"])
            this._handlers.push(this.events.on(ev, () => this._refreshSoon(300)));

        this._onScroll = () => this._reposition();
        // Reposition synchronously on every resize event so notes/ears track a
        // live window drag frame by frame; the debounced refresh still follows
        // for mode flips (side <-> narrow) and rewrapped-model changes.
        this._onResize = () => { this._reposition(); this._refreshSoon(150); };
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
        for (const layer of document.querySelectorAll(".mn-ear-layer")) layer.remove();
        document.getElementById(STYLE_ID)?.remove();
        document.getElementById(MUTE_STYLE_ID)?.remove();
    }

    // ---- data ----

    _refreshSoon(ms) {
        clearTimeout(this._refreshTimer);
        this._refreshTimer = setTimeout(() => this._refresh(), ms);
    }

    // Every editor pane showing a record, each with its DOM element for scoped anchor
    // lookups. Falls back to the single active panel when getPanels() is missing, and
    // to document-wide queries when getElement() is — the pre-multi-pane behavior.
    _editorPanes() {
        let panels = null;
        try { panels = typeof this.ui.getPanels === "function" ? this.ui.getPanels() : null; } catch {}
        if (!Array.isArray(panels) || !panels.length) {
            const p = this.ui.getActivePanel?.();
            panels = p ? [p] : [];
        }
        const panes = [];
        for (const p of panels) {
            let rec = null, el = null, active = false;
            try { rec = p.getActiveRecord?.() || null; } catch {}
            if (!rec) continue;
            try { el = p.getElement?.() || null; } catch {}
            try { active = !!p.isActive?.(); } catch {}
            panes.push({ rec, recGuid: rec.guid, el, active });
        }
        // Without per-panel elements we can't disambiguate duplicate guids across panes:
        // keep only the active pane (or the sole pane) rather than mis-anchor.
        if (panes.length > 1 && panes.some((p) => !p.el))
            return panes.filter((p) => p.el || p.active);
        return panes;
    }

    _paneKey(panes) {
        return panes.map((p) => p.recGuid).sort().join(",");
    }

    async _refresh() {
        if (!this._enabled) return;
        if (this._editing) { this._refreshSoon(1000); return; } // don't kill an open editor card
        const panes = this._editorPanes();
        // Empty can mean "window/panel not focused", not "no document" — don't clear;
        // notes whose anchor rows leave the DOM hide themselves in _reposition.
        if (!panes.length) return;
        const key = this._paneKey(panes);
        const models = new Map();
        const allItems = new Map();
        const noteGuids = new Set();
        try {
            for (const pane of panes) {
                if (models.has(pane.recGuid)) continue; // same record open in two panes
                models.set(pane.recGuid, await this._walkRecord(pane.rec, allItems, noteGuids));
            }
        } catch (e) {
            console.warn("[margin-notes] read failed", e);
            return;
        }
        // Stale-response guard: panes may have navigated/closed while we were reading.
        if (this._paneKey(this._editorPanes()) !== key) return;
        this._panes = panes;
        this._models = models;
        this._allItems = allItems;
        this._recGuids = new Set(panes.map((p) => p.recGuid));
        this._noteGuids = noteGuids;
        this._render();
    }

    async _walkRecord(rec, allItems, noteGuids) {
        const model = [];
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
                    // children arrays retain stale entries (moves, trash) — a kid
                    // only belongs here if its parent_guid points back at this item.
                    if (kid.parent_guid !== item.guid) continue;
                    const segs = kid.segments || [];
                    const first = segs[0];
                    if (first && first.type === "hashtag" && String(first.text).toLowerCase() === CTX_TAG) {
                        noteGuids.add(kid.guid);
                        const text = this._segText(segs.slice(1));
                        if (text) notes.push({ guid: kid.guid, item: kid, text });
                    }
                }
                if (notes.length) model.push({ anchorGuid: item.guid, notes });
                await walk(kids);
            }
        };
        await walk(top);
        return model;
    }

    // Toggle whether margin notes render at all (per device, via localStorage).
    _toggleDisplay() {
        this._enabled = !this._enabled;
        localStorage.setItem("mn-enabled", this._enabled ? "1" : "0");
        if (this._enabled) this._refreshSoon(0);
        else { this._clear(); this._muteStyle.textContent = ""; } // off must un-hide the tree lines
        this.ui.addToaster({ title: "Margin Notes", message: "Margin notes " + (this._enabled ? "on" : "off"), dismissible: true, autoDestroyTime: 2000 });
    }

    // Toggle the #ctx marker on the line that has the caret. The caret line is
    // identified by Thymer's own row class .listitem-with-caret (read-only DOM);
    // only the focused pane has a caret, so a document-wide query is unambiguous.
    async _toggleCaretLine() {
        const toast = (message) => this.ui.addToaster({ title: "Margin Notes", message, dismissible: true, autoDestroyTime: 2500 });
        const guid = document.querySelector(".listitem.listitem-with-caret")?.getAttribute("data-guid");
        if (!guid) { toast("Put the cursor on a line first"); return; }
        let item = this._allItems?.get(guid);
        if (!item) { await this._refresh(); item = this._allItems?.get(guid); }
        if (!item) { toast("Couldn't resolve the line"); return; }
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
                if (this._recGuids.has(item.parent_guid)) { toast("Top-level lines have no parent line to annotate"); return; }
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
        // Ear layers are our own nodes inside the scrollers — remove only them.
        for (const layer of document.querySelectorAll(".mn-ear-layer")) layer.remove();
        this._rendered = [];
    }

    _anchorEl(guid, scope) {
        return (scope || document).querySelector(`.listitem[data-guid="${guid}"]`);
    }

    _gutterFor(el) {
        const scroller = el.closest(".panel-scroller-y");
        if (!scroller) return 0;
        return scroller.getBoundingClientRect().right - el.getBoundingClientRect().right;
    }

    _render() {
        this._clear();
        if (!this._enabled) { this._muteStyle.textContent = ""; return; }
        // Margin wins: a #ctx line whose note renders in the margin is collapsed to
        // zero height in the tree, so expanding the parent (needed to read the real
        // children) never shows the note twice. CSS-only (no DOM mutation), scoped
        // to exact guids, intentionally global across panes. Zero-height, NOT
        // display:none — Thymer's caret movement is geometry-based and a display:none
        // row traps the caret at the end of the previous line (verified live
        // 2026-08-10); a zero-height row stays navigable. The :not(.listitem-with-caret)
        // guard expands the line while Thymer's caret is on it (rendered muted, so it
        // still reads as marginalia), collapsing again when the caret leaves. Empty
        // #ctx lines have no margin note to stand in for them, so they stay
        // visible-but-muted (the user deletes them by hand; invisible would make
        // that impossible).
        const withNote = new Set();
        for (const model of this._models.values())
            for (const entry of model)
                for (const n of entry.notes) withNote.add(n.guid);
        this._muteStyle.textContent = [...this._noteGuids]
            .map((g) => withNote.has(g)
                ? `.listitem[data-guid="${g}"]:not(.listitem-with-caret) { height: 0 !important; min-height: 0 !important; overflow: hidden; padding-top: 0 !important; padding-bottom: 0 !important; margin-top: 0 !important; margin-bottom: 0 !important; }\n` +
                  `.listitem[data-guid="${g}"].listitem-with-caret { opacity: .55; font-style: italic; }`
                : `.listitem[data-guid="${g}"] { opacity: .55; font-style: italic; }`)
            .join("\n");
        for (const pane of this._panes) {
            const model = this._models.get(pane.recGuid) || [];
            for (const entry of model) {
                entry.notes.forEach((note, i) => {
                    const el = document.createElement("div");
                    el.dataset.anchor = entry.anchorGuid;
                    el.addEventListener("click", (e) => { e.stopPropagation(); this._onNoteClick(entry, note, el, pane.el); });
                    const r = { el, paneEl: pane.el, anchorGuid: entry.anchorGuid, note, index: i, earEl: null };
                    // The dog-ear visual lives in the scroller (r.earEl); this fixed
                    // element is only its invisible hit target, so hover is relayed.
                    el.addEventListener("mouseenter", () => r.earEl?.classList.add("mn-ear-hover"));
                    el.addEventListener("mouseleave", () => r.earEl?.classList.remove("mn-ear-hover"));
                    this._root.appendChild(el);
                    this._rendered.push(r);
                });
            }
        }
        this._reposition();
    }

    _reposition() {
        if (!this._rendered.length && !this._editing) return;
        const lastBottoms = new Map(); // layer -> bottom of last placed sidenote (layer coords)
        for (const r of this._rendered) {
            const hide = () => { r.el.style.display = "none"; if (r.earEl) r.earEl.style.display = "none"; };
            const anchor = this._anchorEl(r.anchorGuid, r.paneEl);
            if (!anchor) { hide(); continue; }
            // The tree line is CSS-collapsed when the parent is expanded (margin wins),
            // so the note renders regardless — except while the caret sits on the
            // #ctx line itself: the caret escape makes the source visible there, and
            // showing both would duplicate it. The tick catches caret moves.
            const src = this._anchorEl(r.note.guid, r.paneEl);
            if (src && src.classList.contains("listitem-with-caret")) { hide(); continue; }
            const rect = anchor.getBoundingClientRect();
            const gutter = this._gutterFor(anchor);
            const side = gutter >= SIDENOTE_MIN_GUTTER;
            if (side) {
                // The note lives in the in-scroller layer (same technique as the
                // dog-ear) so it scrolls natively with its line; the scroller's
                // own overflow clips it, so no viewport culling is needed. The
                // gutter is inside the scroller but right of every row, so the
                // note stays directly clickable — the layer swallows the raw
                // mouse events the overlay root used to.
                const layer = this._earLayer(anchor);
                if (!layer) { hide(); continue; }
                if (r.earEl) r.earEl.style.display = "none";
                if (r.el.parentElement !== layer) layer.appendChild(r.el);
                const lr = layer.getBoundingClientRect();
                r.el.style.display = "";
                r.el.className = "mn-note";
                r.el.textContent = r.note.text || "(empty note)";
                // Right-anchored inside the full-width layer: the offset from the
                // layer's right edge is resize-invariant (rows and their container
                // reflow together), so CSS keeps the note glued to the moving edge
                // in real time during a window drag, between reposition passes.
                const w = Math.min(gutter - 30, NOTE_WIDTH_MAX);
                r.el.style.left = "";
                r.el.style.width = w + "px";
                r.el.style.right = lr.right - rect.right - 14 - w + "px";
                let top = rect.top - lr.top + r.index * 18;
                const lastBottom = lastBottoms.get(layer) ?? -1e9;
                if (top < lastBottom + 8) top = lastBottom + 8;
                r.el.style.top = top + "px";
                lastBottoms.set(layer, top + r.el.offsetHeight);
            } else {
                // One dog-ear per line regardless of note count; the popover stacks
                // them. The visible fold lives in the in-scroller layer; the fixed
                // overlay element is only a transparent hit target over it (the fold
                // paints behind the row, so the row would otherwise eat its clicks),
                // and is placed even off-viewport so no culling lag appears on scroll.
                if (r.index > 0) { hide(); continue; }
                if (r.el.parentElement !== this._root) this._root.appendChild(r.el);
                r.el.style.display = "";
                r.el.className = "mn-glyph";
                r.el.textContent = "";
                r.el.style.width = "";
                r.el.style.left = "";
                r.el.style.right = (innerWidth - rect.right) + "px";
                r.el.style.top = rect.top + "px";
                this._placeEar(r, anchor, rect);
            }
        }
    }

    // Per-pane layer holding the dog-ears and sidenotes: an own-node inside the
    // rows' container (the community own-node pattern, out-of-flow so zero
    // layout impact) so its children scroll with the content natively — a fixed
    // overlay always lags compositor scrolling. The ear's behind-the-text
    // painting relies on DOM order, not negative z-index (which would drop
    // below the panel's opaque ancestor background, verified live 2026-08-10):
    // rows are position:relative with z auto, so keeping the layer FIRST among
    // them paints every later row — text included — above the ear. Thymer
    // re-renders may drop the layer or prepend rows before it; both are healed
    // here on every pass. Because it lives inside the editor's scroller it
    // swallows raw mouse events exactly like the overlay root does — Thymer's
    // document-level coordinate handlers must never see clicks on a note.
    _earLayer(anchor) {
        const parent = anchor.parentElement;
        if (!parent) return null;
        let layer = parent.querySelector(":scope > .mn-ear-layer");
        if (!layer) {
            layer = document.createElement("div");
            layer.className = "mn-ear-layer";
            for (const evName of ["mousedown", "mouseup", "dblclick"]) {
                layer.addEventListener(evName, (e) => {
                    e.stopPropagation();
                    if (evName === "mousedown") e.preventDefault();
                });
            }
        }
        if (layer.previousElementSibling || !layer.isConnected) parent.prepend(layer);
        return layer;
    }

    _placeEar(r, anchor, rect) {
        const layer = this._earLayer(anchor);
        if (!layer) { if (r.earEl) r.earEl.style.display = "none"; return; }
        if (!r.earEl || r.earEl.parentElement !== layer) {
            r.earEl?.remove();
            r.earEl = document.createElement("div");
            r.earEl.className = "mn-ear";
            layer.appendChild(r.earEl);
        }
        // Same-frame rects make these offsets scroll-invariant. The fold's top
        // sits flush with the first text line's em box — measured from the
        // line's actual Range rect (line-box top + half-leading), since the row
        // box's padding and the line box's leading both float above the glyphs.
        let earTop = rect.top + 3; // fallback: ≈ row padding
        const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
        for (let n; (n = walker.nextNode()); ) {
            if (!n.textContent.trim()) continue;
            const rr = document.createRange();
            rr.selectNodeContents(n);
            const line = rr.getClientRects()[0];
            if (!line || !line.height) continue;
            const fs = parseFloat(getComputedStyle(n.parentElement).fontSize) || line.height;
            earTop = line.top + Math.max(0, (line.height - fs) / 2);
            break;
        }
        // Right-anchored for the same reason as the sidenote: the layer-right →
        // row-right delta survives a live resize, so the fold tracks the edge
        // via CSS while the window is being dragged.
        const lr = layer.getBoundingClientRect();
        r.earEl.style.display = "";
        r.earEl.style.left = "";
        r.earEl.style.right = lr.right - rect.right + "px";
        r.earEl.style.top = earTop - lr.top + "px";
    }

    // ---- popover (narrow mode) ----

    _onNoteClick(entry, note, el, paneEl) {
        if (el.classList.contains("mn-note")) {
            this._openEditor(entry.anchorGuid, note, paneEl);
        } else {
            if (this._pop?.dataset.anchor === entry.anchorGuid) { this._closePop(); return; }
            this._closePop();
            const anchor = this._anchorEl(entry.anchorGuid, paneEl);
            if (!anchor) return;
            const rect = anchor.getBoundingClientRect();
            const pop = document.createElement("div");
            pop.className = "mn-pop";
            pop.dataset.anchor = entry.anchorGuid;
            for (const n of entry.notes) {
                const row = document.createElement("div");
                row.className = "mn-pop-row";
                row.textContent = n.text;
                row.addEventListener("click", (e) => { e.stopPropagation(); this._closePop(); this._openEditor(entry.anchorGuid, n, paneEl); });
                pop.appendChild(row);
            }
            pop.style.left = Math.min(rect.left + 150, innerWidth - 300) + "px";
            pop.style.top = rect.bottom + 4 + "px";
            pop.addEventListener("click", (e) => e.stopPropagation());
            this._root.appendChild(pop);
            // clamp into the viewport once its height is known; flip above if needed
            const ph = pop.offsetHeight;
            if (rect.bottom + 4 + ph > innerHeight - 8)
                pop.style.top = Math.max(8, rect.top - ph - 4) + "px";
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

    _openEditor(anchorGuid, note, paneEl) {
        this._closeEditor();
        this._closePop();
        const anchor = this._anchorEl(anchorGuid, paneEl);
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
