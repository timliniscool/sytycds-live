import type { ClientHello } from "../shared/protocol";
import { judgeId, type ConnectionRole } from "../shared/domain";
import { isAdminSessionHashActive } from "./admin-auth";
import { sameSecret, tokenHash } from "./security";

function projectorSecret(env: object): string | undefined {
  const value = (env as Record<string, unknown>).PROJECTOR_ACCESS_TOKEN;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Role elevation fails closed; admin authority originates from the HTTP session. */
export async function authenticateSocketRole(
  env: object,
  sql: SqlStorage,
  showIdentifier: string,
  hello: ClientHello,
  adminSessionHash: ArrayBuffer | null,
): Promise<ConnectionRole | null> {
  switch (hello.requestedRole) {
    case "audience":
      return { kind: "audience" };
    case "admin":
      return adminSessionHash && isAdminSessionHashActive(sql, adminSessionHash)
        ? { kind: "admin" }
        : null;
    case "projector": {
      const secret = projectorSecret(env);
      return hello.credential && secret && sameSecret(hello.credential, secret)
        ? { kind: "projector" }
        : null;
    }
    case "judge": {
      if (!hello.credential || hello.credential.length > 512) {
        return null;
      }
      const presentedHash = await tokenHash(hello.credential);
      const row = sql
        .exec<{ id: string }>(
          `SELECT id FROM judges
           WHERE show_id = ? AND token_hash = ? AND revoked_at IS NULL`,
          showIdentifier,
          presentedHash,
        )
        .toArray()[0];
      return row ? { kind: "judge", judgeId: judgeId(row.id) } : null;
    }
  }
}
