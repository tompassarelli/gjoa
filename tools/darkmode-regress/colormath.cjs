/* colormath.cjs — the ONE canonical dark-mode color math (#85 dark-mode v2).
 * CANONICAL IMPLEMENTATION LIVES HERE. `colormath.js` is a thin ESM wrapper that
 * re-exports this file (createRequire), so the ESM importers (colormath.test.js,
 * apca-w3-vectors.test.js) and the CJS/text-concat consumers (runner.bjs &
 * darkcheck-runner.bjs read this file as TEXT and eval it into browser scope;
 * wave6-*.cjs require it) resolve to ONE implementation. gjoa is
 * `"type":"module"`, so a plain `.js` required from CJS yields `{}` (the CJS
 * guard never fires under ESM parse) — that trap is why this is `.cjs`.
 *
 * Shared by BOTH the live harness (runner.bjs prepends this to snap.js so the
 * functions are in browser scope) AND the deterministic bun test
 * (colormath.test.js imports it via the ESM wrapper). Keep it browser-safe: no
 * Node APIs, plain function declarations, a guarded CommonJS export at the bottom.
 *
 * It realizes the theory's two FORCED instruments (docs/darkmode-v2.md):
 *   (i)  a perceptually-uniform, hue-separable space  -> OKLab/OKLCH (Ottosson)
 *   (ii) a polarity-aware, near-black-honest contrast -> APCA Lc (SA98G, canonical)
 * and the FORCED operator: hold hue exactly, move only the legibility coordinate
 * (lightness), clamp chroma to gamut, land |Lc| inside the band [floor..ceiling].
 *
 * The OLD correct() (RGB-lerp toward white/black) is kept as correctRGB() ONLY so
 * the test can demonstrate it drifts hue — it is NOT the operator. */

/* ---- APCA (canonical SA98G; APCA's own simple 2.4 TRC, no sRGB toe) ---- */
function linApca(c) { return Math.pow(c / 255, 2.4); }
function Ys(p) { return 0.2126729 * linApca(p[0]) + 0.7151522 * linApca(p[1]) + 0.0721750 * linApca(p[2]); }
function apca(t, b) {
  let Yt = Ys(t), Yb = Ys(b); const bt = 0.022, bc = 1.414;
  if (Yt <= bt) Yt += Math.pow(bt - Yt, bc);
  if (Yb <= bt) Yb += Math.pow(bt - Yb, bc);
  if (Math.abs(Yb - Yt) < 0.0005) return 0;
  let C;
  if (Yb > Yt) { const s = (Math.pow(Yb, 0.56) - Math.pow(Yt, 0.57)) * 1.14; C = s < 0.1 ? 0 : s - 0.027; }
  else { const s = (Math.pow(Yb, 0.65) - Math.pow(Yt, 0.62)) * 1.14; C = s > -0.1 ? 0 : s + 0.027; }
  return C * 100;
}

/* ---- sRGB <-> OKLab <-> OKLCH (Bjorn Ottosson; true sRGB transfer, with toe) ---- */
function toLinear(c8) { const c = c8 / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function toSrgb8(x) {
  x = Math.min(1, Math.max(0, x));
  const s = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(s * 255)));
}
function srgbToOklab(rgb) {
  const r = toLinear(rgb[0]), g = toLinear(rgb[1]), b = toLinear(rgb[2]);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}
function oklabToLinear(L, a, b) {
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
function srgbToOklch(rgb) {
  const [L, a, b] = srgbToOklab(rgb);
  return [L, Math.hypot(a, b), Math.atan2(b, a)]; // h in radians
}
function inGamut(linRGB) {
  const e = 1e-4;
  return linRGB[0] >= -e && linRGB[0] <= 1 + e && linRGB[1] >= -e && linRGB[1] <= 1 + e && linRGB[2] >= -e && linRGB[2] <= 1 + e;
}
/* OKLCH -> sRGB8, gamut-mapped by reducing CHROMA at fixed L and h (CSS Color 4
 * style) — NEVER a naive RGB clip, which would shift hue and break the solved
 * tone. Holds hue exactly. */
function oklchToSrgb(L, C, h) {
  let lin = oklabToLinear(L, C * Math.cos(h), C * Math.sin(h));
  if (!inGamut(lin)) {
    let lo = 0, hi = C;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklabToLinear(L, mid * Math.cos(h), mid * Math.sin(h)))) lo = mid; else hi = mid;
    }
    lin = oklabToLinear(L, lo * Math.cos(h), lo * Math.sin(h));
  }
  return [toSrgb8(lin[0]), toSrgb8(lin[1]), toSrgb8(lin[2])];
}

