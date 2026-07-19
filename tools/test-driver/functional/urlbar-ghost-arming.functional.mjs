// Regression guard for the two Ctrl+L command-palette bugs the owner hit 2026-07-19:
//
//   BUG 2 "icon isn't the same / text shifts on pop-out": the resting-slot ghost
//         (#gjoa-urlbar-ghost) must pixel-match the REAL resting urlbar. The old
//         ghost hand-drew a plain shield at a guessed padding — measured 52px off
//         the real text start, wrong glyph. The fix derives icon glyph + icon-x +
//         text-x from the real urlbar's LIVE layout. A revert to a hardcoded shield
//         / fixed padding must fail here.
//   BUG 1 "on first Ctrl+L of a session the bar flashes ~40-100px off then snaps":
//         activate() must ARM opacity:0 (no transition) BEFORE showPopover() promotes
//         #urlbar to the top layer, then reveal on the next frame — so the float-in
//         only ever plays from the settled centered geometry.
//
//   bun tools/test-driver/functional/urlbar-ghost-arming.functional.mjs
//
// Behavioural proof: tools/test-driver/urlbar-ghost-match-probe.py (cage: ghost
// text-start == real text-start within 2px, ghost glyph == real leading-icon glyph,
// no layout transient, arming clears). This is the fast source-invariant check.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const bjs = readFileSync(join(root, "src/gjoa/chrome/bjs/drawer/urlbar.bjs"), "utf8");
const css = readFileSync(join(root, "src/gjoa/chrome/css/gjoa.uc.css"), "utf8");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", msg); } };

// --- BUG 2: ghost derives from the real urlbar's live layout ---
ok(/\.urlbar-input-container/.test(bjs),
   "ghost reads the real .urlbar-input-container to find the leading icon");
ok(/\.urlbar-input\b/.test(bjs) || /-inputField/.test(bjs),
   "ghost measures the real .urlbar-input (or inputField) for the text start-x");
// text-x + icon-x come from getBoundingClientRect deltas, not a hardcoded padding
ok(/text-left/.test(bjs) && /icon-left/.test(bjs),
   "ghost positions text + icon from measured offsets (text-left / icon-left)");
ok(/getBoundingClientRect/.test(bjs),
   "ghost derives offsets from live getBoundingClientRect");
// glyph is copied from the real icon's computed image (list-style-image / background)
ok(/listStyleImage/.test(bjs) && /backgroundImage/.test(bjs),
   "ghost copies the real leading-icon glyph (listStyleImage / backgroundImage)");
ok(/-moz-context-properties\s*:\s*fill/.test(bjs),
   "ghost tints copied chrome SVG glyphs via -moz-context-properties: fill");
// the old hardcoded ghost shape must be gone (guessed padding + flex text)
ok(!/padding-inline:12px/.test(bjs),
   "ghost no longer uses the old hardcoded padding-inline:12px (the 52px-off form)");
ok(!/flex:1 1 auto/.test(bjs),
   "ghost text no longer flex-flows (it is positioned at the measured text-x)");

// --- BUG 1: arming gate, set BEFORE showPopover, revealed on a later frame ---
const armIdx = bjs.indexOf('"gjoa-urlbar-arming"');
const popIdx = bjs.indexOf(".showPopover");
ok(armIdx !== -1, "activate arms gjoa-urlbar-arming");
ok(armIdx !== -1 && popIdx !== -1 && armIdx < popIdx,
   "arming is set BEFORE showPopover() (so the pre-promotion frame is opacity:0)");
// reveal on a subsequent animation frame (double-rAF) with a setTimeout fallback
const revealScope = bjs.slice(popIdx);
ok(/requestAnimationFrame/.test(revealScope) && /rmattr!\s+root\s+"gjoa-urlbar-arming"/.test(bjs),
   "arming is cleared on a later frame (requestAnimationFrame reveal)");
ok(/setTimeout\s+window\s+reveal/.test(bjs) || /\.setTimeout window reveal/.test(bjs),
   "a setTimeout fallback clears arming even if rAF is starved (never stuck invisible)");
// teardown also clears arming defensively
ok((bjs.match(/rmattr!\s+root\s+"gjoa-urlbar-arming"/g) || []).length >= 2,
   "arming is also cleared on teardown (defensive, cannot get stuck)");

// --- CSS: the arming rule forces opacity:0 with no animation, out-specifying float-in ---
const armRule = /:root\[gjoa-urlbar-floating\]\[gjoa-urlbar-arming\]\s+#urlbar\s*\{[^}]*\}/.exec(css);
ok(!!armRule, "CSS has :root[gjoa-urlbar-floating][gjoa-urlbar-arming] #urlbar rule");
if (armRule) {
  const body = armRule[0];
  ok(/opacity:\s*0\s*!important/.test(body), "arming rule forces opacity: 0 !important");
  ok(/animation:\s*none\s*!important/.test(body), "arming rule kills the float-in animation");
  ok(/transition:\s*none\s*!important/.test(body), "arming rule kills transitions (instant, no fade-at-wrong-pos)");
}

// --- CENTERING: the in-sidebar de-centering rule must YIELD while floating ---
// The rule `#sidebar-main #gjoa-urlbar-toolbar #urlbar:not([breakout-extend])`
// sets left/right:auto and is (3,1,0)-specific — HIGHER than the floating
// centering rule (1,2,0). Un-guarded, it pins the floating popover to its static
// sidebar slot (left-anchored, only visible at wide windows). It MUST be scoped to
// :root:not([gjoa-urlbar-floating]) so the centering wins while the palette floats.
// Behavioural proof: urlbar-float-realpage-probe.py --cage (real page, 1280px window,
// asserts the palette centers within 40px of viewport-center).
const sidebarRule = /([^\n{}]*#sidebar-main[^\n{}]*#gjoa-urlbar-toolbar[^\n{}]*#urlbar:not\(\[breakout-extend\]\))\s*\{[^}]*left:\s*auto/m.exec(css);
ok(!!sidebarRule, "the in-sidebar left/right:auto rule exists (resting layout)");
if (sidebarRule) {
  ok(/:root:not\(\[gjoa-urlbar-floating\]\)/.test(sidebarRule[1]),
     "in-sidebar de-centering rule is scoped :root:not([gjoa-urlbar-floating]) so floating centers");
}

console.log(`\nurlbar-ghost-arming invariants: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
