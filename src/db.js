import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const TABLES = `
CREATE TABLE IF NOT EXISTS members (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  nome              TEXT    NOT NULL,
  pin_hash          TEXT    NOT NULL UNIQUE,
  ativo             INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
  vencimento        TEXT    NOT NULL,      -- YYYY-MM-DD: membership paid until (inclusive)
  created_at        TEXT    NOT NULL,      -- ISO 8601, UTC
  pin_hash_offline  TEXT                   -- 16 hex chars for the ESP32 offline list; NULL = not in the list
);

CREATE TABLE IF NOT EXISTS access_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT    NOT NULL,            -- ISO 8601, UTC
  device_id   TEXT    NOT NULL,
  member_id   INTEGER REFERENCES members(id) ON DELETE SET NULL,
  liberado    INTEGER NOT NULL CHECK (liberado IN (0, 1)),
  motivo      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_access_logs_member_id ON access_logs(member_id);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT    PRIMARY KEY,
  value  INTEGER NOT NULL
);

-- Starts at 1, so a device that has no list yet (and sends versao=0) always gets a full download.
INSERT OR IGNORE INTO settings (key, value) VALUES ('lista_versao', 1);
`;

/**
 * lista_versao goes up on every change that affects the offline list: member created, deleted, or PIN, ativo
 * or vencimento changed. Triggers make this hold for every writer (API, seed script, manual edits), in the
 * same transaction as the change. Updates that leave those columns as they were (nome only, same PIN again)
 * do not count. The passing of time never changes it: the ESP32 checks dates itself.
 */
const BUMP_LISTA_VERSAO = "UPDATE settings SET value = value + 1 WHERE key = 'lista_versao';";
const TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS lista_versao_on_insert AFTER INSERT ON members
BEGIN ${BUMP_LISTA_VERSAO} END;

CREATE TRIGGER IF NOT EXISTS lista_versao_on_delete AFTER DELETE ON members
BEGIN ${BUMP_LISTA_VERSAO} END;

CREATE TRIGGER IF NOT EXISTS lista_versao_on_update
AFTER UPDATE OF pin_hash, pin_hash_offline, ativo, vencimento ON members
WHEN OLD.pin_hash IS NOT NEW.pin_hash
  OR OLD.pin_hash_offline IS NOT NEW.pin_hash_offline
  OR OLD.ativo IS NOT NEW.ativo
  OR OLD.vencimento IS NOT NEW.vencimento
