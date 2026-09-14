import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "../shared/domain";
import { overallReadiness, type PreflightItem } from "../shared/preflight";
import { parseClientMessage } from "../shared/protocol";
import {
  audienceJoinUrl,
  configuredPublicOrigin,
  normalisePublicOrigin,
} from "../worker/public-origin";

function item(status: PreflightItem["status"], required = true): PreflightItem {
  return {
    id: `${status}-${required}`,
    label: status,
    status,
    detail: "",
    required,
    group: "server",
  };
}

describe("preflight readiness classification", () => {
  it("is READY only when every item passed cleanly", () => {
    expect(overallReadiness([item("READY"), item("READY", false)])).toBe(
      "READY",
    );
  });

  it("never lets a warning masquerade as failure", () => {
    expect(overallReadiness([item("READY"), item("WARNING")])).toBe("WARNING");
    expect(overallReadiness([item("READY"), item("FAILURE", false)])).toBe(
      "WARNING",
    );
  });

  it("blocks READY on a failed required item and reports pending work", () => {
    expect(overallReadiness([item("READY"), item("FAILURE")])).toBe("FAILURE");
    expect(overallReadiness([item("READY"), item("PENDING")])).toBe("PENDING");
    expect(overallReadiness([item("PENDING"), item("FAILURE")])).toBe(
      "FAILURE",
    );
  });
});

describe("canonical public origin", () => {
  it("accepts only a bare http(s) origin", () => {
    expect(normalisePublicOrigin("https://show.school.nz")).toBe(
      "https://show.school.nz",
    );
    expect(normalisePublicOrigin(" https://show.school.nz/ ")).toBe(
      "https://show.school.nz",
    );
    expect(normalisePublicOrigin("http://localhost:5173")).toBe(
      "http://localhost:5173",
    );
    for (const invalid of [
      "",
      "show.school.nz",
      "ftp://show.school.nz",
      "https://show.school.nz/vote",
      "https://show.school.nz/?x=1",
      "https://user:pw@show.school.nz",
    ]) {
      expect(normalisePublicOrigin(invalid)).toBeNull();
    }
  });

  it("reads the Worker variable and builds the audience URL", () => {
    expect(configuredPublicOrigin({ PUBLIC_ORIGIN: "" })).toBeNull();
    expect(configuredPublicOrigin({})).toBeNull();
    expect(
      audienceJoinUrl(
        configuredPublicOrigin({ PUBLIC_ORIGIN: "https://show.school.nz/" }) ??
          "",
      ),
    ).toBe("https://show.school.nz/vote");
  });
});

describe("preflight protocol messages", () => {
  it("parses a projector self-report and rejects malformed ones", () => {
    const valid = parseClientMessage(
      JSON.stringify({
        type: "projector_preflight",
        protocolVersion: PROTOCOL_VERSION,
        requestId: "req-1",
        report: {
          protocolVersion: 1,
          engineReady: true,
          armed: false,
          cacheStorage: true,
          assets: [
            {
              id: "asset-abc",
              kind: "audio",
              ok: true,
              detail: "metadata loaded",
              durationMs: 90000,
            },
          ],
        },
      }),
    );
    expect(valid).toMatchObject({
      ok: true,
      message: { type: "projector_preflight" },
    });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "projector_preflight",
          protocolVersion: PROTOCOL_VERSION,
          requestId: "req-1",
          report: { protocolVersion: 1, assets: [{ id: "x", kind: "zip" }] },
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "preflight_request",
          protocolVersion: PROTOCOL_VERSION,
          requestId: "req 1",
        }),
      ),
    ).toMatchObject({ ok: false });
  });
});
