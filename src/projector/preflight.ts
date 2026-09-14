import type {
  PreflightAssetRequest,
  ProjectorPreflightAsset,
} from "../../shared/preflight";
import { assetUrl } from "./media-cache";

const PROBE_TIMEOUT_MS = 15_000;

function probeImage(id: string): Promise<ProjectorPreflightAsset> {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(
      () =>
        resolve({
          id,
          kind: "image",
          ok: false,
          detail: "timed out",
          durationMs: null,
        }),
      PROBE_TIMEOUT_MS,
    );
    image.onload = () => {
      clearTimeout(timer);
      resolve({
        id,
        kind: "image",
        ok: true,
        detail: `${image.naturalWidth}×${image.naturalHeight}`,
        durationMs: null,
      });
    };
    image.onerror = () => {
      clearTimeout(timer);
      resolve({
        id,
        kind: "image",
        ok: false,
        detail: "failed to decode",
        durationMs: null,
      });
    };
    image.src = assetUrl(id);
  });
}

function probeTimed(
  id: string,
  kind: "audio" | "video",
): Promise<ProjectorPreflightAsset> {
  return new Promise((resolve) => {
    const element = document.createElement(kind);
    element.preload = "metadata";
    const finish = (asset: ProjectorPreflightAsset) => {
      clearTimeout(timer);
      element.removeAttribute("src");
      element.load();
      resolve(asset);
    };
    const timer = setTimeout(
      () =>
        finish({ id, kind, ok: false, detail: "timed out", durationMs: null }),
      PROBE_TIMEOUT_MS,
    );
    element.addEventListener(
      "loadedmetadata",
      () =>
        finish({
          id,
          kind,
          ok: Number.isFinite(element.duration),
          detail: Number.isFinite(element.duration)
            ? kind === "video"
              ? `${(element as HTMLVideoElement).videoWidth}×${(element as HTMLVideoElement).videoHeight}`
              : "metadata loaded"
            : "duration unknown",
          durationMs: Number.isFinite(element.duration)
            ? Math.round(element.duration * 1000)
            : null,
        }),
      { once: true },
    );
    element.addEventListener(
      "error",
      () =>
        finish({
          id,
          kind,
          ok: false,
          detail: element.error?.message || "cannot be decoded by this browser",
          durationMs: null,
        }),
      { once: true },
    );
    element.src = assetUrl(id);
    element.load();
  });
}

/**
 * Loads each referenced asset's metadata in this browser, which is the only
 * place a codec problem or a slow venue link can actually be observed. The
 * requests also warm the HTTP cache the media elements will read from.
 */
export async function probeAssets(
  assets: readonly PreflightAssetRequest[],
): Promise<ProjectorPreflightAsset[]> {
  const results: ProjectorPreflightAsset[] = [];
  for (const asset of assets) {
    results.push(
      asset.kind === "image"
        ? await probeImage(asset.id)
        : await probeTimed(asset.id, asset.kind),
    );
  }
  return results;
}

export function cacheStorageAvailable(): boolean {
  return typeof caches !== "undefined" && typeof caches.open === "function";
}
