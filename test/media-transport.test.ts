import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "../shared/domain";
import {
  PRIMARY_SHOW_ID,
  executeAdminCommand,
  projectShowState,
} from "../worker/show-state";

const now = "2026-09-14T00:00:00.000Z";

interface RuntimeSnapshot extends Record<string, SqlStorageValue> {
  prepared_cue_id: string | null;
  active_visual_cue_id: string | null;
  active_audio_cue_id: string | null;
  visual_transport: string;
  audio_transport: string;
  black_screen: number;
}

function seed(sql: SqlStorage): void {
  sql.exec(
    `INSERT INTO shows (
      id, title, display_mode, audience_vote_state, result_reveal_state,
      active_act_id, revision, created_at, updated_at
    ) VALUES (?, 'Show', 'PERFORMANCE', 'CLOSED', 'HIDDEN', 'act-1', 0, ?, ?)`,
    PRIMARY_SHOW_ID,
    now,
    now,
  );
  sql.exec(
    `INSERT INTO acts (
      id, show_id, order_index, performer_name, school_year, act_name,
      act_type, public_description, internal_notes, created_at, updated_at
    ) VALUES ('act-1', ?, 0, 'Performer', 'Year 10', 'Act one', 'Music',
      'Public blurb', 'BACKSTAGE: fetch the stool', ?, ?)`,
    PRIMARY_SHOW_ID,
    now,
    now,
  );
  const cues: readonly [string, number, string | null, string | null][] = [
    ["cue-visual", 0, "IMAGE", null],
    ["cue-audio", 1, null, "AUDIO"],
  ];
  for (const [id, position, visualKind, audioKind] of cues) {
    sql.exec(
      `INSERT INTO cues (
        id, show_id, act_id, position, visual_kind, visual_source_key,
        visual_title, audio_kind, audio_source_key, duration_ms,
        created_at, updated_at, operator_label, operations_json, internal_note
      ) VALUES (?, ?, 'act-1', ?, ?, ?, NULL, ?, ?, 90000, ?, ?, ?, '[]', ?)`,
      id,
      PRIMARY_SHOW_ID,
      position,
      visualKind,
      visualKind ? "asset-image" : null,
      audioKind,
      audioKind ? "asset-audio" : null,
      now,
      now,
      `Operator label ${id}`,
      "Do not show this to the hall",
    );
  }
}

let commandCounter = 0;

