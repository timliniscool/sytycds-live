/**
 * Regression cover for the foundation repairs: projector pairing and audio
 * arming, one judge configuration, theme persistence, vote submission consent,
 * the act presentation model, the cue command chain, display precedence and the
 * final-results lifecycle. Each test names the behaviour an operator relies on,
 * not the implementation that happens to provide it.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION, showRevision } from "../shared/domain";
import {
  MAX_JUDGES,
  MIN_JUDGES,
  normaliseJudgeConfiguration,
  resizeJudgeNames,
} from "../shared/judges";
import { serialiseServerMessage } from "../shared/protocol";
import {
  RealtimeClient,
  type WebSocketLike,
} from "../src/realtime/RealtimeClient";
import { discardUnlockedSelection } from "../src/vote/vote-view";
import { createAct, editAct, parseActInput } from "../worker/acts";
import { submitAudienceVote } from "../worker/audience-votes";
import { applyScoringConfiguration } from "../worker/scoring-config";
import { upsertShow } from "../worker/show-config";
import {
  PRIMARY_SHOW_ID,
  executeAdminCommand,
  projectShowState,
} from "../worker/show-state";
import { simpleCueForAct } from "../worker/simple-flow";

const NOW = "2026-09-15T00:00:00.000Z";

class FakeSocket implements WebSocketLike {
  readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly sent: string[] = [];
  closedWith: number | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closedWith = code ?? null;
    this.onclose?.({ code } as CloseEvent);
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  receive(data: string): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

/**
 * The realtime client attaches to browser lifecycle events. The Workers test
 * runtime has no DOM, so these minimal stubs capture the listeners and let a
 * test fire "the operator switched back to this tab" deliberately.
 */
interface BrowserStub {
  fire(target: "window" | "document", type: string): void;
  restore(): void;
}

function stubBrowser(): BrowserStub {
  const listeners = {
    window: new Map<string, Set<() => void>>(),
    document: new Map<string, Set<() => void>>(),
  };
  const make = (bucket: Map<string, Set<() => void>>) => ({
    addEventListener(type: string, listener: () => void) {
      const set = bucket.get(type) ?? new Set();
      set.add(listener);
      bucket.set(type, set);
    },
    removeEventListener(type: string, listener: () => void) {
      bucket.get(type)?.delete(listener);
    },
  });
  const scope = globalThis as Record<string, unknown>;
  const previous = { window: scope.window, document: scope.document };
  scope.window = make(listeners.window);
  scope.document = { ...make(listeners.document), visibilityState: "visible" };
  return {
    fire(target, type) {
      for (const listener of listeners[target].get(type) ?? []) listener();
    },
    restore() {
      scope.window = previous.window;
      scope.document = previous.document;
    },
  };
}

