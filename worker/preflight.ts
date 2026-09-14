import { PROTOCOL_VERSION, type CueOperation } from "../shared/domain";
import type {
  PreflightAssetKind,
  PreflightAssetRequest,
  PreflightItem,
} from "../shared/preflight";
import { configuredPublicOrigin, normalisePublicOrigin } from "./public-origin";
import { LATEST_SCHEMA_VERSION, readSchemaVersion } from "./schema";

/** What the coordinator knows about its live sockets when preflight runs. */
export interface SocketInventory {
  projectors: number;
  projectorProtocolVersions: readonly number[];
  connectedJudgeIds: ReadonlySet<string>;
}

export interface ServerPreflightContext {
  sql: SqlStorage;
  bucket: R2Bucket;
  env: object;
  showIdentifier: string;
  sockets: SocketInventory;
  /** Rerun a single check by ID; undefined runs everything. */
  only?: string | undefined;
}

interface AssetRow extends Record<string, SqlStorageValue> {
  id: string;
  object_key: string;
  mime_type: string;
  original_filename: string;
}

interface CueRow extends Record<string, SqlStorageValue> {
  id: string;
  operator_label: string;
  operations_json: string;
}

const ALLOWED_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "video/mp4",
  "video/webm",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

function item(
  id: string,
  label: string,
  status: PreflightItem["status"],
  detail: string,
  required = true,
): PreflightItem {
  return { id, label, status, detail, required, group: "server" };
}

function referencedAssets(
  sql: SqlStorage,
  showIdentifier: string,
): Map<string, AssetRow> {
  const rows = sql
    .exec<AssetRow>(
      `SELECT DISTINCT m.id, m.object_key, m.mime_type, m.original_filename
       FROM media_assets m
       WHERE m.show_id = ? AND m.deleted_at IS NULL AND (
         EXISTS (SELECT 1 FROM cue_asset_references r
           WHERE r.show_id = m.show_id AND r.asset_id = m.id)
         OR EXISTS (SELECT 1 FROM acts a
           WHERE a.show_id = m.show_id AND a.public_image_asset_id = m.id)
       )`,
      showIdentifier,
    )
    .toArray();
  return new Map(rows.map((row) => [row.id, row]));
}

/** Every asset the projector would have to load, with how it will be used. */
export function preflightAssetRequests(
  sql: SqlStorage,
  showIdentifier: string,
): PreflightAssetRequest[] {
  return [...referencedAssets(sql, showIdentifier).values()].map((asset) => ({
    id: asset.id,
    kind: assetKind(asset.mime_type),
  }));
}

function assetKind(mimeType: string): PreflightAssetKind {
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "image";
}

interface CueUsage {
  cueLabel: string;
  assetId: string;
  usage: "IMAGE" | "SLIDES" | "VIDEO" | "AUDIO";
}

function cueUsages(sql: SqlStorage, showIdentifier: string): CueUsage[] {
  const usages: CueUsage[] = [];
  for (const cue of sql
    .exec<CueRow>(
      "SELECT id, operator_label, operations_json FROM cues WHERE show_id = ?",
      showIdentifier,
    )
    .toArray()) {
    let operations: CueOperation[] = [];
    try {
      const parsed: unknown = JSON.parse(cue.operations_json);
      if (Array.isArray(parsed)) operations = parsed as CueOperation[];
    } catch {
      continue;
    }
    const label = cue.operator_label || cue.id;
    for (const operation of operations) {
      if (
        operation.kind === "visual" &&
        operation.visual.sourceKey &&
        (operation.visual.kind === "IMAGE" ||
          operation.visual.kind === "SLIDES" ||
          operation.visual.kind === "VIDEO")
      ) {
        usages.push({
          cueLabel: label,
          assetId: operation.visual.sourceKey,
          usage: operation.visual.kind,
        });
      }
      if (operation.kind === "audio" && operation.assetId) {
        usages.push({
          cueLabel: label,
          assetId: operation.assetId,
          usage: "AUDIO",
        });
      }
    }
  }
  return usages;
}

function mimeSuitsUsage(mimeType: string, usage: CueUsage["usage"]): boolean {
  switch (usage) {
    case "IMAGE":
    case "SLIDES":
      return mimeType.startsWith("image/");
    case "VIDEO":
      return mimeType.startsWith("video/");
    case "AUDIO":
      return mimeType.startsWith("audio/") || mimeType.startsWith("video/");
  }
}

function summarise(labels: readonly string[]): string {
  const shown = labels.slice(0, 4).join(", ");
  return labels.length > 4 ? `${shown} and ${labels.length - 4} more` : shown;
}

/**
 * Runs every server-side probe. Each check is independent so a failure in one
 * cannot hide another, and a thrown probe is reported rather than propagated.
 */
