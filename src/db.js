import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nome        TEXT    NOT NULL,
  pin_hash    TEXT    NOT NULL UNIQUE,
  ativo       INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
  vencimento  TEXT    NOT NULL,            -- YYYY-MM-DD: membership paid until (inclusive)
  created_at  TEXT    NOT NULL             -- ISO 8601, UTC
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
`;

export function openDatabase(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
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
      'INSERT INTO members (nome, pin_hash, ativo, vencimento, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    deleteMember: db.prepare('DELETE FROM members WHERE id = ?'),
    listLogs: db.prepare(`
      SELECT l.id, l.timestamp, l.device_id, l.member_id, m.nome AS nome, l.liberado, l.motivo
      FROM access_logs l
      LEFT JOIN members m ON m.id = l.member_id
      ORDER BY l.id DESC
      LIMIT ?`),
  };

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
    createMember({ nome, pinHash, ativo, vencimento }) {
      const createdAt = new Date().toISOString();
      const info = stmt.insertMember.run(nome, pinHash, ativo ? 1 : 0, vencimento, createdAt);
      return this.getMember(Number(info.lastInsertRowid));
    },

    /** Returns the updated member, or null if it does not exist. Throws on duplicate PIN. */
    updateMember(id, { nome, pinHash, ativo, vencimento }) {
      const sets = [];
      const values = [];
      if (nome !== undefined) { sets.push('nome = ?'); values.push(nome); }
      if (pinHash !== undefined) { sets.push('pin_hash = ?'); values.push(pinHash); }
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
  };
}
