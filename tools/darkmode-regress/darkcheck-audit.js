/* darkcheck-audit.js — DARKCHECK v1 Channel A, CHROME-context auditor
 * (Marionette executeAsyncScript). drawSnapshot the viewport, evaluate the A-rules with
 * ZERO model calls, emit PASS/FAIL per rule + offending nodes.
 *
 * MEASUREMENT GROUND TRUTH = PAINTED PIXELS. gjoa's dark-mode text solve runs at PAINT
 * time (M3, nsTextPaintStyle::GetTextColor), AFTER getComputedStyle, so computed `color`
 * is M3-BLIND. Per node: median-luminance backdrop + the glyph extreme furthest from it,
 * then APCA(glyph, bg). Computed role/size/geometry drive CLASSIFICATION + floors; the
 * CONTRAST number comes from paint. If the glyph is < ~5% of the rect the sample can miss
 * it (glyph≈bg, |Lc|≈0) — a false unreadable — so on |paintedLc|<5 we fall back to the
 * computed fg vs painted bg (recovers sampling misses without hiding true dark-on-dark).
 *
 * AUTHORED ARM (arg[2], engine-off collect): engine-off computed style IS the authored
 * value. nativeDark = authored root dark ⇒ gjoa PASSED THE PAGE THROUGH, so the transform
 * -quality floors (A1/A2/A4/A6) do NOT apply (they'd test the site's own native design,
 * which DR also leaves alone) — A7 passthrough-integrity governs instead. Authored also
 * grounds A5 (hue drift) and A8 (scrim polarity).
 *
 * C2 validity: a page with too few measured text nodes (bot-wall / interstitial /
 * under-render) is QUARANTINED (status=indeterminate) — excluded from the denominator,
 * never silently passed (chief C2 / axe-core "incomplete").
 *
 * args: [meta, config, authored]. Color math (apca, srgbToOklch, Ys) from colormath.js,
 * PREPENDED by the runner. resolves { rules, stats, status } or { err }. */
const done = arguments[arguments.length - 1];
const meta = arguments[0];
const cfg = arguments[1] || {};
const authored = arguments[2] || null;

const F = {
  body: cfg.bodyFloor != null ? cfg.bodyFloor : 75,
  heading: 60, headingLarge: 45, link: 75, control: 60, placeholder: 30, disabled: 30,
  ceiling: cfg.ceiling != null ? cfg.ceiling : 90,
  islandArea: cfg.islandArea != null ? cfg.islandArea : 28000,
  islandL: cfg.islandL != null ? cfg.islandL : 0.5,
  controlBgL: cfg.controlBgL != null ? cfg.controlBgL : 0.35,
  controlNeutralC: cfg.controlNeutralC != null ? cfg.controlNeutralC : 0.08, // A4 exempts brand-colored controls
  linkDeltaLc: cfg.linkDeltaLc != null ? cfg.linkDeltaLc : 15,
  hueTol: cfg.hueTol != null ? cfg.hueTol : 15,       // A5 |Δhue|° tolerance
  chromaKeep: cfg.chromaKeep != null ? cfg.chromaKeep : 0.5, // A5 C_rendered ≥ 0.5·C_authored
  minSamples: 6,
  minEls: cfg.minEls != null ? cfg.minEls : 5,        // C2: fewer measured text els ⇒ quarantine
};
const oklchL = (rgb) => srgbToOklch(rgb)[0];
const oklchC = (rgb) => srgbToOklch(rgb)[1];
const relLum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
const hueDeg = (a, b) => {
  const ca = srgbToOklch(a), cb = srgbToOklch(b);
  if (ca[1] < 0.02 || cb[1] < 0.02) return 0; // achromatic → hue undefined
  let d = Math.abs(ca[2] - cb[2]) * 180 / Math.PI;
  if (d > 180) d = 360 - d;
  return d;
};
const isLargeText = (el) => (el.fontPx >= 36 && el.fontWeight < 700) || (el.fontPx >= 24 && el.fontWeight >= 700) || el.fontPx >= 24;
const floorFor = (el) => {
  switch (el.role) {
    case "body": return F.body;
    case "heading": { const vl = (el.fontPx >= 36 && el.fontWeight < 700) || (el.fontPx >= 24 && el.fontWeight >= 700); return vl ? F.headingLarge : F.heading; }
    case "link": return F.link;
    case "control": return F.control;
    case "placeholder": case "disabled": return F.disabled;
    default: return F.body;
  }
};