/* ---- THE OPERATOR (per-mark step 3 of docs/darkmode-v2.md) ----
 * Land |Lc(mark, frozen bg)| inside the band [T .. ceiling], moving ONLY lightness,
 * holding hue EXACTLY, never ADDING chroma (H-K: shed, don't add). Polarity-pick the
 * lighter/darker side that can reach the band against THIS backdrop, then binary-search
 * the MINIMAL lightness shift that clears T (+3 hysteresis). The minimal-shift solution
 * lands near the floor, so it cannot breach the ceiling; the ceiling clamp is the
 * backstop for surfaces/extremes. Returns sRGB8. */
function correct(fg, bg, T, ceiling) {
  if (ceiling == null) ceiling = 100;
  const [L0, C0, h0] = srgbToOklch(fg);
  const cw = Math.abs(apca([255, 255, 255], bg));
  const cb = Math.abs(apca([0, 0, 0], bg));
  const Lext = cw >= cb ? 1 : 0;                 // forced polarity: toward whichever reads
  const at = (k) => {
    const L = L0 + k * (Lext - L0);
    return oklchToSrgb(L, C0, h0);               // hold hue; chroma clamped to gamut (never added)
  };
  // If even the extreme cannot clear T, return it (backdrop-capped; residual is a bg problem).
  if (Math.abs(apca(at(1), bg)) < T + 3) return at(1);
  let lo = 0, hi = 1, best = at(1);
  for (let i = 0; i < 24; i++) {
    const k = (lo + hi) / 2, c = at(k), lc = Math.abs(apca(c, bg));
    if (lc >= T + 3) { best = c; hi = k; } else { lo = k; }
  }
  // Ceiling backstop: if minimal-shift still breaches the halation ceiling, walk L back
  // toward fg until |Lc| <= ceiling (stays >= floor by construction of the search).
  if (Math.abs(apca(best, bg)) > ceiling) {
    let lo2 = 0, hi2 = 1;
    for (let i = 0; i < 20; i++) {
      const k = (lo2 + hi2) / 2, c = at(k), lc = Math.abs(apca(c, bg));
      if (lc > ceiling) { hi2 = k; } else if (lc < T) { lo2 = k; } else { best = c; break; }
      best = c;
    }
  }
  return best;
}

/* OLD solver — RGB lerp toward white/black. Kept ONLY for the test to show it drifts
 * hue + is non-monotone across the polarity crossing. NOT the operator. */
function correctRGB(fg, bg, T) {
  const cw = Math.abs(apca([255, 255, 255], bg)), cb = Math.abs(apca([0, 0, 0], bg));
  const toward = cw >= cb ? [255, 255, 255] : [0, 0, 0];
  let lo = 0, hi = 1, best = toward.slice();
  for (let i = 0; i < 18; i++) {
    const k = (lo + hi) / 2;
    const c = [Math.round(fg[0] + k * (toward[0] - fg[0])), Math.round(fg[1] + k * (toward[1] - fg[1])), Math.round(fg[2] + k * (toward[2] - fg[2]))];
    if (Math.abs(apca(c, bg)) >= T + 3) { best = c; hi = k; } else { lo = k; }
  }
  return best;
}

