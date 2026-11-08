/**
 * In-memory brute-force guard, keyed by device_id.
 *
 * After `maxFailures` wrong PINs within a sliding `windowMs`, the device is blocked for `blockMs`.
 * While blocked, every attempt is rejected (even a correct PIN) without extending the block.
 * State lives in memory, so it resets when the server restarts.
 */
export function createBruteForceGuard({ maxFailures, windowMs, blockMs, now = Date.now }) {
  const devices = new Map(); // device_id -> { failures: number[], blockedUntil: number }

  function isBlocked(deviceId) {
    const entry = devices.get(deviceId);
    return entry !== undefined && entry.blockedUntil > now();
  }

  function registerFailure(deviceId) {
    const t = now();
    let entry = devices.get(deviceId);
    if (!entry) {
      entry = { failures: [], blockedUntil: 0 };
      devices.set(deviceId, entry);
    }
    entry.failures = entry.failures.filter((ts) => t - ts < windowMs);
    entry.failures.push(t);
    if (entry.failures.length >= maxFailures) {
      entry.blockedUntil = t + blockMs;
      entry.failures = [];
    }
  }

  // Drop entries that no longer matter so the map cannot grow forever.
  function prune() {
    const t = now();
    for (const [deviceId, entry] of devices) {
      const recent = entry.failures.some((ts) => t - ts < windowMs);
      if (!recent && entry.blockedUntil <= t) devices.delete(deviceId);
    }
  }
  const timer = setInterval(prune, windowMs);
  timer.unref();

  return {
    isBlocked,
    registerFailure,
    stop: () => clearInterval(timer),
  };
}
