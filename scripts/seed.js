// Creates (or resets) 3 sample members, including their offline PIN hash. Safe to run more than once.
import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { addDays, localDateString } from '../src/dates.js';
import { createOfflinePinHasher, createPinHasher } from '../src/security.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const hashPin = createPinHasher(config.pinPepper);
const hashPinOffline = createOfflinePinHasher(config.offlineKey);
const today = new Date();

const samples = [
  { nome: 'Joao Silva', pin: '1234', ativo: true, vencimento: localDateString(addDays(today, 30)), situacao: 'paid' },
  { nome: 'Maria Souza', pin: '5678', ativo: true, vencimento: localDateString(addDays(today, -10)), situacao: 'overdue' },
  { nome: 'Pedro Santos', pin: '9999', ativo: false, vencimento: localDateString(addDays(today, 30)), situacao: 'inactive' },
];

const upsert = db.prepare(`
  INSERT INTO members (nome, pin_hash, pin_hash_offline, ativo, vencimento, created_at)
  VALUES (@nome, @pinHash, @pinHashOffline, @ativo, @vencimento, @createdAt)
  ON CONFLICT(pin_hash) DO UPDATE SET
    nome = excluded.nome,
    pin_hash_offline = excluded.pin_hash_offline,
    ativo = excluded.ativo,
    vencimento = excluded.vencimento
`);

db.transaction(() => {
  for (const m of samples) {
    upsert.run({
      nome: m.nome,
      pinHash: hashPin(m.pin),
      pinHashOffline: hashPinOffline(m.pin),
      ativo: m.ativo ? 1 : 0,
      vencimento: m.vencimento,
      createdAt: new Date().toISOString(),
    });
  }
})();

console.log(`Seeded ${samples.length} members into ${config.dbPath}:`);
for (const m of samples) {
  console.log(`  PIN ${m.pin}  ${m.nome.padEnd(14)} ${m.situacao.padEnd(9)} ativo=${m.ativo}  vencimento=${m.vencimento}`);
}
db.close();
