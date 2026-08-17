// Functional contract for the Ctrl+L command palette:
//
//   - The resting-slot ghost derives its value, icons, and coordinates from the
//     live resting urlbar.
//   - activate() arms opacity:0 before showPopover() promotes #urlbar, then
//     reveals it on a later frame from settled centered geometry.
//
//   - The palette is centered and painted over content by DOM position: #urlbar
//     is parked in #gjoa-urlbar-stage under documentElement.
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

// --- ghost freezes the resting bar exactly (value text + every leading icon) ---
ok(/\.urlbar-input-container/.test(bjs),
   "ghost reads the real .urlbar-input-container to reproduce the leading icons");
ok(/-inputField/.test(bjs) || /\.urlbar-input\b/.test(bjs),
   "ghost measures the real .urlbar-input (inputField) for the text start-x");
// Text is the real resting value, with the placeholder only when empty.
ok(/\(js\/get \.value\)/.test(bjs) && /has-value\?/.test(bjs),
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
// --- arming gate, set before showPopover, revealed on a later frame ---
// The promotion that shows the popover is `ensure-floating-promoted`; the file
// also carries a showPopover shim far above activate, so the ordering is read
// against the promotion CALL, not against the first mention of showPopover.
const armIdx = bjs.indexOf('(attr! root "gjoa-urlbar-arming" "")');
const popIdx = bjs.indexOf("(ensure-floating-promoted)", armIdx);
ok(armIdx !== -1, "activate arms gjoa-urlbar-arming");
ok(armIdx !== -1 && popIdx !== -1 && armIdx < popIdx,
   "arming is set BEFORE the promotion (so the pre-promotion frame is opacity:0)");
// reveal on a subsequent animation frame (double-rAF) with a setTimeout fallback
const revealScope = popIdx !== -1 ? bjs.slice(popIdx) : "";
ok(/requestAnimationFrame/.test(revealScope) && /rmattr!\s+root\s+"gjoa-urlbar-arming"/.test(bjs),
   "arming is cleared on a later frame (requestAnimationFrame reveal)");
ok(/js\/call window \.setTimeout reveal/.test(bjs),
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
// The rule `#sidebar-container #gjoa-urlbar-toolbar #urlbar:not([breakout-extend])`
// sets left/right:auto and is (3,1,0)-specific — HIGHER than the floating
// centering rule (1,2,0). Un-guarded, it pins the floating popover to its static
// sidebar slot (left-anchored, only visible at wide windows). It MUST be scoped to
// :root:not([gjoa-urlbar-floating]) so the centering wins while the palette floats.
// Behavioural proof: urlbar-float-realpage-probe.py --cage (real page, 1280px window,
// asserts the palette centers within 40px of viewport-center).
const sidebarRule = /([^\n{}]*#sidebar-container[^\n{}]*#gjoa-urlbar-toolbar[^\n{}]*#urlbar:not\(\[breakout-extend\]\))\s*\{[^}]*left:\s*auto/m.exec(css);
ok(!!sidebarRule, "the in-sidebar left/right:auto rule exists (resting layout)");
if (sidebarRule) {
  ok(/:root:not\(\[gjoa-urlbar-floating\]\)/.test(sidebarRule[1]),
     "in-sidebar de-centering rule is scoped :root:not([gjoa-urlbar-floating]) so floating centers");
}

// --- WINDOW-GLOBAL STAGE: the palette is centered + over the content BY DOM POSITION ---
// #urlbar is parked in #gjoa-urlbar-stage, a direct child of documentElement,
// for the palette's lifetime. The stage owns geometry and z-order.
ok(/ensure-stage!/.test(bjs) && /"gjoa-urlbar-stage"/.test(bjs),
   "there is a stage owner (ensure-stage!) creating #gjoa-urlbar-stage");
ok(/\(js\/call root \.appendChild el\)/.test(bjs),
   "the stage is appended to `root` (documentElement) — the backdrop's proven anchor");
// It must be a <toolbar>: UrlbarInput's connectedCallback (which the reparent fires)
// sets #allowBreakout = !!this.closest("toolbar"); under a plain div that goes false
// and #stopBreakout() permanently kills [breakout]/[breakout-extend].
ok(/xul-id "toolbar" "gjoa-urlbar-stage"/.test(bjs),
   "the stage is a XUL <toolbar> so #urlbar.closest('toolbar') still resolves");
// and the palette must pin the breakout vars, which FF derives from parentNode (= the
// viewport-sized stage) and would otherwise stretch the input row to the whole window.
ok(/--urlbar-container-height:\s*var\(--urlbar-min-height\)\s*!important/.test(css),
   "the floating palette pins --urlbar-container-height (parentNode is the stage)");
ok(/ensure-staged!/.test(bjs) && /js\/call st \.appendChild urlbar/.test(bjs),
   "#urlbar is reparented INTO the stage while floating");
// the home slot must be recorded, and restored before teardown drops the floating attrs
ok(/:parent \(js\/get urlbar \.parentNode\)/.test(bjs) && /:next \(js\/get urlbar \.nextSibling\)/.test(bjs),
   "the resting home slot (parent + nextSibling) is recorded before the move");
ok(/restore-home!/.test(bjs) && /js\/call p \.insertBefore urlbar n/.test(bjs),
   "teardown restores #urlbar to its exact home slot (insertBefore, not just append)");
const restoreIdx = bjs.indexOf("(restore-home!)");
const dropFloatIdx = bjs.indexOf('rmattr! root "gjoa-urlbar-floating"');
ok(restoreIdx !== -1 && dropFloatIdx !== -1 && restoreIdx < dropFloatIdx,
   "the un-stage happens BEFORE gjoa-urlbar-floating is dropped (no-flash ordering)");
// the stage must be laid out window-global and must not eat the backdrop's clicks
const stageRule = /#gjoa-urlbar-stage\s*\{[^}]*\}/.exec(css);
ok(!!stageRule, "CSS has a #gjoa-urlbar-stage rule");
if (stageRule) {
  const body = stageRule[0];
  ok(/position:\s*fixed\s*!important/.test(body), "stage is position: fixed (viewport-sized)");
  ok(/inset:\s*0\s*!important/.test(body), "stage spans the whole viewport (inset: 0)");
  ok(/z-index:\s*10001\s*!important/.test(body), "stage sits above the backdrop (z-index 10001)");
  ok(/pointer-events:\s*none\s*!important/.test(body),
     "stage is pointer-events:none so it cannot swallow the backdrop's dismiss clicks");
}
ok(/:root\[gjoa-urlbar-floating\]\s+#urlbar\s*\{\s*pointer-events:\s*auto\s*!important/.test(css),
   "the floating palette takes its own pointer events back");

// --- TOP-LAYER PROMOTION: breakout rendering without swallowing focus ---
// Promotion restores the [breakout] pair required by .urlbar-background and
// .urlbarView, with one owner reasserting it on every summon.
ok(/ensure-floating-promoted/.test(bjs),
   "there is a single top-layer-promotion owner (ensure-floating-promoted)");
// it must be invoked from the re-arm branch (activated already true) — the desync path
const rearmIdx = bjs.indexOf("activateFloating:re-arm");
const rearmScope = rearmIdx !== -1 ? bjs.slice(rearmIdx, rearmIdx + 1400) : "";
ok(/\(ensure-floating-promoted\)/.test(rearmScope),
   "the re-arm branch calls ensure-floating-promoted (self-heals a pulled popover)");
// Scope covers the whole binding form up to the next top-level binding so the
// assertions remain inside the inspected region as the form changes size.
const promoteIdx = bjs.indexOf("ensure-floating-promoted (fn");
const promoteEnd = promoteIdx !== -1 ? bjs.indexOf("\n        heal (fn", promoteIdx) : -1;
const promoteScope = promoteIdx !== -1 && promoteEnd !== -1
  ? bjs.slice(promoteIdx, promoteEnd) : "";
ok(promoteScope !== "", "could not delimit the ensure-floating-promoted binding form");
ok(/popover.*manual/.test(promoteScope) && /showPopover/.test(promoteScope),
   "ensure-floating-promoted asserts popover=manual + showPopover (top-layer promotion)");
// A showPopover throw must not skip the following focus/select, so promotion and
// focus handling require separate catches.
const catches = (promoteScope.match(/\(catch \(\w+ Any\)/g) || []).length;
ok(catches >= 2,
   "promotion and focus/select have SEPARATE catches (a showPopover throw cannot skip focus)");
const focusIdx = promoteScope.indexOf("(js/call .focus)");
const lastCatchBeforeFocus = promoteScope.lastIndexOf("(catch (", focusIdx);
ok(focusIdx !== -1 && lastCatchBeforeFocus !== -1 &&
   promoteScope.slice(lastCatchBeforeFocus, focusIdx).includes("(try"),
   "gURLBar.focus/select sit in their own try, after the promotion's catch");
// and the promotion must write [breakout] to the real #urlbar-container, which is NOT
// parentNode while the palette is staged.
ok(/container \(fn/.test(bjs) && /\(container\)/.test(promoteScope),
   "the [breakout] pair is written via `container`, not `parentNode` (stale while staged)");

console.log(`\nurlbar-ghost-arming invariants: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
