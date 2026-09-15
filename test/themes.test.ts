import { describe, expect, it } from "vitest";

import { CURATED_THEMES, THEME_IDS } from "../shared/themes";

function channel(value: number): number {
  const normalised = value / 255;
  return normalised <= 0.04045
    ? normalised / 12.92
    : ((normalised + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const rgb = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex);
  if (!rgb) throw new Error(`Invalid theme colour ${hex}`);
  return (
    channel(Number.parseInt(rgb[1]!, 16)) * 0.2126 +
    channel(Number.parseInt(rgb[2]!, 16)) * 0.7152 +
    channel(Number.parseInt(rgb[3]!, 16)) * 0.0722
  );
}

function contrast(first: string, second: string): number {
  const [bright, dark] = [luminance(first), luminance(second)].sort(
    (left, right) => right - left,
  );
  return (bright! + 0.05) / (dark! + 0.05);
}

describe("curated themes", () => {
  it("defines every advertised theme exactly once", () => {
    expect(CURATED_THEMES.map((theme) => theme.id)).toEqual(THEME_IDS);
    expect(new Set(CURATED_THEMES.map((theme) => theme.name)).size).toBe(
      CURATED_THEMES.length,
    );
  });

  it.each(CURATED_THEMES)(
    "keeps $name text readable on primary surfaces",
    (theme) => {
      for (const palette of [theme.web, theme.projector]) {
        expect(
          contrast(palette.text, palette.background),
        ).toBeGreaterThanOrEqual(4.5);
        expect(contrast(palette.text, palette.surface)).toBeGreaterThanOrEqual(
          4.5,
        );
        expect(
          contrast(palette.text, palette.strongSurface),
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
});
