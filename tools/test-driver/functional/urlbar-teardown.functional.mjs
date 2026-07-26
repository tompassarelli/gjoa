// Regression guard for the Ctrl+L command-palette DISMISS jank (2026-07-18).
//
// Two independent jank sources were fixed; this locks both at the source so a
// future edit can't silently re-introduce them. The behavioural end-to-end guard
// is tools/test-driver/urlbar-teardown-probe.py (real-GUI, measures the live
// teardown transition + that FF's view.close is blocked). This is the fast
// source-invariant check.
//
//   bun tools/test-driver/functional/urlbar-teardown.functional.mjs
//
// (1) NO SCALE on teardown. The teardown rule scaled #urlbar, which also scaled
//     its child .urlbarView-results — a tall panel of suggestion text. Sub-pixel
//     scale re-rasterized the text each frame -> the whole list went blurry
//     mid-dismiss ("artifact degradation"). Teardown must be a PURE opacity fade.
// (2) ESCAPE BLOCKS FF. FF's UrlbarController Escape (window-bubble) calls
//     view.close() synchronously, snapping the results shut before our fade. Our
//     capture-phase #urlbar handler must preventDefault + stopImmediatePropagation
//     on Escape so the whole palette fades as one unit.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const css = readFileSync(join(root, "src/gjoa/chrome/css/gjoa.uc.css"), "utf8");
const bjs = readFileSync(join(root, "src/gjoa/chrome/bjs/drawer/urlbar.bjs"), "utf8");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", msg); } };

// --- (1) teardown rule: pure opacity fade, no scale ---
const mRule = css.match(/\[gjoa-urlbar-floating\]\[gjoa-urlbar-teardown\]\s*#urlbar\s*\{([^}]*)\}/);
ok(!!mRule, "found the teardown #urlbar rule");
if (mRule) {
  const body = mRule[1];
  ok(/opacity:\s*0\b/.test(body), "teardown fades opacity to 0");
  ok(/transition:\s*opacity/.test(body), "teardown transitions opacity");
  ok(!/\bscale\b/.test(body), "teardown has NO scale (text-blur regression) [the bug]");
  ok(!/\btransition:[^;]*scale/.test(body), "teardown transition does not include scale");
}

// --- (2) Escape branch blocks FF's synchronous view.close ---
// Slice from the Escape key test to the next cond clause (the Enter test).
const eStart = bjs.indexOf('(= (.-key e) "Escape")');
const eEnd = bjs.indexOf('(= (.-key e) "Enter")', eStart);
ok(eStart >= 0 && eEnd > eStart, "found the Escape cond branch");
if (eStart >= 0 && eEnd > eStart) {
  const branch = bjs.slice(eStart, eEnd);
  ok(/\.preventDefault e/.test(branch), "Escape calls preventDefault (blocks FF view.close) [the bug]");
  ok(/\.stopImmediatePropagation e/.test(branch), "Escape stops propagation to FF's window listener");
}

// --- (3) finish-teardown COLLAPSES the focused/expanded residue ---
// The floating palette showPopover()s the urlbar into the top layer AND focuses it. A
// non-Escape dismiss (backdrop / focus-out) leaves the urlbar FOCUSED, and Firefox
// re-expands a focused resting urlbar into breakout-extend — the empty bar at the slot
// with top-sites results showing (the janky teardown state, owner-reported 2026-07-19).
// The prior code GATED hidePopover behind `not breakout-extend` to "preserve a raced
// click-to-expand" — but the backdrop intercepts every click while floating, so that race
// can't happen; the guard only ever fired on focus-induced breakout-extend and left the
// mess. Regression guard: finish-teardown must return focus to CONTENT
// (selectedBrowser.focus), close the view, hidePopover UNCONDITIONALLY, and clear
// breakout-extend — and must NOT gate the popover-hide behind a breakout-extend check.
const fStart = bjs.indexOf("finish-teardown (fn []");
const fEnd = bjs.indexOf("deactivate-floating (fn []", fStart);
ok(fStart >= 0 && fEnd > fStart, "found finish-teardown");
if (fStart >= 0 && fEnd > fStart) {
  const body = bjs.slice(fStart, fEnd);
  const code = body.replace(/;;[^\n]*/g, ""); // strip beagle comments before matching
  ok(/\.hidePopover urlbar/.test(code), "finish-teardown hides the popover");
  ok(!/compact-on/.test(code), "popover-hide is NOT gated on compact mode");
  ok(/selectedBrowser[\s\S]*?\.focus/.test(code),
     "finish-teardown returns focus to CONTENT — kills the focused breakout-extend residue [the bug]");
  ok(/-view[\s\S]{0,6}\.close/.test(code), "finish-teardown closes the urlbar view (collapses results)");
  ok(/rmattr! urlbar "breakout-extend"/.test(code), "finish-teardown clears breakout-extend");
  ok(!/\(when \(not \(bool \(has\? urlbar "breakout-extend"\)\)\)/.test(code),
     "hidePopover is NOT gated behind a breakout-extend skip [the janky-teardown bug]");
}

console.log(`\nurlbar-teardown invariants: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
