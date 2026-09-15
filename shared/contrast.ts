/**
 * WCAG 2.1 relative luminance and contrast, used by the theme tests so an
 * unreadable colour combination fails the build rather than the show.
 */

export const AA_BODY_TEXT = 4.5;
/** Large text and non-text UI (borders, focus rings, icon shapes). */
export const AA_LARGE_TEXT = 3;

export interface Rgb {
  red: number;
  green: number;
  blue: number;
}

export function parseHexColour(value: string): Rgb {
  const hex = value.trim().replace(/^#/u, "");
  const expanded =
    hex.length === 3
      ? [...hex].map((character) => character + character).join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}$/u.test(expanded)) {
    throw new Error(`Not a six-digit hex colour: ${value}`);
  }
  return {
    red: Number.parseInt(expanded.slice(0, 2), 16),
    green: Number.parseInt(expanded.slice(2, 4), 16),
    blue: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

function channelLuminance(channel: number): number {
  const ratio = channel / 255;
  return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(colour: string): number {
  const { red, green, blue } = parseHexColour(colour);
  return (
    0.2126 * channelLuminance(red) +
    0.7152 * channelLuminance(green) +
    0.0722 * channelLuminance(blue)
  );
}

export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

export function meetsContrast(
  foreground: string,
  background: string,
  minimum: number = AA_BODY_TEXT,
): boolean {
  return contrastRatio(foreground, background) >= minimum;
}
