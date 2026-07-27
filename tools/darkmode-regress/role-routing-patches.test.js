import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { apcaBand, correctA2 } from "./colormath.cjs";

const patch12 = readFileSync(
  new URL("../../patches/0012-dark-mode-role-resolver.patch", import.meta.url),
  "utf8",
);
const patch13 = readFileSync(
  new URL("../../patches/0013-dark-mode-text-solve.patch", import.meta.url),
  "utf8",
);

const STRUCTURAL_FLOOR = 30;
const STRUCTURAL_CEILING = 60;

function resolveStructuralMark(color, backdrop, { inverted, opaque = true }) {
  if (!inverted || !opaque) {
    return color;
  }
  return correctA2(
    color,
    backdrop,
    STRUCTURAL_FLOOR,
    STRUCTURAL_CEILING,
    true,
  );
}

describe("native Border and Selection role routing", () => {
  test("the shared resolver owns both roles behind the master inversion gate", () => {
    expect(patch12).toContain("+    Border,");
    expect(patch12).toContain("+    Selection,");

    const gate = patch12.indexOf("!aFrame->PresContext()->ColorInversion()");
    const borderPolicy = patch12.indexOf("aRole == ColorRole::Border");
    const selectionPolicy = patch12.indexOf("aRole == ColorRole::Selection");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(borderPolicy);
    expect(gate).toBeLessThan(selectionPolicy);
    expect(patch12).toContain(
      "+    return GjoaDarkText::Correct(aColor, aBackdrop, 30.0f, 60.0f, true);",
    );
  });

  test("solid border paint resolves through ColorRole::Border", () => {
    expect(patch12).toContain(
      "+    borderColors[i] = nsLayoutUtils::ResolveDarkModeRole(",
    );
    expect(patch12).toContain(
      "+        nsLayoutUtils::ColorRole::Border);",
    );
  });

  test("native selection keeps authored early returns and scheme-aware contrast ordering", () => {
    const nativeSelection = patch12.indexOf(
      "+    mSelectionBGColor = nsLayoutUtils::ResolveDarkModeRole(",
    );
    const existingContrast = patch12.lastIndexOf(
      "EnsureSufficientContrast(&mSelectionTextColor, &mSelectionBGColor);",
      nativeSelection,
    );
    expect(nativeSelection).toBeGreaterThan(existingContrast);
    expect(patch12).toContain(
      "+        mFrame, mSelectionBGColor, nsLayoutUtils::ColorRole::Selection);",
    );
    expect(patch12).toContain(
      "+        mFrame, mSelectionTextColor, nsLayoutUtils::ColorRole::Text,",
    );
    expect(patch12).toContain(
      "+    // Authored ::selection colors return above unchanged. Native selection",
    );
  });
});

describe("bounded structural-mark behavior", () => {
  const backdrop = [18, 18, 18];

  test("master switch off is byte-identity", () => {
    const color = [35, 35, 35];
    expect(
      resolveStructuralMark(color, backdrop, { inverted: false }),
    ).toBe(color);
  });

  test("translucent structural marks are left authored", () => {
    const color = [35, 35, 35];
    expect(
      resolveStructuralMark(color, backdrop, {
        inverted: true,
        opaque: false,
      }),
    ).toBe(color);
  });

  test("low contrast is raised and high contrast is capped inside [30, 60]", () => {
    for (const color of [
      [35, 35, 35],
      [255, 255, 255],
    ]) {
      const corrected = resolveStructuralMark(color, backdrop, {
        inverted: true,
      });
      expect(
        apcaBand(
          corrected,
          backdrop,
          STRUCTURAL_FLOOR,
          STRUCTURAL_CEILING,
        ).inBand,
      ).toBe(true);
    }
  });
});

describe("0013 is pinned to the modified 0012 postimage", () => {
  test("dependent nsTextPaintStyle and moz.build hunks carry exact full indexes", () => {
    expect(patch13).toContain(
      "index 269d3bc02de88b870d4d5ee383f02ca1b04d8dfa..a6aefccefc9cce1755220f6fa7231b71da979cb7 100644",
    );
    expect(patch13).toContain(
      "index a0b95f0470cc661ad5316768cb637dadc9c8e449..fdbd8b364fa18f7044c02f45c426b6f34d61082e 100644",
    );
  });
});
