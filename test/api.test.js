import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { addDays, localDateString } from '../src/dates.js';

const config = {
  deviceKey: 'test-device-key',
  adminToken: 'test-admin-token',
  pinPepper: 'test-pepper-0123456789abcdef',
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
