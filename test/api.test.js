import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { addDays, localDateString } from '../src/dates.js';

const config = {
  deviceKey: 'test-device-key',
  adminToken: 'test-admin-token',
  pinPepper: 'test-pepper-0123456789abcdef',
  // Bytes 00..1f: the reference key documented in the README, so expected hashes can be cross-checked.
  offlineKey: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
};
const DEVICE = { 'x-device-key': config.deviceKey };
const ADMIN = { authorization: `Bearer ${config.adminToken}` };

const today = new Date();
const future = localDateString(addDays(today, 30));
const past = localDateString(addDays(today, -1));

let app;
let db;
let clock;

beforeEach(async () => {
  clock = Date.now();
  db = openDatabase(':memory:');
  app = buildApp({ config, db, now: () => clock });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
});

function acesso(senha, { deviceId = 'porta-principal', headers = DEVICE } = {}) {
  return app.inject({ method: 'POST', url: '/api/acesso', headers, payload: { device_id: deviceId, senha } });
}

async function createMember(body) {
  const res = await app.inject({ method: 'POST', url: '/api/members', headers: ADMIN, payload: body });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

async function seed() {
  await createMember({ nome: 'João da Conceição', pin: '1234', vencimento: future });
  await createMember({ nome: 'Maria', pin: '5678', vencimento: past });
  await createMember({ nome: 'Pedro', pin: '9999', vencimento: future, ativo: false });
  await createMember({ nome: 'Ana', pin: '4321', vencimento: localDateString(today) });
}

test('GET /api/health needs no auth', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});

describe('POST /api/acesso', () => {
  beforeEach(seed);

  test('paid member is let in, with exactly the 4 contract fields', async () => {
    const res = await acesso('1234');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { liberado: true, motivo: 'OK', mensagem: 'Bem-vindo, Joao!', tempo_abertura_ms: 3000 });
  });

  test('vencimento equal to today still counts as paid', async () => {
    assert.equal((await acesso('4321')).json().motivo, 'OK');
  });

  test('business denials are HTTP 200', async () => {
    const cases = [
      ['0000', { liberado: false, motivo: 'SENHA_INVALIDA', mensagem: 'Senha invalida', tempo_abertura_ms: 0 }],
      ['5678', { liberado: false, motivo: 'PAGAMENTO_PENDENTE', mensagem: 'Mensalidade em atraso', tempo_abertura_ms: 0 }],
      ['9999', { liberado: false, motivo: 'USUARIO_INATIVO', mensagem: 'Cadastro inativo', tempo_abertura_ms: 0 }],
    ];
    for (const [senha, expected] of cases) {
      const res = await acesso(senha);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), expected);
    }
  });

  test('401 when X-Device-Key is missing or wrong (checked before the body)', async () => {
    for (const headers of [{}, { 'x-device-key': 'nope' }]) {
      const res = await acesso('1234', { headers });
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.json(), { erro: 'nao_autorizado' });
    }
    const res = await app.inject({ method: 'POST', url: '/api/acesso', payload: { senha: 'x' } });
    assert.equal(res.statusCode, 401);
  });

  test('400 on invalid bodies', async () => {
    const bodies = [
      { device_id: 'porta', senha: '123' },
      { device_id: 'porta', senha: '123456789' },
      { device_id: 'porta', senha: '12a4' },
      { device_id: '', senha: '1234' },
      { device_id: 'x'.repeat(33), senha: '1234' },
      { senha: '1234' },
      { device_id: 'porta' },
    ];
    for (const payload of bodies) {
      const res = await app.inject({ method: 'POST', url: '/api/acesso', headers: DEVICE, payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.deepEqual(res.json(), { erro: 'requisicao_invalida' });
    }
    const broken = await app.inject({
      method: 'POST', url: '/api/acesso', payload: '{not json',
      headers: { ...DEVICE, 'content-type': 'application/json' },
    });
    assert.equal(broken.statusCode, 400);
    assert.deepEqual(broken.json(), { erro: 'requisicao_invalida' });
  });

  test('5 wrong PINs in 60 s block the device for 30 s, even for a correct PIN', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await acesso('0000')).json().motivo, 'SENHA_INVALIDA');

    const blocked = await acesso('1234');
    assert.equal(blocked.statusCode, 200);
    assert.deepEqual(blocked.json(), {
      liberado: false, motivo: 'BLOQUEADO_TEMPORARIO', mensagem: 'Aguarde e tente de novo', tempo_abertura_ms: 0,
    });

    // Other devices are not affected.
    assert.equal((await acesso('1234', { deviceId: 'porta-2' })).json().motivo, 'OK');

    clock += 29_000;
    assert.equal((await acesso('1234')).json().motivo, 'BLOQUEADO_TEMPORARIO');
    clock += 1_000;
    assert.equal((await acesso('1234')).json().motivo, 'OK');
  });

  test('wrong PINs spread over more than 60 s do not block', async () => {
    for (let i = 0; i < 4; i++) await acesso('0000');
    clock += 61_000;
    await acesso('0000');
    assert.equal((await acesso('1234')).json().motivo, 'OK');
  });

  test('every attempt is logged, and raw PINs are never stored', async () => {
    await acesso('1234');
    await acesso('0000');
    await acesso('5678');

    const res = await app.inject({ method: 'GET', url: '/api/logs?limit=2', headers: ADMIN });
    assert.equal(res.statusCode, 200);
    const logs = res.json();
    assert.equal(logs.length, 2);
    assert.equal(logs[0].motivo, 'PAGAMENTO_PENDENTE');
    assert.equal(logs[0].nome, 'Maria');
    assert.equal(logs[1].motivo, 'SENHA_INVALIDA');
    assert.equal(logs[1].member_id, null);
    assert.equal(logs[1].liberado, false);

    const everything = JSON.stringify([
      db.prepare('SELECT * FROM members').all(),
      db.prepare('SELECT * FROM access_logs').all(),
    ]);
    for (const pin of ['1234', '5678', '9999', '0000']) assert.ok(!everything.includes(pin), `found raw PIN ${pin}`);
  });
});

