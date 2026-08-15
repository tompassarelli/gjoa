// Functional regression test for the "Collapse Layout" width bug (2026-07-18).
//
// SYMPTOM: right-click sidebar button -> "Collapse Layout" left the sidebar at a
// wide ~140px "half-compressed" strip with tab labels + close buttons still
// visible, instead of the ~56px favicon rail it used to snap to.
//
// ROOT CAUSE: tabs/layout.js positionPanel decided the collapsed favicon-rail
// (`gjoa-icons-only`) from whether #navigator-toolbox was still parented inside
// #sidebar-container. But the toolbox is reparented in/out by a SEPARATE module
// (drawer/layout collapse/expand) reacting to the SAME `sidebar-launcher-expanded`
// attribute — and FF's launcher animation makes that reparent LAG. So positionPanel
// routinely read toolbox-still-in and skipped icons-only, leaving labels + width.
//
// FIX / INVARIANT: the collapse decision now lives in the PURE `collapse_flags`
// helper, keyed on the AUTHORITATIVE `sidebar-launcher-expanded` (launcher state)
// plus compact/hover — never the racy toolbox parent. Invariant locked here:
//   launcher collapsed AND not a compact reveal  =>  iconsOnly (favicon rail).
//
//   bun run chrome:compile && bun tools/test-driver/functional/collapse-flags.functional.mjs
//
// We slice collapse_flags out of the real compiled emit (brace-balanced) and eval
// it in isolation — no chrome-graph boot — so drift in the compiled logic fails here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../../../.beagle-out/gjoa/tabs/layout.js"), "utf8");

// Brace-balanced extraction: collapse_flags returns a nested object literal, so a
// naive /\{[^}]*\}/ would stop at the object's first `}` — walk the braces instead.
const start = src.indexOf("export function collapse_flags");
if (start < 0) { console.log("FAIL: could not find collapse_flags in compiled layout.js"); process.exit(1); }
const open = src.indexOf("{", start);
let depth = 0, end = -1;
for (let i = open; i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) { console.log("FAIL: could not brace-balance collapse_flags"); process.exit(1); }
const fnSrc = src.slice(start, end).replace(/^export\s+/, "");
const collapse_flags = new Function(fnSrc + "\nreturn collapse_flags;")();

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", msg); } };
// (launcherExpanded, compact, hover) -> {iconsOnly, sidebarCollapsed}
const f = (le, c, h) => collapse_flags(le, c, h);

// --- THE REGRESSION: plain collapse must give the favicon rail ---
ok(f(false, false, false).iconsOnly === true,       "collapsed (launcher off) -> iconsOnly (favicon rail) [was the bug]");
ok(f(false, false, false).sidebarCollapsed === true, "collapsed -> sidebarCollapsed stamped");

// --- expanded must keep labels (never icons-only) ---
ok(f(true, false, false).iconsOnly === false,        "expanded -> NOT iconsOnly (labels show)");
ok(f(true, false, false).sidebarCollapsed === false, "expanded -> NOT sidebarCollapsed");

// --- compact mode parity (unchanged by the fix) ---
ok(f(true, true, false).iconsOnly === false,         "compact hidden, launcher expanded -> NOT iconsOnly");
ok(f(true, true, false).sidebarCollapsed === true,   "compact -> sidebarCollapsed (floating overlay layout)");
ok(f(true, true, true).iconsOnly === false,          "compact REVEALED -> NOT iconsOnly (full labels on hover)");
ok(f(false, true, true).iconsOnly === false,         "compact revealed even when launcher collapsed -> NOT iconsOnly");
ok(f(false, true, false).iconsOnly === true,         "compact but hidden + launcher collapsed -> iconsOnly rail");

console.log(`\ncollapse-flags truth table: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
