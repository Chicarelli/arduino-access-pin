import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.js';
import { openDatabase, createRepository } from '../src/db.js';
import { dateStringInTimeZone, dayNumber } from '../src/dates.js';
import { createOfflinePinHasher } from '../src/security.js';

const REFERENCE_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

describe('pin_hash_offline', () => {
  test('matches the reference vectors (computed with openssl and Python)', () => {
    const hash = createOfflinePinHasher(REFERENCE_KEY);
    assert.equal(hash('1234'), '75a2b0661f593e7c');
    assert.equal(hash('5678'), 'b7b278a6c70adb7b');
    assert.equal(hash('9999'), '2ca52f41b99ebb28');
    assert.equal(hash('24680'), '3e936c9b116807fd');
    // The key is decoded from hex, so its case does not matter.
    assert.equal(createOfflinePinHasher(REFERENCE_KEY.toUpperCase())('1234'), '75a2b0661f593e7c');
  });

  test('rejects keys that are not 32 bytes of hex', () => {
    for (const key of ['', 'zz'.repeat(32), REFERENCE_KEY.slice(1), `${REFERENCE_KEY}00`, `0x${REFERENCE_KEY.slice(2)}`]) {
      assert.throws(() => createOfflinePinHasher(key), /OFFLINE_KEY/, key);
    }
  });
});

describe('dates', () => {
  test('dayNumber counts calendar days from 2020-01-01', () => {
    assert.equal(dayNumber('2020-01-01'), 0);
    assert.equal(dayNumber('2020-01-02'), 1);
    assert.equal(dayNumber('2020-12-31'), 365); // 2020 is a leap year
    assert.equal(dayNumber('2021-01-01'), 366);
    assert.equal(dayNumber('2026-11-11'), 2506);
  });

  test('dateStringInTimeZone uses the given zone', () => {
    const instant = new Date('2026-11-12T02:30:00Z');
    assert.equal(dateStringInTimeZone('America/Sao_Paulo', instant), '2026-11-11');
    assert.equal(dateStringInTimeZone('UTC', instant), '2026-11-12');
  });
});

describe('OFFLINE_KEY config', () => {
  const base = { DEVICE_KEY: 'd', ADMIN_TOKEN: 'a', PIN_PEPPER: 'a-long-pin-pepper-value' };

  test('is required, must be 64 hex chars, and must differ from PIN_PEPPER', () => {
    assert.throws(() => loadConfig(base), /OFFLINE_KEY/);
    assert.throws(() => loadConfig({ ...base, OFFLINE_KEY: 'too-short' }), /64 hex characters/);
    assert.throws(() => loadConfig({ ...base, PIN_PEPPER: REFERENCE_KEY, OFFLINE_KEY: REFERENCE_KEY.toUpperCase() }), /different/);
    assert.equal(loadConfig({ ...base, OFFLINE_KEY: ` ${REFERENCE_KEY} ` }).offlineKey, REFERENCE_KEY);
  });
});

describe('migration', () => {
  test('a database from before the offline list is upgraded in place', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-migration-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'old.db');

    // Schema as shipped before this change.
    const old = new Database(file);
    old.exec(`
      CREATE TABLE members (
        id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, pin_hash TEXT NOT NULL UNIQUE,
        ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)), vencimento TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO members (nome, pin_hash, ativo, vencimento, created_at) VALUES ('Antigo', 'h1', 1, '2099-01-01', 'x');
    `);
    old.close();

    let db = openDatabase(file);
    let repo = createRepository(db);
    assert.equal(repo.getListaVersao(), 1);
    assert.equal(repo.countMembersWithoutOfflineHash(), 1);
    assert.deepEqual(repo.getOfflineList('2026-11-11', 0).membros, []); // left out until its PIN is set again

    db.prepare("UPDATE members SET pin_hash_offline = 'aaaaaaaaaaaaaaaa' WHERE id = 1").run();
    assert.equal(repo.getListaVersao(), 2);
    db.close();

    // Opening again is a no-op: no duplicate column, version kept.
    db = openDatabase(file);
    repo = createRepository(db);
    assert.equal(repo.getListaVersao(), 2);
    assert.equal(repo.getOfflineList('2026-11-11', 0).membros.length, 1);
    db.close();
  });
});
