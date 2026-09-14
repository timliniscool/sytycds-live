/*
 * Projector media service worker.
 *
 * One job: answer GET /api/media/:id from the CacheStorage cache the projector
 * page fills, including the Range requests a <video> or <audio> element makes,
 * so an already-prepared file keeps playing through a Wi-Fi outage. Nothing
 * else is intercepted: API responses, admin and judge traffic pass straight to
 * the network and are never cached here. The page decides what is cached; this
 * worker never adds to the cache on its own.
 */

const CACHE_NAME = "sytycds-media";
const MEDIA_PREFIX = "/api/media/";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    !url.pathname.startsWith(MEDIA_PREFIX)
  ) {
    return;
  }
  event.respondWith(serveMedia(event.request, url));
});

/**
 * @param {Request} request
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function serveMedia(request, url) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(url.pathname);
  if (!cached) {
    return fetch(request);
  }
  const blob = await cached.blob();
  const headers = new Headers();
  headers.set(
    "Content-Type",
    cached.headers.get("Content-Type") || "application/octet-stream",
  );
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "no-store");
  headers.set("X-SYTYCDS-Cache", "hit");
  const range = parseRange(request.headers.get("Range"), blob.size);
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${blob.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (!range) {
    headers.set("Content-Length", String(blob.size));
    return new Response(blob, { status: 200, headers });
  }
  const part = blob.slice(range.start, range.end + 1);
  headers.set("Content-Length", String(part.size));
  headers.set(
    "Content-Range",
    `bytes ${range.start}-${range.end}/${blob.size}`,
  );
  return new Response(part, { status: 206, headers });
}

/**
 * Single-range parsing only; multipart ranges are never requested by media
 * elements.
 * @param {string | null} header
 * @param {number} size
 * @returns {{ start: number, end: number } | null | "invalid"}
 */
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";
  const startText = match[1];
  const endText = match[2];
  if (startText === "" && endText === "") return "invalid";
  if (startText === "") {
    const suffix = Number(endText);
    if (suffix <= 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  if (start >= size) return "invalid";
  const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
  if (end < start) return "invalid";
  return { start, end };
}
