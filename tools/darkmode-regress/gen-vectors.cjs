#!/usr/bin/env node
/* gen-vectors.cjs — regenerate vectors.json from the canonical oracle.
 *
 * vectors.json is the inputs->expected corpus binding every copy of the dark-mode
 * math (JS oracle, actor, GjoaDarkText.cpp, color.rs) to ONE source of truth
 * (dev-loop-assessment §4). Run after any change to colormath.cjs:
 *     node tools/darkmode-regress/gen-vectors.cjs
 * then `node tools/darkmode-regress/vectors.cjs` (or the .test) must stay green.
 *
 * ANCHORS: a subset of expected values are SPEC-PINNED literals (from
 * dev-loop-assessment §6.1 and the engine source), asserted at generation time so
 * the corpus is anchored to the engine's documented behavior, not merely to
 * whatever the oracle currently emits. If an anchor breaks, generation ABORTS. */
const cm = require("./colormath.cjs");
const {
  correct, correctA2, invertBand, rampFreeze, bandInverse, surfaceCeiling,
  gamutMaxC, srgbToOklch, apca, hueDriftDeg, isLargeText,
} = cm;
const abs = Math.abs;

const FLOOR = 0.16, CEILING = 0.92;      // baked gjoa.darkmode.invert bg/fgLightness
const BG = [13, 13, 13];                 // #0d0d0d canonical dark canvas
const HLINK = srgbToOklch([0, 0, 238])[2]; // link-blue hue (rad), ~264deg

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function anchor(name, got, want) {
  if (!eq(got, want)) {
    console.error(`ANCHOR FAILED ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    process.exit(1);
  }
}

// ---- ANCHORS (spec-pinned; abort generation if the oracle drifts off them) ----
anchor("§6.1 correct([0,0,238],#0d0d0d,60,90)", correct([0, 0, 238], BG, 60, 90), [147, 183, 255]);
anchor("invertBand white->floor", invertBand([255, 255, 255], FLOOR, CEILING), [13, 13, 13]);
anchor("invertBand black->ceiling", invertBand([0, 0, 0], FLOOR, CEILING), [228, 228, 228]);
anchor("invertBand brand orange unchanged", invertBand([255, 78, 0], FLOOR, CEILING), [255, 78, 0]);

// ---- vector builders ----
function vCorrect(fg, bg, T, ceiling) {
  const out = correct(fg, bg, T, ceiling);
  return { fg, bg, T, ceiling, expect: out, lc: +abs(apca(out, bg)).toFixed(2), drift: +hueDriftDeg(fg, out).toFixed(2), c: +srgbToOklch(out)[1].toFixed(4) };
}
function vCorrectA2(fg, bg, T, ceiling, px, weight) {
  const large = isLargeText(px, weight);
  const out = correctA2(fg, bg, T, ceiling, large);
  return { fg, bg, T, ceiling, px, weight, large, expect: out, lc: +abs(apca(out, bg)).toFixed(2) };
}
function vInvert(rgb, note) {
  const cin = srgbToOklch(rgb)[1];
  return { rgb, floor: FLOOR, ceiling: CEILING, chromaIn: +cin.toFixed(4), expect: invertBand(rgb, FLOOR, CEILING), note };
}
function vRamp(rgb, note) {
  const r = rampFreeze(rgb, FLOOR, CEILING);
  return { rgb, floor: FLOOR, ceiling: CEILING, expect: r.rgb, band: r.band, lAuth: +bandInverse(srgbToOklch(rgb)[0], FLOOR, CEILING).toFixed(4), note };
}
function vGamut(L, h, note) { return { L, h: +h.toFixed(6), expect: +gamutMaxC(L, h).toFixed(4), note }; }

const vectors = {
  _meta: {
    source: "tools/darkmode-regress/colormath.cjs",
    generator: "tools/darkmode-regress/gen-vectors.cjs",
    note: "inputs->expected for the dark-mode oracle. rgb are exact (sRGB8); scalars carry the precision shown. f64 oracle vs f32 engine agree to f32-representable tolerance (see colormath.cjs precision note). Regenerate with the generator; verify with vectors.cjs.",
    floor: FLOOR, ceiling: CEILING, bg: BG,
  },

  // §6.1 probe artifacts — the pinned anchor + neighbours.
  probe_6_1: {
    correct_0_0_238: { fg: [0, 0, 238], bg: BG, T: 60, ceiling: 90, expect: [147, 183, 255], drift: 0.44, c: 0.111,
      spec: "dev-loop-assessment §6.1: -> [147,183,255], drift 0.4deg, C 0.111" },
    gamutMaxC_Lc576: { L: 0.744, h: +HLINK.toFixed(6), expect: +gamutMaxC(0.744, HLINK).toFixed(4),
      spec: "§6.1: gamutMaxC at Lc~57.6 (L~0.744) ~= 0.132" },
    gamutMaxC_Lc666: { L: 0.790, h: +HLINK.toFixed(6), expect: +gamutMaxC(0.790, HLINK).toFixed(4),
      spec: "§6.1: gamutMaxC at Lc~66.6 (L~0.790) ~= 0.105" },
  },

  // 1. solver correct()
  correct: [
    vCorrect([0, 0, 238], BG, 60, 90),      // link blue, the anchor
    vCorrect([0, 0, 238], BG, 57, 90),
    vCorrect([204, 0, 0], BG, 57, 90),      // red
    vCorrect([255, 78, 0], BG, 57, 90),     // orange
    vCorrect([214, 44, 122], BG, 57, 90),   // pink
    vCorrect([0, 102, 204], BG, 60, 90),    // #0066cc
    vCorrect([0, 102, 204], [220, 218, 215], 57, 90), // on LIGHT card (black polarity)
    vCorrect([136, 136, 136], BG, 57, 90),  // neutral grey
  ],

  // 2. invertBand — band edges, brand-preserve 0.08+-eps, neutral-snap 0.03+-eps, chroma shed
  invertBand: [
    vInvert([255, 255, 255], "white -> floor (dark)"),
    vInvert([0, 0, 0], "black -> ceiling (light)"),
    vInvert([228, 228, 228], "near-white neutral"),
    vInvert([13, 13, 13], "near-black neutral"),
    vInvert([255, 78, 0], "orange c>0.08 -> brand preserve UNCHANGED"),
    vInvert([0, 0, 238], "saturated blue c>0.08 -> brand preserve UNCHANGED"),
    vInvert([200, 199, 196], "faint cast c<0.03 -> neutral snap"),
    vInvert([120, 130, 150], "low-chroma 0.03<c<0.08 -> inverted + chroma shed"),
    vInvert([90, 90, 92], "very faint c<0.03 -> snapped neutral"),
  ],

  // 3. correctA2 — M4a size-gated halation ceiling (LARGE clamped, BODY not)
  correctA2: [
    vCorrectA2([228, 228, 228], BG, 57, 90, 40, 400),  // band-mapped white, LARGE -> pulled under ceiling
    vCorrectA2([228, 228, 228], BG, 57, 90, 16, 400),  // BODY -> keeps Lc90 (never clamped)
    vCorrectA2([255, 255, 255], BG, 57, 90, 40, 400),  // white LARGE
    vCorrectA2([255, 255, 255], BG, 57, 90, 16, 400),  // white BODY
    vCorrectA2([141, 178, 255], BG, 57, 90, 40, 400),  // #8db2ff link LARGE
    vCorrectA2([141, 178, 255], BG, 57, 90, 16, 400),  // #8db2ff link BODY
    vCorrectA2([228, 228, 228], BG, 57, 90, 24, 700),  // 24px/700 -> LARGE by weight
  ],

  // 4. ramp-freeze — surface remap onto the dark ramp
  ramp: {
    surfaceCeiling: { floor: FLOOR, expect: +surfaceCeiling(FLOOR).toFixed(4) },
    vectors: [
      vRamp([140, 140, 140], "mid grey computed surface"),
      vRamp([90, 90, 90], "darker grey surface"),
      vRamp([228, 228, 228], "band-mapped black surface -> frozen dark"),
      vRamp([40, 40, 40], "already-dark surface (unchanged/darken-only)"),
      vRamp([255, 78, 0], "brand surface c>0.08 -> unchanged"),
    ],
  },

  // 5. gamutMaxC(L, h) — max in-gamut sRGB chroma
  gamutMaxC: [
    vGamut(0.744, HLINK, "Lc~57.6 anchor -> ~0.132"),
    vGamut(0.790, HLINK, "Lc~66.6 anchor -> ~0.105"),
    vGamut(0.50, HLINK, "mid L"),
    vGamut(0.60, 0, "hue 0 (red axis)"),
    vGamut(0.70, Math.PI / 2, "hue 90 (yellow-green axis)"),
    vGamut(0.85, HLINK, "high L"),
  ],
};

const fs = require("fs");
const path = require("path");
const out = path.join(__dirname, "vectors.json");
fs.writeFileSync(out, JSON.stringify(vectors, null, 2) + "\n");
console.log(`wrote ${out} (${vectors.correct.length} correct, ${vectors.invertBand.length} invertBand, ${vectors.correctA2.length} correctA2, ${vectors.ramp.vectors.length} ramp, ${vectors.gamutMaxC.length} gamutMaxC) — all anchors green`);
