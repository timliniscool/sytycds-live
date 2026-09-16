const FONT_WEIGHTS = "400;500;600;700";

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function cacheSelectedFont(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  family: string,
): Promise<boolean> {
  if (family === "system-ui") return true;
  if (
    storage.sql
      .exec<{ present: number }>(
        "SELECT 1 AS present FROM selected_font_css WHERE family = ?",
        family,
      )
      .toArray().length > 0
  )
    return true;
  const response = await fetch(
    `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${FONT_WEIGHTS}&display=swap`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/130 Safari/537.36",
      },
    },
  );
  if (!response.ok) return false;
  let css = await response.text();
  const urls = [
    ...new Set(
      [...css.matchAll(/url\((https:\/\/[^)]+)\)/gu)].map((match) => match[1]!),
    ),
  ];
  const replacements = new Map<string, string>();
  for (const url of urls) {
    const font = await fetch(url);
    if (!font.ok) return false;
    const bytes = await font.arrayBuffer();
    const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
    const id = `font-${digest}`;
    const objectKey = `fonts/${digest}.woff2`;
    await bucket.put(objectKey, bytes, {
      httpMetadata: {
        contentType: "font/woff2",
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
    storage.sql.exec(
      `INSERT OR IGNORE INTO font_assets
        (id, family, object_key, mime_type, size_bytes, created_at)
       VALUES (?, ?, ?, 'font/woff2', ?, ?)`,
      id,
      family,
      objectKey,
      bytes.byteLength,
      new Date().toISOString(),
    );
    replacements.set(url, `/api/font/${id}`);
  }
  for (const [source, target] of replacements)
    css = css.replaceAll(source, target);
  storage.sql.exec(
    `INSERT INTO selected_font_css (family, css_text, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(family) DO UPDATE SET css_text=excluded.css_text, updated_at=excluded.updated_at`,
    family,
    css,
    new Date().toISOString(),
  );
  return true;
}

/** Whether a typeface has already been cached, and may therefore be selected. */
export function isFontCached(sql: SqlStorage, family: string): boolean {
  return (
    family === "system-ui" ||
    sql
      .exec<{ present: number }>(
        "SELECT 1 AS present FROM selected_font_css WHERE family = ?",
        family,
      )
      .toArray().length > 0
  );
}

/** Every cached family, so an act override can only choose what exists. */
export function listCachedFonts(sql: SqlStorage): string[] {
  return sql
    .exec<{ family: string }>(
      "SELECT family FROM selected_font_css ORDER BY family",
    )
    .toArray()
    .map((row) => row.family);
}

/**
 * Serves the CSS for one cached family: the requested one when a client names
 * it (an act override), otherwise the show's own selection.
 */
export function serveSelectedFontCss(
  sql: SqlStorage,
  showIdentifier: string,
  requestedFamily: string | null = null,
): Response {
  const family =
    requestedFamily && requestedFamily.length <= 120
      ? requestedFamily
      : sql
          .exec<{ font_family: string }>(
            "SELECT font_family FROM shows WHERE id = ?",
            showIdentifier,
          )
          .toArray()[0]?.font_family;
  const css = family
    ? sql
        .exec<{ css_text: string }>(
          "SELECT css_text FROM selected_font_css WHERE family = ?",
          family,
        )
        .toArray()[0]?.css_text
    : null;
  return new Response(css ?? "", {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": css ? "public, max-age=3600" : "no-store",
    },
  });
}

export async function serveFontAsset(
  sql: SqlStorage,
  bucket: R2Bucket,
  id: string,
  request: Request,
): Promise<Response> {
  const cacheKey = new Request(request.url, { method: "GET" });
  let cache: Cache | null = null;
  try {
    cache =
      (caches as CacheStorage & { default?: Cache }).default ??
      (await caches.open("selected-font-assets"));
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  } catch {
    // Local runtimes may omit CacheStorage; R2 remains the durable source.
  }
  const row = sql
    .exec<{ object_key: string; mime_type: string; size_bytes: number }>(
      "SELECT object_key, mime_type, size_bytes FROM font_assets WHERE id = ?",
      id,
    )
    .toArray()[0];
  if (!row) return new Response(null, { status: 404 });
  const object = await bucket.get(row.object_key);
  if (!object || !("body" in object))
    return new Response(null, { status: 404 });
  const response = new Response(object.body, {
    headers: {
      "Content-Type": row.mime_type,
      "Content-Length": String(row.size_bytes),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
  try {
    await cache?.put(cacheKey, response.clone());
  } catch {
    // A cache failure must not prevent the selected font from loading.
  }
  return response;
}
