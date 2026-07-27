// Deterministic guards for pass-2 image-analysis cache and color decisions.
//
// bun tools/test-driver/functional/image-analysis-gate.functional.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(here, "../../../src/gjoa/toolkit/components/content-classifier/GjoaDarkmodeChild.sys.mjs"),
  "utf8"
);

function staticMethod(name) {
  const match = source.match(
    new RegExp(`static ${name}\\s*\\(([^)]*)\\)\\s*\\{\\s*return\\s*([\\s\\S]*?);\\s*\\}`)
  );
  if (!match) {
    throw new Error(`could not extract ${name}`);
  }
  return new Function(...match[1].split(",").map(arg => arg.trim()), `return (${match[2]});`);
}

const shouldCache = staticMethod("shouldCacheImageVerdict");
const isLimitedPaletteChromatic = staticMethod("isLimitedPaletteChromatic");
const shouldInvert = staticMethod("shouldInvertDarkTransparentImage");

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.log("FAIL:", message);
  }
};

// Falsifier: a streaming image must not be terminally cached before the one
// delayed rerun. The second analysis completes and then becomes cached.
const transient = [{ retry: true }, { isDark: true }];
let transientCache;
let transientCalls = 0;
for (let pass = 0; pass < 2; pass++) {
  const verdict = transientCache === undefined ? transient[transientCalls++] : transientCache;
  if (shouldCache(verdict)) transientCache = verdict;
}
ok(transientCalls === 2 && transientCache?.isDark === true, "incomplete then complete analyzes twice and caches only completion");

// A terminal CORS/canvas failure is cached by the first pass, so the delayed
// rerun reads the skip instead of retrying indefinitely.
let terminalCache;
let terminalCalls = 0;
for (let pass = 0; pass < 2; pass++) {
  const verdict = terminalCache === undefined ? (terminalCalls++, null) : terminalCache;
  if (shouldCache(verdict)) terminalCache = verdict;
}
ok(terminalCalls === 1 && terminalCache === null, "terminal failure is cached and bounded to one analysis");

// Falsifiers: bounded colorful palettes keep their semantics; neutral dark
// transparent glyphs retain the existing inversion path.
ok(isLimitedPaletteChromatic(6, 0.8, 0.8) === true, "chromatic limited-palette icon is protected");
ok(isLimitedPaletteChromatic(8, 0.1, 0.9) === false, "mostly neutral palette is not protected by saturation alone");
ok(shouldInvert(true, true, 24, true) === false, "semantic-color emote is not hue-inverted");
ok(shouldInvert(true, true, 24, false) === true, "dark neutral transparent asset remains eligible");

console.log(`image-analysis gate truth table: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
