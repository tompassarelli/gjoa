/* Regression guard for the "reddit vanishing comment text" bug (2026-07-17).
 *
 * SYMPTOM: on Reddit (a native-dark site — the engine does NOT invert it), legible
 * light comment/post text turned dark-on-dark after ~15s / on scroll and became
 * unreadable.
 *
 * ROOT CAUSE: the contrast normalizer's backdrop-aware retone (GjoaDarkmodeParent
 * #normalize) darkens a run whose SAMPLED backdrop reads light. On a native-dark,
 * color-scheme-declaring page a scroll/idle re-pass can sample a bright adjacent
 * element (image/thumbnail) for a text rect that actually sits on dark, OR an
 * ancestor serializes an authored-light var via getComputedStyle while the engine
 * paints it dark. Either way the retone flips legible LIGHT text to black -> the run
 * vanishes on the real dark backdrop.
 *
 * FIX / INVARIANT (mirrored by GjoaDarkmodeParent._decideCorrectiveDarkens + the
 * `!inverted` gate at both _correct call sites): on a page the engine is NOT
 * inverting, the normalizer may only LIGHTEN a run, NEVER DARKEN it — the site owns
 * its text colors, so any corrective that lowers OKLCH lightness there is a
 * mis-sample and must be dropped. Darkening polarity is kept only on inverted pages
 * (engine-inverted labels on preserved-light pills).
 *
 * These are PURE assertions on the same math the actor runs (colormath is the
 * canonical operator the actor mirrors). Run: bun test tools/darkmode-regress/normalize-guard.test.js
 */
import { test, expect, describe } from "bun:test";
import { apca, srgbToOklch } from "./colormath.js";

// OKLCH lightness of an sRGB triple — the actor's _oklchL, via the canonical module.
const oklchL = (rgb) => srgbToOklch(rgb)[0];

// The actor's _correct(fg,bg): neutral max-contrast polarity for the backdrop —
// white on a dark backdrop, black on a light one.
const neutralCorrect = (bg) =>
  Math.abs(apca([255, 255, 255], bg)) >= Math.abs(apca([0, 0, 0], bg))
    ? [255, 255, 255]
    : [0, 0, 0];

// The actor's _decideCorrectiveDarkens: does the corrective lower the run's L?
const wouldDarken = (corrective, fg) => oklchL(corrective) < oklchL(fg);

// The full guarded decision the actor makes at each _correct site: on native-dark
// (!inverted) a darkening corrective is DROPPED (returns null = keep the run as-is).
const guardedCorrective = (fg, bg, inverted) => {
  const c = neutralCorrect(bg);
  if (!inverted && wouldDarken(c, fg)) return null; // never darken on native-dark
  return c;
};

// Reddit's actual light comment/post text (near-white neutral) and the mis-sampled
// LIGHT backdrop a racing re-pass reads for it.
const LIGHT_TEXT = [215, 218, 220]; // reddit comment text
const MISSAMPLED_LIGHT_BG = [200, 200, 200]; // bright image/thumbnail sampled by mistake
const REAL_DARK_BG = [12, 12, 14]; // what the text actually sits on
const TRULY_DARK_TEXT = [40, 40, 44]; // a genuinely too-dark run that SHOULD be lightened

describe("normalizer never-darken-on-native-dark guard (reddit vanishing text)", () => {
  test("REPRO: light text + mis-sampled light backdrop would retone to black", () => {
    // This is the raw failure the guard exists to stop: without the guard the actor
    // pushes this black corrective onto legible light text.
    const raw = neutralCorrect(MISSAMPLED_LIGHT_BG);
    expect(raw).toEqual([0, 0, 0]);
    expect(wouldDarken(raw, LIGHT_TEXT)).toBe(true);
  });

  test("native-dark: light text on a mis-sampled light backdrop is NOT darkened", () => {
    // The core fix: on a page the engine is not inverting, drop the darkening retone.
    expect(guardedCorrective(LIGHT_TEXT, MISSAMPLED_LIGHT_BG, /*inverted*/ false)).toBeNull();
  });

  test("native-dark: a genuinely too-dark run is still LIGHTENED (guard only blocks darkening)", () => {
    const c = guardedCorrective(TRULY_DARK_TEXT, REAL_DARK_BG, false);
    expect(c).not.toBeNull();
    expect(oklchL(c)).toBeGreaterThan(oklchL(TRULY_DARK_TEXT)); // lifted, not dropped
    expect(c).toEqual([255, 255, 255]);
  });

  test("native-dark: light text on a truly dark backdrop is left alone (already legible)", () => {
    // High contrast already — the actor skips it before _correct even runs; assert the
    // polarity math agrees it would only ever LIGHTEN here, never darken.
    const c = neutralCorrect(REAL_DARK_BG);
    expect(wouldDarken(c, LIGHT_TEXT)).toBe(false);
  });

  test("inverted page: darkening polarity is preserved (engine-inverted label on a light pill)", () => {
    // On an inverted page a light label over a preserved-light pill legitimately needs
    // black — the guard must NOT block that.
    expect(guardedCorrective(LIGHT_TEXT, MISSAMPLED_LIGHT_BG, /*inverted*/ true)).toEqual([0, 0, 0]);
  });
});
