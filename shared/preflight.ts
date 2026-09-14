/**
 * Preflight is a readiness test the operator runs before doors. Every item is
 * a real probe with an actionable diagnostic; nothing here is decorative.
 */

export type PreflightStatus = "READY" | "WARNING" | "FAILURE" | "PENDING";

/** Who can actually run the probe: the coordinator, this browser, or the projector. */
export type PreflightGroup = "server" | "browser" | "projector" | "realtime";

export interface PreflightItem {
  id: string;
  label: string;
  status: PreflightStatus;
  detail: string;
  /** A required item blocks READY when it fails; an optional one only warns. */
  required: boolean;
  group: PreflightGroup;
}

export type PreflightAssetKind = "image" | "audio" | "video";

export interface PreflightAssetRequest {
  id: string;
  kind: PreflightAssetKind;
}

export interface ProjectorPreflightAsset {
  id: string;
  kind: PreflightAssetKind;
  ok: boolean;
  detail: string;
  durationMs: number | null;
}

/** What only the projector browser can know about itself. */
export interface ProjectorPreflightReport {
  protocolVersion: number;
  engineReady: boolean;
  armed: boolean;
  cacheStorage: boolean;
  assets: readonly ProjectorPreflightAsset[];
}

/**
 * READY means every item passed with nothing to say. A warning is a pass with
 * a note and never reads as failure; a failed optional item is also a warning.
 */
export function overallReadiness(
  items: readonly PreflightItem[],
): PreflightStatus {
  if (items.some((item) => item.required && item.status === "FAILURE")) {
    return "FAILURE";
  }
  if (items.some((item) => item.status === "PENDING")) return "PENDING";
  if (
    items.some((item) => item.status === "WARNING" || item.status === "FAILURE")
  ) {
    return "WARNING";
  }
  return "READY";
}