describe('admin API', () => {
  test('401 without a valid bearer token', async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: config.adminToken }]) {
      const res = await app.inject({ method: 'GET', url: '/api/members', headers });
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.json(), { erro: 'nao_autorizado' });
    }
  });

  test('create, list, patch, delete', async () => {
    const created = await createMember({ nome: '  Joao  ', pin: '1234', vencimento: future });
    assert.equal(created.nome, 'Joao');
    assert.equal(created.ativo, true);
    assert.ok(created.id && created.created_at);
    assert.equal(created.pin, undefined);
    assert.equal(created.pin_hash, undefined);

    const list = (await app.inject({ method: 'GET', url: '/api/members', headers: ADMIN })).json();
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0]).sort(), ['ativo', 'created_at', 'id', 'nome', 'vencimento']);

    const patched = await app.inject({
      method: 'PATCH', url: `/api/members/${created.id}`, headers: ADMIN, payload: { pin: '2468', ativo: false },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().ativo, false);
    assert.equal((await acesso('1234')).json().motivo, 'SENHA_INVALIDA');
    assert.equal((await acesso('2468')).json().motivo, 'USUARIO_INATIVO');

    const del = await app.inject({ method: 'DELETE', url: `/api/members/${created.id}`, headers: ADMIN });
    assert.equal(del.statusCode, 204);
    const again = await app.inject({ method: 'DELETE', url: `/api/members/${created.id}`, headers: ADMIN });
    assert.equal(again.statusCode, 404);

    // Logs survive the deletion, with member_id cleared.
    const logs = (await app.inject({ method: 'GET', url: '/api/logs', headers: ADMIN })).json();
    assert.equal(logs.length, 2);
    assert.ok(logs.every((l) => l.member_id === null));
  });

  test('409 when the PIN is already in use (create and patch)', async () => {
    await createMember({ nome: 'A', pin: '1234', vencimento: future });
    const b = await createMember({ nome: 'B', pin: '5678', vencimento: future });

    const dup = await app.inject({
      method: 'POST', url: '/api/members', headers: ADMIN, payload: { nome: 'C', pin: '1234', vencimento: future },
    });
    assert.equal(dup.statusCode, 409);
    assert.deepEqual(dup.json(), { erro: 'pin_em_uso' });

    const dupPatch = await app.inject({
      method: 'PATCH', url: `/api/members/${b.id}`, headers: ADMIN, payload: { pin: '1234' },
    });
    assert.equal(dupPatch.statusCode, 409);
  });

  test('validation errors', async () => {
    const bad = [
      { nome: 'X', pin: '12', vencimento: future },
      { nome: 'X', pin: '1234', vencimento: '2026-02-30' },
      { nome: 'X', pin: '1234', vencimento: '10/12/2026' },
      { nome: '   ', pin: '1234', vencimento: future },
      { pin: '1234', vencimento: future },
    ];
    for (const payload of bad) {
      const res = await app.inject({ method: 'POST', url: '/api/members', headers: ADMIN, payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
    }
    const m = await createMember({ nome: 'X', pin: '1234', vencimento: future });
    const empty = await app.inject({ method: 'PATCH', url: `/api/members/${m.id}`, headers: ADMIN, payload: {} });
    assert.equal(empty.statusCode, 400);
    const missing = await app.inject({ method: 'PATCH', url: '/api/members/999', headers: ADMIN, payload: { nome: 'Y' } });
    assert.equal(missing.statusCode, 404);
    const badLimit = await app.inject({ method: 'GET', url: '/api/logs?limit=abc', headers: ADMIN });
    assert.equal(badLimit.statusCode, 400);
  });
});

