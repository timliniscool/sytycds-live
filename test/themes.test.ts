import { describe, expect, it } from "vitest";

import {
  AA_BODY_TEXT,
  AA_LARGE_TEXT,
  contrastRatio,
  parseHexColour,
} from "../shared/contrast";
import {
  CONTRAST_REQUIREMENTS,
  CURATED_THEMES,
  THEME_IDS,
  type ThemePalette,
} from "../shared/themes";

const PALETTE_TOKENS: readonly (keyof ThemePalette)[] = [
  "background",
  "surface",
  "elevated",
  "text",
  "muted",
  "accent",
  "onAccent",
  "accentHover",
  "accentActive",
  "accentSoft",
  "border",
  "focus",
  "hover",
  "active",
  "success",
  "onSuccess",
  "warning",
  "onWarning",
  "danger",
  "onDanger",
  "disabled",
  "onDisabled",
];

describe("curated themes", () => {
  it("defines every advertised theme exactly once", () => {
    expect(CURATED_THEMES.map((theme) => theme.id)).toEqual(THEME_IDS);
    expect(new Set(CURATED_THEMES.map((theme) => theme.name)).size).toBe(
      CURATED_THEMES.length,
    );
  });

  it("keeps the curated themes the show was designed around", () => {
    const byId = new Map(CURATED_THEMES.map((theme) => [theme.id, theme.name]));
    expect(byId.get("gold-white")).toBe("Gold & White");
    expect(byId.get("navy-bismarck")).toBe("Navy Bismarck");
  });

  it.each(CURATED_THEMES)(
    "$name defines every semantic token for web and projector",
    (theme) => {
      for (const palette of [theme.web, theme.projector]) {
        for (const token of PALETTE_TOKENS) {
          expect(() => parseHexColour(palette[token])).not.toThrow();
        }
      }
    },
  );
});

describe("theme contrast", () => {
  const cases = CURATED_THEMES.flatMap((theme) =>
    (["web", "projector"] as const).flatMap((surface) =>
      CONTRAST_REQUIREMENTS.map((requirement) => ({
        theme: theme.name,
        surface,
        requirement,
        palette: theme[surface],
      })),
    ),
  );

  it.each(cases)(
    "$theme ($surface): $requirement.label",
    ({ requirement, palette }) => {
      const minimum =
        requirement.minimum === "body" ? AA_BODY_TEXT : AA_LARGE_TEXT;
      const ratio = contrastRatio(
        palette[requirement.foreground],
        palette[requirement.background],
      );
      expect(
        Number(ratio.toFixed(2)),
        `${palette[requirement.foreground]} on ${palette[requirement.background]}`,
      ).toBeGreaterThanOrEqual(minimum);
    },
  );
});
