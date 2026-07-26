#!/usr/bin/env node
/* vectors.cjs — verify the canonical oracle reproduces vectors.json exactly.
 * Plain node, zero deps:  node tools/darkmode-regress/vectors.cjs
 * Green = every copy of the dark-mode math that consumes vectors.json (actor,
 * GjoaDarkText.cpp, color.rs, rust-oracle) has ONE agreed spec. rgb are checked
 * EXACT (sRGB8); scalars within a tight f32-representable tolerance. */
const cm = require("./colormath.cjs");
const {
  correct, correctA2, invertBand, rampFreeze, surfaceCeiling, gamutMaxC,
  srgbToOklch, apca, hueDriftDeg, isLargeText,
} = cm;
const V = require("./vectors.json");
const abs = Math.abs;

let pass = 0, fail = 0;
const eqRgb = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function ck(cond, msg) { if (cond) { pass++; } else { fail++; console.log(`  FAIL  ${msg}`); } }
const near = (a, b, tol) => abs(a - b) <= tol;

console.log("## probe §6.1 anchors");
{
  const p = V.probe_6_1.correct_0_0_238;
  const out = correct(p.fg, p.bg, p.T, p.ceiling);
  ck(eqRgb(out, p.expect), `correct([0,0,238]) => ${JSON.stringify(out)} want ${JSON.stringify(p.expect)}`);
  ck(near(hueDriftDeg(p.fg, out), p.drift, 0.05), `drift ${hueDriftDeg(p.fg, out).toFixed(2)} want ${p.drift}`);
  ck(near(srgbToOklch(out)[1], p.c, 0.001), `C ${srgbToOklch(out)[1].toFixed(4)} want ${p.c}`);
  for (const k of ["gamutMaxC_Lc576", "gamutMaxC_Lc666"]) {
    const g = V.probe_6_1[k];
    ck(near(gamutMaxC(g.L, g.h), g.expect, 1e-4), `${k} gamutMaxC(${g.L}) => ${gamutMaxC(g.L, g.h).toFixed(4)} want ${g.expect}`);
  }
}

console.log("## 1. correct()");
for (const v of V.correct) {
  const out = correct(v.fg, v.bg, v.T, v.ceiling);
  ck(eqRgb(out, v.expect), `correct(${JSON.stringify(v.fg)},bg,${v.T},${v.ceiling}) => ${JSON.stringify(out)} want ${JSON.stringify(v.expect)}`);
}

console.log("## 2. invertBand()");
for (const v of V.invertBand) {
  const out = invertBand(v.rgb, v.floor, v.ceiling);
  ck(eqRgb(out, v.expect), `invertBand(${JSON.stringify(v.rgb)}) [${v.note}] => ${JSON.stringify(out)} want ${JSON.stringify(v.expect)}`);
}

console.log("## 3. correctA2() (M4a)");
for (const v of V.correctA2) {
  ck(isLargeText(v.px, v.weight) === v.large, `isLargeText(${v.px},${v.weight}) want ${v.large}`);
  const out = correctA2(v.fg, v.bg, v.T, v.ceiling, v.large);
  ck(eqRgb(out, v.expect), `correctA2(${JSON.stringify(v.fg)},large=${v.large}) => ${JSON.stringify(out)} want ${JSON.stringify(v.expect)}`);
}

console.log("## 4. ramp-freeze");
ck(near(surfaceCeiling(V.ramp.surfaceCeiling.floor), V.ramp.surfaceCeiling.expect, 1e-4), "surfaceCeiling");
for (const v of V.ramp.vectors) {
  const r = rampFreeze(v.rgb, v.floor, v.ceiling);
  ck(eqRgb(r.rgb, v.expect) && r.band === v.band, `rampFreeze(${JSON.stringify(v.rgb)}) [${v.note}] => ${JSON.stringify(r.rgb)}/${r.band} want ${JSON.stringify(v.expect)}/${v.band}`);
}

console.log("## 5. gamutMaxC()");
for (const v of V.gamutMaxC) {
  ck(near(gamutMaxC(v.L, v.h), v.expect, 1e-4), `gamutMaxC(${v.L},${v.h}) [${v.note}] => ${gamutMaxC(v.L, v.h).toFixed(4)} want ${v.expect}`);
}

console.log(`\n=== ${pass}/${pass + fail} passed ===`);
process.exit(fail ? 1 : 0);
