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

// --- (3) finish-teardown hides the popover in EVERY mode, not just compact ---
// The floating palette always showPopover()s the urlbar into the top layer, so a
// dismiss must hidePopover regardless of mode — else the resting urlbar is left
// :popover-open, stuck in the top layer over its empty sidebar slot (the visual
// artifact on exit). Regression guard: finish-teardown must call hidePopover, and
// that call must NOT be gated behind a compact-mode check (`compact-on`).
const fStart = bjs.indexOf("finish-teardown (fn []");
const fEnd = bjs.indexOf("deactivate-floating (fn []", fStart);
ok(fStart >= 0 && fEnd > fStart, "found finish-teardown");
if (fStart >= 0 && fEnd > fStart) {
  const body = bjs.slice(fStart, fEnd);
  const code = body.replace(/;;[^\n]*/g, ""); // strip beagle comments before matching
  ok(/\.hidePopover urlbar/.test(code), "finish-teardown hides the popover");
  ok(!/compact-on/.test(code), "popover-hide is NOT gated on compact mode [the bug]");
  ok(/breakout-extend/.test(code), "popover-hide still skips a raced click-to-expand (breakout-extend)");
}

console.log(`\nurlbar-teardown invariants: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