BEGIN ${BUMP_LISTA_VERSAO} END;
`;

/** Brings a database created by an older version up to date. Runs inside the schema transaction. */
function migrate(db) {
  const columns = db.prepare('PRAGMA table_info(members)').all().map((c) => c.name);
  if (!columns.includes('pin_hash_offline')) {
    // Existing members get NULL and stay out of the offline list until their PIN is set again (or re-seeded).
    db.exec('ALTER TABLE members ADD COLUMN pin_hash_offline TEXT');
  }
}

export function openDatabase(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // IMMEDIATE: if the server and the seed script start together, only one of them migrates.
  db.transaction(() => {
    db.exec(TABLES);
    migrate(db);
    db.exec(TRIGGERS);
  }).immediate();
  return db;
}

const MEMBER_COLUMNS = 'id, nome, ativo, vencimento, created_at';

function toMember(row) {
  if (!row) return null;
  return {
    id: row.id,
    nome: row.nome,
    ativo: row.ativo === 1,
    vencimento: row.vencimento,
    created_at: row.created_at,
  };
}

function toLog(row) {
  return {
    id: row.id,
    timestamp: row.timestamp,
    device_id: row.device_id,
    member_id: row.member_id,
    nome: row.nome,
    liberado: row.liberado === 1,
    motivo: row.motivo,
  };
}

export function isUniqueViolation(err) {
  return err?.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/** All SQL lives here. Statements are prepared once and reused (better-sqlite3 is synchronous and fast). */
export function createRepository(db) {
  const stmt = {
    // Used by the door: needs the status fields only. pin_hash never leaves this module.
    findByPinHash: db.prepare('SELECT id, nome, ativo, vencimento FROM members WHERE pin_hash = ?'),
    insertLog: db.prepare(
      'INSERT INTO access_logs (timestamp, device_id, member_id, liberado, motivo) VALUES (?, ?, ?, ?, ?)',
    ),
    listMembers: db.prepare(`SELECT ${MEMBER_COLUMNS} FROM members ORDER BY id`),
    getMember: db.prepare(`SELECT ${MEMBER_COLUMNS} FROM members WHERE id = ?`),
    insertMember: db.prepare(
      'INSERT INTO members (nome, pin_hash, pin_hash_offline, ativo, vencimento, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    deleteMember: db.prepare('DELETE FROM members WHERE id = ?'),
    listLogs: db.prepare(`
      SELECT l.id, l.timestamp, l.device_id, l.member_id, m.nome AS nome, l.liberado, l.motivo
      FROM access_logs l
      LEFT JOIN members m ON m.id = l.member_id
      ORDER BY l.id DESC
      LIMIT ?`),
    listaVersao: db.prepare("SELECT value FROM settings WHERE key = 'lista_versao'").pluck(),
    // vencimento is YYYY-MM-DD, so comparing strings compares dates.
    listOffline: db.prepare(`
      SELECT id, pin_hash_offline, vencimento
      FROM members
      WHERE ativo = 1 AND pin_hash_offline IS NOT NULL AND vencimento >= ?
      ORDER BY id`),
    countMissingOffline: db.prepare('SELECT COUNT(*) FROM members WHERE pin_hash_offline IS NULL').pluck(),
  };

  // One read transaction, so the version and the list always come from the same snapshot, even if another
  // process (the seed script) writes in between.
  const readOfflineList = db.transaction((today, knownVersion) => {
    const versao = stmt.listaVersao.get();
    if (versao === knownVersion) return { versao, membros: null };
    return { versao, membros: stmt.listOffline.all(today) };
  });

  return {
    findMemberByPinHash(pinHash) {
      const row = stmt.findByPinHash.get(pinHash);
      return row ? { id: row.id, nome: row.nome, ativo: row.ativo === 1, vencimento: row.vencimento } : null;
    },

    insertAccessLog({ timestamp, deviceId, memberId, liberado, motivo }) {
      stmt.insertLog.run(timestamp, deviceId, memberId ?? null, liberado ? 1 : 0, motivo);
    },

    listMembers() {
      return stmt.listMembers.all().map(toMember);
    },

    getMember(id) {
      return toMember(stmt.getMember.get(id));
    },

    /** Throws a SQLITE_CONSTRAINT_UNIQUE error if the PIN is already used. */
    createMember({ nome, pinHash, pinHashOffline, ativo, vencimento }) {
      const createdAt = new Date().toISOString();
      const info = stmt.insertMember.run(nome, pinHash, pinHashOffline, ativo ? 1 : 0, vencimento, createdAt);
      return this.getMember(Number(info.lastInsertRowid));
    },

    /**
     * Returns the updated member, or null if it does not exist. Throws on duplicate PIN.
     * pinHash and pinHashOffline come from the same PIN and are always written together.
     */
    updateMember(id, { nome, pinHash, pinHashOffline, ativo, vencimento }) {
      const sets = [];
      const values = [];
      if (nome !== undefined) { sets.push('nome = ?'); values.push(nome); }
      if (pinHash !== undefined) {
        sets.push('pin_hash = ?', 'pin_hash_offline = ?');
        values.push(pinHash, pinHashOffline);
      }
      if (ativo !== undefined) { sets.push('ativo = ?'); values.push(ativo ? 1 : 0); }
      if (vencimento !== undefined) { sets.push('vencimento = ?'); values.push(vencimento); }
      if (sets.length > 0) {
        const info = db.prepare(`UPDATE members SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
        if (info.changes === 0) return null;
      }
      return this.getMember(id);
    },

    deleteMember(id) {
      return stmt.deleteMember.run(id).changes > 0;
    },

    listLogs(limit) {
      return stmt.listLogs.all(limit).map(toLog);
    },

    getListaVersao() {
      return stmt.listaVersao.get();
    },

    /**
     * Members the ESP32 may let in offline: ativo, with an offline hash, and vencimento >= today (YYYY-MM-DD).
     * If knownVersion is already the current lista_versao, `membros` is null (nothing to send).
     */
    getOfflineList(today, knownVersion) {
      return readOfflineList(today, knownVersion);
    },

    countMembersWithoutOfflineHash() {
      return stmt.countMissingOffline.get();
    },
  };
}