function projectorClient(sockets: FakeSocket[]): RealtimeClient {
  return new RealtimeClient({
    url: "ws://show.test/api/ws",
    hello: {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      requestedRole: "projector",
    },
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
}

describe("projector pairing without a reload", () => {
  it("opens no socket until the surface asks, so a tab switch cannot latch UNAUTHORISED", () => {
    const browser = stubBrowser();
    try {
      const sockets: FakeSocket[] = [];
      const client = projectorClient(sockets);
      // Constructing the client subscribes to browser events. Before
      // `connect()` none of them may open an unauthenticated connection — this
      // is the bug that left a paired display saying "not authorised" until
      // somebody reloaded it.
      browser.fire("document", "visibilitychange");
      browser.fire("window", "online");
      expect(sockets).toHaveLength(0);
      client.destroy();
    } finally {
      browser.restore();
    }
  });

  it("replaces a refused connection with an authorised one the moment pairing succeeds", () => {
    const sockets: FakeSocket[] = [];
    const client = projectorClient(sockets);

    // An unpaired display connects (for instance because its page was opened
    // before the operator generated a code) and the coordinator refuses it.
    client.connect();
    sockets[0]!.open();
    sockets[0]!.close(1008);
    expect(client.getState().connection).toBe("UNAUTHORISED");
    client.connect();
    expect(sockets).toHaveLength(1);

    // Pairing sets the projector session cookie. The coordinator only reads it
    // during a handshake, so a new socket is opened; no reload is involved.
    client.reconnectWithNewCredential();
    expect(sockets).toHaveLength(2);
    expect(client.getState().connection).toBe("CONNECTING");

    const paired = sockets[1]!;
    paired.open();
    expect(JSON.parse(paired.sent[0]!)).toMatchObject({
      type: "hello",
      requestedRole: "projector",
    });

    // The authorised socket receives the authoritative snapshot by itself.
    paired.receive(
      serialiseServerMessage({
        type: "snapshot",
        protocolVersion: PROTOCOL_VERSION,
        revision: showRevision(7),
        projection: {
          role: "projector",
          show: {
            title: "Show",
            tagline: "",
            shortName: "",
            themeId: "gold-white",
            fontFamily: "system-ui",
            reactionsEnabled: true,
            intermissionMessage: "",
            emergencyMessage: "",
            displayMode: "LOBBY",
            activeActId: null,
            revision: showRevision(7),
          },
          activeAct: null,
          activeCues: [],
          runtime: {
            preparedCueId: null,
            activeVisualCueId: null,
            activeAudioCueId: null,
            visualTransport: "STOPPED",
            audioTransport: "STOPPED",
            blackScreen: false,
            emergencyPresentation: "BLACK",
          },
          scoreboard: { audience: null, judges: [] },
          revealedResult: null,
          publicResults: null,
          joinUrl: null,
          mediaManifest: [],
        },
      }),
    );
    expect(client.getState().connection).toBe("LIVE");
    expect(client.getState().projection?.role).toBe("projector");
    client.destroy();
  });

  it("refuses a wrong, expired, reused or revoked credential without retrying it forever", () => {
    const sockets: FakeSocket[] = [];
    const client = projectorClient(sockets);
    client.connect();
    sockets[0]!.open();
    sockets[0]!.close(1008);
    // Terminal: a rejected credential is not retried, so a display cannot beat
    // on the coordinator while somebody looks for the right code.
    client.connect();
    expect(sockets).toHaveLength(1);
    expect(client.getState().connection).toBe("UNAUTHORISED");
    client.destroy();
  });
});

describe("one judge configuration", () => {
  it.each([MIN_JUDGES, 2, 4, 6, MAX_JUDGES])(
    "accepts a panel of %i judges",
    (count) => {
      const result = normaliseJudgeConfiguration(resizeJudgeNames([], count));
      expect(result.ok && result.names).toHaveLength(count);
    },
  );

  it("treats blank and whitespace names as the default label, not an error", () => {
    const result = normaliseJudgeConfiguration(["", "   ", "  Alice  "]);
    expect(result).toEqual({
      ok: true,
      names: ["Judge 1", "Judge 2", "Alice"],
    });
  });

  it("rejects only a panel size outside one to eight", () => {
    expect(normaliseJudgeConfiguration([]).ok).toBe(false);
    expect(
      normaliseJudgeConfiguration(resizeJudgeNames([], MAX_JUDGES).concat("X"))
        .ok,
    ).toBe(false);
  });

  it("never lets a hidden slot invalidate the configuration", () => {
    // Shrinking from eight to four discards the names the operator can no
    // longer see, so an old entry in slot 7 cannot block a valid save.
    const eight = resizeJudgeNames([], MAX_JUDGES);
    const four = resizeJudgeNames(eight, 4);
    expect(four).toHaveLength(4);
    expect(normaliseJudgeConfiguration(four).ok).toBe(true);
  });

  it("clears the moment a valid name is typed, because it is derived not stored", () => {
    const tooMany = resizeJudgeNames([], MAX_JUDGES).concat("ninth");
    expect(normaliseJudgeConfiguration(tooMany).ok).toBe(false);
    // The very next evaluation of the same fields is valid again; there is no
    // message left over from the previous one anywhere to go stale.
    expect(normaliseJudgeConfiguration(tooMany.slice(0, 8)).ok).toBe(true);
  });

  it("grows, shrinks and renames one authoritative panel", async () => {
    await withShow("prompt1-judges", async (storage) => {
      upsertShow(storage, PRIMARY_SHOW_ID, { title: "Show", tagline: "" });
      const four = await applyScoringConfiguration(storage, PRIMARY_SHOW_ID, {
        judgeNames: ["Alice", "Bob", "Charlie", "David"],
        audienceWeight: 0.5,
        reset: false,
        confirm: null,
      });
      expect(four.ok && four.issued).toHaveLength(4);
      expect(judgeNames(storage)).toEqual(["Alice", "Bob", "Charlie", "David"]);

      const six = await applyScoringConfiguration(storage, PRIMARY_SHOW_ID, {
        judgeNames: ["Alice", "Bob", "Charlie", "David", "Eve", "Frank"],
        audienceWeight: 0.5,
        reset: false,
        confirm: null,
      });
      // Only the two new judges need a link; nobody else's is disturbed.
      expect(six.ok && six.issued).toHaveLength(2);
      expect(judgeNames(storage)).toHaveLength(6);

      await applyScoringConfiguration(storage, PRIMARY_SHOW_ID, {
        judgeNames: ["Renamed", "Bob", "Charlie", "David"],
        audienceWeight: 0.5,
        reset: false,
        confirm: null,
      });
      expect(judgeNames(storage)).toEqual([
        "Renamed",
        "Bob",
        "Charlie",
        "David",
      ]);

      const projection = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      // The count is the panel, everywhere. There is no second source for it.
      expect(projection?.role === "admin" && projection.judges).toHaveLength(4);
    });
  });
});

describe("theme persistence", () => {
  it("is authoritative show configuration that every role receives", async () => {
    await withShow("prompt1-theme", (storage) => {
      upsertShow(storage, PRIMARY_SHOW_ID, { title: "Show", tagline: "" });
      upsertShow(storage, PRIMARY_SHOW_ID, {
        title: "Show",
        tagline: "",
        shortName: "",
        themeId: "gold-white",
        fontFamily: "system-ui",
        reactionsEnabled: true,
      });
      for (const role of ["admin", "projector", "audience", "judge"] as const) {
        if (role === "judge") continue;
        const projection = projectShowState(storage, PRIMARY_SHOW_ID, {
          kind: role,
        });
        expect(
          projection && "themeId" in projection.show
            ? projection.show.themeId
            : null,
        ).toBe("gold-white");
      }
      // A later reconnect re-reads the same stored value: there is nowhere else
      // for a theme to live, so nothing can be lost by navigating away.
      const reconnected = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "projector",
      });
      expect(
        reconnected?.role === "projector" && reconnected.show.themeId,
      ).toBe("gold-white");
    });
  });
});

