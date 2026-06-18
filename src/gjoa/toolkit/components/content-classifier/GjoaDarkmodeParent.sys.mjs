/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Parent half of the gjoa per-site dark-mode HYBRID actor. Decides the
// per-document colorInversionOverride from trusted parent-process state: the
// dark-mode mode, the per-site override prefs, and the child's measurement of
// whether the page rendered dark on its own.

const ENABLED_PREF = "gjoa.darkmode.enabled";
const MODE_PREF = "gjoa.darkmode.mode";
const FORCE_NATIVE_PREF = "gjoa.darkmode.user.force-native";
const FORCE_INVERT_PREF = "gjoa.darkmode.user.force-invert";
const OFF_PREF = "gjoa.darkmode.user.off";

// Curated per-site dark-mode fix registry (Dark-Reader-derived, MIT). Packaged
// to resource://gre/modules/darkmode-fixes.json (FINAL_TARGET_FILES.modules).
// Inert-but-safe until the build packages it: loadFixes() catches the fetch
// failure and returns {} so the actor falls back to the user.*-pref + auto path.
const FIXES_URL = "resource://gre/modules/darkmode-fixes.json";

let gFixes = null; // host -> fix record
let gFixesLoading = null; // de-dupe concurrent first-load

async function loadFixes() {
  if (gFixes) {
    return gFixes;
  }
  if (gFixesLoading) {
    return gFixesLoading;
  }
  gFixesLoading = (async () => {
    try {
      const resp = await fetch(FIXES_URL);
      gFixes = await resp.json();
    } catch (e) {
      gFixes = {}; // never retry-loop; missing data = no fixes
    }
    return gFixes;
  })();
  return gFixesLoading;
}

// Most-specific host match: exact host, then walk parent domains.
function fixForHost(fixes, host) {
  if (!fixes || !host) {
    return null;
  }
  if (fixes[host]) {
    return fixes[host];
  }
  let h = host;
  let i;
  while ((i = h.indexOf(".")) !== -1) {
    h = h.slice(i + 1);
    if (fixes[h]) {
      return fixes[h];
    }
  }
  return null;
}

function hostOf(url) {
  try {
    return Services.io.newURI(url).host.toLowerCase();
  } catch (e) {
    return "";
  }
}

// host matches the pref's CSV exactly or as a parent domain.
function hostInPref(host, pref) {
  let raw = "";
  try {
    raw = Services.prefs.getStringPref(pref, "");
  } catch (e) {}
  return raw
    .split(",")
    .map(h => h.trim().toLowerCase())
    .filter(Boolean)
    .some(h => host === h || host.endsWith("." + h));
}

export class GjoaDarkmodeParent extends JSWindowActorParent {
  trustedUrl() {
    try {
      return this.manager?.documentURI?.spec || "";
    } catch (e) {
      return "";
    }
  }

  // Returns { override, css, inject } for this document.
  //   override: BrowsingContext.colorInversionOverride to set
  //     ("active" invert / "inactive" never / "none" defer to the global pref).
  //   css: optional USER_SHEET body the fix owns (Tier-1 curated colors).
  //   inject: optional document-start scriptlet (e.g. YouTube html[dark]).
  // Precedence: fix registry > user.* prefs > auto measurement.
  async #decide(hasNativeDark) {
    // Per-document overrides are a HYBRID-mode concern. In every other mode the
    // global pref drives inversion uniformly, so defer ("none").
    if (
      !Services.prefs.getBoolPref(ENABLED_PREF, false) ||
      Services.prefs.getStringPref(MODE_PREF, "auto") !== "hybrid"
    ) {
      return { override: "none", css: "", inject: "" };
    }
    const host = hostOf(this.trustedUrl());
    if (host) {
      // (1) Fix registry — highest precedence; owns override + css + inject.
      const fix = fixForHost(await loadFixes(), host);
      if (fix) {
        let css = fix.css || "";
        if (fix.invertSelectors && fix.invertSelectors.length) {
          css +=
            "\n" +
            fix.invertSelectors.join(",") +
            "{filter:invert(1) hue-rotate(180deg)!important}\n";
        }
        return {
          override: fix.override || "inactive",
          css,
          inject: fix.inject || "",
        };
      }
      // (2) User per-site prefs (unchanged order/behavior).
      if (hostInPref(host, OFF_PREF)) {
        return { override: "inactive", css: "", inject: "" };
      }
      if (hostInPref(host, FORCE_INVERT_PREF)) {
        return { override: "active", css: "", inject: "" };
      }
      if (hostInPref(host, FORCE_NATIVE_PREF)) {
        return { override: "inactive", css: "", inject: "" };
      }
    }
    // (3) Auto: invert only sites that did NOT render dark on their own.
    return { override: hasNativeDark ? "inactive" : "active", css: "", inject: "" };
  }

  async receiveMessage(msg) {
    if (msg.name === "Darkmode:GetInject") {
      // document-start fast-path: the child asks ONLY for the inject scriptlet,
      // before the page reads its theme config, so the first cascade is correct.
      const host = hostOf(this.trustedUrl());
      if (
        host &&
        Services.prefs.getBoolPref(ENABLED_PREF, false) &&
        Services.prefs.getStringPref(MODE_PREF, "auto") === "hybrid"
      ) {
        const fix = fixForHost(await loadFixes(), host);
        if (fix && fix.inject) {
          return { inject: fix.inject };
        }
      }
      return { inject: "" };
    }
    if (msg.name === "Darkmode:Decide") {
      return await this.#decide(!!msg.data?.hasNativeDark);
    }
    return null;
  }
}
