// Prints pin_hash_offline for one or more PINs, to cross-check the ESP32 implementation.
//
//   npm run offline-hash -- 1234 5678                        (uses OFFLINE_KEY from .env)
//   OFFLINE_KEY=<64 hex chars> node scripts/offline-hash.js 1234   (any other key)
import 'dotenv/config';
import { createOfflinePinHasher } from '../src/security.js';

const pins = process.argv.slice(2);
if (pins.length === 0) {
  console.error('Usage: npm run offline-hash -- <pin> [<pin> ...]');
  process.exit(1);
}

let hash;
try {
  hash = createOfflinePinHasher((process.env.OFFLINE_KEY ?? '').trim());
} catch (err) {
  console.error(`${err.message} Set it in .env or in the environment.`);
  process.exit(1);
}

for (const pin of pins) console.log(`${pin}  ${hash(pin)}`);