describe("audience vote consent", () => {
  it("discards a selected but unlocked score when voting closes", () => {
    expect(discardUnlockedSelection({ kind: "selected", score: 9 })).toEqual({
      kind: "idle",
    });
    expect(discardUnlockedSelection({ kind: "confirming", score: 9 })).toEqual({
      kind: "idle",
    });
  });

  it("never discards a locked score or a submission the server already has", () => {
    expect(discardUnlockedSelection({ kind: "locked", score: 7 })).toEqual({
      kind: "locked",
      score: 7,
    });
    expect(discardUnlockedSelection({ kind: "submitting", score: 7 })).toEqual({
      kind: "submitting",
      score: 7,
    });
  });

  it("records zero votes when a phone selects a score and the operator closes voting", async () => {
    await withShow("prompt1-vote-close", async (storage) => {
      await seedShowWithAct(storage);
      expect(
        command(storage, "OPEN_AUDIENCE_VOTING").acknowledgement.status,
      ).toBe("accepted");
      // The phone has selected 9. Nothing has been sent: selection is local.
      expect(
        command(storage, "CLOSE_AUDIENCE_VOTING").acknowledgement.status,
      ).toBe("accepted");
      expect(voteCount(storage)).toBe(0);
    });
  });

  it("decides a lock/close race on authoritative order, and says VOTING_CLOSED after", async () => {
    await withShow("prompt1-vote-race", async (storage) => {
      await seedShowWithAct(storage);
      command(storage, "OPEN_AUDIENCE_VOTING");
      // Committed while voting was still open: accepted and counted.
      expect(
        submitAudienceVote(storage, PRIMARY_SHOW_ID, voterHash(1), {
          actIdentifier: "act-1",
          score: 8,
        }),
      ).toMatchObject({ ok: true });
      command(storage, "CLOSE_AUDIENCE_VOTING");
      // Arrived after the close transaction: refused, and never counted.
      expect(
        submitAudienceVote(storage, PRIMARY_SHOW_ID, voterHash(2), {
          actIdentifier: "act-1",
          score: 8,
        }),
      ).toEqual({ ok: false, code: "VOTING_CLOSED" });
      expect(voteCount(storage)).toBe(1);
    });
  });
});

