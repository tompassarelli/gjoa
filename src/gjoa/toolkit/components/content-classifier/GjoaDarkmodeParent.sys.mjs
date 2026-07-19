/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Parent half of the gjoa per-site dark-mode HYBRID actor. Decides the
// per-document colorInversionOverride from trusted parent-process state: the
// dark-mode mode, the per-site override prefs, and (for the auto refiner) the
// child's measurement of whether the page authored itself dark.
//
// Two decision surfaces:
//   #explicit() — the curated fix registry + user per-site prefs. Returned at
//     document-start (Darkmode:GetInject) so curated sites apply their override
//     + css + inject BEFORE first paint (no flash).
//   #auto()     — the post-paint refiner (Darkmode:Decide). Only runs for sites
//     with no explicit decision. With the engine's pre-paint default-invert
//     (gjoa.darkmode.hybrid.default-invert) on, it defers to the engine for
//     themeless pages and only retracts ("inactive") sites whose AUTHORED
//     background is dark but the engine's root-only pre-paint check missed.

const ENABLED_PREF = "gjoa.darkmode.enabled";
const MODE_PREF = "gjoa.darkmode.mode";
const FORCE_NATIVE_PREF = "gjoa.darkmode.user.force-native";
const FORCE_INVERT_PREF = "gjoa.darkmode.user.force-invert";
const OFF_PREF = "gjoa.darkmode.user.off";
// Engine default-invert (read by nsPresContext::UpdateColorInversion); when on,
// the engine darkens themeless pages pre-paint and the actor only refines.
const DEFAULT_INVERT_PREF = "gjoa.darkmode.hybrid.default-invert";

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
    mirrorOverridesPref(gFixes);
    return gFixes;
  })();
  return gFixesLoading;
}

