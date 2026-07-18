// Regression guard for #darkenStrayLightBands' element gate (2026-07-18).
//
// New actor pass darkens large full-width near-white bands that native-dark sites
// leave light (animatedmachines' white <header>, nasa's white <body>/sections) so
// they stop glaring on the dark page and losing to Dark Reader. The DANGER is
// over-reach: darkening a proper native-dark theme's small light accents / dark
// surfaces (the A7 case, e.g. YouTube control pills the owner flagged). This locks
// the gate TIGHT: only LARGE + roughly FULL-WIDTH + OPAQUE + NEAR-WHITE qualifies.
//
//   bun tools/test-driver/functional/stray-band-gate.functional.mjs
//
// isStrayLightBand is pure + static; we slice it out of the actor source and eval it
// in isolation (the .sys.mjs top-level imports Services etc., so no direct import).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(here, "../../../src/gjoa/toolkit/components/content-classifier/GjoaDarkmodeChild.sys.mjs"),
  "utf8"
);

const m = src.match(/static isStrayLightBand\s*\(([^)]*)\)\s*\{\s*return([^;]*);\s*\}/);
if (!m) { console.log("FAIL: could not extract isStrayLightBand from actor source"); process.exit(1); }
const isStrayLightBand = new Function(...m[1].split(",").map(s => s.trim()), `return (${m[2]});`);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", msg); } };
// (widthFrac, areaPx, alpha, lum)
const f = isStrayLightBand;

// --- QUALIFIES: the target defect (nasa body/section, animatedmachines header) ---
ok(f(1.0, 178780, 1, 1.0) === true, "full-width opaque white header band -> darken [the fix]");
ok(f(0.9, 998000, 1, 1.0) === true, "wide opaque white content section -> darken");
ok(f(0.6, 130000, 0.95, 0.8) === true, "just past every threshold -> darken");

// --- SPARED: proper native-dark themes must never be touched ---
ok(f(0.2, 40000, 1, 1.0) === false, "small white logo box (narrow + small) -> spare");
ok(f(1.0, 500000, 1, 0.2) === false, "full-width DARK surface -> spare (not near-white)");
ok(f(1.0, 500000, 1, 0.5) === false, "full-width MID-tone band -> spare (below near-white)");
ok(f(1.0, 500000, 0.4, 1.0) === false, "translucent white overlay -> spare (glass composites)");
ok(f(0.4, 500000, 1, 1.0) === false, "narrow white column (<55% width) -> spare (a card, not a band)");
ok(f(1.0, 50000, 1, 1.0) === false, "thin full-width white strip (small area) -> spare (a divider/pill)");

console.log(`\nstray-band gate truth table: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
