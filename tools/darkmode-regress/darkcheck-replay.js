/* darkcheck-replay.js — OFFLINE gate replay (dev-loop-assessment §8 item 2, tier T2.5).
 *
 * Re-runs the A5 rule over STORED darkcheck records with no browser, no render, no model.
 * Answers rule/policy questions ("what if A5 exempted gamut-limited chroma collapse?") in
 * milliseconds instead of a 37-40 min corpus re-render.
 *
 * Usage:
 *   node darkcheck-replay.js <dir-or-file>...      # replay stored dumps
 *   node darkcheck-replay.js --selftest            # synthetic gamut-exemption discriminator
 *   DARKCHECK_A5_GAMUT_EXEMPT=1 node darkcheck-replay.js <dir>   # apply A5 gamut exemption
 *
 * Flag DARKCHECK_A5_GAMUT_EXEMPT (default OFF): OFF ⇒ pure no-op, reproduces stored verdicts
 * bit-identically. ON ⇒ applies the §6.1 gamut exemption to A5 offenders.
 *
 * SCOPE (honest): today's stored dumps are AUDIT output (rules/stats/OFFENDERS only, capped
 * at 60) — NOT per-node raw records. A5's inputs (authoredFg/renderedFg/renderedC/hueDrift)
 * live ON each stored offender, so the A5 gamut exemption is fully recomputable from OLD
 * dumps. Rules whose inputs are the painted glyph sample (A1/A2/A3/A4) are NOT recomputed
 * here — their stored verdicts pass through unchanged. New-format dumps carrying the raw
 * per-node records (darkcheck-collect §raw + a persisted node dump) would let replay
 * recompute the full pool for every rule; see report at bottom.
 */
import { createRequire } from "module";
import { fileURLToPath } from "url";
import * as pathMod from "path";
import * as fsMod from "fs";
const require = createRequire(import.meta.url);
const __dirname = pathMod.dirname(fileURLToPath(import.meta.url));
const rules = require("./darkcheck-rules.cjs");

const gamutExempt = process.env.DARKCHECK_A5_GAMUT_EXEMPT === "1";
const { cm, source } = rules.loadColormath(__dirname);
const gamutMaxC = rules.makeGamutMaxC(cm);
const cfg = {}; // rule constants default to audit's (hueTol 15, gamutFrac 0.9)

function replayPage(rec, slug) {
  const rlist = (rec.rules || []).slice();
  const a5idx = rlist.findIndex((r) => r.rule === "A5");
  let a5replay = null;
  if (a5idx >= 0) {
    a5replay = rules.replayA5(rlist[a5idx], cfg, cm, gamutMaxC, gamutExempt);
    rlist[a5idx] = { rule: "A5", pass: a5replay.pass, count: a5replay.count, offenders: a5replay.offenders };
  }
  const indet = rec.status === "indeterminate";
  const failedRules = rlist.filter((r) => !r.pass && !r.advisory).map((r) => r.rule);
  const pass = !indet && failedRules.length === 0;
  return { slug, status: rec.status, pass, failedRules, a5replay };
}

function loadDumps(targets) {
  const files = [];
  for (const t of targets) {
    const st = fsMod.statSync(t);
    if (st.isDirectory()) {
      for (const f of fsMod.readdirSync(t)) {
        if (f.endsWith(".json") && !f.endsWith("-rects.json") && f !== "rollup.json")
          files.push(pathMod.join(t, f));
      }
    } else files.push(t);
  }
  return files.sort();
}

function runReplay(targets) {
  const files = loadDumps(targets);
  console.log(`# darkcheck replay · oracle=${source} · A5_GAMUT_EXEMPT=${gamutExempt ? "ON" : "OFF"} · ${files.length} dumps`);
  let diffs = 0, flips = 0;
  for (const f of files) {
    let rec;
    try { rec = JSON.parse(fsMod.readFileSync(f, "utf8")); } catch (e) { continue; }
    if (!rec.rules && !rec.status) continue; // not a page dump
    const slug = rec.slug || pathMod.basename(f, ".json");
    const rp = replayPage(rec, slug);
    const storedFailed = (rec.failedRules || []).slice().sort();
    const newFailed = rp.failedRules.slice().sort();
    const identical = rec.pass === rp.pass && JSON.stringify(storedFailed) === JSON.stringify(newFailed);
    if (!identical) { diffs++; }
    const flipped = rp.a5replay && rp.a5replay.changed;
    if (flipped) flips++;
    const mark = identical ? "=" : "≠";
    let line = `${mark} ${slug.padEnd(28)} stored[pass=${rec.pass} ${JSON.stringify(storedFailed)}]  replay[pass=${rp.pass} ${JSON.stringify(newFailed)}]`;
    if (flipped) {
      const ex = rp.a5replay.exempted;
      line += `  A5:exempted ${ex.length}/${(rec.rules.find((r)=>r.rule==="A5")||{}).count} offenders`;
      if (rp.a5replay.capHidesMore) line += " (cap>stored: pass-flip withheld)";
    }
    console.log(line);
    if (flipped && rp.a5replay.exempted.length) {
      const s = rp.a5replay.exempted[0];
      console.log(`    e.g. ${JSON.stringify(s.renderedFg)} drift=${s.hueDriftDeg}° → ${s.exemptWhy}`);
    }
    if (flipped && rp.a5replay.offenders.length) {
      const k = rp.a5replay.offenders[0];
      console.log(`    still-fails ${JSON.stringify(k.renderedFg)} drift=${k.hueDriftDeg}° reason=${k.reason}`);
    }
  }
  console.log(`# ${gamutExempt ? "ON" : "OFF"}: ${diffs} pages differ from stored verdict, ${flips} pages had A5 exemptions applied`);
  return { diffs, flips };
}

// Synthetic discriminator: proves the rule flips a gamut-limited chroma-collapse to exempt
// while a genuine hue drift STILL FAILS — the two wave-2 blue-link records (§6.1/§6.2).
function selftest() {
  console.log("# darkcheck-replay --selftest · A5 gamut-exemption discriminator");
  const recs = [
    { name: "brendangregg chroma-collapse (hue-exact solve)", authoredFg: [0, 0, 170], renderedFg: [147, 183, 255], hueDriftDeg: 0.4, reason: "chroma-collapse" },
    { name: "bernsteinbear REAL hue drift (§6.2 residual-2 bug)", authoredFg: [0, 0, 238], renderedFg: [158, 158, 255], hueDriftDeg: 18.4, reason: "hue-drift" },
  ];
  let ok = true;
  for (const r of recs) {
    const v = rules.evalA5Exempt(r, cfg, cm, gamutMaxC);
    const verdict = v.exempt ? "EXEMPT (pass)" : "FAIL";
    console.log(`  ${r.name}`);
    console.log(`    ${JSON.stringify(r.renderedFg)} drift=${r.hueDriftDeg}° → ${verdict} · ${v.why}`);
    if (r.reason === "chroma-collapse" && !v.exempt) ok = false;
    if (r.reason === "hue-drift" && v.exempt) ok = false;
  }
  console.log(ok ? "# PASS: chroma-collapse exempts, real hue drift STILL FAILS" : "# FAIL: discriminator wrong");
  process.exit(ok ? 0 : 1);
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) selftest();
else if (args.length === 0) { console.error("usage: node darkcheck-replay.js <dir-or-file>... | --selftest"); process.exit(2); }
else runReplay(args);
