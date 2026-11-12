import { OFFLINE_TIMEZONE } from '../config.js';
import { dateStringInTimeZone, dayNumber } from '../dates.js';
import { requireSecret } from '../security.js';

const querySchema = {
  type: 'object',
  properties: {
    // The lista_versao the device already holds. 0 (or missing) means "I have no list yet".
    versao: { type: 'integer', minimum: 0 },
  },
};

/**
 * GET /api/dispositivo/membros?versao=<n>: the member list the ESP32 uses when the server is unreachable.
 *
 * 304 with an empty body when the device already has the current version. Otherwise 200 with
 * {"versao":43,"membros":[[member_id,"pin_hash_offline",validade_dias],...]}, serialized compactly
 * (about 32 bytes per member). validade_dias is vencimento as a day number (2020-01-01 = 0).
 */
export default async function dispositivoRoutes(app, { config, repo, now }) {
  app.get('/api/dispositivo/membros', {
    onRequest: requireSecret((req) => req.headers['x-device-key'], config.deviceKey),
    schema: { querystring: querySchema },
  }, async (request, reply) => {
    const today = dateStringInTimeZone(OFFLINE_TIMEZONE, new Date(now()));
    const { versao, membros } = repo.getOfflineList(today, request.query.versao);

    if (membros === null) return reply.code(304).send();

    request.log.info({ versao, membros: membros.length }, 'offline list sent');
    // Plain JSON.stringify output: no whitespace, members as 3-element arrays.
    return {
      versao,
      membros: membros.map((m) => [m.id, m.pin_hash_offline, dayNumber(m.vencimento)]),
    };
  });
}
