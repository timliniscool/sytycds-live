import { useEffect } from "react";
import { DEFAULT_THEME_ID, isThemeId, themeById } from "../shared/themes";

export function useShowTheme(
  themeId: unknown,
  fontFamily: string | undefined,
  projector = false,
): void {
  useEffect(() => {
    const theme = themeById(isThemeId(themeId) ? themeId : DEFAULT_THEME_ID);
    const palette = projector ? theme.projector : theme.web;
    const root = document.documentElement;
    root.dataset.theme = theme.id;
    root.style.setProperty("--theme-background", palette.background);
    root.style.setProperty("--theme-surface", palette.surface);
    root.style.setProperty("--theme-surface-strong", palette.strongSurface);
    root.style.setProperty("--theme-text", palette.text);
    root.style.setProperty("--theme-muted", palette.muted);
    root.style.setProperty("--theme-accent", palette.accent);
    root.style.setProperty("--theme-accent-strong", palette.accentStrong);
    root.style.setProperty("--theme-accent-soft", palette.accentSoft);
    root.style.setProperty("--theme-border", palette.border);
    root.style.setProperty("--theme-focus", palette.focus);
    root.style.setProperty("--theme-hover", palette.hover);
    root.style.setProperty("--theme-active", palette.active);
    root.style.setProperty("--theme-success", palette.success);
    root.style.setProperty("--theme-warning", palette.warning);
    root.style.setProperty("--theme-danger", palette.danger);
    root.style.setProperty("--theme-on-accent", palette.onAccent);
    root.style.setProperty(
      "--theme-font",
      fontFamily && fontFamily !== "system-ui"
        ? `"${fontFamily.replaceAll('"', "")}", system-ui, sans-serif`
        : "system-ui, sans-serif",
    );
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
