/**
 * The coordinator owns this schema. SQL is kept here rather than mirrored in a
 * client model or ORM so constraints remain the last line of defence.
 */

export interface SchemaMigration {
  version: number;
  name: string;
  statements: readonly string[];
}

const INITIAL_SCHEMA: SchemaMigration = {
  version: 1,
  name: "initial_show_coordinator_schema",
  statements: [
    `CREATE TABLE shows (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
      title TEXT NOT NULL CHECK (length(title) > 0),
      display_mode TEXT NOT NULL CHECK (display_mode IN (
        'LOBBY', 'ACT_CARD', 'PERFORMANCE', 'SCOREBOARD', 'INTERMISSION',
        'HOLD', 'FINAL_RESULTS', 'EMERGENCY'
      )),
      audience_vote_state TEXT NOT NULL CHECK (audience_vote_state IN ('OPEN', 'CLOSED')),
      result_reveal_state TEXT NOT NULL CHECK (result_reveal_state IN ('HIDDEN', 'REVEALED')),
      active_act_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE acts (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
      show_id TEXT NOT NULL,
      order_index INTEGER NOT NULL CHECK (order_index >= 0),
      performer_name TEXT NOT NULL,
      school_year TEXT NOT NULL,
      act_name TEXT NOT NULL,
      act_type TEXT NOT NULL,
      public_description TEXT NOT NULL,
      internal_notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (show_id, id),
      UNIQUE (show_id, order_index),
      FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE RESTRICT
    ) STRICT`,
    `CREATE TABLE cues (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
      show_id TEXT NOT NULL,
      act_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      visual_kind TEXT CHECK (visual_kind IN ('TITLE_CARD', 'IMAGE', 'SLIDES', 'VIDEO', 'BLACK')),
      visual_source_key TEXT,
      visual_title TEXT,
      audio_kind TEXT CHECK (audio_kind IN ('AUDIO', 'VIDEO_AUDIO')),
      audio_source_key TEXT,
      duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (visual_kind IS NOT NULL OR audio_kind IS NOT NULL),
      CHECK (audio_kind IS NULL OR audio_source_key IS NOT NULL),
      UNIQUE (show_id, act_id, position),
      FOREIGN KEY (show_id, act_id) REFERENCES acts(show_id, id) ON DELETE RESTRICT
    ) STRICT`,
    `CREATE TABLE judges (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
      show_id TEXT NOT NULL,
      slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 4),
      display_name TEXT NOT NULL,
      token_hash BLOB NOT NULL CHECK (length(token_hash) >= 32),
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      UNIQUE (show_id, id),
      UNIQUE (show_id, slot),
      UNIQUE (show_id, token_hash),
      FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE RESTRICT
    ) STRICT`,
    `CREATE TABLE judge_permissions (
      show_id TEXT NOT NULL,
      act_id TEXT NOT NULL,
      judge_id TEXT NOT NULL,
      permission_state TEXT NOT NULL CHECK (permission_state IN ('OPEN', 'CLOSED')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (show_id, act_id, judge_id),
      FOREIGN KEY (show_id, act_id) REFERENCES acts(show_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (show_id, judge_id) REFERENCES judges(show_id, id) ON DELETE RESTRICT
    ) STRICT`,
    `CREATE TABLE judge_submissions (
      show_id TEXT NOT NULL,
      act_id TEXT NOT NULL,
      judge_id TEXT NOT NULL,
      raw_input TEXT NOT NULL,
      parsed_classification TEXT NOT NULL CHECK (parsed_classification IN (
        'FINITE', 'POSITIVE_INFINITY', 'NEGATIVE_INFINITY'
      )),
      finite_value REAL,
      effective_score REAL NOT NULL,
      submitted_at TEXT NOT NULL,
      PRIMARY KEY (show_id, act_id, judge_id),
      CHECK (
        (parsed_classification = 'FINITE' AND finite_value IS NOT NULL) OR
        (parsed_classification != 'FINITE' AND finite_value IS NULL)
      ),
      FOREIGN KEY (show_id, act_id) REFERENCES acts(show_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (show_id, judge_id) REFERENCES judges(show_id, id) ON DELETE RESTRICT
    ) STRICT`,
    `CREATE TABLE audience_votes (
      show_id TEXT NOT NULL,
      act_id TEXT NOT NULL,
      voter_id_hash BLOB NOT NULL CHECK (length(voter_id_hash) >= 32),
      score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 10),
      weight REAL NOT NULL CHECK (weight > 0),
      weighted_score REAL NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (show_id, act_id, voter_id_hash),
      FOREIGN KEY (show_id, act_id) REFERENCES acts(show_id, id) ON DELETE RESTRICT
    ) STRICT`,
    `CREATE TABLE audience_aggregates (
      show_id TEXT NOT NULL,
      act_id TEXT NOT NULL,
      vote_count INTEGER NOT NULL DEFAULT 0 CHECK (vote_count >= 0),
      weighted_sum REAL NOT NULL DEFAULT 0,
      total_weight REAL NOT NULL DEFAULT 0 CHECK (total_weight >= 0),
      weighted_mean REAL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (show_id, act_id),
      CHECK (
        (vote_count = 0 AND total_weight = 0 AND weighted_mean IS NULL) OR
        (vote_count > 0 AND total_weight > 0 AND weighted_mean IS NOT NULL)
      ),
      FOREIGN KEY (show_id, act_id) REFERENCES acts(show_id, id) ON DELETE RESTRICT
    ) STRICT`,
    `CREATE TABLE result_snapshots (
      id INTEGER PRIMARY KEY,
      show_id TEXT NOT NULL,
      act_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      audience_mean REAL,
      judge_scores_json TEXT NOT NULL,
      final_score REAL,
      captured_at TEXT NOT NULL,
      UNIQUE (show_id, act_id, revision),
      FOREIGN KEY (show_id, act_id) REFERENCES acts(show_id, id) ON DELETE RESTRICT
    ) STRICT`,
    `CREATE TABLE finalised_results (
      show_id TEXT NOT NULL,
      act_id TEXT NOT NULL,
      audience_mean REAL NOT NULL,
      judge_1_effective_score REAL NOT NULL,
      judge_2_effective_score REAL NOT NULL,
      judge_3_effective_score REAL NOT NULL,
      judge_4_effective_score REAL NOT NULL,
      final_score REAL NOT NULL,
      finalised_at TEXT NOT NULL,
      PRIMARY KEY (show_id, act_id),
      FOREIGN KEY (show_id, act_id) REFERENCES acts(show_id, id) ON DELETE RESTRICT
    ) STRICT`,
    `CREATE TABLE command_log (
      show_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      actor_role TEXT NOT NULL CHECK (actor_role IN ('admin', 'projector', 'audience', 'judge')),
      outcome_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (show_id, command_id),
      FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE RESTRICT
    ) STRICT`,
    `CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY,
      show_id TEXT NOT NULL,
      command_id TEXT,
      actor_role TEXT NOT NULL CHECK (actor_role IN ('admin', 'projector', 'audience', 'judge', 'system')),
      event_type TEXT NOT NULL,
      event_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE RESTRICT
    ) STRICT`,
    "CREATE INDEX idx_cues_show_act_position ON cues (show_id, act_id, position)",
    "CREATE INDEX idx_audience_votes_show_act_received ON audience_votes (show_id, act_id, received_at)",
    "CREATE INDEX idx_result_snapshots_show_act_captured ON result_snapshots (show_id, act_id, captured_at DESC)",
    "CREATE INDEX idx_audit_events_show_occurred ON audit_events (show_id, occurred_at DESC)",
  ],
};