// nativeDark: authored (engine-off) root BACKGROUND is actually dark ⇒ the site renders
// its own dark theme, gjoa passed it through (A7). The `inverted` probe can't see this,
// and color-scheme MUST NOT be used — `color-scheme: light dark` (dark-CAPABLE but
// currently light) would falsely flag a white page as native (the zdnet bug). Only the
// real authored root luminance is trustworthy.
const nativeDark = !!(authored && authored.rootBgL != null && authored.rootBgL < 56);
// authored lookup by signature (tag|text-prefix)
const authMap = {};
if (authored && authored.els) for (const a of authored.els) if (!authMap[a.sig]) authMap[a.sig] = a;

(async () => {
  try {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const b = win.gBrowser.selectedBrowser;
    const wg = b.browsingContext.currentWindowGlobal;
    const W = meta.w, H = meta.h;
    const bitmap = await wg.drawSnapshot(new win.DOMRect(0, 0, W, H), 1, "rgb(0,0,0)");
    const canvas = new win.OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, W, H).data;
    const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
    const sampleRect = (r) => {
      const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
      const x1 = Math.min(W - 1, r.x + r.w), y1 = Math.min(H - 1, r.y + r.h);
      if (x1 <= x0 || y1 <= y0) return null;
      const sx = Math.max(1, Math.floor((x1 - x0) / 16)), sy = Math.max(1, Math.floor((y1 - y0) / 8));
      const s = [];
      for (let y = y0; y <= y1; y += sy) for (let x = x0; x <= x1; x += sx) s.push(px(x, y));
      if (s.length < F.minSamples) return null;
      s.sort((a, c) => Ys(a) - Ys(c));
      return s;
    };
    const painted = (r) => {
      const s = sampleRect(r);
      if (!s) return null;
      const bg = s[Math.floor(s.length / 2)];
      const lo = s[Math.floor(s.length * 0.05)];
      const hi = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
      const glyph = (Ys(hi) - Ys(bg)) >= (Ys(bg) - Ys(lo)) ? hi : lo;
      return { glyph, bg };
    };

    const sel = (el) => `[data-gjoa-dc="${el.dc}"]`;
    const selS = (s) => `[data-gjoa-dcs="${s.sc}"]`;
    const rules = [];
    const add = (rule, offenders, note, extra) => rules.push(Object.assign(
      { rule, pass: offenders.length === 0, offenders: offenders.slice(0, 60), count: offenders.length, note }, extra || {}));
    const skip = (rule, note) => rules.push({ rule, pass: true, offenders: [], count: 0, skipped: true, note });

    // measure every text node from paint (with computed fallback on sampling miss)
    const textEls = meta.els;
    let measured = 0, tooSmall = 0;
    for (const el of textEls) {
      const p = painted(el);
      if (!p) { el._skip = true; tooSmall++; continue; }
      el._glyph = p.glyph; el._pbg = p.bg;
      let lc = apca(p.glyph, p.bg);
      if (Math.abs(lc) < 5) { // sampling likely missed a sparse glyph → trust computed fg
        const clc = apca(el.fg, p.bg);
        if (Math.abs(clc) > Math.abs(lc)) { lc = clc; el._usedComputed = true; }
      }
      el._lc = lc; el._alc = Math.abs(lc); measured++;
    }

    // ---- C2 validity: under-rendered page ⇒ quarantine (never silent-pass) ----
    if (measured < F.minEls) {
      done({ status: "indeterminate", rules: [], stats: {
        textEls: textEls.length, measured, tooSmall, surfaces: meta.surfaces.length, replaced: meta.replaced.length,
        rootDark: meta.rootDark, rootBgL: meta.rootBgL, nativeDark, colorSchemeDark: meta.colorSchemeDark,
        reason: "under-rendered (bot-wall/interstitial/lazy): measured " + measured + " < " + F.minEls + " text nodes",
      } });
      return;
    }

    // A page that rendered NON-dark while NOT being authored-native-dark did not get
    // darkened at all — a coverage gap, not a text-floor problem. Report it as its own
    // status instead of spamming A1 with nonsensical dark-floor fails on a light page.
    if (!meta.rootDark && !nativeDark) {
      done({ status: "undarkened", rules: [{ rule: "A7", pass: false, offenders: [{ reason: "page rendered NON-dark and is not authored-native-dark — gjoa did not darken it", renderedRootBgL: meta.rootBgL, authoredRootBgL: authored ? authored.rootBgL : null }], count: 1, note: "coverage gap: page not darkened" }],
        stats: { textEls: textEls.length, measured, tooSmall, surfaces: meta.surfaces.length, replaced: meta.replaced.length, rootDark: meta.rootDark, rootBgL: meta.rootBgL, nativeDark, authoredRootBgL: authored ? authored.rootBgL : null } });
      return;
    }

    const passthrough = nativeDark; // native-dark ⇒ floors are inapplicable (A7 governs)
    // body |Lc| distribution — grounds the tolerance ledger (what do good/bad pages land at)
    const bodyAlc = textEls.filter((e) => !e._skip && (e.role === "body" || e.role === "heading" || e.role === "link")).map((e) => e._alc).sort((a, c) => a - c);
    const pct = (p) => bodyAlc.length ? Math.round(bodyAlc[Math.min(bodyAlc.length - 1, Math.floor(bodyAlc.length * p))]) : null;
    const bodyLcDist = { n: bodyAlc.length, p10: pct(0.1), p25: pct(0.25), p50: pct(0.5), p75: pct(0.75), p90: pct(0.9), min: bodyAlc.length ? Math.round(bodyAlc[0]) : null, max: bodyAlc.length ? Math.round(bodyAlc[bodyAlc.length - 1]) : null };

    // ---- A1 floors (hard) + A1-halation (advisory) ----
    if (passthrough) skip("A1", "SKIPPED: native-dark passthrough (A7 governs; transform floors N/A)");
    else {
      const a1 = [], hal = [];
      for (const el of textEls) {
        if (el._skip) continue;
        const floor = floorFor(el);
        if (el._alc < floor) a1.push({ selector: sel(el), role: el.role, tag: el.tag, paintedGlyph: el._glyph, paintedBg: el._pbg, computedFg: el.fg, usedComputed: !!el._usedComputed, Lc: Math.round(el._lc), floor, reason: "below-floor", fontPx: el.fontPx, weight: el.fontWeight, text: el.text });
        if (isLargeText(el) && el._alc > F.ceiling) hal.push({ selector: sel(el), role: el.role, tag: el.tag, Lc: Math.round(el._lc), ceiling: F.ceiling, reason: "above-halation-ceiling", fontPx: el.fontPx, text: el.text });
      }
      if (cfg.ceilingGates) for (const h of hal) a1.push(h);
      add("A1", a1, "per-role |Lc| floors (hard, PAINTED): body 75 / heading 60(45 lg) / link 75 / control 60 / placeholder+disabled 30");
      add("A1-halation", hal, "large text |Lc|>90 (WhyAPCA halation); ADVISORY pending chief ledger sign-off", { advisory: !cfg.ceilingGates });
    }

    // ---- A2 polarity (dark surface, transform pages only) ----
    if (passthrough) skip("A2", "SKIPPED: native-dark passthrough");
    else if (!meta.rootDark) skip("A2", "SKIPPED: page root not dark");
    else {
      const a2 = [];
      for (const el of textEls) {
        if (el._skip) continue;
        if (el._lc >= 0) a2.push({ selector: sel(el), role: el.role, tag: el.tag, paintedGlyph: el._glyph, paintedBg: el._pbg, Lc: Math.round(el._lc), reason: el._lc === 0 ? "unmeasurable-0.0" : "wrong-polarity(dark-on-dark/light-remnant)", text: el.text });
      }
      add("A2", a2, "text on dark page must read light-on-dark (signed painted Lc<0)");
    }

    // ---- A3 bright-island (applies on ANY dark page incl. native — a bright island is a defect regardless) ----
    if (!meta.rootDark) skip("A3", "SKIPPED: page root not dark");
    else {
      const a3 = [];
      for (const s of meta.surfaces) {
        if (s.area < F.islandArea) continue;
        const smp = sampleRect(s);
        if (!smp) continue;
        const bg = smp[Math.floor(smp.length / 2)];
        const L = oklchL(bg);
        if (L > F.islandL) a3.push({ selector: selS(s), tag: s.tag, paintedBg: bg, oklchL: +L.toFixed(3), area: s.area, floor: F.islandL, reason: "bright-surface-on-dark-page", text: s.text });
      }
      add("A3", a3, `no surface ≥${F.islandArea}px² with painted OKLCH L>${F.islandL} on a dark page`);
    }

    // ---- A4 control affordance (transform pages; brand-colored controls exempt from bright-bg) ----
    if (passthrough) skip("A4", "SKIPPED: native-dark passthrough");
    else if (!meta.rootDark) skip("A4", "SKIPPED: page root not dark");
    else {
      const a4 = [];
      for (const el of textEls) {
        if (el._skip || (el.role !== "control" && el.role !== "placeholder")) continue;
        const smp = sampleRect(el);
        const cbg = smp ? smp[Math.floor(smp.length / 2)] : el._pbg;
        if (cbg && oklchL(cbg) > F.controlBgL && oklchC(cbg) < F.controlNeutralC) a4.push({ selector: sel(el), tag: el.tag, paintedBg: cbg, oklchL: +oklchL(cbg).toFixed(3), oklchC: +oklchC(cbg).toFixed(3), floor: F.controlBgL, reason: "bright-neutral-control-surface", text: el.text });
        else if (el._alc < F.control) a4.push({ selector: sel(el), tag: el.tag, paintedGlyph: el._glyph, paintedBg: el._pbg, Lc: Math.round(el._lc), floor: F.control, reason: "control-label-unreadable", text: el.text });
      }
      add("A4", a4, "control painted bg OKLCH L≤0.35 (neutral only; brand-colored exempt) AND label |Lc|≥60");
    }

    // ---- A5 brand-hue preservation (needs authored arm) ----
    if (!authored) skip("A5", "SKIPPED: no authored arm");
    else if (passthrough) skip("A5", "SKIPPED: native-dark passthrough (authored≡rendered)");
    else {
      const a5 = [];
      for (const el of textEls) {
        if (el._skip) continue;
        const a = authMap[el.sig]; if (!a || !a.fg) continue;
        const Ca = oklchC(a.fg);
        if (Ca <= 0.08) continue; // only chromatic authored colors carry brand identity
        if (el._alc < floorFor(el)) continue; // legibility beats identity (failed A1 already reported)
        const dh = hueDeg(a.fg, el.fg);
        const Cr = oklchC(el.fg);
        if (dh > F.hueTol || Cr < F.chromaKeep * Ca) a5.push({ selector: sel(el), tag: el.tag, authoredFg: a.fg, renderedFg: el.fg, hueDriftDeg: +dh.toFixed(1), authoredC: +Ca.toFixed(3), renderedC: +Cr.toFixed(3), hueTol: F.hueTol, reason: dh > F.hueTol ? "hue-drift" : "chroma-collapse", text: el.text });
      }
      add("A5", a5, `authored chromatic colors: |Δhue|≤${F.hueTol}° AND C_rendered≥${F.chromaKeep}·C_authored (GJOA-chosen brand tolerance; calibrated Wave S)`);
    }

    // ---- A7 native-dark passthrough integrity ----
    if (!authored) skip("A7", "SKIPPED: no authored arm");
    else if (!nativeDark) skip("A7", "SKIPPED: page not authored-native-dark");
    else {
      // the page ships dark; gjoa must NOT have re-lightened it (double-invert / white flash).
      const a7 = [];
      if (!meta.rootDark) a7.push({ reason: "native-dark page rendered NON-dark (double-invert / passthrough broken)", authoredRootBgL: authored.rootBgL, renderedRootBgL: meta.rootBgL });
      add("A7", a7, "authored-native-dark page must stay dark end-to-end (no re-inversion / flash)");
    }

    // ---- A8 scrim/overlay polarity (needs authored arm; darkening overlay may not lighten) ----
    if (!authored) skip("A8", "SKIPPED: no authored arm");
    else {
      const a8 = [];
      for (const el of textEls) {
        if (el._skip) continue;
        const a = authMap[el.sig]; if (!a) continue;
        if (!(a.ownBgAlpha != null && a.ownBgAlpha < 1 && a.ownBg)) continue; // authored translucent overlay
        if (!el.ownBg) continue;
        const la = relLum(a.ownBg), lr = relLum(el.ownBg);
        if (lr > la + 8) a8.push({ selector: sel(el), tag: el.tag, authoredOverlay: a.ownBg, authoredAlpha: a.ownBgAlpha, renderedOverlay: el.ownBg, authoredLum: Math.round(la), renderedLum: Math.round(lr), reason: "darkening-overlay-lightened", text: el.text });
      }
      add("A8", a8, "authored translucent overlays (alpha<1) must not render lighter than authored (a scrim may only darken)");
    }

    done({
      status: "audited", rules,
      stats: {
        textEls: textEls.length, measured, tooSmall, surfaces: meta.surfaces.length, replaced: meta.replaced.length,
        rootDark: meta.rootDark, rootBgL: meta.rootBgL, nativeDark, passthrough,
        colorSchemeDark: meta.colorSchemeDark, authoredRootBgL: authored ? authored.rootBgL : null,
        bodyLcDist, normalizedSignal: meta.normalizedSignal != null ? meta.normalizedSignal : null,
      },
    });
  } catch (e) { done({ err: String((e && e.message) || e), stack: String(e && e.stack || "") }); }
})();
