import 'dotenv/config';
import os from 'node:os';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { buildApp } from './app.js';

function lanIPv4Addresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address);
}

function isWsl() {
  return Boolean(process.env.WSL_DISTRO_NAME) || os.release().toLowerCase().includes('microsoft');
}

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[config] ${err.message}`);
  process.exit(1);
}
for (const warning of config.warnings) console.warn(`[config] WARNING: ${warning}`);

const db = openDatabase(config.dbPath);
const app = buildApp({ config, db, logger: { level: config.logLevel } });

try {
  // 0.0.0.0, not localhost: the ESP32 on the LAN must be able to reach us.
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Stop the other process or set PORT in .env.`);
  } else {
    console.error(err);
  }
  db.close();
  process.exit(1);
}

const addresses = lanIPv4Addresses();
console.log('');
if (addresses.length === 0) {
  console.log(`Listening on http://0.0.0.0:${config.port} (no LAN IPv4 address found; is the network up?)`);
} else {
  for (const address of addresses) console.log(`Listening on http://${address}:${config.port}`);
}
console.log(`Local:        http://localhost:${config.port}`);
console.log(`Database:     ${config.dbPath}`);
if (isWsl()) {
  console.log('Note: running inside WSL. If the ESP32 cannot connect, see "Running under WSL2" in README.md.');
}
console.log('');

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received, shutting down`);
  try {
    await app.close();
  } finally {
    db.close();
    process.exit(0);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
