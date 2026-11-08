import { DOOR_OPEN_MS } from '../config.js';
import { localDateString } from '../dates.js';
import { requireSecret } from '../security.js';
import { welcomeMessage } from '../text.js';

// ASCII only, <= 32 chars: these may be shown on a 16x2 LCD.
const DENIED_MESSAGES = {
  SENHA_INVALIDA: 'Senha invalida',
  PAGAMENTO_PENDENTE: 'Mensalidade em atraso',
  USUARIO_INATIVO: 'Cadastro inativo',
  BLOQUEADO_TEMPORARIO: 'Aguarde e tente de novo',
};

const bodySchema = {
  type: 'object',
  required: ['device_id', 'senha'],
  properties: {
    device_id: { type: 'string', minLength: 1, maxLength: 32 },
    senha: { type: 'string', pattern: '^[0-9]{4,8}$' },
  },
};

// The serializer only emits these 4 fields, so the ESP32 always gets the same small flat object.
const decisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['liberado', 'motivo', 'mensagem', 'tempo_abertura_ms'],
  properties: {
    liberado: { type: 'boolean' },
    motivo: { type: 'string' },
    mensagem: { type: 'string' },
    tempo_abertura_ms: { type: 'integer' },
  },
};

function denied(motivo) {
  return { liberado: false, motivo, mensagem: DENIED_MESSAGES[motivo], tempo_abertura_ms: 0 };
}

function allowed(member) {
  return { liberado: true, motivo: 'OK', mensagem: welcomeMessage(member.nome), tempo_abertura_ms: DOOR_OPEN_MS };
}

/**
 * Decision order: rate limit -> PIN lookup -> ativo -> vencimento >= today (server local date).
 * Returns the response plus the member id (if the PIN matched) for the access log.
 */
function decide({ deviceId, senha, repo, hashPin, guard }) {
  if (guard.isBlocked(deviceId)) {
    return { response: denied('BLOQUEADO_TEMPORARIO'), memberId: null };
  }

  const member = repo.findMemberByPinHash(hashPin(senha));
  if (!member) {
    guard.registerFailure(deviceId);
    return { response: denied('SENHA_INVALIDA'), memberId: null };
  }
  if (!member.ativo) {
    return { response: denied('USUARIO_INATIVO'), memberId: member.id };
  }
  if (member.vencimento < localDateString()) {
    return { response: denied('PAGAMENTO_PENDENTE'), memberId: member.id };
  }
  return { response: allowed(member), memberId: member.id };
}

export default async function acessoRoutes(app, { config, repo, hashPin, guard }) {
  app.post('/api/acesso', {
    onRequest: requireSecret((req) => req.headers['x-device-key'], config.deviceKey),
    bodyLimit: 1024,
    schema: { body: bodySchema, response: { 200: decisionSchema } },
  }, async (request) => {
    const { device_id: deviceId, senha } = request.body;
    const { response, memberId } = decide({ deviceId, senha, repo, hashPin, guard });

    repo.insertAccessLog({
      timestamp: new Date().toISOString(),
      deviceId,
      memberId,
      liberado: response.liberado,
      motivo: response.motivo,
    });

    // Never log the PIN, only the outcome.
    request.log.info({ device_id: deviceId, member_id: memberId, motivo: response.motivo }, 'access decision');
    return response;
  });
}