const SHOW_RUNTIME_SCHEMA: SchemaMigration = {
  version: 2,
  name: "persistent_operational_show_state",
  statements: [
    `CREATE TABLE show_runtime (
      show_id TEXT PRIMARY KEY NOT NULL,
      previous_display_mode TEXT CHECK (previous_display_mode IS NULL OR previous_display_mode IN (
        'LOBBY', 'ACT_CARD', 'PERFORMANCE', 'SCOREBOARD', 'INTERMISSION',
        'HOLD', 'FINAL_RESULTS', 'EMERGENCY'
      )),
      global_judge_permission TEXT NOT NULL DEFAULT 'CLOSED'
        CHECK (global_judge_permission IN ('OPEN', 'CLOSED')),
      prepared_cue_id TEXT,
      active_visual_cue_id TEXT,
      active_audio_cue_id TEXT,
      visual_transport TEXT NOT NULL DEFAULT 'STOPPED'
        CHECK (visual_transport IN ('STOPPED', 'PREPARED', 'PLAYING', 'PAUSED')),
      audio_transport TEXT NOT NULL DEFAULT 'STOPPED'
        CHECK (audio_transport IN ('STOPPED', 'PREPARED', 'PLAYING', 'PAUSED')),
      black_screen INTEGER NOT NULL DEFAULT 0 CHECK (black_screen IN (0, 1)),
      updated_at TEXT NOT NULL,
      FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE RESTRICT
    ) STRICT`,
    "CREATE INDEX idx_judge_permissions_show_act ON judge_permissions (show_id, act_id)",
  ],
};

