import type { ClientHello } from "../shared/protocol";
import { judgeId, type ConnectionRole } from "../shared/domain";

function secretBinding(env: object, name: string): string | undefined {
  const value = (env as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

function sameSecret(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const maxLength = Math.max(leftBytes.length, rightBytes.length);

  for (let index = 0; index < maxLength; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

async function digestToken(token: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
}

/**
 * Role elevation is deliberately fail-closed. Deployments configure the two
 * operator secrets as Worker secrets; private judges use only a token hash.
 */
export async function authenticateSocketRole(
  env: object,
  sql: SqlStorage,
  showIdentifier: string,
  hello: ClientHello,
): Promise<ConnectionRole | null> {
  switch (hello.requestedRole) {
    case "audience":
      return { kind: "audience" };
    case "admin":
      return hello.credential &&
        secretBinding(env, "ADMIN_ACCESS_TOKEN") &&
        sameSecret(
          hello.credential,
          secretBinding(env, "ADMIN_ACCESS_TOKEN") ?? "",
        )
        ? { kind: "admin" }
        : null;
    case "projector":
      return hello.credential &&
        secretBinding(env, "PROJECTOR_ACCESS_TOKEN") &&
        sameSecret(
          hello.credential,
          secretBinding(env, "PROJECTOR_ACCESS_TOKEN") ?? "",
        )
        ? { kind: "projector" }
        : null;
    case "judge": {
      if (!hello.credential || hello.credential.length > 512) {
        return null;
      }
      const tokenHash = await digestToken(hello.credential);
      const row = sql
        .exec<{ id: string }>(
          `SELECT id FROM judges
           WHERE show_id = ? AND token_hash = ? AND revoked_at IS NULL`,
          showIdentifier,
          tokenHash,
        )
        .toArray()[0];
      return row ? { kind: "judge", judgeId: judgeId(row.id) } : null;
    }
  }
}
