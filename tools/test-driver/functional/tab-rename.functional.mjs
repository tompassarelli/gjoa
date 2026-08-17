// Regression guard for the tab-rename typing bug (owner 2026-07-20: "rename state
// activates, but then I can't type any additional letters").
//
//   bun tools/test-driver/functional/tab-rename.functional.mjs
//
// ROOT CAUSE: rename focuses an HTML `contenteditable` span INSIDE the XUL sidebar
// panel. The two capture-phase vim keydown handlers gate on
// `document.activeElement` being editable, but focusing that span leaves
// document.activeElement reading as the PANEL at handler-entry for a frame — so the
// "printable key while panel is focused → leave the panel to the page" path fired on
// the very first letter, yanked focus to content, and tore the rename down.
//
// FIX (immune to the focus-read race): a `vs.renaming` STATE flag — set while rename
// is active, cleared in finish — that BOTH capture handlers bail on. This locks that
// in at the source. The behavioural proof is tools/test-driver/tab-rename-live.py
// (cage: rename → type letters + vim keys → label stays focused + editable).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const bjs = readFileSync(join(root, "src/gjoa/chrome/bjs/tabs/vim.bjs"), "utf8");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

// start-rename raises the flag when it adds the gjoa-renaming class + contenteditable
const startIdx = bjs.indexOf('(js/call (js/get label .classList) .add "gjoa-renaming")');
ok(startIdx !== -1, "start-rename adds the gjoa-renaming class");
const startScope = bjs.slice(startIdx, startIdx + 1200);
ok(/\(js\/set!\s+vs\s+\.renaming\s+true\)/.test(startScope),
   "start-rename sets (js/set! vs .renaming true) when rename begins");

// finish clears it when it removes the class. The window is two lines at this
// nesting depth — the clear must sit beside the class removal, not merely
// somewhere in finish.
const finishIdx = bjs.indexOf('(js/call (js/get label .classList) .remove "gjoa-renaming")');
ok(finishIdx !== -1, "finish removes the gjoa-renaming class");
const finishScope = bjs.slice(finishIdx, finishIdx + 160);
ok(/\(js\/set!\s+vs\s+\.renaming\s+false\)/.test(finishScope),
   "finish clears (js/set! vs .renaming false) when rename ends");

// BOTH capture-phase document keydown handlers must bail while renaming.
const guards = bjs.match(/\(not \(js\/get vs \.renaming\)\)/g) || [];
ok(guards.length >= 2,
   `both vim capture keydown handlers guard on (not (js/get vs .renaming)) — found ${guards.length}, need >=2`);

// specifically: the setup-vim-keys handler's panel-active guard includes the renaming bail
ok(/\(js\/get vs \.panel-active\)\s*\(not \(js\/get vs \.renaming\)\)/.test(bjs),
   "setup-vim-keys handler bails on renaming (panel-active AND not renaming)");

console.log(`\ntab-rename invariants: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