/* engine Y->1-lum pre-inversion (RelativeLuminanceUtils::Adjust), replicated exactly. */
function invertLum(rgb) {
  const compute = (u) => { const f = u / 255; return f <= 0.03928 ? f / 12.92 : Math.pow((f + 0.055) / 1.055, 2.4); };
  const decompute = (x) => { const s = x <= 0.03928 / 12.92 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; return Math.min(255, Math.max(0, Math.round(s * 255))); };
  const lr = compute(rgb[0]), lg = compute(rgb[1]), lb = compute(rgb[2]);
  const lum = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  const target = 1 - lum, factor = (target + 0.05) / (lum + 0.05);
  const adj = (l) => decompute(Math.max(0, (l + 0.05) * factor - 0.05));
  return [adj(lr), adj(lg), adj(lb)];
}

/* ---- The four falsification metrics (docs/darkmode-v2.md Part II) ---- */
// (1) hue-drift: |Δh| in OKLCH degrees; 0 for achromatic endpoints.
function hueDriftDeg(a, b) {
  const ca = srgbToOklch(a), cb = srgbToOklch(b);
  if (ca[1] < 0.002 || cb[1] < 0.002) return 0; // achromatic: hue undefined, no drift
  let d = Math.abs(ca[2] - cb[2]) * 180 / Math.PI;
  if (d > 180) d = 360 - d;
  return d;
}
// (2) two-sided band: a mark is a FAIL if below the floor OR above the halation ceiling.
function apcaBand(mark, bg, floor, ceiling) {
  const lc = Math.abs(apca(mark, bg));
  return { lc: lc, belowFloor: lc < floor, aboveCeiling: lc > ceiling, inBand: lc >= floor && lc <= ceiling };
}
// (3) sign/polarity against the real backdrop: +1 mark lighter than ground, -1 darker.
function polaritySign(fg, bg) { const d = Ys(fg) - Ys(bg); return d > 1e-6 ? 1 : d < -1e-6 ? -1 : 0; }
// (4) convergence: a naive JOINT fg+bg solve (each chases the other's last value) — returns
//     the |Lc| history so a test can assert it oscillates (never settles) vs the frozen-bg solve.
function jointSolveHistory(fg0, bg0, T, iters) {
  let fg = fg0.slice(), bg = bg0.slice(); const hist = [];
  for (let i = 0; i < (iters || 12); i++) {
    const nf = correctRGB(fg, bg, T);  // mark chases current ground
    const nb = correctRGB(bg, fg, T);  // ground chases current mark (the illegal joint move)
    fg = nf; bg = nb;
    hist.push(Math.abs(apca(fg, bg)));
  }
  return hist;
}

/* ============================================================================
 * ENGINE MIRRORS — offline replicas of the compiled dark-mode engine math, so
 * engine-behavior questions die in ms of node instead of a 30-min rebuild.
 *
 * PRECISION NOTE (f64-vs-f32 delta, applies to EVERY function below):
 *   The engine computes in f32 (Rust color.rs / style_adjuster.rs, C++
 *   GjoaDarkText.cpp all use `f32`/`float`, `powf`, `cbrt`f). This oracle
 *   computes in f64 (JS Number). The OKLab/APCA constants are BYTE-IDENTICAL
 *   between the three copies (verified against color.rs and GjoaDarkText.cpp),
 *   so the ONLY divergence is rounding: intermediate f64 values carry ~9 extra
 *   bits before the final `Math.round`/`ToSrgb8` snaps to an 8-bit channel.
 *   Consequence: results agree to f32-representable tolerance and are
 *   BYTE-IDENTICAL in the overwhelming majority of cases; a color whose exact
 *   channel sits within ~0.5/255 of a rounding boundary, or whose chroma sits
 *   within ~1e-7 of the 0.08/0.03 thresholds, MAY differ by 1 LSB / flip a
 *   branch. Such boundary cases are the documented delta, not a mirror bug.
 * ========================================================================== */

function clamp01(x) { return Math.min(1, Math.max(0, x)); }

