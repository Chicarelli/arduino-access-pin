import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * pin_hash = HMAC-SHA256(PIN_PEPPER, pin), hex encoded.
 * Deterministic, so a member can be found by PIN alone, but useless without the pepper.
 */
export function createPinHasher(pepper) {
  return (pin) => createHmac('sha256', pepper).update(pin, 'utf8').digest('hex');
}

/**
 * pin_hash_offline = first 8 bytes of HMAC-SHA256(key = OFFLINE_KEY decoded from hex, message = pin as UTF-8),
 * as 16 lowercase hex characters. The ESP32 computes the same value to check a PIN against the offline list.
 */
export function createOfflinePinHasher(offlineKeyHex) {
  const key = Buffer.from(String(offlineKeyHex), 'hex');
  // Buffer.from stops at the first non-hex character, so this also rejects malformed input.
  if (key.length !== 32 || offlineKeyHex.length !== 64) {
    throw new Error('OFFLINE_KEY must be 32 bytes written as 64 hex characters.');
  }
  return (pin) => createHmac('sha256', key).update(pin, 'utf8').digest().subarray(0, 8).toString('hex');
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
