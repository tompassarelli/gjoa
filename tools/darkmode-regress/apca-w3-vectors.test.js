/* apca-w3-vectors.test.js — exact-value conformance of colormath.js `apca()` against
 * the PINNED apca-w3 v0.1.9, algorithm 0.0.98G-4g (chief-spec-apca.md §1 / DARKCHECK
 * §"Formula + provenance requirements"). This is the "measure == fix" gate: the audit
 * harness and the engine text-solve MUST share one canonical implementation, so drift
 * here is a hard stop.
 *
 * Two independent checks:
 *   (1) PUBLISHED VECTORS — exact float outputs from the apca-w3 reference suite
 *       (Myndex, algo 0.0.98G-4g). Full-precision equality (===), not approximate.
 *   (2) DIFFERENTIAL TRANSCRIPTION — an INDEPENDENT reimplementation of the pinned
 *       formula from the verbatim SA98G constants (chief-spec-apca.md §1a-1d), asserted
 *       equal to colormath.apca() across a wide input battery. Proves conformance over
 *       the whole domain, not just the anchor points, and is fully offline-reproducible.
 *
 * Run: bun test tools/darkmode-regress/apca-w3-vectors.test.js */
import { test, expect, describe } from "bun:test";
import { apca } from "./colormath.js";

/* ---- (1) published apca-w3 reference vectors (algo 0.0.98G-4g) ----
 * [text, bg, expectedLc]. Signed: reverse polarity (light-on-dark) is negative BY
 * DESIGN (apca-w3 src L183-185; chief-spec §1d) — polarity is load-bearing, never
 * abs() away the sign at the source. Values are the exact 64-bit floats the reference
 * emits. #888/#fff and #fff/#888 are from the published test suite; #000/#fff and
 * #fff/#000 are the canonical documented extremes (~±106/108). */
const PUBLISHED = [
  [[136, 136, 136], [255, 255, 255], 63.056469930209424],   // #888 on #fff  (BoW, normal)
  [[255, 255, 255], [136, 136, 136], -68.54146436644962],   // #fff on #888  (WoB, reverse)
  [[0, 0, 0], [255, 255, 255], 106.04067321268862],         // black on white — max normal
  [[255, 255, 255], [0, 0, 0], -107.88473318309848],        // white on black — max reverse
];

describe("apca-w3 published vectors (algo 0.0.98G-4g) — exact float", () => {
  for (const [t, b, exp] of PUBLISHED) {
    test(`apca(${t}, ${b}) === ${exp}`, () => {
      expect(apca(t, b)).toBe(exp); // strict === : zero tolerance, full 64-bit precision
    });
  }
});

/* ---- (2) independent transcription of the pinned SA98G formula ----
 * Reimplemented from chief-spec-apca.md §1 verbatim constants. NOT imported from
 * colormath — the point is that two independent transcriptions of the pin agree. */
function refApca(txt, bg) {
  const SA98G = {
    mainTRC: 2.4, sRco: 0.2126729, sGco: 0.7151522, sBco: 0.0721750,
    normBG: 0.56, normTXT: 0.57, revTXT: 0.62, revBG: 0.65,
    blkThrs: 0.022, blkClmp: 1.414, scaleBoW: 1.14, scaleWoB: 1.14,
    loBoWoffset: 0.027, loWoBoffset: 0.027, loClip: 0.1, deltaYmin: 0.0005,
  };
  const toY = (rgb) => {
    const s = (c) => Math.pow(c / 255.0, SA98G.mainTRC);
    return SA98G.sRco * s(rgb[0]) + SA98G.sGco * s(rgb[1]) + SA98G.sBco * s(rgb[2]);
  };
  let txtY = toY(txt), bgY = toY(bg);
  const soft = (Y) => (Y > SA98G.blkThrs ? Y : Y + Math.pow(SA98G.blkThrs - Y, SA98G.blkClmp));
  txtY = soft(txtY); bgY = soft(bgY);
  if (Math.abs(bgY - txtY) < SA98G.deltaYmin) return 0.0;
  let out;
  if (bgY > txtY) {
    const SAPC = (Math.pow(bgY, SA98G.normBG) - Math.pow(txtY, SA98G.normTXT)) * SA98G.scaleBoW;
    out = SAPC < SA98G.loClip ? 0.0 : SAPC - SA98G.loBoWoffset;
  } else {
    const SAPC = (Math.pow(bgY, SA98G.revBG) - Math.pow(txtY, SA98G.revTXT)) * SA98G.scaleWoB;
    out = SAPC > -SA98G.loClip ? 0.0 : SAPC + SA98G.loWoBoffset;
  }
  return out * 100.0;
}

describe("colormath.apca ≡ independent SA98G transcription over the input battery", () => {
  test("exact match across 0/64/128/192/255 grid + hue extremes (both polarities)", () => {
    const levels = [0, 8, 18, 34, 64, 100, 136, 170, 200, 235, 255];
    const hues = [
      [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255],
      [255, 0, 255], [40, 90, 220], [225, 64, 64], [18, 18, 18], [245, 245, 245],
    ];
    let n = 0;
    for (const g of levels) {
      const gray = [g, g, g];
      for (const h of hues) {
        expect(apca(gray, h)).toBe(refApca(gray, h)); // gray text on hue bg
        expect(apca(h, gray)).toBe(refApca(h, gray)); // hue text on gray bg
        n += 2;
      }
      for (const g2 of levels) {
        expect(apca([g, g, g], [g2, g2, g2])).toBe(refApca([g, g, g], [g2, g2, g2]));
        n++;
      }
    }
    expect(n).toBeGreaterThan(300); // battery actually exercised
  });

  test("reverse polarity returns negative Lc (dark-mode invariant, sign preserved)", () => {
    // light text on dark bg — our whole domain. Must be < 0 (never swap arg order).
    expect(apca([230, 230, 230], [20, 20, 20])).toBeLessThan(0);
    expect(apca([200, 210, 255], [12, 12, 16])).toBeLessThan(0);
    // dark text on light bg — positive
    expect(apca([20, 20, 20], [230, 230, 230])).toBeGreaterThan(0);
  });
});
