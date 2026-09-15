import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "../shared/domain";
import { parseClientMessage } from "../shared/protocol";
import {
  REACTION_EPOCH_MS,
  REACTION_INTERVAL_MS,
  REACTION_MAX_UNITS,
  reactionTrafficEstimate,
  reporterEligible,
} from "../shared/reactions";
import { calculateFinalScore } from "../shared/scoring";
import { ReactionReporter } from "../src/vote/reaction-reporter";
import {
  ADMIN_PBKDF2_ITERATIONS,
  createAdminSession,
  destroyAdminSession,
  readAdminSession,
  recoverAdminCredential,
} from "../worker/admin-auth";
import {
  generateProjectorPairingCode,
  pairProjector,
  readProjectorSessionHash,
  revokeProjectors,
} from "../worker/projector-pairing";
import {
  applyScoringConfiguration,
  scoringDataExists,
} from "../worker/scoring-config";
import { PRIMARY_SHOW_ID } from "../worker/show-state";
import { upsertShow } from "../worker/show-config";
import { validateReactionSummary } from "../worker/reactions";
import { cueValidationState } from "../worker/cues";
import { updateMediaMetadata } from "../worker/media-assets";

async function withStorage(
  name: string,
  run: (storage: DurableObjectStorage) => Promise<void> | void,
) {
  const stub = env.SHOW_COORDINATOR.get(env.SHOW_COORDINATOR.idFromName(name));
  await stub.fetch("https://show.internal/health");
  await runInDurableObject(stub, async (_instance, state) =>
    run(state.storage),
  );
}

describe("dynamic scoring configuration", () => {
  it.each([1, 2, 3, 4, 5, 8])(
    "uses the mean of %i equally weighted judges",
    (count) => {
      const scores = Array.from({ length: count }, (_, index) => index + 1);
      const result = calculateFinalScore(scores, 8, 0.5);
      expect(result).toEqual({
        kind: "complete",
        value: 4 + scores.reduce((sum, score) => sum + score, 0) / count / 2,
      });
    },
  );

  it.each([
    [0, 6],
    [0.25, 6.5],
    [0.5, 7],
    [0.75, 7.5],
    [1, 8],
  ])("supports audience allocation %f", (weight, expected) => {
    expect(calculateFinalScore([6, 6, 6, 6], 8, weight)).toEqual({
      kind: "complete",
      value: expected,
    });
  });

  it("does not require a zero-weight block", () => {
    expect(calculateFinalScore([10], null, 0)).toEqual({
      kind: "complete",
      value: 10,
    });
    expect(calculateFinalScore([], 7, 1)).toEqual({
      kind: "complete",
      value: 7,
    });
  });

  it("locks configuration after scoring and resets it only with explicit confirmation", async () => {
    await withStorage("scoring-config-p1", async (storage) => {
      upsertShow(storage, PRIMARY_SHOW_ID, { title: "Show", tagline: "" });
      const configured = await applyScoringConfiguration(
        storage,
        PRIMARY_SHOW_ID,
        {
          judgeNames: Array.from(
            { length: 5 },
            (_, index) => `Judge ${index + 1}`,
          ),
          audienceWeight: 0.25,
          reset: false,
          confirm: null,
        },
      );
      expect(configured.ok && configured.issued).toHaveLength(5);
      const now = new Date().toISOString();
      storage.sql.exec(
        `INSERT INTO acts (id, show_id, order_index, performer_name, school_year,
          act_name, act_type, public_description, internal_notes, created_at, updated_at)
         VALUES ('act-1', ?, 0, 'P', 'Y', 'A', 'T', '', '', ?, ?)`,
        PRIMARY_SHOW_ID,
        now,
        now,
      );
      storage.sql.exec(
        `INSERT INTO audience_votes
          (show_id, act_id, voter_id_hash, score, weight, weighted_score, received_at)
         VALUES (?, 'act-1', ?, 8, 0.95, 7.6, ?)`,
        PRIMARY_SHOW_ID,
        new Uint8Array(32).buffer,
        now,
      );
      expect(scoringDataExists(storage.sql, PRIMARY_SHOW_ID)).toBe(true);
      const blocked = await applyScoringConfiguration(
        storage,
        PRIMARY_SHOW_ID,
        {
          judgeNames: Array.from(
            { length: 3 },
            (_, index) => `Judge ${index + 1}`,
          ),
          audienceWeight: 0.75,
          reset: false,
          confirm: null,
        },
      );
      expect(blocked).toMatchObject({ ok: false, status: 409 });
      const reset = await applyScoringConfiguration(storage, PRIMARY_SHOW_ID, {
        judgeNames: Array.from(
          { length: 3 },
          (_, index) => `Judge ${index + 1}`,
        ),
        audienceWeight: 0.75,
        reset: true,
        confirm: "RESET SCORING",
      });
      expect(reset).toMatchObject({ ok: true, scoringReset: true });
      expect(scoringDataExists(storage.sql, PRIMARY_SHOW_ID)).toBe(false);
    });
  });
});

