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

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  INITIAL_SCHEMA,
  SHOW_RUNTIME_SCHEMA,
  COMMAND_IDEMPOTENCY_SCHEMA,
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