const COMMAND_IDEMPOTENCY_SCHEMA: SchemaMigration = {
  version: 3,
  name: "command_request_fingerprint",
  statements: [
    `ALTER TABLE command_log
      ADD COLUMN request_fingerprint TEXT NOT NULL DEFAULT ''`,
  ],
};

const AUTH_AND_VOTER_SCHEMA: SchemaMigration = {
  version: 4,
  name: "admin_sessions_and_login_rate_limits",
  statements: [
    `CREATE TABLE admin_sessions (
      token_hash BLOB PRIMARY KEY NOT NULL CHECK (length(token_hash) = 32),
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    ) STRICT`,
    "CREATE INDEX idx_admin_sessions_expiry ON admin_sessions (expires_at)",
    `CREATE TABLE admin_login_limits (
      subject_hash BLOB PRIMARY KEY NOT NULL CHECK (length(subject_hash) = 32),
      window_started_at INTEGER NOT NULL,
      failed_count INTEGER NOT NULL CHECK (failed_count >= 0),
      blocked_until INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    ) STRICT`,
  ],
};

/**
 * Asset bytes live in R2; SQLite only records their immutable identity and
 * references.  Cue operations are deliberately JSON because they are a small,
 * discriminated command list, not arbitrary executable data.
 */
const RESULTS_ACTS_MEDIA_SCHEMA: SchemaMigration = {
  version: 5,
  name: "results_act_management_and_r2_media",
  statements: [
    `CREATE TABLE media_assets (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
      show_id TEXT NOT NULL,
      object_key TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      version_identifier TEXT NOT NULL,
      duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
      width INTEGER CHECK (width IS NULL OR width > 0),
      height INTEGER CHECK (height IS NULL OR height > 0),
      uploaded_at TEXT NOT NULL,
      deleted_at TEXT,
      UNIQUE (show_id, object_key),
      FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE RESTRICT
    ) STRICT`,
    `CREATE TABLE cue_asset_references (
      show_id TEXT NOT NULL,
      cue_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      PRIMARY KEY (show_id, cue_id, asset_id),
      FOREIGN KEY (show_id, cue_id) REFERENCES cues(show_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (asset_id) REFERENCES media_assets(id) ON DELETE RESTRICT
    ) STRICT`,
    "CREATE INDEX idx_cue_asset_references_asset ON cue_asset_references (asset_id)",
    "ALTER TABLE cues ADD COLUMN operator_label TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE cues ADD COLUMN operations_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE cues ADD COLUMN internal_note TEXT NOT NULL DEFAULT ''",
  ],
};

const SHOW_IDENTITY_SCHEMA: SchemaMigration = {
  version: 6,
  name: "show_lobby_identity",
  statements: [
    // Lobby graphics carry an optional tagline beside the event title; both are
    // show configuration, not per-act content.
    "ALTER TABLE shows ADD COLUMN tagline TEXT NOT NULL DEFAULT ''",
  ],
};

const CUE_REFERENCE_INTEGRITY_SCHEMA: SchemaMigration = {
  version: 7,
  name: "cue_parent_key_for_asset_references",
  statements: [
    // `cue_asset_references` names `cues(show_id, id)` as its parent key, but
    // that pair carried no unique index, so SQLite rejected every write to the
    // child table with "foreign key mismatch". This index is the parent key.
    "CREATE UNIQUE INDEX idx_cues_show_id ON cues (show_id, id)",
  ],
};

