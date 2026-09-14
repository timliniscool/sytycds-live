import { isRecord } from "../shared/trust";

const CATALOG_TTL_SECONDS = 24 * 60 * 60;

export interface FontCatalogueEntry {
  family: string;
  category: string;
  variants: readonly string[];
}

function apiKey(env: object): string | null {
  const value = (env as Record<string, unknown>).GOOGLE_FONTS_API_KEY;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseCatalogue(value: unknown): FontCatalogueEntry[] | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const entries: FontCatalogueEntry[] = [];
  for (const item of value.items) {
    if (
      !isRecord(item) ||
      typeof item.family !== "string" ||
      typeof item.category !== "string" ||
      !Array.isArray(item.variants) ||
      !item.variants.every((variant) => typeof variant === "string")
    )
      continue;
    entries.push({
      family: item.family,
      category: item.category,
      variants: item.variants,
    });
  }
  return entries;
}

async function cachedCatalogue(
  env: object,
): Promise<FontCatalogueEntry[] | null> {
  const key = apiKey(env);
  if (!key) return null;
  const cacheRequest = new Request(
    "https://sytycds.invalid/cache/google-fonts-catalogue",
  );
  let cache: Cache | null = null;
  try {
    cache =
      (caches as CacheStorage & { default?: Cache }).default ??
      (await caches.open("google-fonts-catalogue"));
    const cached = await cache.match(cacheRequest);
    if (cached) return parseCatalogue(await cached.json());
  } catch {
    // Cache API may be unavailable in a local test runtime; the API remains usable.
  }
  const response = await fetch(
    `https://www.googleapis.com/webfonts/v1/webfonts?sort=popularity&key=${encodeURIComponent(key)}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) return null;
  const body: unknown = await response.json();
  const parsed = parseCatalogue(body);
  if (!parsed) return null;
  try {
    await cache?.put(
      cacheRequest,
      Response.json(body, {
        headers: { "Cache-Control": `public, max-age=${CATALOG_TTL_SECONDS}` },
      }),
    );
  } catch {
    // The current request can still succeed without the optional edge cache.
  }
  return parsed;
}

export async function searchGoogleFonts(
  env: object,
  query: string,
  limit: number,
): Promise<
  { ok: true; fonts: FontCatalogueEntry[] } | { ok: false; error: string }
> {
  const catalogue = await cachedCatalogue(env).catch(() => null);
  if (!catalogue)
    return {
      ok: false,
      error: "Google Fonts catalogue is temporarily unavailable",
    };
  const needle = query.trim().toLocaleLowerCase();
  const fonts = (
    needle
      ? catalogue.filter((entry) =>
          entry.family.toLocaleLowerCase().includes(needle),
        )
      : catalogue
  ).slice(0, Math.min(Math.max(limit, 1), 50));
  return { ok: true, fonts };
}
