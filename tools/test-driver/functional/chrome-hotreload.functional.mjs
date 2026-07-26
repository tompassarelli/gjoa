// Enforcement gate for the dev live-reload guarantee (owner 2026-07-19: "a running
// browser can NEVER hold a stale chrome bundle, by construction").
//
//   bun tools/test-driver/functional/chrome-hotreload.functional.mjs
//
// The guarantee has three load-bearing parts; if any is broken a recompile stops
// propagating into a running browser and we're back to testing ghosts. This is the
// fast source-invariant check; the behavioural proof is chrome-hotreload-live.py
// (cage: edit → recompile → running browser reflects it in <1s).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

// (1) on1! macro auto-registers window-unload handlers into __gjoaHR — the by-construction
//     coverage (every bundle's main teardown IS its unload handler, so nothing to forget).
const macros = readFileSync(join(root, "src/gjoa/chrome/bjs/macros.bjs"), "utf8");
const on1 = macros.slice(macros.indexOf("(defmacro on1!"), macros.indexOf("(defmacro on1!") + 400);
ok(/__gjoaHR/.test(on1), "on1! macro registers window-unload handlers into __gjoaHR [the guarantee]");
ok(/"unload"/.test(on1) && /\.push/.test(on1), "on1! guards on \"unload\" and pushes the handler");

// (2) No bundle bypasses on1! with a raw addEventListener(\"unload\") — that would escape
//     the registry and leave stale state on live-reload.
const bjsDir = join(root, "src/gjoa/chrome/bjs");
function walk(d, acc = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".bjs")) acc.push(p);
  }
  return acc;
}
for (const f of walk(bjsDir)) {
  if (f.endsWith("macros.bjs")) continue;
  const src = readFileSync(f, "utf8").replace(/;;[^\n]*/g, "");
  const raw = /addEventListener[^)]*["']unload["']/.test(src);
  ok(!raw, `${f.slice(root.length + 1)} uses on1! (not raw addEventListener unload) so its teardown auto-registers`);
}

// (3) The loader has the stamp-watch + hot-reload machinery.
const loader = readFileSync(join(root, "src/gjoa/browser/components/gjoa/GjoaLoader.bjs"), "utf8");
ok(/\.bundle-stamp/.test(loader), "loader watches .bundle-stamp");
ok(/start-dev-watch/.test(loader) && /setInterval/.test(loader), "loader polls for bundle changes");
ok(/hot-reload/.test(loader) && /unregister-sheets/.test(loader), "loader hot-reloads (teardown + css drop + re-run)");

// (4) chrome:dist writes the stamp.
const dist = readFileSync(join(root, "tools/chrome-bundle/dist.bjs"), "utf8");
ok(/\.bundle-stamp/.test(dist) && /CryptoHasher/.test(dist), "chrome:dist writes a content stamp");

// (5) If a compiled dist exists, every bundle with an unload listener must reference __gjoaHR.
const distJs = join(root, "dist/chrome/JS");
if (existsSync(distJs)) {
  for (const name of readdirSync(distJs)) {
    if (!name.endsWith(".uc.js")) continue;
    const b = readFileSync(join(distJs, name), "utf8");
    if (/addEventListener\([^)]*["']unload["']/.test(b) || /"unload"/.test(b)) {
      ok(/__gjoaHR/.test(b), `compiled ${name} registers a hot-reload teardown (__gjoaHR)`);
    }
  }
}

console.log(`\nchrome-hotreload invariants: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