/**
 * Public text and the results stage are show configuration and operational
 * state respectively; neither may live only in a browser or in isolate memory.
 * Withdrawal is a timestamp so the act's history stays intact and auditable.
 */
const PUBLIC_MODES_AND_RESULTS_SCHEMA: SchemaMigration = {
  version: 8,
  name: "public_messages_emergency_results_stage_withdrawal",
  statements: [
    "ALTER TABLE shows ADD COLUMN intermission_message TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE shows ADD COLUMN emergency_message TEXT NOT NULL DEFAULT ''",
    `ALTER TABLE show_runtime ADD COLUMN emergency_presentation TEXT NOT NULL DEFAULT 'BLACK'
      CHECK (emergency_presentation IN ('BLACK', 'TEXT'))`,
    `ALTER TABLE show_runtime ADD COLUMN results_stage TEXT NOT NULL DEFAULT 'HIDDEN'
      CHECK (results_stage IN ('HIDDEN', 'LEADERBOARD', 'STAGED', 'TOP_THREE', 'WINNER'))`,
    `ALTER TABLE show_runtime ADD COLUMN results_revealed_groups INTEGER NOT NULL DEFAULT 0
      CHECK (results_revealed_groups >= 0)`,
    "ALTER TABLE acts ADD COLUMN withdrawn_at TEXT",
  ],
};

/**
 * Prompt-1 configuration and identity model. New tables sit beside the legacy
 * fixed-four tables so an in-place deployment never has to disable foreign-key
 * enforcement while migrating live data. All runtime code uses the v2 tables.
 */
