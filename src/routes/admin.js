import { isUniqueViolation } from '../db.js';
import { bearerToken, requireSecret } from '../security.js';

const nome = { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' };
const pin = { type: 'string', pattern: '^[0-9]{4,8}$' };
const vencimento = { type: 'string', format: 'date' }; // YYYY-MM-DD
const ativo = { type: 'boolean' };

const memberSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    nome: { type: 'string' },
    ativo: { type: 'boolean' },
    vencimento: { type: 'string' },
    created_at: { type: 'string' },
  },
};

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
};

const logSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    timestamp: { type: 'string' },
    device_id: { type: 'string' },
    member_id: { type: ['integer', 'null'] },
    nome: { type: ['string', 'null'] },
    liberado: { type: 'boolean' },
    motivo: { type: 'string' },
  },
};

const PIN_IN_USE = { erro: 'pin_em_uso' };
const NOT_FOUND = { erro: 'nao_encontrado' };

/** Admin API: every route in this plugin requires `Authorization: Bearer <ADMIN_TOKEN>`. */
export default async function adminRoutes(app, { config, repo, hashPin, hashPinOffline }) {
  app.addHook('onRequest', requireSecret(bearerToken, config.adminToken));

  app.post('/members', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['nome', 'pin', 'vencimento'],
        properties: { nome, pin, vencimento, ativo },
      },
      response: { 201: memberSchema },
    },
  }, async (request, reply) => {
    const { nome, pin, vencimento, ativo = true } = request.body;
    try {
      const member = repo.createMember({
        nome: nome.trim(),
        pinHash: hashPin(pin),
        pinHashOffline: hashPinOffline(pin),
        ativo,
        vencimento,
      });
      return reply.code(201).send(member);
    } catch (err) {
      if (isUniqueViolation(err)) return reply.code(409).send(PIN_IN_USE);
      throw err;
    }
  });

  app.get('/members', {
    schema: { response: { 200: { type: 'array', items: memberSchema } } },
  }, async () => repo.listMembers());

  app.patch('/members/:id', {
    schema: {
      params: idParams,
      body: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: { nome, pin, vencimento, ativo },
      },
      response: { 200: memberSchema },
    },
  }, async (request, reply) => {
    const { nome, pin, vencimento, ativo } = request.body;
    if ([nome, pin, vencimento, ativo].every((v) => v === undefined)) {
      return reply.code(400).send({ erro: 'requisicao_invalida' });
    }
    try {
      const member = repo.updateMember(request.params.id, {
        nome: nome?.trim(),
        pinHash: pin === undefined ? undefined : hashPin(pin),
        pinHashOffline: pin === undefined ? undefined : hashPinOffline(pin),
        ativo,
        vencimento,
      });
      if (!member) return reply.code(404).send(NOT_FOUND);
      return member;
    } catch (err) {
      if (isUniqueViolation(err)) return reply.code(409).send(PIN_IN_USE);
      throw err;
    }
  });

  app.delete('/members/:id', {
    schema: { params: idParams },
  }, async (request, reply) => {
    if (!repo.deleteMember(request.params.id)) return reply.code(404).send(NOT_FOUND);
    return reply.code(204).send();
  });

  app.get('/logs', {
    schema: {
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 1000, default: 50 } },
      },
      response: { 200: { type: 'array', items: logSchema } },
    },
  }, async (request) => repo.listLogs(request.query.limit));
}
