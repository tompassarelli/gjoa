/* colormath.js — THIN ESM WRAPPER. The canonical implementation lives in
 * colormath.cjs; this file exists only so ESM importers keep working after the
 * "type":"module" require('colormath.js') -> {} trap was fixed by making the
 * canonical file `.cjs` (dev-loop-assessment §7). ONE implementation, two import
 * paths:
 *   - CJS / text-concat consumers (runner.bjs, darkcheck-runner.bjs read the .cjs
 *     as text; wave6-*.cjs, .scratch/*.cjs require it) -> colormath.cjs directly.
 *   - ESM consumers (colormath.test.js, apca-w3-vectors.test.js) -> this wrapper.
 * Do NOT add logic here; edit colormath.cjs. */
import { createRequire } from "node:module";

const cm = createRequire(import.meta.url)("./colormath.cjs");

export const {
  linApca, Ys, apca, toLinear, toSrgb8, srgbToOklab, oklabToLinear, srgbToOklch,
  inGamut, oklchToSrgb, correct, correctRGB, invertLum,
  hueDriftDeg, apcaBand, polaritySign, jointSolveHistory,
  invertBand, bandInverse, surfaceCeiling, rampFreeze, isLargeText, correctA2,
  gamutMaxC, clamp01,
} = cm;

export default cm;
