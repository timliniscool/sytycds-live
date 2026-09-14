import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  createAdminSession,
  destroyAdminSession,
  readAdminSession,
} from "../worker/admin-auth";
import {
  hasAudienceVote,
  resolveVoterIdentity,
  submitAudienceVote,
} from "../worker/audience-votes";
import {
  createJudges,
  listJudges,
  revokeJudge,
  rotateJudgeToken,
} from "../worker/judge-lifecycle";
import { tokenHash } from "../worker/security";
import { PRIMARY_SHOW_ID } from "../worker/show-state";

const now = "2026-09-14T00:00:00.000Z";

function seedVotingShow(sql: SqlStorage): void {
  sql.exec(
    `INSERT INTO shows (
      id, title, display_mode, audience_vote_state, result_reveal_state,
      active_act_id, revision, created_at, updated_at
    ) VALUES (?, 'Show', 'LOBBY', 'OPEN', 'HIDDEN', 'act-1', 0, ?, ?)`,
    PRIMARY_SHOW_ID,
    now,
    now,
  );
  sql.exec(
    `INSERT INTO acts (
      id, show_id, order_index, performer_name, school_year, act_name,
      act_type, public_description, internal_notes, created_at, updated_at
    ) VALUES ('act-1', ?, 0, 'P', 'Y', 'A', 'Music', 'D', '', ?, ?)`,
    PRIMARY_SHOW_ID,
    now,
    now,
  );
}

async function withShow(
  name: string,
  run: (storage: DurableObjectStorage) => Promise<void> | void,
): Promise<void> {
  const stub = env.SHOW_COORDINATOR.get(env.SHOW_COORDINATOR.idFromName(name));
  await stub.fetch("https://show.internal/health");
  await runInDurableObject(stub, async (_instance, state) => {
    seedVotingShow(state.storage.sql);
    await run(state.storage);
  });
}