function command(
  storage: DurableObjectStorage,
  type: string,
  extras: Record<string, unknown> = {},
) {
  const revision = storage.sql
    .exec<{ revision: number }>(
      "SELECT revision FROM shows WHERE id = ?",
      PRIMARY_SHOW_ID,
    )
    .one().revision;
  commandCounter += 1;
  return executeAdminCommand(
    storage,
    PRIMARY_SHOW_ID,
    { kind: "admin" },
    {
      type,
      protocolVersion: PROTOCOL_VERSION,
      commandId: `cmd-${commandCounter}`,
      expectedRevision: revision,
      ...extras,
    },
  );
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

async function withShow(
  name: string,
  test: (storage: DurableObjectStorage) => void,
): Promise<void> {
  const stub = env.SHOW_COORDINATOR.get(env.SHOW_COORDINATOR.idFromName(name));
  await stub.fetch("https://show.internal/health");
  await runInDurableObject(stub, (_instance, state) => {
    seed(state.storage.sql);
    test(state.storage);
  });
}

describe("media transport semantics", () => {
  it("keeps backing audio running when the visual channel is stopped", async () => {
    await withShow("media-stop", (storage) => {
      expect(
        command(storage, "PLAY_CUE", { cueId: "cue-audio" }).acknowledgement
          .status,
      ).toBe("accepted");
      expect(
        command(storage, "PLAY_CUE", { cueId: "cue-visual" }).acknowledgement
          .status,
      ).toBe("accepted");

      const playing = runtime(storage);
      expect(playing.active_audio_cue_id).toBe("cue-audio");
      expect(playing.active_visual_cue_id).toBe("cue-visual");
      expect(playing.audio_transport).toBe("PLAYING");

      expect(command(storage, "STOP_MEDIA").acknowledgement.status).toBe(
        "accepted",
      );
      const stopped = runtime(storage);
      expect(stopped.active_visual_cue_id).toBeNull();
      expect(stopped.visual_transport).toBe("STOPPED");
      expect(stopped.active_audio_cue_id).toBe("cue-audio");
      expect(stopped.audio_transport).toBe("PLAYING");
    });
  });

  it("stops every transport only on STOP ALL", async () => {
    await withShow("media-stop-all", (storage) => {
      command(storage, "PLAY_CUE", { cueId: "cue-audio" });
      command(storage, "PLAY_CUE", { cueId: "cue-visual" });
      command(storage, "BLACK_SCREEN");
      expect(runtime(storage).black_screen).toBe(1);

      expect(command(storage, "STOP_ALL_MEDIA").acknowledgement.status).toBe(
        "accepted",
      );
      const stopped = runtime(storage);
      expect(stopped.active_visual_cue_id).toBeNull();
      expect(stopped.active_audio_cue_id).toBeNull();
      expect(stopped.visual_transport).toBe("STOPPED");
      expect(stopped.audio_transport).toBe("STOPPED");
      expect(stopped.black_screen).toBe(0);
    });
  });

  it("replays backing audio without disturbing the visual channel", async () => {
    await withShow("media-replay", (storage) => {
      expect(command(storage, "REPLAY_MEDIA").acknowledgement).toMatchObject({
        status: "rejected",
        reason: "There is no backing audio to replay",
      });

      command(storage, "PLAY_CUE", { cueId: "cue-audio" });
      command(storage, "PLAY_CUE", { cueId: "cue-visual" });
      command(storage, "PAUSE_MEDIA");
      expect(runtime(storage).audio_transport).toBe("PAUSED");

      expect(command(storage, "REPLAY_MEDIA").acknowledgement.status).toBe(
        "accepted",
      );
      const replayed = runtime(storage);
      expect(replayed.audio_transport).toBe("PLAYING");
      expect(replayed.visual_transport).toBe("PAUSED");
      expect(replayed.active_visual_cue_id).toBe("cue-visual");
    });
  });

  it("toggles the black screen and never silences audio with it", async () => {
    await withShow("media-black", (storage) => {
      command(storage, "PLAY_CUE", { cueId: "cue-audio" });
      command(storage, "BLACK_SCREEN");
      expect(runtime(storage).black_screen).toBe(1);
      expect(runtime(storage).audio_transport).toBe("PLAYING");

      command(storage, "BLACK_SCREEN");
      expect(runtime(storage).black_screen).toBe(0);
      expect(runtime(storage).audio_transport).toBe("PLAYING");
    });
  });

  it("never sends operator labels or backstage notes to the projector", async () => {
    await withShow("media-projection", (storage) => {
      const projection = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "projector",
      });
      expect(projection?.role).toBe("projector");
      const serialised = JSON.stringify(projection);
      expect(serialised).not.toContain("Operator label");
      expect(serialised).not.toContain("Do not show this to the hall");
      expect(serialised).not.toContain("BACKSTAGE");
      expect(serialised).toContain("asset-audio");
    });
  });

  it("gives an audience phone the display mode but no private state", async () => {
    await withShow("media-audience", (storage) => {
      const projection = projectShowState(storage, PRIMARY_SHOW_ID, {
        kind: "audience",
      });
      expect(projection?.role).toBe("audience");
      if (projection?.role !== "audience") return;
      expect(projection.show.displayMode).toBe("PERFORMANCE");
      const serialised = JSON.stringify(projection);
      expect(serialised).not.toContain("asset-audio");
      expect(serialised).not.toContain("BACKSTAGE");
    });
  });

  it("executes cue-stack audio and visual actions without crossing channels", async () => {
    await withShow("media-operation-stack", (storage) => {
      const insert = (
        id: string,
        position: number,
        operations: readonly Record<string, unknown>[],
        audioSource: string | null = null,
        visualSentinel = "TITLE_CARD",
      ) =>
        storage.sql.exec(
          `INSERT INTO cues (
            id, show_id, act_id, position, visual_kind, visual_source_key,
            visual_title, audio_kind, audio_source_key, duration_ms,
            created_at, updated_at, operator_label, operations_json, internal_note
          ) VALUES (?, ?, 'act-1', ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, '')`,
          id,
          PRIMARY_SHOW_ID,
          position,
          visualSentinel,
          audioSource ? "AUDIO" : null,
          audioSource,
          now,
          now,
          id,
          JSON.stringify(operations),
        );
      insert(
        "cue-load",
        2,
        [{ kind: "audio", action: "LOAD", assetId: "asset-track" }],
        "asset-track",
      );
      insert("cue-resume", 3, [{ kind: "audio", action: "RESUME" }]);
      insert("cue-pause", 4, [{ kind: "audio", action: "PAUSE" }]);
      insert("cue-seek", 5, [
        { kind: "audio", action: "SEEK", positionMs: 12_500 },
      ]);
      insert("cue-black-operation", 6, [
        {
          kind: "visual",
          visual: { kind: "BLACK", sourceKey: null, title: null },
        },
      ]);
      insert("cue-clear-operation", 7, [
        {
          kind: "visual",
          visual: { kind: "CLEAR", sourceKey: null, title: null },
        },
      ]);

      command(storage, "PLAY_CUE", { cueId: "cue-visual" });
      command(storage, "PLAY_CUE", { cueId: "cue-load" });
      expect(runtime(storage)).toMatchObject({
        active_visual_cue_id: "cue-visual",
        active_audio_cue_id: "cue-load",
        audio_transport: "PLAYING",
      });
      command(storage, "PLAY_CUE", { cueId: "cue-resume" });
      expect(runtime(storage).audio_transport).toBe("PLAYING");
      command(storage, "PLAY_CUE", { cueId: "cue-pause" });
      expect(runtime(storage).audio_transport).toBe("PAUSED");
      command(storage, "PLAY_CUE", { cueId: "cue-seek" });
      expect(runtime(storage)).toMatchObject({
        active_visual_cue_id: "cue-visual",
        active_audio_cue_id: "cue-load",
        audio_transport: "PLAYING",
      });
      command(storage, "PLAY_CUE", { cueId: "cue-black-operation" });
      expect(runtime(storage)).toMatchObject({
        black_screen: 1,
        active_audio_cue_id: "cue-load",
      });
      command(storage, "PLAY_CUE", { cueId: "cue-clear-operation" });
      expect(runtime(storage)).toMatchObject({
        black_screen: 0,
        active_visual_cue_id: null,
        active_audio_cue_id: "cue-load",
      });
    });
  });
});