/* invertBand(rgb, floor, ceiling) — mirror of color.rs:877 `invert_color_luminance`.
 * Engine-level pre-paint inversion: map OKLCH lightness L linearly onto
 * [floor, ceiling] (white->floor, black->ceiling), hold hue EXACTLY, shed chroma
 * proportional to the lightness drop (ratio capped at 1 so lightening keeps
 * chroma). Two policy gates, in Rust order:
 *   - BRAND PRESERVE: c_in > 0.08  => return the color UNCHANGED (never inverted).
 *   - NEUTRAL SNAP:   c_in < 0.03  => treat chroma as 0 (kill faint casts).
 * `floor` is the DARK target lightness (bgLightness ~0.16), `ceiling` the LIGHT
 * target (fgLightness ~0.92) — same argument meaning as the Rust fn. Returns sRGB8.
 * Rust keeps the result in OKLCH and converts at paint; we convert here via
 * oklchToSrgb (chroma-reduce gamut map), which the chroma-shed keeps a no-op in
 * gamut — the documented-intent equivalence (color.rs:881-883). */
function invertBand(rgb, floor, ceiling) {
  const [l_in, c_in, h] = srgbToOklch(rgb);
  const l_out = clamp01(ceiling - l_in * (ceiling - floor));
  if (c_in > 0.08) return rgb.slice();                 // brand preserve: UNCHANGED
  const c_eff = c_in < 0.03 ? 0.0 : c_in;              // neutral snap
  const c_out = l_in > 1e-4 ? c_eff * Math.min(l_out / l_in, 1) : c_eff;
  return oklchToSrgb(l_out, c_out, h);
}

/* bandInverse(l, floor, ceiling) — the band map is a bijection; recover the
 * AUTHORED OKLCH lightness from a computed (already-inverted) L. Mirror of the
 * `l_auth = ((ceiling - l) / band).clamp(0,1)` used at style_adjuster.rs:400/468. */
function bandInverse(l, floor, ceiling) {
  const band = Math.max(ceiling - floor, 0.01);
  return clamp01((ceiling - l) / band);
}

/* surfaceCeiling(floor) — M4a ramp-freeze upper bound: `(floor + 0.18).min(0.36)`
 * (style_adjuster.rs:429). */
function surfaceCeiling(floor) { return Math.min(floor + 0.18, 0.36); }

/* rampFreeze(rgb, floor, ceiling) — mirror of the M4a SURFACE RAMP-FREEZE clause
 * (style_adjuster.rs:381-451). Input is a COMPUTED (already band-inverted) surface
 * background color; recover its authored L and re-map onto a dark surface ramp so
 * no near-neutral surface flips to a bright island. Returns { rgb, band } where
 * band is one of: 'brand' (c>0.08, unchanged), 'preserved-dark' (restored to
 * authored dark), 'ramped' (darkened onto the surface ramp), or 'unchanged'
 * (darken-only guard: never lift a surface below the ramp). Darken-only + chroma
 * shed by l_surface/l exactly as the Rust. */
function rampFreeze(rgb, floor, ceiling) {
  const [l, c, h] = srgbToOklch(rgb);
  const l_auth = bandInverse(l, floor, ceiling);
  if (c > 0.08) {
    // brand-preserved: color unchanged; l_auth<0.40 means the engine ALSO flags
    // it a preserved-dark region, but the color itself never moves either way.
    return { rgb: rgb.slice(), band: "brand" };
  }
  if (l_auth < 0.40 && l_auth < l) {                   // preserved-dark: restore authored
    return { rgb: oklchToSrgb(l_auth, c, h), band: "preserved-dark" };
  }
  if (l_auth >= 0.40) {
    const sc = surfaceCeiling(floor);
    const l_surface = sc - l_auth * (sc - floor);
    if (l_surface < l) {                               // darken-only
      const c_ramp = l > 1e-4 ? c * (l_surface / l) : c;
      return { rgb: oklchToSrgb(l_surface, c_ramp, h), band: "ramped" };
    }
  }
  return { rgb: rgb.slice(), band: "unchanged" };
}

/* IsLargeText — APCA size×weight matrix (GjoaDarkText::IsLargeText, GjoaDarkText.h). */
function isLargeText(cssPx, weight) {
  return cssPx >= 36 || (cssPx >= 24 && weight >= 700);
}

