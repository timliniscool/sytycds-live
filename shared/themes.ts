/**
 * Curated themes are defined as complete sets of *semantic* tokens. No
 * component is ever allowed to assume what a role looks like — "accent means a
 * white label" is exactly the assumption that made text unreadable — so every
 * pairing a component can draw has a named token for both halves.
 *
 * `test/themes.test.ts` asserts WCAG AA on the pairings listed in
 * `CONTRAST_REQUIREMENTS`; a theme that fails one of them fails the build.
 */

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
  /** The page ground. */
  background: string;
  /** A panel sitting on the ground. */
  surface: string;
  /** A panel sitting on a panel: menus, popovers, inset rows, inputs. */
  elevated: string;
  /** Primary body text on background, surface and elevated alike. */
  text: string;
  /** Secondary text; still readable, never decorative grey-on-grey. */
  muted: string;
  accent: string;
  /** Text and icons drawn on top of `accent`. */
  onAccent: string;
  accentHover: string;
  accentActive: string;
  /** A tinted accent wash for selected rows; carries `text`, not `onAccent`. */
  accentSoft: string;
  border: string;
  focus: string;
  /** Neutral surface hover/active for non-accent controls. */
  hover: string;
  active: string;
  success: string;
  onSuccess: string;
  warning: string;
  onWarning: string;
  danger: string;
  /** Text and icons drawn on top of `danger`. */
  onDanger: string;
  /** The ground of a disabled control. */
  disabled: string;
  /** Its label: deliberately readable, because unreadable is not "disabled". */
  onDisabled: string;
}

export interface CuratedTheme {
  id: ThemeId;
  name: string;
  /** Phones and the operator console. */
  web: ThemePalette;
  /** The hall: a darker ground and brighter ink for projection. */
  projector: ThemePalette;
}

/** Status colours are drawn as text on dark grounds and as fills under near-black. */
const DARK_STATUS = {
  success: "#4ee0a0",
  onSuccess: "#04120b",
  warning: "#f4a34f",
  onWarning: "#1c1003",
  danger: "#ff8b8b",
  onDanger: "#2a0407",
} as const;

const DARK_DISABLED = { disabled: "#1b262b", onDisabled: "#9fb1b8" } as const;

/**
 * Five of the seven themes share one dark chassis so a new accent cannot
 * quietly break a pairing; only the accent ramp differs.
 */
const dark = (
  id: ThemeId,
  name: string,
  accent: string,
  accentHover: string,
  accentSoft: string,
): CuratedTheme => ({
  id,
  name,
  web: {
    background: "#071014",
    surface: "#0d1b20",
    elevated: "#14262c",
    text: "#f3f7f8",
    muted: "#a9bcc1",
    accent,
    onAccent: "#04090b",
    accentHover,
    accentActive: accentHover,
    accentSoft,
    border: "#4a6a74",
    focus: accent,
    hover: "#16292f",
    active: "#1d353d",
    ...DARK_STATUS,
    ...DARK_DISABLED,
  },
  projector: {
    background: "#020506",
    surface: "#071014",
    elevated: "#0d1b20",
    text: "#ffffff",
    muted: "#c3d0d4",
    accent,
    onAccent: "#04090b",
    accentHover,
    accentActive: accentHover,
    accentSoft,
    border: "#4a6a74",
    focus: accent,
    hover: "#0d1b20",
    active: "#14262c",
    ...DARK_STATUS,
    ...DARK_DISABLED,
  },
});