describe("credential architecture", () => {
  it("stays within the Cloudflare Workers PBKDF2 limit", () => {
    expect(ADMIN_PBKDF2_ITERATIONS).toBe(100_000);
  });

  it("recovers the stored admin credential exactly once without touching show data", async () => {
    await withStorage("admin-recovery", async (storage) => {
      upsertShow(storage, PRIMARY_SHOW_ID, {
        title: "Recovery must preserve me",
        tagline: "",
      });
      const oldLogin = await createAdminSession(
        storage,
        new Request("https://show.test/api/admin/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: "old",
            password: "old-password-value",
          }),
        }),
        { username: "old", password: "old-password-value" },
        PRIMARY_SHOW_ID,
      );
      expect(oldLogin.ok).toBe(true);
      const token = "A".repeat(43);
      expect(
        await recoverAdminCredential(
          storage,
          { username: "operator", password: "new-password-value" },
          token,
          "B".repeat(43),
        ),
      ).toBe("not_accepted");
      expect(
        await recoverAdminCredential(
          storage,
          { username: "operator", password: "new-password-value" },
          token,
          token,
        ),
      ).toBe("recovered");
      expect(
        storage.sql
          .exec<{ title: string }>(
            "SELECT title FROM shows WHERE id = ?",
            PRIMARY_SHOW_ID,
          )
          .one().title,
      ).toBe("Recovery must preserve me");
      expect(
        storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM admin_sessions",
          )
          .one().count,
      ).toBe(0);
      expect(
        await recoverAdminCredential(
          storage,
          { username: "another", password: "another-password" },
          token,
          token,
        ),
      ).toBe("already_used");

      const newLogin = await createAdminSession(
        storage,
        new Request("https://show.test/api/admin/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: "operator",
            password: "new-password-value",
          }),
        }),
        { username: "ignored", password: "ignored-password" },
        PRIMARY_SHOW_ID,
      );
      expect(newLogin.ok).toBe(true);
    });
  });

  it("verifies username/password server-side and creates an HttpOnly session", async () => {
    await withStorage("admin-password-p1", async (storage) => {
      const result = await createAdminSession(
        storage,
        new Request("https://show.test/api/admin/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://show.test",
          },
          body: JSON.stringify({
            username: "operator",
            password: "a strong password",
          }),
        }),
        { username: "operator", password: "a strong password" },
        PRIMARY_SHOW_ID,
      );
      expect(result.ok).toBe(true);
      expect(result.setCookie).toContain("HttpOnly");
      expect(
        storage.sql
          .exec<{ verifier: ArrayBuffer }>(
            "SELECT verifier FROM admin_credentials",
          )
          .one().verifier.byteLength,
      ).toBe(32);
    });
  });

  it("rejects a bad password, expires sessions, and logs out server-side", async () => {
    await withStorage("admin-session-lifecycle-p2", async (storage) => {
      upsertShow(storage, PRIMARY_SHOW_ID, { title: "Show", tagline: "" });
      const request = (password: string, cookie?: string) =>
        new Request("https://show.test/api/admin/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://show.test",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: JSON.stringify({ username: "operator", password }),
        });
      expect(
        await createAdminSession(
          storage,
          request("wrong password"),
          { username: "operator", password: "correct password" },
          PRIMARY_SHOW_ID,
        ),
      ).toMatchObject({ ok: false, status: 401 });
      const login = await createAdminSession(
        storage,
        request("correct password"),
        { username: "operator", password: "correct password" },
        PRIMARY_SHOW_ID,
      );
      expect(login.ok).toBe(true);
      const cookie = login.setCookie?.split(";", 1)[0] ?? "";
      const sessionRequest = new Request(
        "https://show.test/api/admin/session",
        {
          headers: { Cookie: cookie },
        },
      );
      expect(
        await readAdminSession(storage.sql, sessionRequest),
      ).not.toBeNull();
      const logoutCookie = await destroyAdminSession(storage, sessionRequest);
      expect(logoutCookie).toContain("Max-Age=0");
      expect(await readAdminSession(storage.sql, sessionRequest)).toBeNull();

      const relogin = await createAdminSession(
        storage,
        request("correct password"),
        { username: "operator", password: "correct password" },
        PRIMARY_SHOW_ID,
      );
      const reloginCookie = relogin.setCookie?.split(";", 1)[0] ?? "";
      storage.sql.exec("UPDATE admin_sessions SET expires_at = 0");
      expect(
        await readAdminSession(
          storage.sql,
          new Request("https://show.test", {
            headers: { Cookie: reloginCookie },
          }),
        ),
      ).toBeNull();
    });
  });

  it("uses an expiring one-time projector code then a long-lived opaque cookie", async () => {
    await withStorage("projector-pair-p1", async (storage) => {
      upsertShow(storage, PRIMARY_SHOW_ID, { title: "Show", tagline: "" });
      const issued = await generateProjectorPairingCode(
        storage,
        PRIMARY_SHOW_ID,
      );
      expect(issued.code).toMatch(/^\d{8}$/u);
      const request = new Request("https://show.test/api/projector/pair", {
        method: "POST",
      });
      const paired = await pairProjector(
        storage,
        request,
        PRIMARY_SHOW_ID,
        issued.code,
      );
      expect(paired.ok).toBe(true);
      if (!paired.ok) return;
      expect(paired.setCookie).toContain("HttpOnly");
      expect(
        storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM projector_pairing_codes",
          )
          .one().count,
      ).toBe(0);
      const cookie = paired.setCookie.split(";", 1)[0]!;
      expect(
        await readProjectorSessionHash(
          storage.sql,
          new Request("https://show.test", { headers: { Cookie: cookie } }),
        ),
      ).not.toBeNull();
    });
  });

  it("rejects wrong, expired, reused, and revoked projector credentials", async () => {
    await withStorage("projector-credential-lifecycle-p2", async (storage) => {
      upsertShow(storage, PRIMARY_SHOW_ID, { title: "Show", tagline: "" });
      const request = new Request("https://show.test/api/projector/pair", {
        method: "POST",
      });
      const issued = await generateProjectorPairingCode(
        storage,
        PRIMARY_SHOW_ID,
      );
      const wrong = issued.code === "00000000" ? "11111111" : "00000000";
      expect(
        await pairProjector(storage, request, PRIMARY_SHOW_ID, wrong),
      ).toMatchObject({ ok: false, status: 401 });
      const paired = await pairProjector(
        storage,
        request,
        PRIMARY_SHOW_ID,
        issued.code,
      );
      expect(paired.ok).toBe(true);
      expect(
        await pairProjector(storage, request, PRIMARY_SHOW_ID, issued.code),
      ).toMatchObject({ ok: false, status: 401 });
      if (!paired.ok) return;
      const cookie = paired.setCookie.split(";", 1)[0]!;
      const sessionRequest = new Request("https://show.test", {
        headers: { Cookie: cookie },
      });
      expect(
        await readProjectorSessionHash(storage.sql, sessionRequest),
      ).not.toBeNull();
      // The local Durable Object test store can survive watch/retry runs, so an
      // earlier unrevoked session may also be retired here.
      expect(revokeProjectors(storage, PRIMARY_SHOW_ID)).toBeGreaterThanOrEqual(
        1,
      );
      expect(
        await readProjectorSessionHash(storage.sql, sessionRequest),
      ).toBeNull();

      const expiring = await generateProjectorPairingCode(
        storage,
        PRIMARY_SHOW_ID,
      );
      storage.sql.exec(
        "UPDATE projector_pairing_codes SET expires_at = 0 WHERE show_id = ?",
        PRIMARY_SHOW_ID,
      );
      expect(
        await pairProjector(storage, request, PRIMARY_SHOW_ID, expiring.code),
      ).toMatchObject({
        ok: false,
        status: 401,
        error: "Pairing code expired",
      });
    });
  });
});

