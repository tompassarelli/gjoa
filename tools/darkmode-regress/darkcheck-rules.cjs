/* darkcheck-rules.cjs — SHARED A-rule logic for the offline gate replay (T2.5).
 *
 * Pure, browser-free rule math extracted so darkcheck-replay.js can re-audit stored
 * records with ZERO model calls and no render. The LIVE gate (darkcheck-audit.js,
 * Marionette/chrome context) cannot require() this (it runs in a browser sandbox), so
 * its A5 gamut-exemption is an inline MIRROR of evalA5Exempt() below, byte-inert when the
 * flag is off — keep the two in lockstep if either changes.
 *
 * The colormath ORACLE is loaded ESM-trap-safe (gjoa is "type":"module", so a plain
 * require('./colormath.js') yields {} — the CJS guard never fires under ESM parse; see
 * dev-loop-assessment §7). We prefer the canonical colormath.cjs (P0.1) the moment it
 * lands, else evaluate colormath.js in a CommonJS shim so the exported functions ARE the
 * oracle's (no duplicated color math).
 */
"use strict";
const fs = require("fs");
const path = require("path");

// ---- oracle load (ESM-trap-safe) ----
function loadColormath(dir) {
  dir = dir || __dirname;
  const cjs = path.join(dir, "colormath.cjs"); // P0.1 canonical — poll for it
  if (fs.existsSync(cjs)) return { cm: require(cjs), source: "colormath.cjs" };
  const jsPath = path.join(dir, "colormath.js");
  const src = fs.readFileSync(jsPath, "utf8");
  const m = { exports: {} };
  // colormath.js's own bottom guard fires with a real `module`, exporting the oracle set.
  new Function("module", "exports", src)(m, m.exports);
  return { cm: m.exports, source: "colormath.js(shim)" };
}

// ---- gamutMaxC(L,h): max in-gamut OKLCH chroma at fixed L,h (hue-preserving boundary) ----
// Prefer the canonical export once colormath.cjs ships it; else vendor it here. VENDORED —
// swap to cm.gamutMaxC when P0.1 lands (poll tools/darkmode-regress/colormath.cjs).
function makeGamutMaxC(cm) {
  if (typeof cm.gamutMaxC === "function") return cm.gamutMaxC;
  return function gamutMaxC(L, h) {
    if (L <= 0 || L >= 1) return 0;
    let lo = 0, hi = 0.5; // sRGB OKLCH chroma tops out well under 0.5
    const inG = (C) => cm.inGamut(cm.oklabToLinear(L, C * Math.cos(h), C * Math.sin(h)));
    if (inG(hi)) return hi;
    for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (inG(mid)) lo = mid; else hi = mid; }
    return lo;
  };
}

// ---- A5 gamut-exemption (spec §6.1, the analytically-closed residual) ----
// A mark that currently FAILS A5 is exempt iff BOTH:
//   (1) hue is HELD (|Δhue| ≤ hueTol) — a genuine hue drift is a real defect, never exempt;
//   (2) rendered chroma is at the sRGB gamut boundary for its solved L+hue
//       (Cr ≥ gamutFrac·gamutMaxC(L_rendered, h_rendered)) — chroma collapse lifting a
//       saturated color to legibility is gamut physics, not a defect.
// Both wave-2 blue-link renders sit AT their gamut boundary (Cr≈gamutMaxC), so the chroma
// test alone would exempt both; the hue gate is what keeps the real 18.4° drift failing.
const A5_DEFAULTS = { hueTol: 15, gamutFrac: 0.9 };

function evalA5Exempt(off, cfg, cm, gamutMaxC) {
  cfg = cfg || {};
  const hueTol = cfg.hueTol != null ? cfg.hueTol : A5_DEFAULTS.hueTol;
  const gamutFrac = cfg.a5GamutFrac != null ? cfg.a5GamutFrac : A5_DEFAULTS.gamutFrac;
  const rendered = off.renderedFg;
  if (!rendered) return { exempt: false, why: "no-renderedFg" };
  // drift: use stored hueDriftDeg when present, else recompute from authored↔rendered
  let dh = off.hueDriftDeg;
  if (dh == null && off.authoredFg) dh = cm.hueDriftDeg(off.authoredFg, rendered);
  if (dh == null) return { exempt: false, why: "no-hue-drift" };
  if (dh > hueTol) return { exempt: false, why: "hue-drift(" + dh + "°>" + hueTol + "°)-not-gamut" };
  const [L, Cr, h] = cm.srgbToOklch(rendered);
  const gmax = gamutMaxC(L, h);
  const thresh = gamutFrac * gmax;
  if (Cr >= thresh) {
    return { exempt: true, why: "gamut-limited(Cr=" + Cr.toFixed(3) + "≥" + gamutFrac + "·gamutMaxC=" + thresh.toFixed(3) + ")", gamutMaxC: +gmax.toFixed(4), renderedC: +Cr.toFixed(4) };
  }
  return { exempt: false, why: "chroma-collapse-below-gamut(Cr=" + Cr.toFixed(3) + "<" + thresh.toFixed(3) + ")", gamutMaxC: +gmax.toFixed(4), renderedC: +Cr.toFixed(4) };
}

// Re-evaluate a stored A5 rule object under the gamut exemption. Returns a NEW rule object
// (offenders with exemptions removed) + the exempted list. gamutExempt=false is a pure
// no-op → returns verdict-identical output (the flag-off byte-identical guarantee).
function replayA5(a5rule, cfg, cm, gamutMaxC, gamutExempt) {
  const offenders = (a5rule && a5rule.offenders) || [];
  if (!gamutExempt) {
    return { rule: "A5", pass: a5rule.pass, count: a5rule.count, offenders, exempted: [], changed: false };
  }
  const kept = [], exempted = [];
  for (const off of offenders) {
    const v = evalA5Exempt(off, cfg, cm, gamutMaxC);
    if (v.exempt) exempted.push(Object.assign({}, off, { exemptWhy: v.why })); else kept.push(off);
  }
  // NOTE: stored dumps cap offenders at 60 and only carry OFFENDERS (not the full node pool),
  // so `count` may exceed offenders.length. When exemption removes offenders we can only
  // assert the NEW pass state from what is stored: if every stored offender is exempt AND
  // count ≤ stored offenders (nothing hidden by the cap), the rule flips to pass.
  const allStoredExempt = kept.length === 0 && exempted.length > 0;
  const capHidesMore = (a5rule.count || 0) > offenders.length;
  const pass = allStoredExempt && !capHidesMore ? true : (kept.length === 0 ? a5rule.pass : false);
  return { rule: "A5", pass, count: kept.length, offenders: kept, exempted, changed: exempted.length > 0, capHidesMore };
}

module.exports = { loadColormath, makeGamutMaxC, evalA5Exempt, replayA5, A5_DEFAULTS };