describe("admin sessions, anonymous voters, and judge tokens", () => {
  it("issues revocable HttpOnly admin sessions and throttles failed logins", async () => {
    await withShow("security-session", async (storage) => {
      const loginRequest = new Request("https://show.test/api/admin/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://show.test",
        },
        body: JSON.stringify({ secret: "correct" }),
      });
      const login = await createAdminSession(storage, loginRequest, "correct");
      expect(login.ok).toBe(true);
      expect(login.setCookie).toContain("HttpOnly");
      expect(login.setCookie).toContain("Secure");
      const cookie = login.setCookie?.split(";")[0] ?? "";
      const authenticatedRequest = new Request(
        "https://show.test/api/admin/session",
        {
          headers: { Cookie: cookie },
        },
      );
      expect(
        await readAdminSession(storage.sql, authenticatedRequest),
      ).not.toBeNull();
      const modified = new Request("https://show.test/api/admin/session", {
        headers: { Cookie: `${cookie}x` },
      });
      expect(await readAdminSession(storage.sql, modified)).toBeNull();
      await destroyAdminSession(storage, authenticatedRequest);
      expect(
        await readAdminSession(storage.sql, authenticatedRequest),
      ).toBeNull();

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const failed = await createAdminSession(
          storage,
          new Request("https://show.test/api/admin/login", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "https://show.test",
            },
            body: JSON.stringify({ secret: "wrong" }),
          }),
          "correct",
        );
        expect(failed.status).toBe(401);
      }
      const limited = await createAdminSession(
        storage,
        new Request("https://show.test/api/admin/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://show.test",
          },
          body: JSON.stringify({ secret: "correct" }),
        }),
        "correct",
      );
      expect(limited.status).toBe(429);
    });
  });

  it("issues hashed anonymous voter identities and atomically locks one vote", async () => {
    await withShow("security-voter", async (storage) => {
      const first = await resolveVoterIdentity(
        new Request("https://show.test/api/vote"),
      );
      expect(first.setCookie).toContain("HttpOnly");
      expect(first.setCookie).toContain("SameSite=Lax");
      const rawCookie = first.setCookie?.split(";")[0] ?? "";
      const rawToken = rawCookie.split("=")[1] ?? "";
      const modifiedToken = `${rawToken.slice(0, -1)}${rawToken.endsWith("A") ? "B" : "A"}`;
      const modified = await resolveVoterIdentity(
        new Request("https://show.test/api/vote", {
          headers: { Cookie: `sytycds_voter=${modifiedToken}` },
        }),
      );
      expect(modified.setCookie).toBeUndefined();
      expect(
        hasAudienceVote(storage.sql, PRIMARY_SHOW_ID, "act-1", modified.hash),
      ).toBe(false);
      const firstVote = submitAudienceVote(
        storage,
        PRIMARY_SHOW_ID,
        first.hash,
        {
          actIdentifier: "act-1",
          score: 7,
        },
      );
      const duplicate = submitAudienceVote(
        storage,
        PRIMARY_SHOW_ID,
        first.hash,
        {
          actIdentifier: "act-1",
          score: 7,
        },
      );
      expect(firstVote.ok).toBe(true);
      expect(duplicate).toEqual({ ok: false, code: "ALREADY_VOTED" });
      expect(
        hasAudienceVote(storage.sql, PRIMARY_SHOW_ID, "act-1", first.hash),
      ).toBe(true);
      expect(
        submitAudienceVote(storage, PRIMARY_SHOW_ID, modified.hash, {
          actIdentifier: "act-2",
          score: 5,
        }),
      ).toEqual({ ok: false, code: "WRONG_ACT" });
      const malformed = await resolveVoterIdentity(
        new Request("https://show.test/api/vote", {
          headers: { Cookie: "sytycds_voter=bad" },
        }),
      );
      expect(malformed.setCookie).toBeDefined();
      const concurrent = await Promise.all([
        Promise.resolve(
          submitAudienceVote(storage, PRIMARY_SHOW_ID, malformed.hash, {
            actIdentifier: "act-1",
            score: 5,
          }),
        ),
        Promise.resolve(
          submitAudienceVote(storage, PRIMARY_SHOW_ID, malformed.hash, {
            actIdentifier: "act-1",
            score: 5,
          }),
        ),
      ]);
      expect(concurrent.filter((result) => result.ok)).toHaveLength(1);
      storage.sql.exec(
        "UPDATE shows SET audience_vote_state = 'CLOSED' WHERE id = ?",
        PRIMARY_SHOW_ID,
      );
      expect(
        submitAudienceVote(storage, PRIMARY_SHOW_ID, modified.hash, {
          actIdentifier: "act-1",
          score: 5,
        }),
      ).toEqual({ ok: false, code: "VOTING_CLOSED" });
    });
  });

  it("creates exactly four hashed judge tokens and makes rotation revoke the old URL", async () => {
    await withShow("security-judges", async (storage) => {
      const issued = await createJudges(storage, PRIMARY_SHOW_ID, [
        "A",
        "B",
        "C",
        "D",
      ]);
      expect(issued).toHaveLength(4);
      expect(
        await createJudges(storage, PRIMARY_SHOW_ID, ["E", "F", "G", "H"]),
      ).toBeNull();
      const first = issued?.[0];
      if (!first) {
        throw new Error("Expected first judge");
      }
      const oldHash = await tokenHash(first.token);
      const rotated = await rotateJudgeToken(
        storage,
        PRIMARY_SHOW_ID,
        first.judgeId,
      );
      expect(rotated?.token).not.toBe(first.token);
      expect(
        storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM judges WHERE show_id = ? AND token_hash = ?",
            PRIMARY_SHOW_ID,
            oldHash,
          )
          .one().count,
      ).toBe(0);
      expect(listJudges(storage.sql, PRIMARY_SHOW_ID)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ linkAvailable: false }),
        ]),
      );
      expect(revokeJudge(storage, PRIMARY_SHOW_ID, first.judgeId)).toBe(true);
      expect(listJudges(storage.sql, PRIMARY_SHOW_ID)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.judgeId, active: false }),
        ]),
      );
    });
  });
});