describe("cue media integrity", () => {
  it("distinguishes missing and incompatible media before a cue is saved", async () => {
    await withStorage("cue-validation-p1", async (storage) => {
      upsertShow(storage, PRIMARY_SHOW_ID, { title: "Show", tagline: "" });
      const now = new Date().toISOString();
      storage.sql.exec(
        `INSERT INTO media_assets
          (id, show_id, object_key, original_filename, mime_type, size_bytes,
           version_identifier, duration_ms, width, height, uploaded_at, deleted_at)
         VALUES ('asset-image', ?, 'private/image', 'image.png', 'image/png', 10,
           'v1', NULL, NULL, NULL, ?, NULL)`,
        PRIMARY_SHOW_ID,
        now,
      );
      expect(
        cueValidationState(storage.sql, PRIMARY_SHOW_ID, [
          {
            kind: "visual",
            visual: { kind: "IMAGE", sourceKey: "missing", title: null },
          },
        ]),
      ).toBe("MISSING_MEDIA");
      expect(
        cueValidationState(storage.sql, PRIMARY_SHOW_ID, [
          { kind: "audio", action: "LOAD", assetId: "asset-image" },
        ]),
      ).toBe("INCOMPATIBLE_MEDIA");
      expect(
        cueValidationState(storage.sql, PRIMARY_SHOW_ID, [
          {
            kind: "visual",
            visual: {
              kind: "IMAGE",
              sourceKey: "asset-image",
              title: null,
            },
          },
        ]),
      ).toBe("VALID");
    });
  });

  it("persists bounded browser-extracted media metadata", async () => {
    await withStorage("media-metadata-p2", (storage) => {
      upsertShow(storage, PRIMARY_SHOW_ID, { title: "Show", tagline: "" });
      storage.sql.exec(
        `INSERT INTO media_assets
          (id, show_id, object_key, original_filename, mime_type, size_bytes,
           version_identifier, duration_ms, width, height, uploaded_at, deleted_at)
         VALUES ('asset-video', ?, 'private/video', 'video.mp4', 'video/mp4', 10,
           'v1', NULL, NULL, NULL, ?, NULL)`,
        PRIMARY_SHOW_ID,
        new Date().toISOString(),
      );
      expect(
        updateMediaMetadata(storage, PRIMARY_SHOW_ID, "asset-video", {
          durationMs: 92_500,
          width: 1920,
          height: 1080,
        }),
      ).toBe(true);
      expect(
        storage.sql
          .exec<{
            duration_ms: number;
            width: number;
            height: number;
          }>(
            "SELECT duration_ms, width, height FROM media_assets WHERE id = 'asset-video'",
          )
          .one(),
      ).toEqual({ duration_ms: 92_500, width: 1920, height: 1080 });
      expect(
        updateMediaMetadata(storage, PRIMARY_SHOW_ID, "asset-video", {
          durationMs: -1,
          width: 1920,
          height: 1080,
        }),
      ).toBe(false);
    });
  });
});