describe('GET /api/dispositivo/membros', () => {
  // Noon in Sao Paulo on 2026-11-11 (day 2506), so the dates below hold wherever the tests run.
  beforeEach(() => { clock = Date.parse('2026-11-11T15:00:00Z'); });

  function membros(versao, headers = DEVICE) {
    const url = versao === undefined ? '/api/dispositivo/membros' : `/api/dispositivo/membros?versao=${versao}`;
    return app.inject({ method: 'GET', url, headers });
  }
  async function currentVersion() {
    const res = await membros(0);
    assert.equal(res.statusCode, 200);
    return res.json().versao;
  }
  function patch(id, payload) {
    return app.inject({ method: 'PATCH', url: `/api/members/${id}`, headers: ADMIN, payload });
  }

  test('401 without a valid device key', async () => {
    for (const headers of [{}, { 'x-device-key': 'nope' }, ADMIN]) {
      const res = await membros(0, headers);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.json(), { erro: 'nao_autorizado' });
    }
  });

  test('lists only active, paid members with an offline hash, in the compact shape', async () => {
    const joao = await createMember({ nome: 'Joao', pin: '1234', vencimento: '2026-12-31' });
    const ana = await createMember({ nome: 'Ana', pin: '4321', vencimento: '2026-11-11' }); // today: still valid
    await createMember({ nome: 'Maria', pin: '5678', vencimento: '2026-11-10' }); // overdue
    await createMember({ nome: 'Pedro', pin: '9999', vencimento: '2026-12-31', ativo: false });
    const legacy = await createMember({ nome: 'Legado', pin: '2468', vencimento: '2026-12-31' });
    db.prepare('UPDATE members SET pin_hash_offline = NULL WHERE id = ?').run(legacy.id); // as after the migration

    const res = await membros(0);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^application\/json/);
    // Starts at 1; 5 creates + 1 hash cleared = 7.
    assert.equal(res.body, `{"versao":7,"membros":[[${joao.id},"75a2b0661f593e7c",2556],[${ana.id},"bd3e34fdff668e05",2506]]}`);
  });

  test('"today" is the Sao Paulo date, not UTC', async () => {
    const m = await createMember({ nome: 'Ana', pin: '4321', vencimento: '2026-11-11' });

    clock = Date.parse('2026-11-12T02:59:59Z'); // 23:59:59 on 2026-11-11 in Sao Paulo
    const before = (await membros(0)).json();
    assert.deepEqual(before.membros.map((e) => e[0]), [m.id]);

    clock = Date.parse('2026-11-12T03:00:00Z'); // midnight in Sao Paulo
    const after = (await membros(0)).json();
    assert.deepEqual(after.membros, []);
    // A date passing is not a change: the device drops the member by checking validade_dias itself.
    assert.equal(after.versao, before.versao);
  });

  test('304 with an empty body when the device already has the current version', async () => {
    await createMember({ nome: 'Joao', pin: '1234', vencimento: '2026-12-31' });
    const versao = await currentVersion();

    const same = await membros(versao);
    assert.equal(same.statusCode, 304);
    assert.equal(same.body, '');

    for (const other of [undefined, 0, versao - 1, versao + 1]) {
      const res = await membros(other);
      assert.equal(res.statusCode, 200, `versao=${other}`);
      assert.equal(res.json().versao, versao);
    }
  });

  test('400 when versao is not a non-negative integer', async () => {
    for (const versao of ['abc', '-1', '1.5']) {
      const res = await membros(versao);
      assert.equal(res.statusCode, 400, versao);
      assert.deepEqual(res.json(), { erro: 'requisicao_invalida' });
    }
  });

  test('lista_versao goes up exactly when the offline list can change', async () => {
    const m = await createMember({ nome: 'Joao', pin: '1234', vencimento: '2026-12-31' });
    await createMember({ nome: 'Ana', pin: '4321', vencimento: '2026-12-31' });
    let versao = await currentVersion();

    async function step(label, action, bumps) {
      await action();
      const now = await currentVersion();
      assert.equal(now, bumps ? versao + 1 : versao, label);
      versao = now;
    }

    await step('nome only', () => patch(m.id, { nome: 'Joao Silva' }), false);
    await step('same ativo', () => patch(m.id, { ativo: true }), false);
    await step('same vencimento', () => patch(m.id, { vencimento: '2026-12-31' }), false);
    await step('same PIN', () => patch(m.id, { pin: '1234' }), false);
    await step('PIN taken (409)', () => patch(m.id, { pin: '4321' }), false);
    await step('unknown member (404)', () => patch(999, { ativo: false }), false);
    await step('time passes', () => { clock += 60 * 86_400_000; }, false);
    await step('PIN changed', () => patch(m.id, { pin: '5678' }), true);
    await step('ativo changed', () => patch(m.id, { ativo: false }), true);
    await step('vencimento changed', () => patch(m.id, { vencimento: '2027-06-30' }), true);
    await step('several fields in one PATCH', () => patch(m.id, { ativo: true, vencimento: '2027-07-31' }), true);
    await step('created', () => createMember({ nome: 'Novo', pin: '1357', vencimento: '2027-01-31' }), true);
    await step('create with a taken PIN (409)', () => app.inject({
      method: 'POST', url: '/api/members', headers: ADMIN, payload: { nome: 'X', pin: '1357', vencimento: '2027-01-31' },
    }), false);
    await step('deleted', () => app.inject({ method: 'DELETE', url: `/api/members/${m.id}`, headers: ADMIN }), true);
    await step('delete again (404)', () => app.inject({ method: 'DELETE', url: `/api/members/${m.id}`, headers: ADMIN }), false);
  });

  test('a PIN change replaces the offline hash', async () => {
    const m = await createMember({ nome: 'Joao', pin: '1234', vencimento: '2026-12-31' });
    await patch(m.id, { pin: '5678' });
    assert.deepEqual((await membros(0)).json().membros, [[m.id, 'b7b278a6c70adb7b', 2556]]);
  });

  test('handles 2000+ members', async () => {
    const insert = db.prepare(`INSERT INTO members (nome, pin_hash, pin_hash_offline, ativo, vencimento, created_at)
      VALUES (?, ?, ?, 1, '2027-11-11', '2026-11-11T00:00:00.000Z')`);
    db.transaction(() => {
      for (let i = 1; i <= 2500; i++) insert.run(`Membro ${i}`, `online-${i}`, i.toString(16).padStart(16, '0'));
    })();

    const res = await membros(0);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.versao, 2501);
    assert.equal(body.membros.length, 2500);
    assert.deepEqual(body.membros[2499], [2500, '00000000000009c4', 2871]);
    assert.ok(res.body.length < 2500 * 34, `body is ${res.body.length} bytes`);
  });

  test('POST /api/acesso is unaffected by the offline list', async () => {
    // /api/acesso checks the real server date, not the test clock.
    await createMember({ nome: 'Joao', pin: '1234', vencimento: future });
    const res = await acesso('1234');
    assert.deepEqual(Object.keys(res.json()), ['liberado', 'motivo', 'mensagem', 'tempo_abertura_ms']);
    assert.equal(res.json().motivo, 'OK');
  });
});
