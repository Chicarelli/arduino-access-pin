import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * pin_hash = HMAC-SHA256(PIN_PEPPER, pin), hex encoded.
 * Deterministic, so a member can be found by PIN alone, but useless without the pepper.
 */
export function createPinHasher(pepper) {
  return (pin) => createHmac('sha256', pepper).update(pin, 'utf8').digest('hex');
}

/** Constant-time string comparison (hashing first makes both sides the same length). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Fastify onRequest hook factory: 401 unless the header carries the expected secret. */
export function requireSecret(getPresented, expected) {
  return async function checkSecret(request, reply) {
    if (!safeEqual(getPresented(request), expected)) {
      return reply.code(401).send({ erro: 'nao_autorizado' });
    }
  };
}

export function bearerToken(request) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? '');
  return match ? match[1] : undefined;
}
