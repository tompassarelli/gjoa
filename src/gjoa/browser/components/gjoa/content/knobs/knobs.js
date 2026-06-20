"use strict";

// about:knobs — render the reversible-feature dashboard from the live pref state.
// Every knob is a present, flippable pref; costs are shown as measured or honestly
// "unmeasured". Profiles flip a whole bundle (applied by GjoaLoader's apply-profile!).
// textContent-only — never innerHTML (privileged page rendering data + pref names).

(function () {
  const $ = (id) => document.getElementById(id);

  let Services = null;
  try { Services = globalThis.Services; } catch (_) {}

  function getPref(name, type, dflt) {
    try {
      return type === "int"
        ? Services.prefs.getIntPref(name, dflt)
        : Services.prefs.getBoolPref(name, dflt);
    } catch (_) { return dflt; }
  }
  function setBool(name, v) { try { Services.prefs.setBoolPref(name, v); } catch (_) {} }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // a checkbox styled as a switch; onChange(bool).
  function toggle(checked, onChange) {
    const label = el("label", "toggle");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    const track = el("span", "toggle-track");
    track.appendChild(el("span", "toggle-thumb"));
    label.appendChild(input);
    label.appendChild(track);
    return label;
  }

  function costText(m) {
    if (!m) return "cost: unknown";
    if (m.method === "unmeasured" || m.value == null) {
      return "cost: unmeasured" + (m.method && m.method !== "unmeasured" ? " (" + m.method + ")" : "");
    }
    return "cost: " + m.value + " " + (m.unit || "") + " (" + (m.confidence || "") + ")";
  }

  function renderProfiles(reg) {
    const root = $("profiles");
    root.textContent = "";
    for (const p of reg.profiles || []) {
      const card = el("div", "profile");
      const head = el("div", "profile-head");
      const txt = el("div", "profile-txt");
      txt.appendChild(el("div", "profile-title", p.title));
      if (p.claim) txt.appendChild(el("div", "profile-claim", p.claim));
      head.appendChild(txt);
      head.appendChild(toggle(getPref(p.pref, "bool", false), (on) => { setBool(p.pref, on); render(reg); }));
      card.appendChild(head);
      if (p.disclaimer) card.appendChild(el("p", "profile-disclaimer", p.disclaimer));
      if (p.tradeoffs && p.tradeoffs.length) {
        const ul = el("ul", "tradeoffs");
        for (const t of p.tradeoffs) {
          const li = el("li", "tradeoff");
          li.appendChild(el("span", "tradeoff-title", t.title));
          li.appendChild(el("span", "tradeoff-detail", t.detail));
          ul.appendChild(li);
        }
        card.appendChild(ul);
      }
      root.appendChild(card);
    }
  }

  function renderKnobs(reg) {
    const root = $("knobs");
    root.textContent = "";
    const cats = new Map();
    for (const k of reg.knobs || []) {
      if (!cats.has(k.category)) cats.set(k.category, []);
      cats.get(k.category).push(k);
    }
    for (const [cat, ks] of cats) {
      root.appendChild(el("h3", "cat", cat));
      for (const k of ks) {
        const row = el("div", "knob");
        const main = el("div", "knob-main");
        main.appendChild(el("div", "knob-title", k.title));
        const cur = getPref(k.pref, k.type, k.gjoaDefault);
        const isDefault = cur === k.gjoaDefault;
        main.appendChild(el("div", "knob-state",
          (cur ? "Enabled" : "Disabled") + (isDefault ? " · gjoa default" : " · overridden")));
        main.appendChild(el("div", "knob-cost", costText(k.measurement)));
        if (k.measurement && k.measurement.basis) {
          main.appendChild(el("div", "knob-basis", k.measurement.basis));
        }
        main.appendChild(el("div", "knob-pref", k.pref));
        row.appendChild(main);
        // bool knobs get a switch; non-bool (rare) show the value read-only.
        if (k.type === "bool") {
          row.appendChild(toggle(!!cur, (on) => { setBool(k.pref, on); render(reg); }));
        } else {
          row.appendChild(el("div", "knob-value", String(cur)));
        }
        root.appendChild(row);
      }
    }
  }

  function render(reg) {
    renderProfiles(reg);
    renderKnobs(reg);
    const n = (reg.knobs || []).length, p = (reg.profiles || []).length;
    $("foot").textContent = p + " profile(s), " + n + " knob(s). " +
      "Costs are measured against a real gjoa binary, or marked unmeasured — never invented.";
  }

  async function load() {
    try {
      const r = await fetch("chrome://gjoa/content/knobs/registry.json");
      render(await r.json());
    } catch (e) {
      $("knobs").textContent = "could not load the knobs registry: " + e;
    }
  }
  load();
})();
