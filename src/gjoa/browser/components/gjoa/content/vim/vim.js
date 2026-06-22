"use strict";

// about:vim — gjoa keybinding customizer. Reads the command catalog
// (gjoa.keys.commands, published by the vim module's VIM-COMMANDS registry) and
// edits the override pref gjoa.keys.bindings (JSON {key: commandId|null}). The
// dispatch side resolves the same pref, so a change here is live on the next key.
// textContent-only (privileged page rendering data).

(function () {
  let Services = null;
  try { Services = globalThis.Services; } catch (_) {}

  const $ = (id) => document.getElementById(id);

  function getStr(name, dflt) {
    try { return Services.prefs.getStringPref(name, dflt); } catch (_) { return dflt; }
  }
  function setStr(name, v) { try { Services.prefs.setStringPref(name, v); } catch (_) {} }
  function clearPref(name) { try { Services.prefs.clearUserPref(name); } catch (_) {} }

  function loadCatalog() {
    try { return JSON.parse(getStr("gjoa.keys.commands", "[]")) || []; } catch (_) { return []; }
  }
  function loadOverrides() {
    const raw = getStr("gjoa.keys.bindings", "");
    if (!raw) return {};
    try { return JSON.parse(raw) || {}; } catch (_) { return {}; }
  }

  let catalog = loadCatalog();
  let overrides = loadOverrides();

  const keyLabel = (k) => (k === " " ? "Space" : k === "`" ? "` (backtick)" : k);

  function defaultKeymap() {
    const m = {};
    for (const c of catalog) m[c.key] = c.id;
    return m;
  }
  function effectiveKeymap() {
    const m = defaultKeymap();
    for (const k in overrides) {
      if (overrides[k] === null) delete m[k];
      else m[k] = overrides[k];
    }
    return m;
  }
  function keyForCommand(id, eff) {
    for (const k in eff) if (eff[k] === id) return k;
    return null;
  }

  function save() {
    if (Object.keys(overrides).length === 0) clearPref("gjoa.keys.bindings");
    else setStr("gjoa.keys.bindings", JSON.stringify(overrides));
  }

  // Drop override entries that merely restate the default (keep the pref minimal).
  function normalize() {
    const def = defaultKeymap();
    for (const k in overrides) {
      if (overrides[k] !== null && def[k] === overrides[k]) delete overrides[k];
    }
  }

  function rebind(id, newKey) {
    const def = defaultKeymap();
    const oldKey = keyForCommand(id, effectiveKeymap());
    if (oldKey && oldKey !== newKey) {
      if (def[oldKey] === id) overrides[oldKey] = null; // unbind the default
      else if (overrides[oldKey] === id) delete overrides[oldKey];
    }
    overrides[newKey] = id;
    normalize();
    save();
    render();
    flash(`Bound ${keyLabel(newKey)} → ${id}`);
  }

  function resetOne(id) {
    const def = defaultKeymap();
    for (const k in overrides) if (overrides[k] === id) delete overrides[k];
    const dk = Object.keys(def).find((k) => def[k] === id);
    if (dk && overrides[dk] === null) delete overrides[dk];
    save();
    render();
  }

  function flash(msg) {
    const s = $("status");
    if (!s) return;
    s.textContent = msg;
    setTimeout(() => { if (s.textContent === msg) s.textContent = ""; }, 2200);
  }

  // ---- capture: click a key, press the next key to bind it --------------------
  let capturing = null;
  function startCapture(cmd) {
    capturing = cmd;
    $("capture-cmd").textContent = `${cmd.desc} (${cmd.id})`;
    $("capture").hidden = false;
  }
  function endCapture() {
    capturing = null;
    $("capture").hidden = true;
  }
  document.addEventListener("keydown", (e) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") { endCapture(); return; }
    // ignore lone modifiers
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
    const cmd = capturing;
    endCapture();
    rebind(cmd.id, e.key);
  }, true);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function render() {
    catalog = loadCatalog();
    overrides = loadOverrides();
    const eff = effectiveKeymap();
    const root = $("groups");
    root.textContent = "";

    if (catalog.length === 0) {
      root.appendChild(el("p", "empty",
        "No command catalog found. Open a browser window once so the vim module publishes it."));
      return;
    }

    // group by category, preserving first-seen order
    const order = [];
    const byCat = new Map();
    for (const c of catalog) {
      if (!byCat.has(c.cat)) { byCat.set(c.cat, []); order.push(c.cat); }
      byCat.get(c.cat).push(c);
    }

    for (const cat of order) {
      const section = el("section", "group");
      section.appendChild(el("h2", null, cat));
      const list = el("div", "rows");
      for (const cmd of byCat.get(cat)) {
        const row = el("div", "row");
        const desc = el("div", "desc", cmd.desc);
        const meta = el("div", "meta");
        const curKey = keyForCommand(cmd.id, eff);
        const isCustom = curKey !== cmd.key || overrides[cmd.key] != null;

        const keyBtn = el("button", "keybtn", curKey == null ? "unbound" : keyLabel(curKey));
        if (curKey == null) keyBtn.classList.add("unbound");
        keyBtn.title = "Click, then press a key to rebind";
        keyBtn.addEventListener("click", () => startCapture(cmd));
        meta.appendChild(keyBtn);

        if (isCustom) {
          const reset = el("button", "reset", "↺");
          reset.title = `Reset to default (${keyLabel(cmd.key)})`;
          reset.addEventListener("click", () => resetOne(cmd.id));
          meta.appendChild(reset);
        }
        row.appendChild(desc);
        row.appendChild(meta);
        list.appendChild(row);
      }
      section.appendChild(list);
      root.appendChild(section);
    }
  }

  $("reset-all").addEventListener("click", () => {
    overrides = {};
    clearPref("gjoa.keys.bindings");
    render();
    flash("All keybindings reset to defaults");
  });

  // live-refresh if the pref changes elsewhere (:bind, another window)
  try {
    Services.prefs.addObserver("gjoa.keys.bindings", { observe: () => render() });
  } catch (_) {}

  render();
})();