export const CURATED_THEMES: readonly CuratedTheme[] = [
  {
    id: "gold-white",
    name: "Gold & White",
    web: {
      background: "#f7f3e8",
      surface: "#fffdf8",
      elevated: "#ffffff",
      text: "#17140f",
      muted: "#57503f",
      accent: "#6d4f14",
      onAccent: "#fffdf8",
      accentHover: "#8d651e",
      accentActive: "#4e380d",
      accentSoft: "#e8d6a6",
      border: "#8d8471",
      focus: "#6d4f14",
      hover: "#f0e4c2",
      active: "#dcc17c",
      success: "#0f6242",
      onSuccess: "#ffffff",
      warning: "#71440b",
      onWarning: "#ffffff",
      danger: "#a01b26",
      onDanger: "#ffffff",
      disabled: "#e6e0d2",
      onDisabled: "#57503f",
    },
    // The hall variant of a light theme is still dark: a white field at
    // projector size is glare, not brand.
    projector: {
      background: "#0d0b08",
      surface: "#17130d",
      elevated: "#211b11",
      text: "#fffaf0",
      muted: "#d6c9af",
      accent: "#e8c870",
      onAccent: "#1a1308",
      accentHover: "#f1d68d",
      accentActive: "#d2a84d",
      accentSoft: "#5e4a21",
      border: "#8a7551",
      focus: "#f1d68d",
      hover: "#302718",
      active: "#49391d",
      ...DARK_STATUS,
      disabled: "#2a2318",
      onDisabled: "#bfb094",
    },
  },
  {
    id: "navy-bismarck",
    name: "Navy Bismarck",
    web: {
      background: "#071a2b",
      surface: "#0d2436",
      elevated: "#123047",
      text: "#f3f7f9",
      muted: "#adc0c9",
      accent: "#8bb5c5",
      onAccent: "#04121c",
      accentHover: "#a9cfdb",
      accentActive: "#6f98a9",
      accentSoft: "#173b50",
      border: "#5b8296",
      focus: "#a9cfdb",
      hover: "#16374c",
      active: "#214c62",
      ...DARK_STATUS,
      disabled: "#153043",
      onDisabled: "#a3b6be",
    },
    projector: {
      background: "#030d16",
      surface: "#071a2b",
      elevated: "#0d2436",
      text: "#f8fbfc",
      muted: "#b6c8d0",
      accent: "#a9cfdb",
      onAccent: "#03111a",
      accentHover: "#c8e3eb",
      accentActive: "#8bb5c5",
      accentSoft: "#173b50",
      border: "#5b8296",
      focus: "#c8e3eb",
      hover: "#123047",
      active: "#214c62",
      ...DARK_STATUS,
      disabled: "#12293a",
      onDisabled: "#a3b6be",
    },
  },
  dark("electric-cyan", "Electric Cyan", "#31d9e6", "#6ee8f1", "#163f46"),
  dark("crimson", "Crimson", "#ff8f9c", "#ffb3bc", "#4b2028"),
  dark("emerald", "Emerald", "#3ddc97", "#77e9b7", "#173f31"),
  dark("royal-violet", "Royal Violet", "#bda6f0", "#d4c5f6", "#35294d"),
  dark("monochrome", "Monochrome", "#d8dde0", "#eef1f2", "#30383c"),
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

export interface ContrastRequirement {
  label: string;
  foreground: keyof ThemePalette;
  background: keyof ThemePalette;
  /** AA body text unless the pairing is only ever large or non-text. */
  minimum: "body" | "large";
}

/**
 * Every pairing a component is allowed to draw. A component that needs a new
 * pairing adds it here first, so every theme is checked against it.
 */
export const CONTRAST_REQUIREMENTS: readonly ContrastRequirement[] = [
  {
    label: "body text on page",
    foreground: "text",
    background: "background",
    minimum: "body",
  },
  {
    label: "body text on surface",
    foreground: "text",
    background: "surface",
    minimum: "body",
  },
  {
    label: "input text on input surface",
    foreground: "text",
    background: "elevated",
    minimum: "body",
  },
  {
    label: "secondary text on page",
    foreground: "muted",
    background: "background",
    minimum: "body",
  },
  {
    label: "secondary text on surface",
    foreground: "muted",
    background: "surface",
    minimum: "body",
  },
  {
    label: "button text on accent",
    foreground: "onAccent",
    background: "accent",
    minimum: "body",
  },
  {
    label: "button text on accent hover",
    foreground: "onAccent",
    background: "accentHover",
    minimum: "body",
  },
  {
    label: "button text on accent active",
    foreground: "onAccent",
    background: "accentActive",
    minimum: "body",
  },
  {
    label: "selected row text on accent wash",
    foreground: "text",
    background: "accentSoft",
    minimum: "body",
  },
  {
    label: "success text on surface",
    foreground: "success",
    background: "surface",
    minimum: "body",
  },
  {
    label: "warning text on surface",
    foreground: "warning",
    background: "surface",
    minimum: "body",
  },
  {
    label: "destructive text on surface",
    foreground: "danger",
    background: "surface",
    minimum: "body",
  },
  {
    label: "text on destructive fill",
    foreground: "onDanger",
    background: "danger",
    minimum: "body",
  },
  {
    label: "text on success fill",
    foreground: "onSuccess",
    background: "success",
    minimum: "body",
  },
  {
    label: "text on warning fill",
    foreground: "onWarning",
    background: "warning",
    minimum: "body",
  },
  {
    label: "disabled label on disabled control",
    foreground: "onDisabled",
    background: "disabled",
    minimum: "large",
  },
  {
    label: "accent on page",
    foreground: "accent",
    background: "background",
    minimum: "large",
  },
  {
    label: "border on surface",
    foreground: "border",
    background: "surface",
    minimum: "large",
  },
  {
    label: "focus ring on page",
    foreground: "focus",
    background: "background",
    minimum: "large",
  },
];
