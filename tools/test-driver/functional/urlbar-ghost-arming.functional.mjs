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

// --- BUG 2: ghost FREEZES the resting bar exactly (value text + every leading icon) ---
ok(/\.urlbar-input-container/.test(bjs),
   "ghost reads the real .urlbar-input-container to reproduce the leading icons");
ok(/-inputField/.test(bjs) || /\.urlbar-input\b/.test(bjs),
   "ghost measures the real .urlbar-input (inputField) for the text start-x");
// TEXT = the real resting value (gURLBar.value), placeholder ONLY when empty —
// not always the placeholder (the owner saw 'Search…' where the URL should be).
ok(/\.-value/.test(bjs) && /has-value\?/.test(bjs),
   "ghost text = the real resting gURLBar.value (placeholder only when the bar is empty)");
// EVERY visible leading icon reproduced (not one hand-drawn shield): iterate leading + glyph-of
ok(/glyph-of/.test(bjs) && /\bleading\b/.test(bjs) && /doseq/.test(bjs),
   "ghost reproduces EVERY visible leading icon (iterates leading via glyph-of)");
ok(/input-left/.test(bjs) && /getBoundingClientRect/.test(bjs),
   "ghost positions text + icons from live getBoundingClientRect offsets");
// glyph copied from iconsrc (moz-button switcher) / <img src> / list-style / background
ok(/iconsrc/.test(bjs),
   "ghost honours the moz-button `iconsrc` attr (search-mode switcher's shadow glyph)");
ok(/shadowRoot/.test(bjs),
   "ghost pierces the open shadow root for icons rendered there");
ok(/listStyleImage/.test(bjs) && /backgroundImage/.test(bjs),
   "ghost copies computed list-style / background glyphs too");
ok(/-moz-context-properties\s*:\s*fill/.test(bjs),
   "ghost tints copied chrome SVG glyphs via -moz-context-properties: fill");
// the old hardcoded ghost shape must be gone (guessed padding + single flex text)
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

// --- TOP-LAYER SELF-HEAL: single owner, re-asserted on every summon ---
// The palette escapes the sidebar's (compact = transformed) stacking context only by
// being a top-layer popover. `popover` has multiple writers (compact.bjs, activate,
// teardown), so it can desync from the `activated` flag. activate-floating must
// re-assert the promotion on BOTH the fresh AND the re-arm path via one owner, so a
// re-summon can never leave the palette stranded out of the top layer (clipped under
// content). Behavioural proof: urlbar-promote-selfheal.py.
ok(/ensure-floating-promoted/.test(bjs),
   "there is a single top-layer-promotion owner (ensure-floating-promoted)");
// it must be invoked from the re-arm branch (activated already true) — the desync path
const rearmIdx = bjs.indexOf("activateFloating:re-arm");
const rearmScope = rearmIdx !== -1 ? bjs.slice(rearmIdx, rearmIdx + 1400) : "";
ok(/\(ensure-floating-promoted\)/.test(rearmScope),
   "the re-arm branch calls ensure-floating-promoted (self-heals a pulled popover)");
// and the promotion actually asserts popover=manual + showPopover
const promoteIdx = bjs.indexOf("ensure-floating-promoted (fn");
const promoteScope = promoteIdx !== -1 ? bjs.slice(promoteIdx, promoteIdx + 600) : "";
ok(/popover.*manual/.test(promoteScope) && /showPopover/.test(promoteScope),
   "ensure-floating-promoted asserts popover=manual + showPopover (top-layer promotion)");

console.log(`\nurlbar-ghost-arming invariants: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
