// All dates in the app are in the kitchen's local time zone.
export const TIME_ZONE = process.env.TIME_ZONE || 'Asia/Kolkata';

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false,
});

/** YYYY-MM-DD for a millisecond timestamp, in the kitchen's time zone. */
export function localDate(ts = Date.now()) {
  return dateFmt.format(new Date(ts));
}

/** HH:MM (24h) for a millisecond timestamp, in the kitchen's time zone. */
export function localTime(ts = Date.now()) {
  return timeFmt.format(new Date(ts));
}

/** Offset of TIME_ZONE from UTC, in minutes, at the given instant. */
function zoneOffsetMinutes(ts) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ts));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - ts) / 60000);
}

/** Millisecond timestamp for a wall-clock time in the kitchen's time zone. */
export function zonedTimestamp(year, month, day, hour = 0, minute = 0, second = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  return guess - zoneOffsetMinutes(guess) * 60000;
}

/** Shift a YYYY-MM-DD string by a number of days. */
export function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}