/* correctA2(fg, bg, T, ceiling, clampLargeCeiling) — mirror of
 * GjoaDarkText::Correct (GjoaDarkText.cpp) INCLUDING the M4a size-gated halation
 * ceiling down-pull. clampLargeCeiling === IsLargeText(px, weight) at the call
 * site (nsTextPaintStyle.cpp:120, floor 57 / ceiling 90). With clampLargeCeiling
 * false this is byte-identical to correct() (the pre-M4a operator). The M4a pass:
 * when the floor-lifted mark still exceeds the ceiling (band-mapped white/black,
 * whose l0 IS the extreme so the floor search + backstop are no-ops for it), pull
 * it DOWN the OKLCH lightness axis toward the backdrop L (hue-held, chroma-held)
 * until |Lc| <= ceiling. Source of truth folded in from .scratch/laneA2-halation.cjs. */
function correctA2(fg, bg, T, ceiling, clampLargeCeiling) {
  if (ceiling == null) ceiling = 100;
  const [L0, C0, h0] = srgbToOklch(fg);
  const cw = Math.abs(apca([255, 255, 255], bg));
  const cb = Math.abs(apca([0, 0, 0], bg));
  const Lext = cw >= cb ? 1 : 0;
  const at = (k) => oklchToSrgb(L0 + k * (Lext - L0), C0, h0);

  let best;
  if (Math.abs(apca(at(1), bg)) < T + 3) {
    best = at(1);                                      // backdrop-capped
  } else {
    let lo = 0, hi = 1;
    best = at(1);
    for (let i = 0; i < 24; i++) {
      const k = (lo + hi) / 2, c = at(k);
      if (Math.abs(apca(c, bg)) >= T + 3) { best = c; hi = k; } else { lo = k; }
    }
    if (Math.abs(apca(best, bg)) > ceiling) {          // pre-existing ceiling backstop
      let lo2 = 0, hi2 = 1;
      for (let i = 0; i < 20; i++) {
        const k = (lo2 + hi2) / 2, c = at(k), lc = Math.abs(apca(c, bg));
        if (lc > ceiling) { hi2 = k; } else if (lc < T) { lo2 = k; } else { best = c; break; }
        best = c;
      }
    }
  }

  if (clampLargeCeiling && Math.abs(apca(best, bg)) > ceiling) {  // M4a additive down-pull
    const [lm, cm, hm] = srgbToOklch(best);
    const [lbg] = srgbToOklch(bg);
    const atCap = (t) => oklchToSrgb(lm + t * (lbg - lm), cm, hm);
    let lo3 = 0, hi3 = 1, capped = atCap(1);
    for (let i = 0; i < 24; i++) {
      const t = (lo3 + hi3) / 2, c = atCap(t);
      if (Math.abs(apca(c, bg)) > ceiling) { lo3 = t; } else { capped = c; hi3 = t; }
    }
    best = capped;
  }
  return best;
}

/* gamutMaxC(L, h) — max in-gamut sRGB chroma at fixed OKLab lightness L and hue h
 * (h in RADIANS, matching srgbToOklch()[2]). Binary-search the largest C whose
 * (L, C, h) stays inside sRGB, using the SAME inGamut/oklabToLinear the operator's
 * gamut map uses — so gamutMaxC(L,h) equals the chroma oklchToSrgb would clamp to
 * at that (L,h). Exported for the darkcheck A5 gamut-exemption lane. */
function gamutMaxC(L, h) {
  if (L <= 0 || L >= 1) return 0;
  const cos = Math.cos(h), sin = Math.sin(h);
  const at = (C) => inGamut(oklabToLinear(L, C * cos, C * sin));
  let lo = 0, hi = 0.5;
  if (at(hi)) return hi;                               // whole search range in gamut
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    linApca, Ys, apca, toLinear, toSrgb8, srgbToOklab, oklabToLinear, srgbToOklch,
    inGamut, oklchToSrgb, correct, correctRGB, invertLum,
    hueDriftDeg, apcaBand, polaritySign, jointSolveHistory,
    // engine mirrors
    invertBand, bandInverse, surfaceCeiling, rampFreeze, isLargeText, correctA2,
    gamutMaxC, clamp01,
  };
}
