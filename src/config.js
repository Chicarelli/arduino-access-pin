import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** How long the ESP32 keeps the door unlocked after an allowed attempt. */
export const DOOR_OPEN_MS = 3000;

/** Brute-force protection: MAX_FAILURES wrong PINs within WINDOW_MS blocks the device for BLOCK_MS. */
export const BRUTE_FORCE = Object.freeze({
  maxFailures: 5,
  windowMs: 60_000,
  blockMs: 30_000,
});

const REQUIRED = ['DEVICE_KEY', 'ADMIN_TOKEN', 'PIN_PEPPER'];

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !env[name] || !env[name].trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}. Copy .env.example to .env and fill them in.`);
  }

  const port = env.PORT === undefined || env.PORT === '' ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535 (got "${env.PORT}").`);
  }

  const warnings = [];
  if (env.PIN_PEPPER.trim().length < 16) {
    warnings.push('PIN_PEPPER is shorter than 16 characters; use a long random value.');
  }

  return {
    port,
    host: '0.0.0.0',
    deviceKey: env.DEVICE_KEY.trim(),
    adminToken: env.ADMIN_TOKEN.trim(),
    pinPepper: env.PIN_PEPPER.trim(),
    dbPath: env.DB_PATH ? path.resolve(projectRoot, env.DB_PATH) : path.join(projectRoot, 'data', 'gym.db'),
    logLevel: env.LOG_LEVEL || 'info',
    warnings,
  };
}
