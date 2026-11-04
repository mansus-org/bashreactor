// The SQLite schema and its migrations. `PRAGMA user_version` records which schema version a store
// file was written with; opening an older store runs each migration in order inside one transaction,
// and opening a newer one is refused.

import type { Database } from "bun:sqlite";
import { StoreError } from "./errors.ts";

export const SCHEMA_VERSION = 1;

type Migration = (db: Database) => void;

const MIGRATIONS: readonly Migration[] = [
  (db) => {
    db.exec(`
      CREATE TABLE block_versions (
        name       TEXT    NOT NULL,
        version    INTEGER NOT NULL,
        sha256     TEXT    NOT NULL,
        path       TEXT    NOT NULL,
        size       INTEGER NOT NULL,
        created_at TEXT    NOT NULL,
        PRIMARY KEY (name, version)
      ) STRICT;

      CREATE TABLE pipelines (
        name        TEXT    NOT NULL,
        version     INTEGER NOT NULL,
        sha256      TEXT    NOT NULL,
        yaml        TEXT    NOT NULL,
        parsed_json TEXT    NOT NULL,
        created_at  TEXT    NOT NULL,
        PRIMARY KEY (name, version)
      ) STRICT;

      CREATE TABLE runs (
        id                  TEXT PRIMARY KEY,
        pipeline_name       TEXT    NOT NULL,
        pipeline_version    INTEGER NOT NULL,
        status              TEXT    NOT NULL,
        created_at          TEXT    NOT NULL,
        finished_at         TEXT,
        cancel_requested_at TEXT,
        inputs_json         TEXT    NOT NULL,
        outputs_json        TEXT,
        FOREIGN KEY (pipeline_name, pipeline_version) REFERENCES pipelines (name, version)
      ) STRICT;

      CREATE TABLE steps (
        run_id          TEXT    NOT NULL,
        step_id         TEXT    NOT NULL,
        position        INTEGER NOT NULL,
        name            TEXT    NOT NULL,
        status          TEXT    NOT NULL,
        uses            TEXT    NOT NULL,
        block_name      TEXT    NOT NULL,
        block_version   INTEGER,
        block_sha256    TEXT    NOT NULL,
        needs_json      TEXT    NOT NULL,
        with_json       TEXT,
        outputs_json    TEXT,
        failure_json    TEXT,
        attempts_used   INTEGER NOT NULL,
        next_attempt_at TEXT,
        PRIMARY KEY (run_id, step_id),
        FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE attempts (
        run_id       TEXT    NOT NULL,
        step_id      TEXT    NOT NULL,
        n            INTEGER NOT NULL,
        status       TEXT    NOT NULL,
        pid          INTEGER,
        pid_start    INTEGER,
        started_at   TEXT,
        finished_at  TEXT,
        exit_code    INTEGER,
        signal       TEXT,
        failure_json TEXT,
        log_path     TEXT    NOT NULL,
        log_size     INTEGER NOT NULL,
        PRIMARY KEY (run_id, step_id, n),
        FOREIGN KEY (run_id, step_id) REFERENCES steps (run_id, step_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE artifacts (
        run_id    TEXT    NOT NULL,
        step_id   TEXT    NOT NULL,
        attempt   INTEGER NOT NULL,
        name      TEXT    NOT NULL,
        type      TEXT    NOT NULL,
        path      TEXT    NOT NULL,
        size      INTEGER NOT NULL,
        sha256    TEXT,
        published INTEGER NOT NULL,
        PRIMARY KEY (run_id, step_id, attempt, name),
        FOREIGN KEY (run_id, step_id, attempt) REFERENCES attempts (run_id, step_id, n) ON DELETE CASCADE
      ) STRICT;
    `);
  },
];

export function migrate(db: Database): void {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  const from = row.user_version;
  if (from > SCHEMA_VERSION) {
    throw new StoreError(
      "store_migration_failed",
      `store was written by schema version ${from}, this build understands up to ${SCHEMA_VERSION}`,
    );
  }
  if (from === SCHEMA_VERSION) return;

  db.transaction(() => {
    for (let version = from; version < SCHEMA_VERSION; version++) {
      const migration = MIGRATIONS[version];
      if (migration === undefined) {
        throw new StoreError("store_migration_failed", `missing migration from schema ${version} to ${version + 1}`);
      }
      migration(db);
    }
    db.run("PRAGMA user_version = " + String(SCHEMA_VERSION));
  })();
}