describe("hard-budget reactions", () => {
  it("keeps taps local and limits 1000 continuous clients to one packet per second", () => {
    const start = REACTION_EPOCH_MS * 100;
    const reporters = Array.from({ length: 1_000 }, () => {
      const reporter = new ReactionReporter();
      for (let tap = 0; tap < 50; tap += 1) reporter.tap("applause");
      return reporter;
    });
    const packetsPerSecond = Array.from(
      { length: REACTION_INTERVAL_MS / 1_000 },
      (_, second) =>
        reporters.reduce((packets, reporter, slot) => {
          const packet = reporter.flush(start + second * 1_000, {
            slot,
            serverOffsetMs: 0,
            epochMs: REACTION_EPOCH_MS,
            intervalMs: REACTION_INTERVAL_MS,
            eligibleSlots: 5,
          });
          if (packet) {
            expect(
              packet.histogram.reduce((sum, count) => sum + count, 0),
            ).toBe(REACTION_MAX_UNITS);
          }
          return packets + (packet ? 1 : 0);
        }, 0),
    );
    expect(packetsPerSecond).toEqual([1, 1, 1, 1, 1]);
  });

  it("rotates cohorts and rejects invalid, duplicate, disabled and emergency packets", () => {
    const epoch = 100;
    const first = Array.from({ length: 1_000 }, (_, slot) => slot).filter(
      (slot) => reporterEligible(slot, epoch),
    );
    const second = Array.from({ length: 1_000 }, (_, slot) => slot).filter(
      (slot) => reporterEligible(slot, epoch + 1),
    );
    expect(first).toHaveLength(5);
    expect(second).toHaveLength(5);
    expect(second).not.toEqual(first);
    const now = epoch * REACTION_EPOCH_MS;
    const valid = {
      slot: first[0]!,
      epoch,
      interval: Math.floor(now / REACTION_INTERVAL_MS),
      lastInterval: -1,
      now,
      enabled: true,
      emergency: false,
      histogram: [1, 0, 0, 0, 0] as const,
      eligibleSlots: 5,
    };
    expect(validateReactionSummary(valid)).toBe(true);
    expect(validateReactionSummary({ ...valid, slot: 500 })).toBe(false);
    expect(
      validateReactionSummary({ ...valid, lastInterval: valid.interval }),
    ).toBe(false);
    expect(validateReactionSummary({ ...valid, enabled: false })).toBe(false);
    expect(validateReactionSummary({ ...valid, emergency: true })).toBe(false);
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "reaction_summary",
          protocolVersion: PROTOCOL_VERSION,
          epoch,
          interval: valid.interval,
          histogram: ["🔥", 0, 0, 0, 0],
        }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("budgets a three-hour show at 10,800 raw packets, about 540 billable 20-message units", () => {
    const messages = reactionTrafficEstimate(1_000, 3 * 60 * 60);
    expect(messages).toBe(10_800);
    expect(Math.ceil(messages / 20)).toBe(540);
  });

  it("accepts an idempotent operator reaction-clear command", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "clear_reactions",
          protocolVersion: PROTOCOL_VERSION,
          commandId: "clear-123",
        }),
      ),
    ).toMatchObject({
      ok: true,
      message: { type: "clear_reactions", commandId: "clear-123" },
    });
  });
});
