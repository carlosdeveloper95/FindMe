import Database from 'better-sqlite3';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  code        TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  id            TEXT PRIMARY KEY,
  session_code  TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
  slot          INTEGER NOT NULL,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  joined_at     INTEGER NOT NULL,
  UNIQUE (session_code, slot)
);

CREATE TABLE IF NOT EXISTS points (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id  TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  lat             REAL NOT NULL,
  lng             REAL NOT NULL,
  accuracy        REAL NOT NULL,
  ts              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_points_participant ON points (participant_id, id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
`;

/** Abre (ou cria) a base de dados. Usa ':memory:' nos testes. */
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Garante que os dados apagados não ficam recuperáveis no ficheiro.
  db.pragma('secure_delete = ON');
  db.exec(SCHEMA);
  return db;
}
