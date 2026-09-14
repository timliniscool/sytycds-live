import type { ClientHello } from "../shared/protocol";
import { judgeId, type ConnectionRole } from "../shared/domain";
import { isAdminSessionHashActive } from "./admin-auth";
import { tokenHash } from "./security";
import { projectorSessionActive } from "./projector-pairing";

/** Role elevation fails closed; admin authority originates from the HTTP session. */
export async function authenticateSocketRole(
  sql: SqlStorage,
  showIdentifier: string,
  hello: ClientHello,
  adminSessionHash: ArrayBuffer | null,
  projectorSessionHash: ArrayBuffer | null,
): Promise<ConnectionRole | null> {
  switch (hello.requestedRole) {
    case "audience":
      return { kind: "audience" };
    case "admin":
      return adminSessionHash && isAdminSessionHashActive(sql, adminSessionHash)
        ? { kind: "admin" }
        : null;
    case "projector":
      return projectorSessionHash &&
        projectorSessionActive(sql, projectorSessionHash)
        ? { kind: "projector" }
        : null;
    case "judge": {
      if (!hello.credential || hello.credential.length > 512) {
        return null;
      }
      const presentedHash = await tokenHash(hello.credential);
      const row = sql
        .exec<{ id: string }>(
          `SELECT id FROM show_judges
           WHERE show_id = ? AND token_hash = ? AND active = 1 AND credential_revoked_at IS NULL`,
          showIdentifier,
          presentedHash,
        )
        .toArray()[0];
      return row ? { kind: "judge", judgeId: judgeId(row.id) } : null;
    }
  }
}