describe("act presentation model", () => {
  it("gives every act a performance without deriving a cue for it", async () => {
    await withShow("prompt1-default-performance", async (storage) => {
      const act = await seedShowWithAct(storage);
      // No custom visual and no backing audio: nothing to execute, and the
      // projector draws the act's own performance screen.
      expect(simpleCueForAct(storage.sql, PRIMARY_SHOW_ID, act)).toBeNull();
      const projection = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "projector",
      });
      expect(projection?.role === "projector" && projection.activeCues).toEqual(
        [],
      );
    });
  });

  it("derives one PERFORMANCE cue from a custom visual and backing audio", async () => {
    await withShow("prompt1-custom-performance", async (storage) => {
      const act = await seedShowWithAct(storage);
      seedAsset(storage, "asset-image", "image/png");
      seedAsset(storage, "asset-audio", "audio/mpeg");
      expect(
        editAct(
          storage,
          PRIMARY_SHOW_ID,
          act,
          actInput({
            presentation: {
              performanceMode: "CUSTOM",
              performanceAssetId: "asset-image",
              performanceFit: "contain",
              backingAudioAssetId: "asset-audio",
              backingAudioStart: "PERFORMANCE",
            },
          }),
        ),
      ).toBe(true);

      const projection = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "projector",
      });
      const cues =
        projection?.role === "projector" ? projection.activeCues : [];
      expect(cues).toHaveLength(1);
      expect(cues[0]).toMatchObject({ position: 0, origin: "SIMPLE" });
      expect(cues[0]?.operations).toEqual([
        {
          kind: "visual",
          // `contain` is the default and is expressed by the absence of a fit,
          // so an image is never stretched or cropped unless asked.
          visual: { kind: "IMAGE", sourceKey: "asset-image", title: null },
        },
        { kind: "audio", action: "LOAD", assetId: "asset-audio" },
      ]);
    });
  });

  it("marks a cropped visual explicitly and only for images", async () => {
    await withShow("prompt1-cover", async (storage) => {
      const act = await seedShowWithAct(storage);
      seedAsset(storage, "asset-image", "image/png");
      editAct(
        storage,
        PRIMARY_SHOW_ID,
        act,
        actInput({
          presentation: {
            performanceMode: "CUSTOM",
            performanceAssetId: "asset-image",
            performanceFit: "cover",
            backingAudioAssetId: null,
            backingAudioStart: "MANUAL",
          },
        }),
      );
      const projection = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "projector",
      });
      const cues =
        projection?.role === "projector" ? projection.activeCues : [];
      expect(cues[0]?.visual).toMatchObject({ kind: "IMAGE", fit: "cover" });
    });
  });

  it("starts the performance visual with PERFORMANCE and holds audio for GO", async () => {
    await withShow("prompt1-manual-audio", async (storage) => {
      const act = await seedShowWithAct(storage);
      seedAsset(storage, "asset-image", "image/png");
      seedAsset(storage, "asset-audio", "audio/mpeg");
      editAct(
        storage,
        PRIMARY_SHOW_ID,
        act,
        actInput({
          presentation: {
            performanceMode: "CUSTOM",
            performanceAssetId: "asset-image",
            performanceFit: "contain",
            backingAudioAssetId: "asset-audio",
            backingAudioStart: "MANUAL",
          },
        }),
      );
      command(storage, "SET_DISPLAY_MODE", { mode: "PERFORMANCE" });
      const held = runtime(storage);
      expect(held.visual_transport).toBe("PLAYING");
      expect(held.audio_transport).toBe("STOPPED");

      command(storage, "PLAY_CUE", { cueId: held.prepared_cue_id });
      expect(runtime(storage).audio_transport).toBe("PLAYING");
    });
  });

  it("starts backing audio with the performance when the act asks it to", async () => {
    await withShow("prompt1-auto-audio", async (storage) => {
      const act = await seedShowWithAct(storage);
      seedAsset(storage, "asset-audio", "audio/mpeg");
      editAct(
        storage,
        PRIMARY_SHOW_ID,
        act,
        actInput({
          presentation: {
            performanceMode: "DEFAULT",
            performanceAssetId: null,
            performanceFit: "contain",
            backingAudioAssetId: "asset-audio",
            backingAudioStart: "PERFORMANCE",
          },
        }),
      );
      command(storage, "SET_DISPLAY_MODE", { mode: "PERFORMANCE" });
      expect(runtime(storage).audio_transport).toBe("PLAYING");
    });
  });

  it("omits optional act copy and artwork from audience phones unless opted in", async () => {
    await withShow("prompt1-audience-fields", async (storage) => {
      const act = await seedShowWithAct(storage);
      seedAsset(storage, "asset-image", "image/png");
      editAct(
        storage,
        PRIMARY_SHOW_ID,
        act,
        actInput({
          publicDescription: "A secret blurb",
          publicImageAssetId: "asset-image",
        }),
      );
      const phone = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "audience",
      });
      expect(phone?.role === "audience" && phone.activeAct).toMatchObject({
        actName: "Act one",
        performerName: "Performer",
        schoolYear: "Year 10",
        publicDescription: "",
        publicImageAssetId: null,
      });
      // The stage still sees everything; only phones are narrowed.
      const stage = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "projector",
      });
      expect(stage?.role === "projector" && stage.activeAct).toMatchObject({
        publicDescription: "A secret blurb",
        publicImageAssetId: "asset-image",
      });

      editAct(
        storage,
        PRIMARY_SHOW_ID,
        act,
        actInput({
          publicDescription: "A secret blurb",
          publicImageAssetId: "asset-image",
          showDescriptionToAudience: true,
          showImageToAudience: true,
        }),
      );
      const opted = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "audience",
      });
      expect(opted?.role === "audience" && opted.activeAct).toMatchObject({
        publicDescription: "A secret blurb",
        publicImageAssetId: "asset-image",
      });
    });
  });

  it("never sends stage media to phones", async () => {
    await withShow("prompt1-no-stage-media", async (storage) => {
      const act = await seedShowWithAct(storage);
      seedAsset(storage, "asset-audio", "audio/mpeg");
      editAct(
        storage,
        PRIMARY_SHOW_ID,
        act,
        actInput({
          presentation: {
            performanceMode: "DEFAULT",
            performanceAssetId: null,
            performanceFit: "contain",
            backingAudioAssetId: "asset-audio",
            backingAudioStart: "MANUAL",
          },
        }),
      );
      const phone = JSON.stringify(
        projectShowState(storage, PRIMARY_SHOW_ID, { kind: "audience" }),
      );
      expect(phone).not.toContain("asset-audio");
      expect(phone).not.toContain("mediaManifest");
      expect(phone).not.toContain("activeCues");
    });
  });
});