const CONFIGURATION_AND_DYNAMIC_JUDGES_SCHEMA: SchemaMigration = {
  version: 9,
  name: "show_configuration_dynamic_judges_auth_pairing",
  statements: [
    "ALTER TABLE shows ADD COLUMN short_name TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE shows ADD COLUMN theme_id TEXT NOT NULL DEFAULT 'navy-bismarck'",
    "ALTER TABLE shows ADD COLUMN font_family TEXT NOT NULL DEFAULT 'system-ui'",
    "ALTER TABLE shows ADD COLUMN audience_weight REAL NOT NULL DEFAULT 0.5 CHECK (audience_weight >= 0 AND audience_weight <= 1)",
    "ALTER TABLE shows ADD COLUMN reactions_enabled INTEGER NOT NULL DEFAULT 1 CHECK (reactions_enabled IN (0, 1))",
    `CREATE TABLE show_judges (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
      show_id TEXT NOT NULL,
      slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 8),
      display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
      token_hash BLOB NOT NULL CHECK (length(token_hash) = 32),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL,
      deactivated_at TEXT,
      credential_revoked_at TEXT,
      UNIQUE (show_id, id),
      UNIQUE (show_id, slot),
      UNIQUE (show_id, token_hash),
      FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE RESTRICT
    ) STRICT`,
    `INSERT INTO show_judges (
      id, show_id, slot, display_name, token_hash, active, created_at,
      deactivated_at, credential_revoked_at
    ) SELECT id, show_id, slot, display_name, token_hash,
      1, created_at, NULL, revoked_at FROM judges`,
    `CREATE TABLE show_judge_permissions (
      show_id TEXT NOT NULL,
      act_id TEXT NOT NULL,
      judge_id TEXT NOT NULL,
      permission_state TEXT NOT NULL CHECK (permission_state IN ('OPEN', 'CLOSED')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (show_id, act_id, judge_id),
      FOREIGN KEY (show_id, act_id) REFERENCES acts(show_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (show_id, judge_id) REFERENCES show_judges(show_id, id) ON DELETE RESTRICT
    ) STRICT`,
    `INSERT INTO show_judge_permissions
      SELECT show_id, act_id, judge_id, permission_state, updated_at FROM judge_permissions`,
    `CREATE TABLE show_judge_submissions (
      show_id TEXT NOT NULL,
      act_id TEXT NOT NULL,
      judge_id TEXT NOT NULL,
      raw_input TEXT NOT NULL,
      parsed_classification TEXT NOT NULL CHECK (parsed_classification IN (
        'FINITE', 'POSITIVE_INFINITY', 'NEGATIVE_INFINITY'
      )),
      finite_value REAL,
      effective_score REAL NOT NULL,
      submitted_at TEXT NOT NULL,
      PRIMARY KEY (show_id, act_id, judge_id),
      CHECK (
        (parsed_classification = 'FINITE' AND finite_value IS NOT NULL) OR
        (parsed_classification != 'FINITE' AND finite_value IS NULL)
      ),
      FOREIGN KEY (show_id, act_id) REFERENCES acts(show_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (show_id, judge_id) REFERENCES show_judges(show_id, id) ON DELETE RESTRICT
    ) STRICT`,
    `INSERT INTO show_judge_submissions
      SELECT show_id, act_id, judge_id, raw_input, parsed_classification,
             finite_value, effective_score, submitted_at FROM judge_submissions`,
    `CREATE TABLE finalised_results_v2 (
      show_id TEXT NOT NULL,
      act_id TEXT NOT NULL,
      audience_mean REAL,
      judge_scores_json TEXT NOT NULL,
      audience_weight REAL NOT NULL CHECK (audience_weight >= 0 AND audience_weight <= 1),
      judge_weight REAL NOT NULL CHECK (judge_weight >= 0 AND judge_weight <= 1),
      active_judge_ids_json TEXT NOT NULL,
      formula_version INTEGER NOT NULL,
      final_score REAL NOT NULL,
      finalised_at TEXT NOT NULL,
      PRIMARY KEY (show_id, act_id),
      FOREIGN KEY (show_id, act_id) REFERENCES acts(show_id, id) ON DELETE RESTRICT
    ) STRICT`,
    `INSERT INTO finalised_results_v2 (
      show_id, act_id, audience_mean, judge_scores_json, audience_weight,
      judge_weight, active_judge_ids_json, formula_version, final_score, finalised_at
    ) SELECT f.show_id, f.act_id, f.audience_mean,
      json_array(f.judge_1_effective_score, f.judge_2_effective_score,
                 f.judge_3_effective_score, f.judge_4_effective_score),
      0.5, 0.5,
      COALESCE((SELECT json_group_array(id) FROM
        (SELECT id FROM show_judges j WHERE j.show_id = f.show_id
         AND j.slot BETWEEN 1 AND 4 ORDER BY j.slot)), '[]'),
      1, f.final_score, f.finalised_at FROM finalised_results f`,
    `CREATE TABLE admin_credentials (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      username TEXT NOT NULL CHECK (length(username) BETWEEN 1 AND 120),
      salt BLOB NOT NULL CHECK (length(salt) = 16),
      verifier BLOB NOT NULL CHECK (length(verifier) = 32),
      iterations INTEGER NOT NULL CHECK (iterations >= 100000),
      updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE projector_pairing_codes (
      show_id TEXT PRIMARY KEY NOT NULL,
      code_hash BLOB NOT NULL CHECK (length(code_hash) = 32),
      salt BLOB NOT NULL CHECK (length(salt) = 16),
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at TEXT NOT NULL,
      FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE RESTRICT
    ) STRICT`,
    `CREATE TABLE projector_sessions (
      token_hash BLOB PRIMARY KEY NOT NULL CHECK (length(token_hash) = 32),
      show_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE RESTRICT
    ) STRICT`,
    "CREATE INDEX idx_projector_sessions_show ON projector_sessions (show_id, revoked_at)",
    `CREATE TABLE font_assets (
      id TEXT PRIMARY KEY NOT NULL,
      family TEXT NOT NULL,
      object_key TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
      created_at TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE selected_font_css (
      family TEXT PRIMARY KEY NOT NULL,
      css_text TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE TRIGGER legacy_judges_insert AFTER INSERT ON judges BEGIN
      INSERT OR IGNORE INTO show_judges
        (id, show_id, slot, display_name, token_hash, active, created_at, deactivated_at, credential_revoked_at)
      VALUES (NEW.id, NEW.show_id, NEW.slot, NEW.display_name, NEW.token_hash,
        1, NEW.created_at, NULL, NEW.revoked_at);
    END`,
    `CREATE TRIGGER legacy_judge_permissions_insert AFTER INSERT ON judge_permissions BEGIN
      INSERT OR REPLACE INTO show_judge_permissions
        (show_id, act_id, judge_id, permission_state, updated_at)
      VALUES (NEW.show_id, NEW.act_id, NEW.judge_id, NEW.permission_state, NEW.updated_at);
    END`,
    `CREATE TRIGGER legacy_judge_submissions_insert AFTER INSERT ON judge_submissions BEGIN
      INSERT OR IGNORE INTO show_judge_submissions
        (show_id, act_id, judge_id, raw_input, parsed_classification, finite_value, effective_score, submitted_at)
      VALUES (NEW.show_id, NEW.act_id, NEW.judge_id, NEW.raw_input,
        NEW.parsed_classification, NEW.finite_value, NEW.effective_score, NEW.submitted_at);
    END`,
    `CREATE TRIGGER legacy_finalised_results_insert AFTER INSERT ON finalised_results BEGIN
      INSERT OR IGNORE INTO finalised_results_v2
        (show_id, act_id, audience_mean, judge_scores_json, audience_weight, judge_weight,
         active_judge_ids_json, formula_version, final_score, finalised_at)
      VALUES (NEW.show_id, NEW.act_id, NEW.audience_mean,
        json_array(NEW.judge_1_effective_score, NEW.judge_2_effective_score,
                   NEW.judge_3_effective_score, NEW.judge_4_effective_score),
        0.5, 0.5,
        COALESCE((SELECT json_group_array(id) FROM
          (SELECT id FROM show_judges j WHERE j.show_id = NEW.show_id ORDER BY j.slot LIMIT 4)), '[]'),
        1, NEW.final_score, NEW.finalised_at);
    END`,
  ],
};

