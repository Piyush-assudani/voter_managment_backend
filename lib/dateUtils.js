/**
 * Timezone & Date/Time Chaos Guards (UTC persistence + deterministic IANA localization).
 * Prevents client clock skew, DST shifts, or local offset mismatches between servers.
 */

const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata';

function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

function resolveTimeZone(tz) {
  return isValidTimeZone(tz) ? tz.trim() : DEFAULT_TIMEZONE;
}

function parseSafeDate(input) {
  if (!input) return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toUtcIso(input = new Date()) {
  const d = parseSafeDate(input);
  return d ? d.toISOString() : new Date().toISOString();
}

function formatInTimeZone(input, timeZone = DEFAULT_TIMEZONE, locale = 'en-IN') {
  const d = parseSafeDate(input);
  if (!d) return '';
  return new Intl.DateTimeFormat(locale, {
    timeZone: resolveTimeZone(timeZone),
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

/**
 * Compute UTC [start, end] bounds for a calendar day inside a target IANA timezone (e.g. Asia/Kolkata).
 */
function getDayBoundsUtc(dateInput = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const d = parseSafeDate(dateInput) || new Date();
  const tz = resolveTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const isoDay = `${map.year}-${map.month}-${map.day}`;

  // Determine exact offset at local noon so DST edge transitions never double-count
  const probe = new Date(`${isoDay}T12:00:00.000Z`);
  const tzLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'shortOffset',
  })
    .formatToParts(probe)
    .find((p) => p.type === 'timeZoneName')?.value || 'GMT+05:30';

  const offsetMatch = tzLabel.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  let offsetMinutes = 330; // Default IST +05:30
  if (offsetMatch) {
    const sign = offsetMatch[1] === '-' ? -1 : 1;
    offsetMinutes = sign * (Number.parseInt(offsetMatch[2], 10) * 60 + Number.parseInt(offsetMatch[3] || '0', 10));
  }

  const startMs = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), 0, 0, 0, 0) - offsetMinutes * 60_000;
  return {
    dayString: isoDay,
    timeZone: tz,
    startUtc: new Date(startMs),
    endUtc: new Date(startMs + 24 * 60 * 60_000 - 1),
  };
}

module.exports = {
  DEFAULT_TIMEZONE,
  isValidTimeZone,
  resolveTimeZone,
  parseSafeDate,
  toUtcIso,
  formatInTimeZone,
  getDayBoundsUtc,
};

