"use strict";
var plugins = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // plugin.js
  var plugin_exports = {};
  __export(plugin_exports, {
    Plugin: () => Plugin
  });
  var CTX_TAG = "#ctx";
  var SIDENOTE_MIN_GUTTER = 190;
  var NOTE_WIDTH_MAX = 260;
  var STYLE_ID = "margin-notes-style";
  var MUTE_STYLE_ID = "margin-notes-mute";
  var CSS = `
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
  var Plugin = class extends AppPlugin {
    static {
      __name(this, "Plugin");
    }
    onLoad() {
      this._enabled = localStorage.getItem("mn-enabled") !== "0";
      this._panes = [];
      this._models = /* @__PURE__ */ new Map();
      this._allItems = /* @__PURE__ */ new Map();
      this._recGuids = /* @__PURE__ */ new Set();
      this._noteGuids = /* @__PURE__ */ new Set();
      this._rendered = [];
      this._editing = null;
      this._pop = null;
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
        onClick: /* @__PURE__ */ __name(() => {
          this._enabled = !this._enabled;
          localStorage.setItem("mn-enabled", this._enabled ? "1" : "0");
          this._enabled ? this._refreshSoon(0) : this._clear();
          this.ui.addToaster({ title: "Margin Notes", message: "Margin notes " + (this._enabled ? "on" : "off"), dismissible: true, autoDestroyTime: 2e3 });
        }, "onClick")
      });
      this.ui.addCommandPaletteCommand({
        label: "Margin Notes: toggle #ctx on current line",
        icon: "ti-notes",
        onSelected: /* @__PURE__ */ __name(() => this._toggleCaretLine(), "onSelected")
      });
      for (const ev of ["panel.navigated", "panel.focused", "panel.closed"])
        this._handlers.push(this.events.on(ev, () => this._refreshSoon(150)));
      for (const ev of ["lineitem.created", "lineitem.updated", "lineitem.moved", "lineitem.deleted", "lineitem.undeleted"])
        this._handlers.push(this.events.on(ev, () => this._refreshSoon(300)));
      this._onScroll = () => this._reposition();
      this._onResize = () => this._refreshSoon(150);
      document.addEventListener("scroll", this._onScroll, { capture: true, passive: true });
      window.addEventListener("resize", this._onResize);
      this._tick = setInterval(() => this._reposition(), 1200);
      this._panelObs = new MutationObserver(() => this._reposition());
      this._refreshSoon(400);
    }
    onUnload() {
      for (const h of this._handlers) this.events.off(h);
      clearInterval(this._tick);
      this._panelObs?.disconnect();
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
    // Every editor pane showing a record, each with its DOM element for scoped anchor
    // lookups. Falls back to the single active panel when getPanels() is missing, and
    // to document-wide queries when getElement() is — the pre-multi-pane behavior.
    _editorPanes() {
      let panels = null;
      try {
        panels = typeof this.ui.getPanels === "function" ? this.ui.getPanels() : null;
      } catch {
      }
      if (!Array.isArray(panels) || !panels.length) {
        const p = this.ui.getActivePanel?.();
        panels = p ? [p] : [];
      }
      const panes = [];
      for (const p of panels) {
        let rec = null, el = null, active = false;
        try {
          rec = p.getActiveRecord?.() || null;
        } catch {
        }
        if (!rec) continue;
        try {
          el = p.getElement?.() || null;
        } catch {
        }
        try {
          active = !!p.isActive?.();
        } catch {
        }
        panes.push({ rec, recGuid: rec.guid, el, active });
      }
      if (panes.length > 1 && panes.some((p) => !p.el))
        return panes.filter((p) => p.el || p.active);
      return panes;
    }
    _paneKey(panes) {
      return panes.map((p) => p.recGuid).sort().join(",");
    }
    async _refresh() {
      if (!this._enabled) return;
      if (this._editing) {
        this._refreshSoon(1e3);
        return;
      }
      const panes = this._editorPanes();
      if (!panes.length) return;
      const key = this._paneKey(panes);
      const models = /* @__PURE__ */ new Map();
      const allItems = /* @__PURE__ */ new Map();
      const noteGuids = /* @__PURE__ */ new Set();
      try {
        for (const pane of panes) {
          if (models.has(pane.recGuid)) continue;
          models.set(pane.recGuid, await this._walkRecord(pane.rec, allItems, noteGuids));
        }
      } catch (e) {
        console.warn("[margin-notes] read failed", e);
        return;
      }
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
      const top = await rec.getLineItems();
      const visited = /* @__PURE__ */ new Set();
      const walk = /* @__PURE__ */ __name(async (list) => {
        for (const item of list || []) {
          if (!item || visited.has(item.guid)) continue;
          visited.add(item.guid);
          allItems.set(item.guid, item);
          const kids = await this._childrenOf(item);
          const notes = [];
          for (const kid of kids || []) {
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
      }, "walk");
      await walk(top);
      return model;
    }
    // Toggle the #ctx marker on the line that has the caret. The caret line is
    // identified by Thymer's own row class .listitem-with-caret (read-only DOM);
    // only the focused pane has a caret, so a document-wide query is unambiguous.
    async _toggleCaretLine() {
      const toast = /* @__PURE__ */ __name((message) => this.ui.addToaster({ title: "Margin Notes", message, dismissible: true, autoDestroyTime: 2500 }), "toast");
      const guid = document.querySelector(".listitem.listitem-with-caret")?.getAttribute("data-guid");
      if (!guid) {
        toast("Put the cursor on a line first");
        return;
      }
      let item = this._allItems?.get(guid);
      if (!item) {
        await this._refresh();
        item = this._allItems?.get(guid);
      }
      if (!item) {
        toast("Couldn't resolve the line");
        return;
      }
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
          if (this._recGuids.has(item.parent_guid)) {
            toast("Top-level lines have no parent line to annotate");
            return;
          }
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
      if (typeof item.getChildren === "function") return await item.getChildren() || [];
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
      if (!this._enabled) {
        this._muteStyle.textContent = "";
        return;
      }
      this._muteStyle.textContent = [...this._noteGuids].map((g) => `.listitem[data-guid="${g}"] { opacity: .55; font-style: italic; }`).join("\n");
      for (const pane of this._panes) {
        const model = this._models.get(pane.recGuid) || [];
        for (const entry of model) {
          entry.notes.forEach((note, i) => {
            const el = document.createElement("div");
            el.dataset.anchor = entry.anchorGuid;
            el.addEventListener("click", (e) => {
              e.stopPropagation();
              this._onNoteClick(entry, note, el, pane.el);
            });
            this._root.appendChild(el);
            this._rendered.push({ el, paneEl: pane.el, anchorGuid: entry.anchorGuid, note, index: i });
          });
        }
      }
      if (this._panelObs) {
        this._panelObs.disconnect();
        for (const pane of this._panes) if (pane.el) this._panelObs.observe(pane.el, { childList: true });
      }
      this._reposition();
    }
    _reposition() {
      if (!this._rendered.length && !this._editing) return;
      const lastBottoms = /* @__PURE__ */ new Map();
      for (const r of this._rendered) {
        const anchor = this._anchorEl(r.anchorGuid, r.paneEl);
        if (!anchor) {
          r.el.style.display = "none";
          continue;
        }
        if (this._anchorEl(r.note.guid, r.paneEl)) {
          r.el.style.display = "none";
          continue;
        }
        const rect = anchor.getBoundingClientRect();
        if (rect.bottom < -40 || rect.top > innerHeight + 40) {
          r.el.style.display = "none";
          continue;
        }
        if (this._anchorCovered(anchor, rect)) {
          r.el.style.display = "none";
          continue;
        }
        const gutter = this._gutterFor(anchor);
        const side = gutter >= SIDENOTE_MIN_GUTTER;
        r.el.style.display = "";
        if (side) {
          r.el.className = "mn-note";
          r.el.textContent = r.note.text || "(empty note)";
          r.el.style.width = Math.min(gutter - 30, NOTE_WIDTH_MAX) + "px";
          r.el.style.left = rect.right + 14 + "px";
          let top = rect.top + r.index * 18;
          const lastBottom = lastBottoms.get(r.paneEl) ?? -1e9;
          if (top < lastBottom + 8) top = lastBottom + 8;
          r.el.style.top = top + "px";
          lastBottoms.set(r.paneEl, top + r.el.offsetHeight);
        } else {
          if (r.index > 0) {
            r.el.style.display = "none";
            continue;
          }
          r.el.className = "mn-glyph";
          r.el.textContent = "\u273B";
          r.el.style.width = "";
          r.el.style.left = rect.right + 4 + "px";
          r.el.style.top = rect.top + (rect.height - 16) / 2 + "px";
        }
      }
    }
    // Occlusion: hide a note when its anchor row is visually covered by another
    // layer — a full-panel plugin overlay, a native modal, a sticky header. The
    // topmost element at the row's center tells us: anything inside the row's own
    // scroller is just the editor painting itself (selection layers etc.); anything
    // outside it is a cover. Read-only (elementFromPoint), no DOM mutation.
    _anchorCovered(anchor, rect) {
      const cy = rect.top + rect.height / 2;
      if (cy < 0 || cy >= innerHeight) return false;
      const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1);
      const el = document.elementFromPoint(cx, cy);
      if (!el || anchor.contains(el)) return false;
      if (this._root.contains(el)) return false;
      const scroller = anchor.closest(".panel-scroller-y");
      return scroller ? !scroller.contains(el) : false;
    }
    // ---- popover (narrow mode) ----
    _onNoteClick(entry, note, el, paneEl) {
      if (el.classList.contains("mn-note")) {
        this._openEditor(entry.anchorGuid, note, paneEl);
      } else {
        if (this._pop?.dataset.anchor === entry.anchorGuid) {
          this._closePop();
          return;
        }
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
          row.addEventListener("click", (e) => {
            e.stopPropagation();
            this._closePop();
            this._openEditor(entry.anchorGuid, n, paneEl);
          });
          pop.appendChild(row);
        }
        pop.style.left = Math.min(rect.left + 150, innerWidth - 300) + "px";
        pop.style.top = rect.bottom + 4 + "px";
        pop.addEventListener("click", (e) => e.stopPropagation());
        this._root.appendChild(pop);
        const ph = pop.offsetHeight;
        if (rect.bottom + 4 + ph > innerHeight - 8)
          pop.style.top = Math.max(8, rect.top - ph - 4) + "px";
        this._pop = pop;
        this._outside = (e) => {
          if (!pop.contains(e.target)) this._closePop();
        };
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
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this._saveEditor();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this._closeEditor();
        }
      });
      card.addEventListener("blur", () => this._saveEditor());
      this._root.appendChild(card);
      this._editing = { card, anchorGuid, note };
      card.focus();
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
        if (!text) {
          await note.item.setSegments([{ type: "hashtag", text: CTX_TAG }]);
          this.ui.addToaster({ title: "Margin Notes", message: "Note cleared \u2014 delete the empty #ctx line in the outline to remove it", dismissible: true, autoDestroyTime: 4e3 });
        } else if (text !== note.text)
          await note.item.setSegments([{ type: "hashtag", text: CTX_TAG }, { type: "text", text: " " + text }]);
      } catch (e) {
        console.warn("[margin-notes] save failed", e);
        this.ui.addToaster({ title: "Margin Notes", message: "Note save failed", dismissible: true, autoDestroyTime: 3e3 });
      }
      this._refreshSoon(350);
    }
  };
  return __toCommonJS(plugin_exports);
})();