/**
 * Prompt-2 act artwork was added after configuration migration 9 had already
 * shipped. Keep it in a new migration so existing coordinators receive the
 * column; editing migration 9 would update only fresh installations.
 */
const ACT_PUBLIC_IMAGE_SCHEMA: SchemaMigration = {
  version: 10,
  name: "act_public_image",
  statements: ["ALTER TABLE acts ADD COLUMN public_image_asset_id TEXT"],
};

const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  INITIAL_SCHEMA,
  SHOW_RUNTIME_SCHEMA,
  COMMAND_IDEMPOTENCY_SCHEMA,
  AUTH_AND_VOTER_SCHEMA,
  RESULTS_ACTS_MEDIA_SCHEMA,
  SHOW_IDENTITY_SCHEMA,
  CUE_REFERENCE_INTEGRITY_SCHEMA,
  PUBLIC_MODES_AND_RESULTS_SCHEMA,
  CONFIGURATION_AND_DYNAMIC_JUDGES_SCHEMA,
  ACT_PUBLIC_IMAGE_SCHEMA,
];
export const LATEST_SCHEMA_VERSION = SCHEMA_MIGRATIONS.length;

function appliedVersions(sql: SqlStorage): Set<number> {
  return new Set(
    sql
      .exec<{ version: number }>("SELECT version FROM schema_migrations")
      .toArray()
      .map((row) => row.version),
  );
}

/**
 * Applies each migration in one SQLite transaction and records it only after its
 * statements succeed. A malformed or discontinuous migration history is fatal.
 */
export function initialiseSchema(storage: DurableObjectStorage): void {
  storage.sql.exec("PRAGMA foreign_keys = ON");
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);

  const applied = appliedVersions(storage.sql);
  const highestKnownVersion = SCHEMA_MIGRATIONS.at(-1)?.version ?? 0;

  for (const version of applied) {
    if (version > highestKnownVersion) {
      throw new Error(
        `Database schema version ${version} is newer than this Worker`,
      );
    }
  }

  for (const migration of SCHEMA_MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }

    const higherVersionExists = [...applied].some(
      (version) => version > migration.version,
    );
    if (higherVersionExists) {
      throw new Error(
        `Database migration ${migration.version} is missing from history`,
      );
    }

    storage.transactionSync(() => {
      for (const statement of migration.statements) {
        storage.sql.exec(statement);
      }
      storage.sql.exec(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });
  }
}

export function readSchemaVersion(sql: SqlStorage): number {
  const row = sql
    .exec<{ version: number }>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    )
    .one();

  return row.version ?? 0;
}
