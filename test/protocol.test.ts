import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  showRevision,
  type AudienceShowProjection,
} from "../shared/domain";
import {
  parseClientMessage,
  parseServerMessage,
  serialiseServerMessage,
} from "../shared/protocol";

describe("realtime protocol", () => {
  it("parses a compact valid admin command and rejects malformed input", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "admin_command",
          protocolVersion: PROTOCOL_VERSION,
          command: {
            type: "CLOSE_AUDIENCE_VOTING",
            protocolVersion: PROTOCOL_VERSION,
            commandId: "close-voting",
            expectedRevision: 4,
          },
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(parseClientMessage('{"type":"admin_command"}')).toMatchObject({
      ok: false,
    });
  });

  it("round-trips revisioned server snapshots and marks incompatible versions", () => {
    const projection: AudienceShowProjection = {
      role: "audience",
      show: {
        title: "Show",
        activeActId: null,
        audienceVoteState: "CLOSED",
        revision: showRevision(2),
      },
      activeAct: null,
    };
    const wire = serialiseServerMessage({
      type: "snapshot",
      protocolVersion: PROTOCOL_VERSION,
      revision: showRevision(2),
      projection,
    });
    expect(parseServerMessage(wire)).toMatchObject({ ok: true });
    expect(
      parseServerMessage(
        JSON.stringify({ type: "snapshot", protocolVersion: 999, revision: 0 }),
      ),
    ).toMatchObject({ ok: false, incompatible: true });
  });
});
