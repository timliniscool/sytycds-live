import { describe, expect, it } from "vitest";

import type { MediaManifestEntry } from "../shared/domain";
import { parseClientMessage } from "../shared/protocol";
import { PROTOCOL_VERSION } from "../shared/domain";
import { planCacheWork, summariseCache } from "../src/projector/media-cache";

const manifest: MediaManifestEntry[] = [
  { id: "asset-a", version: "v1", sizeBytes: 100, mimeType: "audio/mpeg" },
  { id: "asset-b", version: "v2", sizeBytes: 250, mimeType: "video/mp4" },
  { id: "asset-c", version: "v1", sizeBytes: 50, mimeType: "image/png" },
];

describe("projector media cache planning", () => {
  it("fetches only missing or re-versioned files and drops the rest", () => {
    const plan = planCacheWork(manifest, [
      { id: "asset-a", version: "v1" },
      { id: "asset-b", version: "v1" },
      { id: "asset-old", version: "v9" },
    ]);
    expect(plan.fetch.map((entry) => entry.id)).toEqual(["asset-b", "asset-c"]);
    expect(plan.remove).toEqual(["asset-b", "asset-old"]);
  });

  it("does nothing when the cache already matches", () => {
    expect(
      planCacheWork(
        manifest,
        manifest.map((entry) => ({ id: entry.id, version: entry.version })),
      ),
    ).toEqual({ fetch: [], remove: [] });
  });

  it("tracks files and bytes including the file in flight", () => {
    const summary = summariseCache(
      manifest,
      new Set(["asset-a"]),
      new Set(["asset-c"]),
      120,
      true,
      null,
    );
    expect(summary).toEqual({
      files: 3,
      cached: 1,
      failed: 1,
      bytes: 400,
      cachedBytes: 220,
      persisted: true,
      error: null,
    });
  });
});

describe("cache telemetry on the wire", () => {
  it("carries a well-formed cache summary and drops a malformed one", () => {
    const base = {
      type: "projector_status",
      protocolVersion: PROTOCOL_VERSION,
      status: {
        visual: "IDLE",
        audio: "IDLE",
        positionMs: null,
        durationMs: null,
        armed: true,
        black: false,
        error: null,
      },
    };
    const good = parseClientMessage(
      JSON.stringify({
        ...base,
        status: {
          ...base.status,
          held: true,
          cache: {
            files: 3,
            cached: 2,
            failed: 0,
            bytes: 400,
            cachedBytes: 350,
            persisted: null,
            error: null,
          },
        },
      }),
    );
    expect(
      good.ok &&
        good.message.type === "projector_status" &&
        good.message.status,
    ).toMatchObject({
      held: true,
      cache: { files: 3, cached: 2, cachedBytes: 350 },
    });
    const bad = parseClientMessage(
      JSON.stringify({
        ...base,
        status: { ...base.status, cache: { files: "3" } },
      }),
    );
    expect(
      bad.ok &&
        bad.message.type === "projector_status" &&
        bad.message.status.cache,
    ).toBeUndefined();
  });
});