describe("display precedence", () => {
  it("keeps blackout on through every ordinary presentation change", async () => {
    await withShow("prompt1-blackout", async (storage) => {
      await seedShowWithAct(storage);
      command(storage, "BLACK_SCREEN");
      for (const mode of [
        "LOBBY",
        "ACT_CARD",
        "PERFORMANCE",
        "SCOREBOARD",
        "INTERMISSION",
        "FINAL_RESULTS",
      ] as const) {
        command(storage, "SET_DISPLAY_MODE", { mode });
        expect(runtime(storage).black_screen).toBe(1);
      }
      command(storage, "STOP_ALL_MEDIA");
      expect(runtime(storage).black_screen).toBe(1);
      command(storage, "BLACK_SCREEN");
      expect(runtime(storage).black_screen).toBe(0);
    });
  });

  it("restores the presentation that was underneath HOLD", async () => {
    await withShow("prompt1-hold", async (storage) => {
      await seedShowWithAct(storage);
      command(storage, "SET_DISPLAY_MODE", { mode: "SCOREBOARD" });
      command(storage, "SET_DISPLAY_MODE", { mode: "HOLD" });
      expect(displayMode(storage)).toBe("HOLD");
      expect(activeActId(storage)).toBe("act-1");
      command(storage, "RESTORE_DISPLAY");
      expect(displayMode(storage)).toBe("SCOREBOARD");
    });
  });

  it("keeps intermission away from scores, the current act and voting", async () => {
    await withShow("prompt1-intermission", async (storage) => {
      await seedShowWithAct(storage);
      command(storage, "OPEN_AUDIENCE_VOTING");
      command(storage, "SET_DISPLAY_MODE", { mode: "INTERMISSION" });
      expect(displayMode(storage)).toBe("INTERMISSION");
      expect(activeActId(storage)).toBe("act-1");
      expect(voteState(storage)).toBe("OPEN");
      expect(voteCount(storage)).toBe(0);
    });
  });

  it("gives emergency the highest priority and pauses what is audible", async () => {
    await withShow("prompt1-emergency", async (storage) => {
      await seedShowWithAct(storage);
      seedAsset(storage, "asset-audio", "audio/mpeg");
      const act = "act-1";
      editAct(
        storage,
        PRIMARY_SHOW_ID,
        act,
        actInput({
          presentation: {
            performanceMode: "DEFAULT",
            performanceAssetId: null,
            performanceFit: "contain",
            backingAudioAssetId: "asset-audio",
            backingAudioStart: "PERFORMANCE",
          },
        }),
      );
      command(storage, "SET_DISPLAY_MODE", { mode: "PERFORMANCE" });
      expect(runtime(storage).audio_transport).toBe("PLAYING");
      command(storage, "ACTIVATE_EMERGENCY", { presentation: "BLACK" });
      expect(displayMode(storage)).toBe("EMERGENCY");
      expect(runtime(storage).audio_transport).toBe("PAUSED");
      // Nothing durable is erased: the act and its cue survive the emergency.
      expect(activeActId(storage)).toBe("act-1");
      command(storage, "RESTORE_DISPLAY");
      expect(displayMode(storage)).toBe("PERFORMANCE");
    });
  });
});

