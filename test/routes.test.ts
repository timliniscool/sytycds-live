import { describe, expect, it } from "vitest";

import { metadataForRoute, resolveRoute } from "../src/router";

describe("fixed surface routing", () => {
  it.each([
    ["/admin", { kind: "admin" }],
    ["/projector", { kind: "projector" }],
    ["/vote", { kind: "vote" }],
    ["/judge/example", { kind: "judge", token: "example" }],
  ] as const)("resolves %s", (path, expected) => {
    expect(resolveRoute(path)).toEqual(expected);
  });

  it("rejects unrecognised paths and unsafe judge path segments", () => {
    expect(resolveRoute("/")).toEqual({ kind: "not-found" });
    expect(resolveRoute("/admin/extra")).toEqual({ kind: "not-found" });
    expect(resolveRoute("/judge/foo%2Fbar")).toEqual({ kind: "not-found" });
    expect(resolveRoute("/judge/")).toEqual({ kind: "not-found" });
  });

  it("provides route-specific document metadata", () => {
    expect(metadataForRoute(resolveRoute("/vote")).title).toBe(
      "Vote · SYTYCDS Live",
    );
    expect(metadataForRoute(resolveRoute("/unknown")).title).toBe(
      "Page not found · SYTYCDS Live",
    );
  });
});
