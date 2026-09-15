import { useEffect } from "react";
import { DEFAULT_THEME_ID, isThemeId, themeById } from "../shared/themes";

export function applyShowTheme(
  themeId: unknown,
  fontFamily: string | undefined,
  projector = false,
): void {
  const theme = themeById(isThemeId(themeId) ? themeId : DEFAULT_THEME_ID);
  const palette = projector ? theme.projector : theme.web;
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  const properties = {
    "--theme-background": palette.background,
    "--theme-surface": palette.surface,
    "--theme-surface-strong": palette.strongSurface,
    "--theme-text": palette.text,
    "--theme-muted": palette.muted,
    "--theme-accent": palette.accent,
    "--theme-accent-strong": palette.accentStrong,
    "--theme-accent-soft": palette.accentSoft,
    "--theme-border": palette.border,
    "--theme-focus": palette.focus,
    "--theme-hover": palette.hover,
    "--theme-active": palette.active,
    "--theme-success": palette.success,
    "--theme-warning": palette.warning,
    "--theme-danger": palette.danger,
    "--theme-on-accent": palette.onAccent,
  } as const;
  for (const [name, value] of Object.entries(properties))
    root.style.setProperty(name, value);
  root.style.setProperty(
    "--theme-font",
    fontFamily && fontFamily !== "system-ui"
      ? `"${fontFamily.replaceAll('"', "")}", system-ui, sans-serif`
      : "system-ui, sans-serif",
  );
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
      fontLink.href = `/api/font/selected.css?v=${encodeURIComponent(fontFamily)}`;
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