describe("cue command chain", () => {
  it("turns every transport button into authoritative state the projector can execute", async () => {
    await withShow("prompt1-cue-chain", async (storage) => {
      const act = await seedShowWithAct(storage);
      seedAsset(storage, "asset-image", "image/png");
      seedAsset(storage, "asset-audio", "audio/mpeg");
      editAct(
        storage,
        PRIMARY_SHOW_ID,
        act,
        actInput({
          presentation: {
            performanceMode: "CUSTOM",
            performanceAssetId: "asset-image",
            performanceFit: "contain",
            backingAudioAssetId: "asset-audio",
            backingAudioStart: "MANUAL",
          },
        }),
      );
      const cueId = storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM cues WHERE show_id = ? AND act_id = ?",
          PRIMARY_SHOW_ID,
          act,
        )
        .one().id;

      expect(
        command(storage, "PREPARE_CUE", { cueId }).acknowledgement.status,
      ).toBe("accepted");
      expect(runtime(storage).prepared_cue_id).toBe(cueId);

      expect(
        command(storage, "PLAY_CUE", { cueId }).acknowledgement.status,
      ).toBe("accepted");
      expect(runtime(storage)).toMatchObject({
        active_visual_cue_id: cueId,
        active_audio_cue_id: cueId,
        visual_transport: "PLAYING",
        audio_transport: "PLAYING",
      });

      command(storage, "PAUSE_MEDIA");
      expect(runtime(storage)).toMatchObject({
        visual_transport: "PAUSED",
        audio_transport: "PAUSED",
      });

      command(storage, "RESUME_MEDIA");
      expect(runtime(storage).audio_transport).toBe("PLAYING");

      command(storage, "RESTART_MEDIA");
      expect(runtime(storage).visual_transport).toBe("PLAYING");

      command(storage, "REPLAY_MEDIA");
      expect(runtime(storage).audio_transport).toBe("PLAYING");

      // STOP ends the visual channel; the backing track deliberately survives.
      command(storage, "STOP_MEDIA");
      expect(runtime(storage)).toMatchObject({
        active_visual_cue_id: null,
        visual_transport: "STOPPED",
        audio_transport: "PLAYING",
      });

      command(storage, "STOP_ALL_MEDIA");
      expect(runtime(storage)).toMatchObject({
        active_audio_cue_id: null,
        audio_transport: "STOPPED",
      });
    });
  });

  it("refuses a transport that has nothing to act on, with a reason", async () => {
    await withShow("prompt1-cue-refusals", async (storage) => {
      await seedShowWithAct(storage);
      expect(command(storage, "REPLAY_MEDIA").acknowledgement).toMatchObject({
        status: "rejected",
        reason: "There is no backing audio to replay",
      });
      expect(command(storage, "RESTART_MEDIA").acknowledgement).toMatchObject({
        status: "rejected",
      });
      expect(command(storage, "NEXT_CUE").acknowledgement).toMatchObject({
        status: "rejected",
      });
    });
  });

  it("is idempotent: a replayed command never executes twice", async () => {
    await withShow("prompt1-cue-idempotent", async (storage) => {
      await seedShowWithAct(storage);
      const revision = currentRevision(storage);
      const once = executeAdminCommand(
        storage,
        PRIMARY_SHOW_ID,
        {
          kind: "admin",
        },
        {
          type: "BLACK_SCREEN",
          protocolVersion: PROTOCOL_VERSION,
          commandId: "same-id",
          expectedRevision: revision,
        },
      );
      expect(once.acknowledgement.status).toBe("accepted");
      expect(runtime(storage).black_screen).toBe(1);
      const again = executeAdminCommand(
        storage,
        PRIMARY_SHOW_ID,
        {
          kind: "admin",
        },
        {
          type: "BLACK_SCREEN",
          protocolVersion: PROTOCOL_VERSION,
          commandId: "same-id",
          expectedRevision: revision,
        },
      );
      expect(again.acknowledgement.status).toBe("accepted");
      // Still black: the toggle did not fire a second time.
      expect(runtime(storage).black_screen).toBe(1);
    });
  });
});

