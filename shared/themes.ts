export const THEME_IDS = [
  "gold-white",
  "navy-bismarck",
  "electric-cyan",
  "crimson",
  "emerald",
  "royal-violet",
  "monochrome",
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export interface ThemePalette {
  background: string;
  surface: string;
  strongSurface: string;
  text: string;
  muted: string;
  accent: string;
  accentStrong: string;
  accentSoft: string;
  border: string;
  focus: string;
  hover: string;
  active: string;
  success: string;
  warning: string;
  danger: string;
  onAccent: string;
}

export interface CuratedTheme {
  id: ThemeId;
  name: string;
  web: ThemePalette;
  projector: ThemePalette;
}

const dark = (
  id: ThemeId,
  name: string,
  accent: string,
  accentStrong: string,
  accentSoft: string,
): CuratedTheme => ({
  id,
  name,
  web: {
    background: "#071014",
    surface: "#0d1b20",
    strongSurface: "#14262c",
    text: "#f3f7f8",
    muted: "#9babb0",
    accent,
    accentStrong,
    accentSoft,
    border: "#294047",
    focus: accent,
    hover: accentSoft,
    active: accentStrong,
    success: "#4ee0a0",
    warning: "#f4a34f",
    danger: "#f05d5e",
    onAccent: "#071014",
  },
  projector: {
    background: "#020506",
    surface: "#071014",
    strongSurface: "#0d1b20",
    text: "#ffffff",
    muted: "#b7c4c8",
    accent,
    accentStrong,
    accentSoft,
    border: "#294047",
    focus: accent,
    hover: accentSoft,
    active: accentStrong,
    success: "#4ee0a0",
    warning: "#f4a34f",
    danger: "#f05d5e",
    onAccent: "#020506",
  },
});

export const CURATED_THEMES: readonly CuratedTheme[] = [
  {
    id: "gold-white",
    name: "Gold & White",
    web: {
      background: "#f7f3e8",
      surface: "#fffdf8",
      strongSurface: "#ffffff",
      text: "#17140f",
      muted: "#6d6558",
      accent: "#b8892d",
      accentStrong: "#8d651e",
      accentSoft: "#e8d6a6",
      border: "#d9cfbc",
      focus: "#8d651e",
      hover: "#f0e4c2",
      active: "#dcc17c",
      success: "#1f7a53",
      warning: "#8a5700",
      danger: "#b4232e",
      onAccent: "#17140f",
    },
    projector: {
      background: "#0d0b08",
      surface: "#17130d",
      strongSurface: "#211b11",
      text: "#fffaf0",
      muted: "#cfc2a8",
      accent: "#d2a84d",
      accentStrong: "#b8892d",
      accentSoft: "#5e4a21",
      border: "#57482e",
      focus: "#e8c870",
      hover: "#302718",
      active: "#49391d",
      success: "#4ee0a0",
      warning: "#f4a34f",
      danger: "#f05d5e",
      onAccent: "#0d0b08",
    },
  },
  {
    id: "navy-bismarck",
    name: "Navy Bismarck",
    web: {
      background: "#071a2b",
      surface: "#0d2436",
      strongSurface: "#123047",
      text: "#f3f7f9",
      muted: "#a3b6be",
      accent: "#497183",
      accentStrong: "#6f98a9",
      accentSoft: "#173b50",
      border: "#234354",
      focus: "#8bb5c5",
      hover: "#16374c",
      active: "#214c62",
      success: "#4ee0a0",
      warning: "#f4a34f",
      danger: "#f05d5e",
      onAccent: "#071a2b",
    },
    projector: {
      background: "#030d16",
      surface: "#071a2b",
      strongSurface: "#0d2436",
      text: "#f8fbfc",
      muted: "#a3b6be",
      accent: "#6f98a9",
      accentStrong: "#8bb5c5",
      accentSoft: "#173b50",
      border: "#234354",
      focus: "#a9cfdb",
      hover: "#123047",
      active: "#214c62",
      success: "#4ee0a0",
      warning: "#f4a34f",
      danger: "#f05d5e",
      onAccent: "#030d16",
    },
  },
  dark("electric-cyan", "Electric Cyan", "#31d9e6", "#10aebc", "#163f46"),
  dark("crimson", "Crimson", "#e55364", "#b92e41", "#4b2028"),
  dark("emerald", "Emerald", "#3ddc97", "#159663", "#173f31"),
  dark("royal-violet", "Royal Violet", "#a786e8", "#7958bd", "#35294d"),
  dark("monochrome", "Monochrome", "#d8dde0", "#9da7ac", "#30383c"),
] as const;

export const DEFAULT_THEME_ID: ThemeId = "navy-bismarck";

export function isThemeId(value: unknown): value is ThemeId {
  return (
    typeof value === "string" &&
    (THEME_IDS as readonly string[]).includes(value)
  );
}

export function themeById(id: ThemeId): CuratedTheme {
  return CURATED_THEMES.find((theme) => theme.id === id) ?? CURATED_THEMES[1]!;
}
