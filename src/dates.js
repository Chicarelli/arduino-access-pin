/** Server local date as YYYY-MM-DD. */
export function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** Calendar date (YYYY-MM-DD) of `date` as seen in `timeZone`, e.g. "America/Sao_Paulo". */
export function dateStringInTimeZone(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const DAY_ZERO_UTC_MS = Date.UTC(2020, 0, 1);
const MS_PER_DAY = 86_400_000;

/**
 * Calendar days from 2020-01-01 to a YYYY-MM-DD date: 2020-01-01 is 0, 2020-01-02 is 1.
 * Pure calendar arithmetic (no timezone involved), so it matches the ESP32's own count.
 */
export function dayNumber(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - DAY_ZERO_UTC_MS) / MS_PER_DAY;
}