// Mirror the registry's host -> override into a pref the CONTENT-process actor
// reads SYNCHRONOUSLY at document-start (before PresShell::Initialize), so a
// curated site's override lands pre-paint with no IPC round-trip — eliminating
// the brief double-dark on attribute-gated sites (e.g. YouTube's html[dark]).
function mirrorOverridesPref(fixes) {
  try {
    const overrides = {};
    const colorSchemes = {};
    for (const host of Object.keys(fixes || {})) {
      const ov = fixes[host].override || "inactive";
      if (ov !== "auto") {
        overrides[host] = ov; // "auto" is decided at runtime by the refiner, not pre-paint
      }
      // colorScheme:"light"/"dark" — force a native-dark site to serve that theme
      // pre-paint (then the engine inverts). Mirrored like overrides so the content
      // actor applies it SYNC at document-start via prefersColorSchemeOverride.
      const cs = fixes[host].colorScheme;
      if (cs) {
        colorSchemes[host] = cs;
      }
    }
    Services.prefs.setStringPref(
      "gjoa.darkmode.fix-overrides",
      JSON.stringify(overrides)
    );
    Services.prefs.setStringPref(
      "gjoa.darkmode.fix-colorscheme",
      JSON.stringify(colorSchemes)
    );
  } catch (e) {}
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

// ── APCA contrast + backdrop-aware corrective retone ───────────────────────────
// Keep in sync with tools/darkmode-regress/snap.js (the deterministic suite uses
// the exact same math to MEASURE; here we apply it to FIX). Pure functions.
const NORMALIZE_PREF = "gjoa.darkmode.normalize.enabled";
const NORMALIZE_FLOOR_PREF = "gjoa.darkmode.normalize.floor";
// The engine's inversion band (patch 0009): every color's OKLCH L is remapped to
// L_out = ceiling - L_in*(ceiling - floor). Read the same live prefs the cascade
// reads so we can INVERT the map and recover a text run's AUTHORED lightness.
const INVERT_FLOOR_PREF = "gjoa.darkmode.invert.bgLightness"; // white maps here
const INVERT_CEIL_PREF = "gjoa.darkmode.invert.fgLightness"; // black maps here
// FG over-dimming thresholds (OKLCH L, 0..1), tuned on the mark-2 corpus.
const FG_DARK_BG_L = 0.45; // backdrop counts as dark/saturated at or below this L
const FG_LIGHT_MIN_L = 0.55; // a run this light is a clear light-on-dark run
const FG_RAISE_BELOW_L = 0.85; // only raise runs dimmer than near-white (no-op above)
const FG_AUTHORED_LIGHT_L = 0.85; // recovered authored L that counts as near-white
// DARK-FG-ON-BRAND-BG (wave-5b). The engine brand-PRESERVES a mid/dark chromatic bg
// (chroma > 0.08) yet still role-blind-INVERTS an authored-light fg on it to dark, breaking
// the pair below the A1 floor with the WRONG polarity. Recover toward the authored light
// polarity where the bg is non-dark (W-D's clauses handle dark bg) AND white is the higher-
// contrast choice for that backdrop.
const FG_BRAND_BG_FLOOR = 75; // A1 body floor: recover an authored-light run under this |Lc|
const FG_HALATION_CEIL = 90; // A1 Lc90 halation ceiling: don't over-contrast the recovered fg
// CHROMATIC ACCENT / LINK (wave6). The engine (0009 invert_color_luminance) brand-
// PRESERVES every C>0.08 color and applies that role-blind, so a chromatic FOREGROUND
// (a link, a brand accent) is returned UNCHANGED — never lifted — and lands illegible
// or hue-flat on the dark canvas. These own the fg-side repair for such runs.
// OKLCH chroma above which a run carries a hue worth preserving. Aligned to the
// engine's OWN neutral-snap boundary (0009 zeroes c_in < 0.03): any run the engine
// kept chromatic (incl. a blue the band DESATURATED, e.g. akr #323b4d at c≈0.034) is
// a link/accent to preserve; a true neutral snaps to c=0 below this and falls through
// to the neutral clauses. (The band's over-desaturation of saturated links is the
// engine-side root — see wave6 report §engine; this recovers the muted hue it left.)
const FG_ACCENT_CHROMA = 0.03;
const FG_ACCENT_FLOOR = 60; // chromatic accents read at >= Lc 60 (A5 / done-when), brighter than the 45 legibility floor
// PURPLE-SHIFT / periwinkle cast (cluster D). invertBand brand-PRESERVES hue+chroma for any
// run whose chroma sits in [0.03, 0.08] (its neutral-snap only zeroes c < 0.03). So a text a
// site authored a FAINT slate / blue-violet (chroma just above the 0.03 snap, a cool hue)
// keeps that faint cast through the L-remap and, at the light OUTPUT lightness, reads as a
// visible LAVENDER / PERIWINKLE — the classic dark-mode purple-shift (cambridge headings +
// body). The wave6 accent clause below then PRESERVES it (a chromatic run clearing the floor
// is left exactly as painted), so the cast survives to screen. But a genuine brand accent is
// VIVIDLY chromatic (the engine brand-preserves it at c > 0.08; even a muted link sits well
// above this), so a NON-LINK run carrying only a faint cool cast is an inversion ARTIFACT, not
// authored intent: snap it to a same-lightness neutral gray, exactly what Dark Reader renders.
// Narrowly gated so it can never touch a real accent: NON-LINK only (a link keeps its
// affordance re-solve / chroma-boost below), FAINT chroma only (vivid brand accents untouched),
// and the COOL/VIOLET hue band only — a warm muted brand heading (gold / red / orange) is left
// exactly as the engine painted it.
const FG_CAST_CHROMA_CEIL = 0.07; // a faint cool cast; a real (even muted) accent sits at/above this
const FG_CAST_HUE_LO = 255; // OKLCH blue-violet …
const FG_CAST_HUE_HI = 330; // … through magenta: the purple-shift artifact band

function _lin(c) { return Math.pow(c / 255, 2.4); }
function _Ys(p) { return 0.2126729 * _lin(p[0]) + 0.7151522 * _lin(p[1]) + 0.0721750 * _lin(p[2]); }
function _apca(t, b) {
  let Yt = _Ys(t), Yb = _Ys(b); const bt = 0.022, bc = 1.414;
  if (Yt <= bt) Yt += Math.pow(bt - Yt, bc);
  if (Yb <= bt) Yb += Math.pow(bt - Yb, bc);
  if (Math.abs(Yb - Yt) < 0.0005) return 0;
  let C;
  if (Yb > Yt) { const s = (Math.pow(Yb, 0.56) - Math.pow(Yt, 0.57)) * 1.14; C = s < 0.1 ? 0 : s - 0.027; }
  else { const s = (Math.pow(Yb, 0.65) - Math.pow(Yt, 0.62)) * 1.14; C = s > -0.1 ? 0 : s + 0.027; }
  return C * 100;
}
// Re-tone fg over bg to clear |Lc| >= T: pick the polarity (toward white/black) with
// the most contrast against bg, binary-search the minimal hue-preserving shift.
function _correct(fg, bg, T) {
  // Retone failing text to NEUTRAL max contrast — white on a dark backdrop, black on a light
  // one. BRIGHT (not the minimal-floor grey that muted bestbuy's heading in the v1 regression)
  // so corrected text reads as crisp as DR's; NEUTRAL so it round-trips cleanly through the
  // engine's OKLCH inversion (a grey/white can't come back purple). The engine's inversion
  // band caps the painted result near the ceiling (~0.9), so this lands as near-white text.
  const cw = Math.abs(_apca([255, 255, 255], bg)), cb = Math.abs(_apca([0, 0, 0], bg));
  const tv = cw >= cb ? 255 : 0;
  return [tv, tv, tv];
}
// Raise a light-on-dark (or authored-light-but-floored) text run toward the
// near-white ceiling, PRESERVING hue for chromatic runs so a link keeps its blue.
// Returns the desired PAINTED color; the child re-inverts it (invertLum) so the
// engine's band lands it near-white. Neutral -> pure white; chromatic -> the same
// hue scaled so its brightest channel reaches white (raises L, keeps hue).
function _raiseLight(fg) {
  const mx = Math.max(fg[0], fg[1], fg[2]), mn = Math.min(fg[0], fg[1], fg[2]);
  if (mx - mn <= 24 || mx <= 0) {
    return [255, 255, 255];
  }
  const k = 255 / mx;
  return [Math.round(fg[0] * k), Math.round(fg[1] * k), Math.round(fg[2] * k)];
}
// Cap a recovered fg below the A1 Lc90 halation ceiling: if the near-white target
// over-contrasts its (dark/mid) backdrop, scale its brightness down HUE-PRESERVED (a
// uniform channel scale keeps the hue, lowers L) until |APCA| <= 90. On a mid/dark brand
// bg pure white is typically < 90, so this is a no-op there; it only binds on the darker
// end of the preserved-bg range. Monotonic (brighter target = more |Lc| on a dark bg), so
// a bounded binary search finds the brightest target that still clears the ceiling.
function _capHalation(target, bg) {
  if (Math.abs(_apca(target, bg)) <= FG_HALATION_CEIL) {
    return target;
  }
  let lo = 0, hi = 1, best = target;
  for (let i = 0; i < 14; i++) {
    const k = (lo + hi) / 2;
    const t = [Math.round(target[0] * k), Math.round(target[1] * k), Math.round(target[2] * k)];
    if (Math.abs(_apca(t, bg)) > FG_HALATION_CEIL) {
      hi = k;
    } else {
      lo = k;
      best = t;
    }
  }
  return best;
}
// sRGB neutral gray whose OKLCH L == L. For a neutral, oklchL = cbrt(Y_lin) (the OKLab
// matrix rows each sum to ~1), so Y_lin = L^3 and g = sRGB-gamma(L^3). This is the
// LIGHTEST fg the engine can paint (its band ceiling = fgLightness): the achievable-
// light-contrast bound the brand-bg clause checks before recovering (see below).
function _neutralAtL(L) {
  const y = Math.max(0, Math.min(1, L * L * L));
  const g = Math.round(255 * (y <= 0.0031308 ? 12.92 * y : 1.055 * Math.pow(y, 1 / 2.4) - 0.055));
  return [g, g, g];
}
// The engine luminance-inverts every computed color (patch 0009, an involution). To
// make the painted result equal `target` when inversion is ON, author invertLum(target).
function _invertLum(rgb) {
  const compute = (u) => { const f = u / 255; return f <= 0.03928 ? f / 12.92 : Math.pow((f + 0.055) / 1.055, 2.4); };
  const decompute = (x) => { const s = x <= 0.03928 / 12.92 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; return Math.min(255, Math.max(0, Math.round(s * 255))); };
  const lr = compute(rgb[0]), lg = compute(rgb[1]), lb = compute(rgb[2]);
  const lum = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  const factor = ((1 - lum) + 0.05) / (lum + 0.05);
  const adj = (l) => decompute(Math.max(0, (l + 0.05) * factor - 0.05));
  return [adj(lr), adj(lg), adj(lb)];
}
// Scorer-exact sRGB → CIE L* (mirrors tools/darkmode-regress/scorer.js) so the actor's
// Tier-1 "did we get dark?" decision uses the SAME math as the QA grader (the keystone).
function _srgbLin(c8) { const c = c8 / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function _relLum(r, g, b) { return 0.2126 * _srgbLin(r) + 0.7152 * _srgbLin(g) + 0.0722 * _srgbLin(b); }
function _lstar(Y) { return Y <= 0.008856 ? 903.3 * Y : 116 * Math.cbrt(Y) - 16; }
// sRGB(0..255) -> OKLab L (== OKLCH L, 0..1). The engine's band works in OKLCH L,
// so the fg-preservation logic must reason in the SAME space (Ottosson OKLab).
function _oklchL(rgb) {
  const lin = _srgbLin;
  const r = lin(rgb[0]), g = lin(rgb[1]), b = lin(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
}
// True when a corrective would DARKEN the run (lower its OKLCH lightness). The
// never-darken-on-native-dark guard uses this: on a page the engine is not inverting,
// the normalizer may only lighten, never darken (the site owns its text colors). Pure
// mirror of the invariant tested in tools/darkmode-regress/normalize-guard.test.js.
function _decideCorrectiveDarkens(corrective, fg) {
  return _oklchL(corrective) < _oklchL(fg);
}
// ── OKLCH ⇄ sRGB (Ottosson) + the hue-preserving accent solve ──────────────────────
// Ported from tools/darkmode-regress/colormath.js (the canonical operator, the SAME
// math patch 0013 runs at paint) so a CHROMATIC accent/link the engine left illegible
// is re-solved HUE-EXACT toward legibility — the fg-side answer to the role-blind
// brand-preserve (0009 exempts every C>0.08 fg from lift; see wave6-link-class-report).
function _oklab(rgb) {
  const r = _srgbLin(rgb[0]), g = _srgbLin(rgb[1]), b = _srgbLin(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
function _oklchC(rgb) { const [, a, b] = _oklab(rgb); return Math.hypot(a, b); }
function _toSrgb8(x) {
  x = Math.min(1, Math.max(0, x));
  const s = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(s * 255)));
}
function _oklabToLinear(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}
function _inGamut(c) {
  const e = 1e-4;
  return c[0] >= -e && c[0] <= 1 + e && c[1] >= -e && c[1] <= 1 + e && c[2] >= -e && c[2] <= 1 + e;
}
// OKLCH -> sRGB8, gamut-mapped by REDUCING CHROMA at fixed L,h (never a hue-shifting
// clip) — so hue is held EXACTLY; only saturation sheds if the tone is out of gamut.
function _oklchToSrgb(L, C, h) {
  let lin = _oklabToLinear(L, C * Math.cos(h), C * Math.sin(h));
  if (!_inGamut(lin)) {
    let lo = 0, hi = C;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (_inGamut(_oklabToLinear(L, mid * Math.cos(h), mid * Math.sin(h)))) lo = mid; else hi = mid;
    }
    lin = _oklabToLinear(L, lo * Math.cos(h), lo * Math.sin(h));
  }
  return [_toSrgb8(lin[0]), _toSrgb8(lin[1]), _toSrgb8(lin[2])];
}
// THE OPERATOR: land |APCA(fg,bg)| in [T..ceiling], moving ONLY OKLCH lightness,
// holding hue EXACTLY, never adding chroma. Polarity-pick the higher-contrast side for
// THIS backdrop, then binary-search the MINIMAL lightness shift that clears T (+3
// hysteresis). Returns the desired PAINTED rgb (the child pre-inverts as needed).
// Mirrors colormath.correct() / patch-0013 GjoaDarkText::Correct exactly.
function _solveAccent(fg, bg, T, ceiling) {
  const lab = _oklab(fg);
  const L0 = lab[0], C0 = Math.hypot(lab[1], lab[2]), h0 = Math.atan2(lab[2], lab[1]);
  const cw = Math.abs(_apca([255, 255, 255], bg)), cb = Math.abs(_apca([0, 0, 0], bg));
  const Lext = cw >= cb ? 1 : 0;
  const at = k => _oklchToSrgb(L0 + k * (Lext - L0), C0, h0);
  if (Math.abs(_apca(at(1), bg)) < T + 3) return at(1); // backdrop-capped: return the extreme
  let lo = 0, hi = 1, best = at(1);
  for (let i = 0; i < 24; i++) {
    const k = (lo + hi) / 2, c = at(k);
    if (Math.abs(_apca(c, bg)) >= T + 3) { best = c; hi = k; } else { lo = k; }
  }
  if (Math.abs(_apca(best, bg)) > ceiling) {
    let lo2 = 0, hi2 = 1;
    for (let i = 0; i < 20; i++) {
      const k = (lo2 + hi2) / 2, c = at(k), lc = Math.abs(_apca(c, bg));
      if (lc > ceiling) { hi2 = k; } else if (lc < T) { lo2 = k; } else { best = c; break; }
      best = c;
    }
  }
  return best;
}
// wave-A LINK re-saturation. The engine band (invertBand) brand-PRESERVES chroma > 0.08
// but remaps a LOW-chroma authored link (a slate/muted blue near the 0.03 neutral-snap)
// to a washed mid-light that clears the legibility floor yet reads NEUTRAL — the blue
// affordance is gone (marginalia/antonz/fnordig link-flatten). _solveAccent alone can't
// fix it: it holds chroma FIXED, so a washed run stays washed. This RE-synthesises a
// healthy link chroma at the run's SURVIVING hue (the band preserves hue direction, only
// sheds magnitude), holding hue EXACTLY and clamping to the sRGB gamut. The boosted run
// carries C ≈ 0.11 > 0.08, so the engine brand-preserves it on re-band (verified via the
// colormath oracle: invertBand(boosted) == boosted) — the vivid link survives to paint.
// Returns null when the painted run has no trustworthy hue (a genuine neutral link), so
// the caller leaves it neutral rather than inventing a tint.
const FG_LINK_VIVID_C = 0.1; // painted chroma below this = a washed link worth re-saturating
const FG_LINK_TARGET_C = 0.11; // synthesised link chroma (> 0.08 so the band preserves it)
function _boostLinkChroma(fg) {
  const lab = _oklab(fg);
  const L = lab[0], C = Math.hypot(lab[1], lab[2]), h = Math.atan2(lab[2], lab[1]);
  if (C < 0.008) {
    return null; // no hue to hold — a real neutral link
  }
  return _oklchToSrgb(L, Math.max(C, FG_LINK_TARGET_C), h);
}

export class GjoaDarkmodeParent extends JSWindowActorParent {
  // Decision-path trace (pref-gated, zero overhead off). Tab-delimited on
  // stdout, same channel discipline as gjoa.darkmode.normalize.logms — lets a
  // harness assert WHY a page was (not) inverted instead of guessing from
  // pixels.
  #debug(line) {
    try {
      if (Services.prefs.getBoolPref("gjoa.darkmode.debug", false)) {
        dump(`GJOA_DARKMODE\t${line}\n`);
      }
    } catch (e) {}
  }

  trustedUrl() {
    try {
      return this.manager?.documentURI?.spec || "";
    } catch (e) {
      return "";
    }
  }

  #hybridActive() {
    // Active for the explicit "hybrid" mode AND whenever the engine's pre-paint
    // default-invert is on (e.g. "system" mode while the OS is dark) — that pref
    // is the single signal that hybrid behavior is live, so the actor's curated
    // fixes + refiner track it without knowing the mode string.
    if (!Services.prefs.getBoolPref(ENABLED_PREF, false)) {
      return false;
    }
    const m = Services.prefs.getStringPref(MODE_PREF, "dark");
    return (
      m === "dark" || m === "hybrid" ||
      Services.prefs.getBoolPref(DEFAULT_INVERT_PREF, false)
    );
  }

  // The explicit (non-measured) decision: curated fix registry, then user
  // per-site prefs. Returns { override, css, inject } or null when nothing
  // explicit applies (the engine default-invert + auto refiner then decide).
  async #explicit() {
    if (!this.#hybridActive()) {
      return null;
    }
    const host = hostOf(this.trustedUrl());
    if (!host) {
      return null;
    }
    // (1) Fix registry — but only a HARD override ("active"/"inactive") applies here,
    // pre-paint. An "auto" entry (the bulk default) defers its invert/accept decision
    // to the measured #auto refiner, which yields to a genuinely-dark site (so github
    // with a fix is NOT force-inverted). So fall through "auto" as if no explicit
    // decision and let #auto measure + decide + ship the curated CSS.
    // A HARD "inactive" entry is a complete hand-authored DARK THEME (sets a dark
    // html/body/:root bg or color-scheme:dark): apply the css AS-IS with inversion OFF
    // (inverting it would flip its dark bg back to light — the HN/BBC regression). The
    // bulk "auto" entries are corrections layered on DR's own inversion, which conflict
    // with gjoa's engine inversion, so they DON'T ship css — they only signal "force"
    // to the measured #auto refiner.
    const fix = fixForHost(await loadFixes(), host);
    // colorScheme:"light"/"dark" — a HARD pre-paint decision that takes precedence
    // over the override field: force the site to serve that theme (child sets
    // prefersColorSchemeOverride) and force-invert it ("active"), yielding a uniform
    // dark that matches Dark Reader on native-dark sites whose own dark theme is
    // off-brand/imperfect (theverge green→purple, django white search-pill→dark).
    if (fix && fix.colorScheme) {
      return {
        colorScheme: fix.colorScheme,
        override: "active",
        css: fix.css || "",
        inject: fix.inject || "",
        ignoreImageAnalysis: fix.ignoreImageAnalysis ?? false,
        ignoreInlineStyle: fix.ignoreInlineStyle ?? false,
      };
    }
    if (fix && (fix.override || "auto") !== "auto") {
      return {
        override: fix.override,
        css: fix.css || "",
        inject: fix.inject || "",
        ignoreImageAnalysis: fix.ignoreImageAnalysis ?? false,
        ignoreInlineStyle: fix.ignoreInlineStyle ?? false,
      };
    }
    // (2) User per-site prefs.
    if (hostInPref(host, OFF_PREF)) {
      return { override: "inactive", css: "", inject: "" };
    }
    if (hostInPref(host, FORCE_INVERT_PREF)) {
      return { override: "active", css: "", inject: "" };
    }
    if (hostInPref(host, FORCE_NATIVE_PREF)) {
      return { override: "inactive", css: "", inject: "" };
    }
    return null;
  }

  // Tier-1 decision from the REAL painted pixels (the scorer's coverage signal), not a
  // declaration. drawSnapshot the viewport, take the median L*. getComputedStyle(body) —
  // and the engine's pre-paint patch-0014 check — are both fooled the same way: under our
  // forced prefers-color-scheme:dark, a page declaring `color-scheme: light dark` resolves
  // its system Canvas bg DARK while it paints explicit WHITE content (Wikipedia, NYT,
  // example.com), so a computed-color read reports dark and the straggler slips through
  // un-inverted. A snapshot sees the white. So:
  //   painted LIGHT (median L* >= 50) → the page slipped through → FORCE invert ("active")
  //   painted DARK                    → already correct (native-dark accepted, or themeless
  //                                     already inverted) → defer ("none"), keeping the
  //                                     engine's durable mHybridDefaultInvert decision.
  // Threshold + math mirror scorer.js so the actor's decision == the QA grader's verdict.
  async #auto(data) {
    if (!this.#hybridActive()) {
      return { override: "none", css: "", inject: "" };
    }
    // Transparent root, snapshot untrustworthy: the child measured html AND body as
    // authored-alpha-0 while the engine is NOT inverting this doc. Such a page has
    // no page background and is authored LIGHT (it relied on the UA white canvas) —
    // but the drawSnapshot reads the DARK browser backdrop bleeding through the
    // transparent root and lies "already dark" (pvk.ca: L=10 → "none" → never
    // inverted → white header/cards glare over the backdrop, body text stays dark).
    // Do NOT measure it: force the inversion. The child then lays the opaque dark
    // root (#forceOpaqueRoot fires on "active"), replacing the backdrop bleed with
    // real dark paint. A native-dark page has an OPAQUE root and never reaches here;
    // a transparent-root page the engine already inverts reads opaque (oklch) and is
    // gated out by !engineInverting. Skip on the probe re-measure (that path
    // deliberately retracted the inversion to read the authored paint).
    if (data?.transparentRoot && !data?.engineInverting && !data?.probeRetract) {
      this.#debug(
        `decide host=${hostOf(this.trustedUrl())} transparentRoot ` +
          `-> active (authored-light; snapshot over transparent root untrusted)`
      );
      return { override: "active", css: "", inject: "" };
    }
    let L = null;
    try {
      L = await this.#paintedMedianLstar(data?.w | 0, data?.h | 0);
    } catch (e) {
      L = null;
    }
    if (L === null) {
      // Snapshot unavailable/failed. Under force-every-site-dark we must NOT accept the
      // native theme blind: a heavy light SPA (YouTube's logged-in home feed) whose
      // snapshot keeps failing was silently left LIGHT by the old "hasNativeDark ?
      // inactive" fallback (reproduced with a real logged-in profile). The user
      // chose force-every-site-dark, so force the inversion rather than leave it light.
      // (On a probe re-measure this restores the pre-probe forced state — never leaves
      // the retraction standing on an unmeasured page.)
      this.#debug(
        `decide host=${hostOf(this.trustedUrl())} L=null (snapshot failed) ` +
          `nativeDark=${!!data?.hasNativeDark} -> active (blind force)`
      );
      return { override: "active", css: "", inject: "" };
    }
    // A curated Tier-2 fix (override:"auto") is a "this site's dark is bad" signal, so it
    // LOWERS the force bar (FIX_FORCE_LSTAR) — yet still yields to a site that painted
    // clearly dark (github WITH a fix stays native). No fix → only force a clearly-light
    // page (LIGHT_LSTAR), to avoid double-inverting an un-curated medium-dark theme. We do
    // NOT ship the correction css here: it's tuned for DR's own inversion and conflicts
    // with gjoa's engine inversion; the engine luminance-invert alone carries the force.
    const host = hostOf(this.trustedUrl());
    const fix = host ? fixForHost(await loadFixes(), host) : null;
    const useFix = !!fix && (fix.override || "auto") === "auto";
    const LIGHT_LSTAR = 50,
      FIX_FORCE_LSTAR = 20;
    const bar = useFix ? FIX_FORCE_LSTAR : LIGHT_LSTAR;
    if (data?.probeRetract) {
      // Probe re-measure: the child retracted the engine's inversion ("inactive") and
      // repainted, so L now reads the AUTHORED paint. Dark ⇒ the site's own dark theme
      // is live (it honored our forced prefers-color-scheme:dark) — keep it native.
      // Light ⇒ genuinely light (e.g. photo-dominated median) — force the inversion.
      const invert = L >= bar;
      this.#debug(
        `decide host=${host} L=${L.toFixed(1)} fix=${useFix} PROBE ` +
          `-> ${invert ? "active" : "inactive (native dark confirmed)"}`
      );
      return { override: invert ? "active" : "inactive", css: "", inject: "" };
    }
    if (L >= bar && data?.engineInverting) {
      // Painted LIGHT while the engine is inverting this doc. The inversion is an
      // involution, so light-out means dark-in: the engine's pre-paint tier-0 check
      // missed a page that authored its OWN dark theme (under our forced
      // prefers-color-scheme:dark) and double-inverted it back to light — the
      // gray-wash defect (redis/kubernetes/washingtonpost, mark-1 C3). The snapshot
      // measures DOWNSTREAM of the engine's own transform, so it cannot distinguish
      // "site is light" from "we made it light": ask the child to retract the
      // inversion and re-measure the authored paint (Darkmode:Decide, probeRetract).
      this.#debug(
        `decide host=${host} L=${L.toFixed(1)} fix=${useFix} engineInverting ` +
          `-> probe-retract (light paint under inversion = suspected native dark)`
      );
      return { override: "probe-retract", css: "", inject: "" };
    }
    const invert = L >= bar;
    this.#debug(
      `decide host=${host} L=${L.toFixed(1)} fix=${useFix} ` +
        `nativeDark=${!!data?.hasNativeDark} -> ${invert ? "active" : "none"}`
    );
    return { override: invert ? "active" : "none", css: "", inject: "" };
  }

  // drawSnapshot the content viewport, downsample, return the MEDIAN CIE L* of the painted
  // pixels (0..100), or null on failure. Median is immune to a bright photo/thumbnail
  // minority (same rationale as the scorer's coverage). One snapshot per top-level nav.
  async #paintedMedianLstar(W, H) {
    if (!W || !H) {
      return null;
    }
    const win =
      this.browsingContext?.topChromeWindow ||
      Services.wm.getMostRecentWindow("navigator:browser");
    if (!win) {
      return null;
    }
    const scale = Math.min(1, 256 / Math.max(W, H)); // cap longest side ~256px
    let pix, w2, h2;
    try {
      const bitmap = await this.manager.drawSnapshot(
        new win.DOMRect(0, 0, W, H),
        scale,
        "rgb(0,0,0)"
      );
      w2 = bitmap.width;
      h2 = bitmap.height;
      const canvas = new win.OffscreenCanvas(w2, h2);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      pix = ctx.getImageData(0, 0, w2, h2).data;
    } catch (e) {
      return null;
    }
    const n = w2 * h2;
    if (!n) {
      return null;
    }
    const Ls = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      Ls[i] = _lstar(_relLum(pix[o], pix[o + 1], pix[o + 2]));
    }
    Ls.sort();
    return Ls[n >> 1];
  }

  // Backdrop-aware APCA retone. The child sends viewport + tagged text els (cn, rect,
  // fg) plus whether the engine is inverting THIS doc. We drawSnapshot the real
  // composited content (catches image/gradient backdrops), and for each element whose
  // text fails the floor against its sampled backdrop, return a corrective color —
  // pre-inverted iff inversion is active so the engine renders the intended tone.
  async #normalize(data) {
    // Independent of mode: the retone applies in ANY dark mode (engine, hybrid, …)
    // where dark mode is enabled — the per-doc `inverted` flag the child measured
    // decides whether to pre-invert, so we don't need #hybridActive here.
    if (
      !Services.prefs.getBoolPref(ENABLED_PREF, false) ||
      !Services.prefs.getBoolPref(NORMALIZE_PREF, false)
    ) {
      return { correctives: [] };
    }
    const W = data?.w | 0, H = data?.h | 0, els = data?.els || [];
    if (!W || !H || !els.length) {
      return { correctives: [] };
    }
    const T = Services.prefs.getIntPref(NORMALIZE_FLOOR_PREF, 45);
    // Live inversion band, to recover a run's authored lightness (see below).
    const floor = Services.prefs.getIntPref(INVERT_FLOOR_PREF, 20) / 100;
    const ceil = Services.prefs.getIntPref(INVERT_CEIL_PREF, 92) / 100;
    const span = Math.max(0.01, ceil - floor);
    // The lightest fg the engine can paint (band ceiling). The brand-bg clause below
    // only recovers toward it when doing so BEATS the current floored fg's contrast —
    // on a bright preserved brand bg the ceiling-white loses to the floored-dark fg, so
    // recovering would DROP below the DARKCHECK hard floor. That is a bg-side (A3) defect.
    const ceilGray = _neutralAtL(ceil);
    // Only the engine's band dims a light fg — and it only runs where THIS doc is
    // being inverted. On a native-dark site (not inverted) the muted-looking text is
    // the site's own choice, so the raise below must NOT touch it (protects the
    // native-dark winners). The child measured this per-doc flag with a black probe.
    const inverted = !!data?.inverted;
    const win =
      this.browsingContext?.topChromeWindow ||
      Services.wm.getMostRecentWindow("navigator:browser");
    if (!win) {
      return { correctives: [] };
    }
    let pix;
    try {
      const bitmap = await this.manager.drawSnapshot(
        new win.DOMRect(0, 0, W, H),
        1,
        "rgb(0,0,0)"
      );
      const canvas = new win.OffscreenCanvas(W, H);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      pix = ctx.getImageData(0, 0, W, H).data;
    } catch (e) {
      return { correctives: [] };
    }
    const px = (x, y) => {
      const i = (y * W + x) * 4;
      return [pix[i], pix[i + 1], pix[i + 2]];
    };
    const correctives = [];
    for (const el of els) {
      const x0 = Math.max(0, el.x),
        y0 = Math.max(0, el.y);
      const x1 = Math.min(W - 1, el.x + el.w),
        y1 = Math.min(H - 1, el.y + el.h);
      if (x1 <= x0 || y1 <= y0) {
        continue;
      }
      const samples = [];
      const sx = Math.max(1, Math.floor((x1 - x0) / 14)),
        sy = Math.max(1, Math.floor((y1 - y0) / 6));
      for (let y = y0; y <= y1; y += sy) {
        for (let x = x0; x <= x1; x += sx) {
          samples.push(px(x, y));
        }
      }
      if (samples.length < 4) {
        continue;
      }
      samples.sort((a, c) => _Ys(a) - _Ys(c));
      const bg = samples[Math.floor(samples.length / 2)];
      // Per-element decision trace (same pref/channel discipline as normalize.logms).
      try {
        if (Services.prefs.getBoolPref("gjoa.darkmode.normalize.logms", false)) {
          dump(
            `GJOA_NORMALIZE_EL\tcn=${el.cn}\tfg=${el.fg}\tbg=${bg}\t` +
              `apca=${_apca(el.fg, bg).toFixed(1)}\trect=${el.x},${el.y},${el.w},${el.h}\n`
          );
        }
      } catch (e) {}
      // FG over-dimming guard (wave-5). The engine band remaps EVERY color's OKLCH L
      // role-blind (L_out = ceiling - L_in*span), so foreground text a site drew LIGHT
      // lands muted mid-grey — or, when it was authored near-white, is floored to dark:
      // legible but far dimmer than the near-white a reference dark theme keeps. Correct
      // that BEFORE the APCA skip, and only ever RAISE toward the ceiling (never lower a
      // run's L on a dark backdrop). Two faces, both scoped to a dark/saturated backdrop:
      const fgL = _oklchL(el.fg), bgL = _oklchL(bg);
      // CHROMATIC ACCENT / LINK (wave6): own every chromatic run here. The engine
      // brand-preserved it (C>0.08 → returned UNCHANGED, role-blind) so it was never
      // lifted; the old neutral clauses below then flattened it (_correct → white) or
      // under-lifted it (_raiseLight channel-scale left #0000AA at #0000FF, APCA 15).
      // Re-solve HUE-EXACT toward the accent floor so the link keeps its blue/red/
      // orange AND reads. Gated on `inverted` — a native-dark site keeps its accents.
      // A run already clearing the floor is left exactly as the engine painted it.
      const fgC = _oklchC(el.fg);
      // Cluster D purple-shift: a NON-LINK run carrying only a faint COOL cast is an
      // inversion artifact (a near-neutral the band preserved into visible lavender), not a
      // brand accent — neutralize it to a same-lightness gray BEFORE the hue-preserving
      // accent solve below would otherwise lock the periwinkle in. See FG_CAST_* above.
      if (inverted && !el.link && fgC > FG_ACCENT_CHROMA && fgC < FG_CAST_CHROMA_CEIL) {
        const lab = _oklab(el.fg);
        const hue = ((Math.atan2(lab[2], lab[1]) * 180) / Math.PI + 360) % 360;
        if (hue >= FG_CAST_HUE_LO && hue <= FG_CAST_HUE_HI) {
          // Retone to a NEUTRAL max-contrast tone (via _correct — the same crisp-neutral
          // operator the fallback uses). It kills the cast (chroma -> 0) and lands the run
          // at the legible polarity for THIS backdrop; a mid-grey target can't be placed
          // through the child's extreme-only pre-invert (invertLum round-trips cleanly only
          // near white/black), so a neutral extreme is both correct and machinery-safe.
          const r = _correct(el.fg, bg, T);
          correctives.push({ cn: el.cn, color: `rgb(${r[0]},${r[1]},${r[2]})` });
          continue;
        }
      }
      // LINK-ROLE re-saturation (wave-A A6 link-flatten). A hyperlink whose painted run
      // is WASHED (chroma below a healthy link level) or still ILLEGIBLE gets its hue
      // recovered + re-saturated to a vivid in-gamut accent (see _boostLinkChroma). This
      // catches the low-chroma links the chroma-gated clause below misses or under-lifts
      // (the band snapped their blue toward neutral so it reads white/gray — marginalia/
      // antonz/fnordig). A run with no trustworthy hue (a genuine neutral link) returns
      // null and falls through to the neutral clauses (no invented tint).
      if (inverted && el.link) {
        const washed = fgC < FG_LINK_VIVID_C;
        const illegible = Math.abs(_apca(el.fg, bg)) < FG_ACCENT_FLOOR;
        if (washed || illegible) {
          const boosted = _boostLinkChroma(el.fg);
          if (boosted) {
            const r = _solveAccent(boosted, bg, FG_ACCENT_FLOOR, FG_HALATION_CEIL);
            correctives.push({ cn: el.cn, color: `rgb(${r[0]},${r[1]},${r[2]})` });
            continue;
          }
        }
      }
      if (inverted && fgC > FG_ACCENT_CHROMA) {
        if (Math.abs(_apca(el.fg, bg)) < FG_ACCENT_FLOOR) {
          const r = _solveAccent(el.fg, bg, FG_ACCENT_FLOOR, FG_HALATION_CEIL);
          correctives.push({ cn: el.cn, color: `rgb(${r[0]},${r[1]},${r[2]})` });
        }
        continue;
      }
      const authoredL = Math.max(0, Math.min(1, (ceil - fgL) / span)); // invert the band
      const darkBg = inverted && bgL <= FG_DARK_BG_L;
      // (1) a legible light-on-dark run the band left dimmer than near-white.
      const mutedLight =
        darkBg && fgL > bgL + 0.1 && fgL >= FG_LIGHT_MIN_L && fgL < FG_RAISE_BELOW_L;
      // (2) a run authored near-WHITE that the band floored to dark.
      const flooredWhite =
        darkBg && authoredL >= FG_AUTHORED_LIGHT_L && fgL < FG_LIGHT_MIN_L;
      if (mutedLight || flooredWhite) {
        const r = _raiseLight(el.fg);
        correctives.push({ cn: el.cn, color: `rgb(${r[0]},${r[1]},${r[2]})` });
        continue;
      }
      // (3) DARK-FG-ON-BRAND-BG (wave-5b): the band PRESERVED a mid/dark chromatic bg
      // (bgL > FG_DARK_BG_L, so the dark-backdrop clauses above skipped it) but inverted an
      // authored-near-white fg on it to dark — the pair fails the A1 floor with the WRONG
      // polarity (bestbuy "Choose a country." white-on-blue floored to dark-tan-on-blue,
      // |Lc| 20-37 vs floor 60/75). Recover the authored light polarity (toward white) ONLY
      // where white is the higher-contrast choice for THIS backdrop (cw >= cb); on a
      // genuinely LIGHT card black wins, so we fall through to _correct and keep W-D's
      // "dark-on-light-card = no-op" invariant. Hue preserved via _raiseLight (a chromatic
      // run keeps its hue); capped at the Lc90 halation ceiling. No bg edit.
      const cw = Math.abs(_apca([255, 255, 255], bg));
      const cb = Math.abs(_apca([0, 0, 0], bg));
      const brandBg = inverted && bgL > FG_DARK_BG_L;
      // Improve-only guard: recover ONLY when the achievable ceiling-white (ceilGray, the
      // lightest the band can paint) actually clears MORE contrast than the current floored
      // fg. On a bright brand bg (bestbuy's light-blue gradient hero) ceiling-white loses to
      // the floored-dark fg, so we abstain and leave the darker (higher-contrast) run — never
      // pushing it below the DARKCHECK hard floor. Darkening that bright island is a bg-side
      // (A3) job, not the fg pass's. On a mid/dark brand bg, ceiling-white wins → recover.
      const brandFloored =
        brandBg &&
        authoredL >= FG_AUTHORED_LIGHT_L &&
        fgL < FG_LIGHT_MIN_L &&
        cw >= cb &&
        Math.abs(_apca(el.fg, bg)) < FG_BRAND_BG_FLOOR &&
        Math.abs(_apca(ceilGray, bg)) >= Math.abs(_apca(el.fg, bg));
      if (brandFloored) {
        const r = _capHalation(_raiseLight(el.fg), bg);
        correctives.push({ cn: el.cn, color: `rgb(${r[0]},${r[1]},${r[2]})` });
        continue;
      }
      // OVERLAY-LIGHT-ON-IMAGE (cluster C — dark-on-bright hero text). An authored-near-white
      // run the band floored to dark, sitting on a BRIGHT backdrop that is NOT a solid light
      // surface of its own — a hero PHOTO or brand GRADIENT the engine exempts / brand-preserves
      // (nba "WATCH LIVE" over the hero image, bestbuy "Choose a country." over the blue
      // gradient). The improve-only brandFloored clause above ABSTAINS here: on a bright island
      // ceiling-white loses raw |Lc| to the floored-dark fg, so it keeps the darker (higher-
      // contrast) run and defers darkening the island to a bg-side pass. But the SITE authored
      // the text LIGHT and the reference dark theme (Dark Reader) keeps it light — overlay text
      // on imagery is DESIGNED light, and max-contrast black on a bright photo is the WRONG
      // polarity (the judged defect). Recover the authored LIGHT polarity (hue-preserved,
      // halation-capped) so the overlay reads as intended. The discriminator vs W-D's "dark text
      // on a light card / white pill stays dark" invariant is the run's OWN background: a solid
      // light surface serializes an opaque LIGHT ownBg (ownBgLight) and is left to the pairing
      // clause below; only a transparent / dark ownBg means the bright pixels come from an exempt
      // image or gradient BEHIND the text, which is the overlay class. authoredL >= near-white
      // keeps this to originally-light runs only — a dark-authored run (low authoredL) is never
      // flipped. Darkening the bright island itself remains a bg-side job; this fixes only the fg
      // polarity so the intended light overlay is legible-as-designed rather than inverted dark.
      const ownBgLight = el.ownBg && _oklchL(el.ownBg) >= FG_LIGHT_MIN_L;
      const overlayFloored =
        brandBg &&
        !ownBgLight &&
        authoredL >= FG_AUTHORED_LIGHT_L &&
        fgL < FG_LIGHT_MIN_L;
      if (overlayFloored) {
        const r = _capHalation(_raiseLight(el.fg), bg);
        correctives.push({ cn: el.cn, color: `rgb(${r[0]},${r[1]},${r[2]})` });
        continue;
      }
      // PRESERVED-BG PAIRING (wave-A white-pill). A run whose OWN element background is
      // opaque and LIGHT (a preserved white pill / consent button) but whose fg fails the
      // floor against THAT bg is a white-on-white pair — regardless of what the racing
      // viewport snapshot sampled for its rect. The snapshot can read the dark page
      // backdrop behind a late/fixed overlay and falsely judge the white label legible
      // (the top-view/mid-view split: reddit/npr/fifa/docker consent buttons). Re-solve
      // against the element's OWN bg so the pairing is pass-order-independent: a preserved
      // light bg ⇒ fg MUST flip to its max-contrast (black) polarity. The child's
      // per-element pre-invert then lands it whether or not the button subtree inverted.
      if (
        el.ownBg &&
        _oklchL(el.ownBg) >= FG_LIGHT_MIN_L &&
        // Corroborate the light ownBg against the REAL painted backdrop (snapshot)
        // before darkening. On a native-dark site that declares color-scheme (reddit),
        // an ancestor's COMPUTED background-color serializes LIGHT (the authored var)
        // while the engine PAINTS it dark — so a legible light-on-dark comment run reads
        // here as "light-on-light" and, without this guard, gets flipped to black-on-dark
        // (the vanishing-comment-text bug; the +3.2s/scroll re-passes spread it). Only
        // trust the light ownBg when the SNAPSHOT sees a light backdrop too. If the painted
        // pixels are dark, the run is on dark → never darken it. A genuinely light pill not
        // yet composited (snapshot reads the dark page behind it) is recovered on a later
        // re-pass once it paints — we do NOT darken live legible text to catch it.
        _oklchL(bg) > FG_DARK_BG_L &&
        Math.abs(_apca(el.fg, el.ownBg)) < T
      ) {
        const c = _correct(el.fg, el.ownBg, T);
        // Same never-darken-on-native-dark guard (see the final fallback below): a
        // color-scheme-declaring native-dark site (reddit) can serialize an ancestor's
        // authored-light var via getComputedStyle while the engine PAINTS it dark, so a
        // legible light run reads as light-on-light here — never darken it on a page the
        // engine isn't inverting.
        if (!inverted && _decideCorrectiveDarkens(c, el.fg)) {
          continue;
        }
        correctives.push({ cn: el.cn, color: `rgb(${c[0]},${c[1]},${c[2]})` });
        continue;
      }
      if (Math.abs(_apca(el.fg, bg)) >= T) {
        continue;
      }
      // Return the TARGET rendered color. The child decides per-element whether to
      // pre-invert it (probe: set target, read computed — if the engine inverted it,
      // re-author invertLum so it renders the target). Page-level inversion flags are
      // wrong on mixed pages (a non-inverted light card inside an inverted dark page).
      const c = _correct(el.fg, bg, T);
      // NEVER-DARKEN-ON-NATIVE-DARK guard (reddit vanishing-text). On a page the engine
      // is NOT inverting, the SITE authored its text colors — the normalizer may only
      // LIGHTEN genuinely-too-dark runs, never DARKEN. A light snapshot median for an
      // already-light run here is a racing/scroll re-pass that sampled an adjacent
      // bright element (image, thumbnail) while the text actually sits on dark; flipping
      // that legible light text to black-on-dark is the vanishing-comment-text failure.
      // (Extends the same principle the raise clauses already honor for native-dark —
      // see the `inverted` comment above. Inverted pages keep the darken polarity for
      // engine-inverted labels on preserved-light pills.) Tested in
      // tools/darkmode-regress/normalize-guard.test.js.
      if (!inverted && _decideCorrectiveDarkens(c, el.fg)) {
        continue;
      }
      correctives.push({ cn: el.cn, color: `rgb(${c[0]},${c[1]},${c[2]})` });
    }
    return { correctives };
  }

  async receiveMessage(msg) {
    if (msg.name === "Darkmode:Normalize") {
      return this.#normalize(msg.data);
    }
    if (msg.name === "Darkmode:GetInject") {
      // document-start: return the explicit curated/user decision so the child
      // applies override + css + inject BEFORE first paint. `explicit:false`
      // tells the child to fall through to the post-paint auto refiner.
      const explicit = await this.#explicit();
      if (explicit) {
        return { explicit: true, ...explicit };
      }
      return { explicit: false, override: "none", css: "", inject: "" };
    }
    if (msg.name === "Darkmode:Decide") {
      return this.#auto(msg.data);
    }
    return null;
  }
}
