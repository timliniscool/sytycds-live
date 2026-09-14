import type {
  MediaCacheSummary,
  MediaManifestEntry,
} from "../../shared/domain";

const MEDIA_CACHE_NAME = "sytycds-media";

/** The one URL scheme for media bytes; the service worker matches on it too. */
export function assetUrl(assetId: string): string {
  return `/api/media/${encodeURIComponent(assetId)}`;
}
const VERSION_HEADER = "X-SYTYCDS-Version";

export interface CachedEntry {
  id: string;
  version: string;
}

export interface CachePlan {
  /** Manifest entries with no matching cached version, in manifest order. */
  fetch: MediaManifestEntry[];
  /** Cached asset IDs that are gone from the manifest or have a stale version. */
  remove: string[];
}

/**
 * Pure planning: what to download and what to drop, given what the cache
 * already holds. A changed R2 version is a different file and is refetched;
 * an asset no cue references any more is removed so the quota goes to the
 * show that is actually on tonight.
 */
export function planCacheWork(
  manifest: readonly MediaManifestEntry[],
  cached: readonly CachedEntry[],
): CachePlan {
  const wanted = new Map(manifest.map((entry) => [entry.id, entry]));
  const have = new Map(cached.map((entry) => [entry.id, entry.version]));
  return {
    fetch: manifest.filter((entry) => have.get(entry.id) !== entry.version),
    remove: cached
      .filter((entry) => wanted.get(entry.id)?.version !== entry.version)
      .map((entry) => entry.id),
  };
}

export function summariseCache(
  manifest: readonly MediaManifestEntry[],
  cachedIds: ReadonlySet<string>,
  failedIds: ReadonlySet<string>,
  partialBytes: number,
  persisted: boolean | null,
  error: string | null,
): MediaCacheSummary {
  let bytes = 0;
  let cachedBytes = 0;
  for (const entry of manifest) {
    bytes += entry.sizeBytes;
    if (cachedIds.has(entry.id)) cachedBytes += entry.sizeBytes;
  }
  return {
    files: manifest.length,
    cached: manifest.filter((entry) => cachedIds.has(entry.id)).length,
    failed: manifest.filter((entry) => failedIds.has(entry.id)).length,
    bytes,
    cachedBytes: cachedBytes + partialBytes,
    persisted,
    error,
  };
}

function isQuotaError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "QuotaExceededError") ||
    (error instanceof Error && /quota/iu.test(error.message))
  );
}

/**
 * Fills the CacheStorage cache the media service worker serves from. One sync
 * runs at a time; a manifest that changes mid-sync is picked up by the next
 * pass, and every file is fetched at most once per version.
 */
export class MediaCache {
  private manifest: readonly MediaManifestEntry[] = [];
  private readonly cachedIds = new Set<string>();
  private readonly failedIds = new Set<string>();
  private partialBytes = 0;
  private persisted: boolean | null = null;
  private error: string | null = null;
  private running: Promise<void> | null = null;
  private dirty = false;
  private disposed = false;

  constructor(
    private readonly onProgress: (summary: MediaCacheSummary) => void,
  ) {}

  static available(): boolean {
    return typeof caches !== "undefined" && typeof caches.open === "function";
  }

  summary(): MediaCacheSummary {
    return summariseCache(
      this.manifest,
      this.cachedIds,
      this.failedIds,
      this.partialBytes,
      this.persisted,
      this.error,
    );
  }

  /** Reconcile the cache with a manifest; safe to call on every snapshot. */
  sync(manifest: readonly MediaManifestEntry[]): Promise<void> {
    this.manifest = manifest;
    this.dirty = true;
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  dispose(): void {
    this.disposed = true;
  }

  private async drain(): Promise<void> {
    while (this.dirty && !this.disposed) {
      this.dirty = false;
      await this.pass();
    }
  }

  private async pass(): Promise<void> {
    if (!MediaCache.available()) {
      this.error =
        "This browser has no CacheStorage; media plays from the network only.";
      this.emit();
      return;
    }
    if (this.persisted === null && navigator.storage?.persist) {
      // Persistent storage protects the show's files from the browser's own
      // eviction under pressure; the answer is reported, never assumed.
      this.persisted = await navigator.storage.persist().catch(() => false);
    }
    const cache = await caches.open(MEDIA_CACHE_NAME);
    const existing = await this.inventory(cache);
    const plan = planCacheWork(this.manifest, existing);
    for (const id of plan.remove) {
      await cache.delete(assetUrl(id));
      this.cachedIds.delete(id);
    }
    for (const entry of existing) {
      if (!plan.remove.includes(entry.id)) this.cachedIds.add(entry.id);
    }
    this.error = null;
    this.emit();
    for (const entry of plan.fetch) {
      if (this.disposed) return;
      await this.download(cache, entry);
      this.emit();
    }
  }

  private async inventory(cache: Cache): Promise<CachedEntry[]> {
    const entries: CachedEntry[] = [];
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      const id = decodeURIComponent(
        new URL(request.url).pathname.replace("/api/media/", ""),
      );
      const version = response?.headers.get(VERSION_HEADER);
      if (version) entries.push({ id, version });
      else await cache.delete(request);
    }
    return entries;
  }

  /** Streams one file, verifies its length, then stores it under its version. */
  private async download(
    cache: Cache,
    entry: MediaManifestEntry,
  ): Promise<void> {
    this.partialBytes = 0;
    try {
      const response = await fetch(assetUrl(entry.id), {
        // Bypass the HTTP cache so the version check is against R2, and keep
        // the service worker out of its own download loop.
        cache: "no-store",
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      // One branch streams straight into the cache, the other counts bytes,
      // so a large video never sits in page memory in full.
      const [toCache, toCount] = response.body.tee();
      const stored = cache.put(
        assetUrl(entry.id),
        new Response(toCache, {
          headers: {
            "Content-Type": entry.mimeType,
            "Content-Length": String(entry.sizeBytes),
            [VERSION_HEADER]: entry.version,
          },
        }),
      );
      const reader = toCount.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.partialBytes += value.byteLength;
        this.emit();
      }
      await stored;
      if (this.partialBytes !== entry.sizeBytes) {
        await cache.delete(assetUrl(entry.id));
        throw new Error(
          `received ${this.partialBytes} of ${entry.sizeBytes} bytes`,
        );
      }
      // Verify the write actually landed before counting it as prepared.
      const written = await cache.match(assetUrl(entry.id));
      if (written?.headers.get(VERSION_HEADER) !== entry.version) {
        throw new Error("cache write could not be read back");
      }
      this.cachedIds.add(entry.id);
      this.failedIds.delete(entry.id);
    } catch (error: unknown) {
      this.failedIds.add(entry.id);
      if (isQuotaError(error)) {
        const estimate = await navigator.storage
          ?.estimate?.()
          .catch(() => null);
        const quota = estimate?.quota
          ? ` (${Math.round(estimate.quota / 1_048_576)} MB available to this site)`
          : "";
        this.error = `Insufficient storage for show media${quota}. Free space on the projector or use a different browser profile.`;
      } else {
        this.error = `${entry.id.slice(0, 14)}…: ${error instanceof Error ? error.message : "download failed"}`;
      }
    } finally {
      this.partialBytes = 0;
    }
  }

  private emit(): void {
    if (!this.disposed) this.onProgress(this.summary());
  }
}
