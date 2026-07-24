export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Epoch ms of local midnight for the day containing `ts`. */
export function localMidnight(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Round `ts` up to the next slot boundary.
 * Anchored to local midnight so slots land on wall-clock :00/:30 even in
 * half-hour-offset timezones. Already-on-a-boundary stays put.
 */
export function ceilToSlot(ts, slotMinutes) {
  const slot = slotMinutes * MINUTE;
  const base = localMidnight(ts);
  const delta = ts - base;
  const rounded = Math.ceil(delta / slot) * slot;
  return base + rounded;
}

export function floorToSlot(ts, slotMinutes) {
  const slot = slotMinutes * MINUTE;
  const base = localMidnight(ts);
  return base + Math.floor((ts - base) / slot) * slot;
}

/** 'HH:MM' -> minutes past local midnight. Returns null on bad input. */
export function parseClock(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function minutesIntoLocalDay(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Is `ts` inside the dark window? Handles windows that wrap midnight
 * (e.g. 21:00 -> 07:00, which is the normal case for a kids' channel).
 */
export function inDarkWindow(ts, darkStart, darkEnd) {
  const s = parseClock(darkStart);
  const e = parseClock(darkEnd);
  if (s === null || e === null || s === e) return false;
  const now = minutesIntoLocalDay(ts);
  return s < e ? now >= s && now < e : now >= s || now < e;
}

/** When does the current dark window end, as an epoch ms? */
export function darkWindowEnd(ts, darkStart, darkEnd) {
  const e = parseClock(darkEnd);
  if (e === null) return ts;
  const base = localMidnight(ts);
  let end = base + e * MINUTE;
  if (end <= ts) end += DAY;
  return end;
}

export function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function fmtDuration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
