import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "../shared/domain";
import type { ServerMessage } from "../shared/protocol";
import { createAct } from "../worker/acts";
import { createAdminSession } from "../worker/admin-auth";
import { uploadMediaAsset } from "../worker/media-assets";
import { applyScoringConfiguration } from "../worker/scoring-config";
import { upsertShow } from "../worker/show-config";
import { PRIMARY_SHOW_ID } from "../worker/show-state";

/**
 * Show configuration lives in the coordinator's SQLite, never in a browser.
 * An administrator who configured the show on one device and signs in on
 * another must receive the same acts, performers, media assignments, judge
 * panel, weighting and GO policy in their very first snapshot. This drives the
 * real socket path with a second, independent admin session.
 */
describe("show state across administrator devices", () => {
  it("delivers the persisted configuration to a fresh session on another device", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("admin-cross-device"),
    );
    await stub.fetch("https://show.internal/health");

    let deviceB = "";
    let trackId = "";
    let actId = "";
    await runInDurableObject(stub, async (_instance, state) => {
      const { storage } = state;
      // Device A configures the show through the same functions the admin
      // endpoints call.
      upsertShow(storage, PRIMARY_SHOW_ID, {
        title: "Cross Device Show",
        tagline: "Configured on device A",
        shortName: "XD",
        themeId: "emerald",
        fontFamily: "system-ui",
        reactionsEnabled: false,
        flowPolicy: {
          openJudgesOnScoring: false,
          openVotingOnScoring: true,
          scoreboardStep: false,
          stopMediaOnScoring: true,
        },
      });
      const judges = await applyScoringConfiguration(storage, PRIMARY_SHOW_ID, {
        judgeNames: ["Ada", "Grace", "Linus"],
        audienceWeight: 0.3,
        reset: false,
        confirm: null,
      });
      expect(judges.ok).toBe(true);
      const upload = await uploadMediaAsset(
        storage,
        env.MEDIA,
        PRIMARY_SHOW_ID,
        new Request("https://show.test/api/admin/media", {
          method: "POST",
          headers: { "Content-Type": "audio/wav", "Content-Length": "8" },
          body: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]),
        }),
        "backing.wav",
      );
      expect(upload.ok).toBe(true);
      if (!upload.ok) return;
      trackId = upload.asset.id;
      const act = createAct(storage, PRIMARY_SHOW_ID, {
        performerName: "The Trio",
        performers: [
          { id: "performer-1", name: "Ana" },
          { id: "performer-2", name: "Ben" },
          { id: "performer-3", name: "Cyd" },
        ],
        groupName: "The Trio",
        performerDisplayMode: "GROUP_NAME_AND_MEMBERS",
        schoolYear: "Year 11",
        actName: "Three Voices",
        actType: "Vocal",
        publicDescription: "",
        internalNotes: "Stage left entrance",
        publicImageAssetId: null,
        showDescriptionToAudience: false,
        showImageToAudience: false,
        showFullMemberListToAudience: true,
        presentation: {
          actImageAssetId: null,
          performanceMode: "DEFAULT",
          performanceVisualMode: "AUTOMATIC",
          performanceAssetId: null,
          performanceFit: "contain",
          backingAudioAssetId: trackId,
          backingAudioStart: "PERFORMANCE",
        },
        appearance: { themeId: "crimson", fontFamily: null },
      });
      expect(act).not.toBeNull();
      actId = act?.id ?? "";

      // Device B: a separate login, a separate cookie, nothing shared but the
      // coordinator.
      const login = await createAdminSession(
        storage,
        new Request("https://show.test/api/admin/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://show.test",
          },
          body: JSON.stringify({ secret: "s" }),
        }),
        "s",
        PRIMARY_SHOW_ID,
      );
      deviceB = login.setCookie?.split(";")[0] ?? "";
    });

    const response = await stub.fetch(
      new Request("https://show.test/api/ws", {
        headers: {
          Upgrade: "websocket",
          Cookie: deviceB,
          Origin: "https://show.test",
        },
      }),
    );
    if (!response.webSocket) throw new Error("upgrade failed");
    const socket = response.webSocket;
    socket.accept();
    const snapshot = new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no snapshot")), 3_000);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === "snapshot") {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        requestedRole: "admin",
      }),
    );
    const message = await snapshot;
    expect(message.type).toBe("snapshot");
    if (message.type !== "snapshot" || message.projection.role !== "admin")
      throw new Error("expected an admin snapshot");
    const projection = message.projection;

    expect(projection.show).toMatchObject({
      title: "Cross Device Show",
      themeId: "emerald",
      audienceWeight: 0.3,
      flowPolicy: {
        openJudgesOnScoring: false,
        openVotingOnScoring: true,
        scoreboardStep: false,
        stopMediaOnScoring: true,
      },
    });
    expect(projection.judges.map((judge) => judge.displayName)).toEqual([
      "Ada",
      "Grace",
      "Linus",
    ]);
    const act = projection.acts.find((entry) => entry.id === actId);
    expect(act).toMatchObject({
      actName: "Three Voices",
      groupName: "The Trio",
      performerDisplayMode: "GROUP_NAME_AND_MEMBERS",
      internalNotes: "Stage left entrance",
      showFullMemberListToAudience: true,
      presentation: {
        backingAudioAssetId: trackId,
        backingAudioStart: "PERFORMANCE",
      },
      appearance: { themeId: "crimson" },
    });
    expect(act?.performers?.map((performer) => performer.name)).toEqual([
      "Ana",
      "Ben",
      "Cyd",
    ]);
    // The derived PERFORMANCE cue, and therefore the backing track, came too.
    expect(
      act?.cues.some((cue) =>
        cue.operations.some(
          (operation) =>
            operation.kind === "audio" && operation.assetId === trackId,
        ),
      ),
    ).toBe(true);
    socket.close(1000, "done");
  });
});
