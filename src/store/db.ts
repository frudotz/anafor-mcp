import { DatabaseSync } from 'node:sqlite';

/** Sıralı migration'lar. Yalnızca sona ekleme yapılır; mevcutlar değiştirilmez. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    objective TEXT NOT NULL,
    criteria_json TEXT NOT NULL DEFAULT '[]',
    constraints_json TEXT NOT NULL DEFAULT '[]',
    context_refs_json TEXT NOT NULL DEFAULT '[]',
    review_level TEXT NOT NULL DEFAULT 'standard',
    priority TEXT NOT NULL DEFAULT 'normal',
    state TEXT NOT NULL DEFAULT 'open',
    branch TEXT,
    base_ref TEXT,
    correction_count INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    role TEXT NOT NULL,
    worker TEXT NOT NULL,
    model TEXT,
    state TEXT NOT NULL,
    workspace_mode TEXT NOT NULL,
    workdir TEXT NOT NULL,
    branch TEXT,
    session_ref TEXT,
    parent_job_id TEXT,
    is_correction INTEGER NOT NULL DEFAULT 0,
    instructions TEXT NOT NULL,
    inputs_json TEXT NOT NULL DEFAULT '{}',
    timeout_s INTEGER NOT NULL,
    pid INTEGER,
    exit_code INTEGER,
    error TEXT,
    result_json TEXT,
    warnings_json TEXT,
    usage_json TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX jobs_task ON jobs(task_id);
  CREATE INDEX jobs_state ON jobs(state);
  CREATE TABLE sessions (
    task_id TEXT NOT NULL,
    role TEXT NOT NULL,
    worker TEXT NOT NULL,
    session_ref TEXT NOT NULL,
    last_job_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, role, worker)
  );
  CREATE TABLE events (
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    summary TEXT NOT NULL,
    PRIMARY KEY (job_id, seq)
  );
  `,
  // 2: iş başlangıcındaki git tabanı (job_diff ve kabul için)
  `ALTER TABLE jobs ADD COLUMN base_sha TEXT;`,
  `ALTER TABLE jobs ADD COLUMN auto_check_json TEXT;`,
  `ALTER TABLE jobs ADD COLUMN auto_continue_pending INTEGER NOT NULL DEFAULT 0; ALTER TABLE jobs ADD COLUMN auto_continued INTEGER NOT NULL DEFAULT 0;`,
];

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    { value: string } | undefined;
  let version = row ? Number(row.value) : 0;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) break;
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(sql);
      version += 1;
      db.prepare(
        "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(version));
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }
}