export async function runServerPreflight(
  context: ServerPreflightContext,
): Promise<PreflightItem[]> {
  const checks: Record<string, () => Promise<PreflightItem> | PreflightItem> = {
    schema: () => {
      const version = readSchemaVersion(context.sql);
      return version === LATEST_SCHEMA_VERSION
        ? item("schema", "Database schema", "READY", `Version ${version}`)
        : item(
            "schema",
            "Database schema",
            "FAILURE",
            `Database is at version ${version}; this Worker expects ${LATEST_SCHEMA_VERSION}. Redeploy the Worker or restore the coordinator.`,
          );
    },
    show: () => {
      const show = context.sql
        .exec<{ title: string; intermission: string; emergency: string }>(
          "SELECT title, intermission_message AS intermission, emergency_message AS emergency FROM shows WHERE id = ?",
          context.showIdentifier,
        )
        .toArray()[0];
      if (!show)
        return item(
          "show",
          "Show configuration",
          "FAILURE",
          "No show exists in the coordinator. Provision the show before doors.",
        );
      if (show.title.trim().length === 0)
        return item(
          "show",
          "Show configuration",
          "FAILURE",
          "The show has no title; the lobby graphic would be blank.",
        );
      return item(
        "show",
        "Show configuration",
        "READY",
        `“${show.title}”${show.intermission ? "; intermission text set" : "; no intermission text"}${show.emergency ? "; emergency text set" : "; emergency text empty (black screen only)"}`,
      );
    },
    acts: () => {
      const counts = context.sql
        .exec<{ total: number; active: number }>(
          `SELECT COUNT(*) AS total, SUM(CASE WHEN withdrawn_at IS NULL THEN 1 ELSE 0 END) AS active
             FROM acts WHERE show_id = ?`,
          context.showIdentifier,
        )
        .one();
      const active = counts.active ?? 0;
      if (active === 0)
        return item(
          "acts",
          "Acts",
          "FAILURE",
          counts.total === 0
            ? "The running order is empty. Add the acts."
            : "Every act is withdrawn. Reinstate at least one act.",
        );
      return item(
        "acts",
        "Acts",
        "READY",
        `${active} act${active === 1 ? "" : "s"} in the running order${counts.total - active > 0 ? `, ${counts.total - active} withdrawn` : ""}`,
      );
    },
    running_order: () => {
      const orders = context.sql
        .exec<{ order_index: number }>(
          "SELECT order_index FROM acts WHERE show_id = ? ORDER BY order_index",
          context.showIdentifier,
        )
        .toArray()
        .map((row) => row.order_index);
      const contiguous = orders.every((order, index) => order === index);
      return contiguous
        ? item(
            "running_order",
            "Running order",
            "READY",
            orders.length === 0
              ? "No acts to order"
              : `Positions 1–${orders.length} are contiguous`,
          )
        : item(
            "running_order",
            "Running order",
            "FAILURE",
            "Act positions have a gap or duplicate. Re-save the running order from the console.",
          );
    },
    judges: () => {
      const judges = context.sql
        .exec<{ slot: number; revoked: string | null }>(
          "SELECT slot, CASE WHEN active = 1 AND credential_revoked_at IS NULL THEN NULL ELSE COALESCE(credential_revoked_at, deactivated_at, 'inactive') END AS revoked FROM show_judges WHERE show_id = ? ORDER BY slot",
          context.showIdentifier,
        )
        .toArray();
      const active = judges.filter((judge) => judge.revoked === null);
      if (judges.length === 0)
        return item(
          "judges",
          "Judge links",
          "FAILURE",
          "No judges have been configured. Configure between one and eight judges.",
        );
      if (active.length < 1 || active.length > 8)
        return item(
          "judges",
          "Judge links",
          "FAILURE",
          `${active.length} judge links are active; configure between one and eight.`,
        );
      return item(
        "judges",
        "Judge links",
        "READY",
        `${active.length} active judge link${active.length === 1 ? "" : "s"}`,
      );
    },
    judge_connections: () => {
      const judges = context.sql
        .exec<{ id: string; slot: number; display_name: string }>(
          "SELECT id, slot, display_name FROM show_judges WHERE show_id = ? AND active = 1 AND credential_revoked_at IS NULL ORDER BY slot",
          context.showIdentifier,
        )
        .toArray();
      const offline = judges.filter(
        (judge) => !context.sockets.connectedJudgeIds.has(judge.id),
      );
      return offline.length === 0
        ? item(
            "judge_connections",
            "Judge devices",
            judges.length === 0 ? "WARNING" : "READY",
            judges.length === 0
              ? "No judges to connect"
              : `All ${judges.length} judge device${judges.length === 1 ? " is" : "s are"} connected`,
            false,
          )
        : item(
            "judge_connections",
            "Judge devices",
            "WARNING",
            `Not connected: ${summarise(offline.map((judge) => `${judge.display_name} (judge ${judge.slot})`))}. Judges may open their links later.`,
            false,
          );
    },
    projector: () => {
      const count = context.sockets.projectors;
      if (count === 0)
        return item(
          "projector",
          "Projector connected",
          "FAILURE",
          "No projector is connected. Open /projector and enter a one-time pairing code.",
        );
      return item(
        "projector",
        "Projector connected",
        count === 1 ? "READY" : "WARNING",
        count === 1
          ? "One projector display connected"
          : `${count} projector displays are connected; only one should be public.`,
      );
    },
    projector_protocol: () => {
      const versions = context.sockets.projectorProtocolVersions;
      if (versions.length === 0)
        return item(
          "projector_protocol",
          "Projector protocol",
          "FAILURE",
          "Cannot verify until a projector connects.",
        );
      return versions.every((version) => version === PROTOCOL_VERSION)
        ? item(
            "projector_protocol",
            "Projector protocol",
            "READY",
            `Protocol version ${PROTOCOL_VERSION}`,
          )
        : item(
            "projector_protocol",
            "Projector protocol",
            "FAILURE",
            "A projector speaks a different protocol version. Reload the projector page.",
          );
    },
    media_references: () => {
      const assets = referencedAssets(context.sql, context.showIdentifier);
      const broken = cueUsages(context.sql, context.showIdentifier).filter(
        (usage) => !assets.has(usage.assetId),
      );
      return broken.length === 0
        ? item(
            "media_references",
            "Media references",
            "READY",
            `${assets.size} asset${assets.size === 1 ? "" : "s"} referenced by cues`,
          )
        : item(
            "media_references",
            "Media references",
            "FAILURE",
            `Cues point at missing or deleted media: ${summarise(broken.map((usage) => usage.cueLabel))}. Re-attach media in the cue editor.`,
          );
    },
    r2_objects: async () => {
      const assets = [
        ...referencedAssets(context.sql, context.showIdentifier).values(),
      ];
      const missing: string[] = [];
      for (const asset of assets) {
        try {
          if ((await context.bucket.head(asset.object_key)) === null)
            missing.push(asset.original_filename);
        } catch {
          return item(
            "r2_objects",
            "Media storage",
            "FAILURE",
            "The media bucket did not answer. Check the R2 binding and network.",
          );
        }
      }
      return missing.length === 0
        ? item(
            "r2_objects",
            "Media storage",
            "READY",
            `${assets.length} object${assets.length === 1 ? "" : "s"} present in R2`,
          )
        : item(
            "r2_objects",
            "Media storage",
            "FAILURE",
            `Missing from R2: ${summarise(missing)}. Re-upload these files.`,
          );
    },
    media_mime: () => {
      const assets = referencedAssets(context.sql, context.showIdentifier);
      const problems: string[] = [];
      const warnings: string[] = [];
      for (const usage of cueUsages(context.sql, context.showIdentifier)) {
        const asset = assets.get(usage.assetId);
        if (!asset) continue;
        if (!ALLOWED_MIME_TYPES.has(asset.mime_type)) {
          problems.push(`${asset.original_filename} (${asset.mime_type})`);
        } else if (asset.mime_type === "application/pdf") {
          warnings.push(
            `${usage.cueLabel}: PDF cannot render on the projector; export slides as images`,
          );
        } else if (!mimeSuitsUsage(asset.mime_type, usage.usage)) {
          problems.push(
            `${usage.cueLabel}: ${asset.mime_type} used as ${usage.usage}`,
          );
        }
      }
      if (problems.length > 0)
        return item(
          "media_mime",
          "Media types",
          "FAILURE",
          `Unusable media: ${summarise(problems)}.`,
        );
      if (warnings.length > 0)
        return item(
          "media_mime",
          "Media types",
          "WARNING",
          summarise(warnings),
        );
      return item(
        "media_mime",
        "Media types",
        "READY",
        "Every referenced asset has a playable type for its use",
      );
    },
    public_origin: () => {
      const raw = (context.env as Record<string, unknown>).PUBLIC_ORIGIN;
      const configured = configuredPublicOrigin(context.env);
      if (typeof raw === "string" && raw.trim().length > 0 && !configured)
        return item(
          "public_origin",
          "Production origin",
          "FAILURE",
          `PUBLIC_ORIGIN “${raw}” is not a bare https origin. Set it like https://show.example.school`,
        );
      if (!configured)
        return item(
          "public_origin",
          "Production origin",
          "WARNING",
          "PUBLIC_ORIGIN is not set; the QR uses whatever origin the projector browser opened. Fine locally, set it for the venue.",
          false,
        );
      return item(
        "public_origin",
        "Production origin",
        "READY",
        `QR points at ${normalisePublicOrigin(configured)}/vote`,
      );
    },
  };

  const selected = context.only
    ? Object.entries(checks).filter(([id]) => id === context.only)
    : Object.entries(checks);
  const items: PreflightItem[] = [];
  for (const [id, check] of selected) {
    try {
      items.push(await check());
    } catch (error: unknown) {
      items.push(
        item(
          id,
          id.replaceAll("_", " "),
          "FAILURE",
          error instanceof Error ? error.message : "Check threw",
        ),
      );
    }
  }
  return items;
}
