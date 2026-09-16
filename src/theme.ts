import { useEffect } from "react";
import {
  DEFAULT_THEME_ID,
  isThemeId,
  themeById,
  type ThemeId,
} from "../shared/themes";
import type { ActAppearance } from "../shared/domain";

export function applyShowTheme(
  themeId: unknown,
  fontFamily: string | undefined,
  projector = false,
): void {
  const theme = themeById(isThemeId(themeId) ? themeId : DEFAULT_THEME_ID);
  const palette = projector ? theme.projector : theme.web;
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  // Every semantic token reaches CSS. A component that needs a colour uses the
  // token for its role; it never hard-codes one, and never assumes what sits
  // on top of another (an accent button's label is `--theme-on-accent`).
  const properties = {
    "--theme-background": palette.background,
    "--theme-surface": palette.surface,
    "--theme-elevated": palette.elevated,
    "--theme-text": palette.text,
    "--theme-muted": palette.muted,
    "--theme-accent": palette.accent,
    "--theme-on-accent": palette.onAccent,
    "--theme-accent-hover": palette.accentHover,
    "--theme-accent-active": palette.accentActive,
    "--theme-accent-soft": palette.accentSoft,
    "--theme-border": palette.border,
    "--theme-focus": palette.focus,
    "--theme-hover": palette.hover,
    "--theme-active": palette.active,
    "--theme-success": palette.success,
    "--theme-on-success": palette.onSuccess,
    "--theme-warning": palette.warning,
    "--theme-on-warning": palette.onWarning,
    "--theme-danger": palette.danger,
    "--theme-on-danger": palette.onDanger,
    "--theme-disabled": palette.disabled,
    "--theme-on-disabled": palette.onDisabled,
  } as const;
  for (const [name, value] of Object.entries(properties))
    root.style.setProperty(name, value);
  // The browser's own chrome (address bar, overscroll) follows the theme too.
  root.style.colorScheme = isLightColour(palette.background) ? "light" : "dark";
  let meta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = palette.background;
  root.style.setProperty(
    "--theme-font",
    fontFamily && fontFamily !== "system-ui"
      ? `"${fontFamily.replaceAll('"', "")}", system-ui, sans-serif`
      : "system-ui, sans-serif",
  );
}

/**
 * The theme and typeface a public surface draws the current act in: the act's
 * own override where it has one, otherwise the show's. The operator console
 * never follows an act override; it stays in the show's own theme so the
 * console does not change colour under the operator mid-show.
 */
/** Relative luminance of a #rrggbb colour, enough to pick a colour scheme. */
function isLightColour(hex: string): boolean {
  const match = /^#?([0-9a-f]{6})$/iu.exec(hex.trim());
  if (!match) return false;
  const value = Number.parseInt(match[1]!, 16);
  const channel = (shift: number) => ((value >> shift) & 0xff) / 255;
  const luminance =
    0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance > 0.5;
}

export function effectiveAppearance(
  show: { themeId: ThemeId; fontFamily: string },
  act: { appearance: ActAppearance } | null | undefined,
): { themeId: ThemeId; fontFamily: string } {
  return {
    themeId: act?.appearance.themeId ?? show.themeId,
    fontFamily: act?.appearance.fontFamily ?? show.fontFamily,
  };
}

export function useShowTheme(
  themeId: unknown,
  fontFamily: string | undefined,
  projector = false,
): void {
  useEffect(() => {
    applyShowTheme(themeId, fontFamily, projector);
    let fontLink = document.querySelector<HTMLLinkElement>(
      "link[data-sytycds-font]",
    );
    if (fontFamily && fontFamily !== "system-ui") {
      if (!fontLink) {
        fontLink = document.createElement("link");
        fontLink.rel = "stylesheet";
        fontLink.dataset.sytycdsFont = "";
        document.head.append(fontLink);
      }
      fontLink.href = `/api/font/selected.css?family=${encodeURIComponent(fontFamily)}`;
    } else fontLink?.remove();
  }, [themeId, fontFamily, projector]);
}

export function useShowDocumentTitle(
  eventTitle: string | undefined,
  surface: string,
): void {
  useEffect(() => {
    document.title = eventTitle
      ? `${surface} · ${eventTitle}`
      : `${surface} · SYTYCDS Live`;
  }, [eventTitle, surface]);
}