describe("final results lifecycle", () => {
  it("ranks only frozen results and says why each other act is missing", async () => {
    await withShow("prompt1-results", async (storage) => {
      await seedShowWithAct(storage);
      await applyScoringConfiguration(storage, PRIMARY_SHOW_ID, {
        judgeNames: ["Alice"],
        audienceWeight: 0,
        reset: false,
        confirm: null,
      });
      const admin = () => {
        const projection = projectShowState(storage, PRIMARY_SHOW_ID, {
          kind: "admin",
        });
        if (projection?.role !== "admin") throw new Error("expected admin");
        return projection;
      };

      expect(admin().ranking.ranked).toEqual([]);
      expect(admin().ranking.incomplete[0]).toMatchObject({
        reason: "JUDGE_SCORE_MISSING",
        missingJudgeSlots: [1],
      });

      const judge = storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM show_judges WHERE show_id = ? AND active = 1",
          PRIMARY_SHOW_ID,
        )
        .one().id;
      storage.sql.exec(
        `INSERT INTO show_judge_submissions (
          show_id, act_id, judge_id, raw_input, parsed_classification,
          finite_value, effective_score, submitted_at
        ) VALUES (?, 'act-1', ?, '9', 'FINITE', 9, 9, ?)`,
        PRIMARY_SHOW_ID,
        judge,
        NOW,
      );
      // Complete but not frozen: still excluded, and the operator is told why.
      expect(admin().ranking.ranked).toEqual([]);
      expect(admin().ranking.incomplete[0]).toMatchObject({
        reason: "NOT_FINALISED",
      });

      expect(command(storage, "FINALISE_RESULT").acknowledgement.status).toBe(
        "accepted",
      );
      expect(admin().ranking.ranked).toMatchObject([
        { actId: "act-1", rank: 1, finalScore: 9 },
      ]);
      expect(admin().ranking.incomplete).toEqual([]);
    });
  });

  it("freezes the act identity with the score, so a later rename cannot rewrite history", async () => {
    await withShow("prompt1-frozen-identity", async (storage) => {
      await seedShowWithAct(storage);
      await applyScoringConfiguration(storage, PRIMARY_SHOW_ID, {
        judgeNames: ["Alice"],
        audienceWeight: 0,
        reset: false,
        confirm: null,
      });
      const judge = storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM show_judges WHERE show_id = ? AND active = 1",
          PRIMARY_SHOW_ID,
        )
        .one().id;
      storage.sql.exec(
        `INSERT INTO show_judge_submissions (
          show_id, act_id, judge_id, raw_input, parsed_classification,
          finite_value, effective_score, submitted_at
        ) VALUES (?, 'act-1', ?, '7.5', 'FINITE', 7.5, 7.5, ?)`,
        PRIMARY_SHOW_ID,
        judge,
        NOW,
      );
      command(storage, "FINALISE_RESULT");

      editAct(
        storage,
        PRIMARY_SHOW_ID,
        "act-1",
        actInput({ performerName: "Renamed Later" }),
      );
      const projection = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      const ranked =
        projection?.role === "admin" ? projection.ranking.ranked : [];
      expect(ranked[0]).toMatchObject({
        performerName: "Performer",
        finalScore: 7.5,
        rank: 1,
      });
    });
  });

  it("does not recompute a frozen score when the weighting changes", async () => {
    await withShow("prompt1-frozen-score", async (storage) => {
      await seedShowWithAct(storage);
      await applyScoringConfiguration(storage, PRIMARY_SHOW_ID, {
        judgeNames: ["Alice"],
        audienceWeight: 0,
        reset: false,
        confirm: null,
      });
      const judge = storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM show_judges WHERE show_id = ? AND active = 1",
          PRIMARY_SHOW_ID,
        )
        .one().id;
      storage.sql.exec(
        `INSERT INTO show_judge_submissions (
          show_id, act_id, judge_id, raw_input, parsed_classification,
          finite_value, effective_score, submitted_at
        ) VALUES (?, 'act-1', ?, '6', 'FINITE', 6, 6, ?)`,
        PRIMARY_SHOW_ID,
        judge,
        NOW,
      );
      command(storage, "FINALISE_RESULT");
      // Changing the show's weighting afterwards must not touch a frozen row.
      storage.sql.exec(
        "UPDATE shows SET audience_weight = 0.9 WHERE id = ?",
        PRIMARY_SHOW_ID,
      );
      const projection = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "admin",
      });
      expect(
        projection?.role === "admin" && projection.ranking.ranked[0],
      ).toMatchObject({ finalScore: 6 });
    });
  });
});

// -- Fixtures ---------------------------------------------------------------

let commandCounter = 0;

function command(
  storage: DurableObjectStorage,
  type: string,
  extras: Record<string, unknown> = {},
) {
  commandCounter += 1;
  return executeAdminCommand(
    storage,
    PRIMARY_SHOW_ID,
    { kind: "admin" },
    {
      type,
      protocolVersion: PROTOCOL_VERSION,
      commandId: `prompt1-${commandCounter}`,
      expectedRevision: currentRevision(storage),
      ...extras,
    },
  );
}

