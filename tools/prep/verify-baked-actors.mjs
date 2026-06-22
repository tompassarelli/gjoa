#!/usr/bin/env bun
// Post-build smoke check (#139): every actor registered in patches/0008
// EXTRA_JS_MODULES must actually appear in a built omni.ja. "Registered != baked"
// — the v0.4.1 checkpoint build silently dropped GjoaInput* (the vim editable-
// focus foundation) from a transient shared-worktree snapshot while baking the
// rest, which would have shipped a vim-broken binary. This gates the bake.
//
//   bun tools/prep/verify-baked-actors.mjs [result-dir]   # default ./result
//
// Exit 1 if any registered .sys.mjs is absent from every omni.ja; exit 0 (skip)
// if there is no build to check.

import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const REPO = process.cwd();
const PATCH = join(REPO, "patches", "0008-content-classifier-cosmetic-filtering.patch");
const RESULT = process.argv[2] || join(REPO, "result");

// the .sys.mjs names ADDED to the EXTRA_JS_MODULES list by patch 0008 (the `+`
// lines inside the `EXTRA_JS_MODULES += [ ... ]` block).
function registeredModules() {
  const src = readFileSync(PATCH, "utf8");
  const out = [];
  let inBlock = false;
  for (const line of src.split("\n")) {
    if (/EXTRA_JS_MODULES\s*\+=/.test(line)) inBlock = true;
    else if (inBlock) {
      const m = line.match(/^\+\s*"([\w.-]+\.sys\.mjs)"/);
      if (m) out.push(m[1]);
      if (/\]/.test(line)) inBlock = false;
    }
  }
  return [...new Set(out)];
}

function omniPaths() {
  return ["lib/gjoa/omni.ja", "lib/gjoa/browser/omni.ja"]
    .map((p) => join(RESULT, p)).filter(existsSync);
}

function bakedSet(paths) {
  const baked = new Set();
  for (const o of paths) {
    const listing = execSync(`unzip -l "${o}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    for (const line of listing.split("\n")) {
      const m = line.match(/([\w.-]+\.sys\.mjs)\s*$/);
      if (m) baked.add(m[1]);
    }
  }
  return baked;
}

function main() {
  const registered = registeredModules();
  const paths = omniPaths();
  if (!paths.length) {
    console.log(`verify-baked-actors: no omni.ja under ${RESULT} — build first (skipped)`);
    process.exit(0);
  }
  const baked = bakedSet(paths);
  const missing = registered.filter((m) => !baked.has(m));
  console.log(`verify-baked-actors: ${registered.length} registered (patches/0008 EXTRA_JS_MODULES), ${registered.length - missing.length} baked, checking ${paths.length} omni.ja`);
  for (const m of registered) console.log(`  ${baked.has(m) ? "✓" : "✗ MISSING"}  ${m}`);
  if (missing.length) {
    console.error(`\n  ${missing.length} registered actor(s) NOT in any omni.ja: ${missing.join(", ")}`);
    console.error("  the build dropped them (likely a stale/transient source snapshot) — re-import + rebuild from a clean committed state, then re-check.");
    process.exit(1);
  }
  console.log("  all registered actors baked ✓");
}
main();