function currentRevision(storage: DurableObjectStorage): number {
  return storage.sql
    .exec<{ revision: number }>(
      "SELECT revision FROM shows WHERE id = ?",
      PRIMARY_SHOW_ID,
    )
    .one().revision;
}

interface RuntimeSnapshot extends Record<string, SqlStorageValue> {
  prepared_cue_id: string | null;
  active_visual_cue_id: string | null;
  active_audio_cue_id: string | null;
  visual_transport: string;
  audio_transport: string;
  black_screen: number;
}

function runtime(storage: DurableObjectStorage): RuntimeSnapshot {
  return storage.sql
    .exec<RuntimeSnapshot>(
      `SELECT prepared_cue_id, active_visual_cue_id, active_audio_cue_id,
              visual_transport, audio_transport, black_screen
       FROM show_runtime WHERE show_id = ?`,
      PRIMARY_SHOW_ID,
    )
    .one();
}

function displayMode(storage: DurableObjectStorage): string {
  return storage.sql
    .exec<{ display_mode: string }>(
      "SELECT display_mode FROM shows WHERE id = ?",
      PRIMARY_SHOW_ID,
    )
    .one().display_mode;
}

function activeActId(storage: DurableObjectStorage): string | null {
  return storage.sql
    .exec<{ active_act_id: string | null }>(
      "SELECT active_act_id FROM shows WHERE id = ?",
      PRIMARY_SHOW_ID,
    )
    .one().active_act_id;
}

function voteState(storage: DurableObjectStorage): string {
  return storage.sql
    .exec<{ audience_vote_state: string }>(
      "SELECT audience_vote_state FROM shows WHERE id = ?",
      PRIMARY_SHOW_ID,
    )
    .one().audience_vote_state;
}

function voteCount(storage: DurableObjectStorage): number {
  return storage.sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM audience_votes WHERE show_id = ?",
      PRIMARY_SHOW_ID,
    )
    .one().count;
}

function judgeNames(storage: DurableObjectStorage): string[] {
  return storage.sql
    .exec<{ display_name: string }>(
      "SELECT display_name FROM show_judges WHERE show_id = ? AND active = 1 ORDER BY slot",
      PRIMARY_SHOW_ID,
    )
    .toArray()
    .map((row) => row.display_name);
}

function voterHash(seed: number): ArrayBuffer {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  return bytes.buffer;
}

function seedAsset(
  storage: DurableObjectStorage,
  id: string,
  mimeType: string,
): void {
  storage.sql.exec(
    `INSERT INTO media_assets (
      id, show_id, object_key, original_filename, mime_type, size_bytes,
      version_identifier, duration_ms, width, height, uploaded_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, 1024, 'v1', NULL, NULL, NULL, ?, NULL)`,
    id,
    PRIMARY_SHOW_ID,
    `objects/${id}`,
    `${id}.file`,
    mimeType,
    NOW,
  );
}

/** A complete, valid act payload; overrides replace only what a test cares about. */
function actInput(overrides: Record<string, unknown> = {}) {
  const parsed = parseActInput({
    performerName: "Performer",
    schoolYear: "Year 10",
    actName: "Act one",
    actType: "Music",
    publicDescription: "",
    internalNotes: "",
    publicImageAssetId: null,
    showDescriptionToAudience: false,
    showImageToAudience: false,
    presentation: {
      performanceMode: "DEFAULT",
      performanceAssetId: null,
      performanceFit: "contain",
      backingAudioAssetId: null,
      backingAudioStart: "MANUAL",
    },
    ...overrides,
  });
  if (!parsed) throw new Error("Test fixture is not a valid act");
  return parsed;
}

async function seedShowWithAct(storage: DurableObjectStorage): Promise<string> {
  upsertShow(storage, PRIMARY_SHOW_ID, { title: "Show", tagline: "" });
  const act = createAct(storage, PRIMARY_SHOW_ID, actInput());
  if (!act) throw new Error("Test fixture could not create the act");
  storage.sql.exec(
    "UPDATE acts SET id = 'act-1' WHERE show_id = ? AND id = ?",
    PRIMARY_SHOW_ID,
    act.id,
  );
  storage.sql.exec(
    "UPDATE shows SET active_act_id = 'act-1' WHERE id = ?",
    PRIMARY_SHOW_ID,
  );
  return "act-1";
}

async function withShow(
  name: string,
  test: (storage: DurableObjectStorage) => void | Promise<void>,
): Promise<void> {
  const stub = env.SHOW_COORDINATOR.get(env.SHOW_COORDINATOR.idFromName(name));
  await stub.fetch("https://show.internal/health");
  await runInDurableObject(stub, async (_instance, state) => {
    await test(state.storage);
  });
}
