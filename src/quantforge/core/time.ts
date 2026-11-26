// Market calendar for spot XAUUSD and UTC timeframe arithmetic.
//
// Spot gold trades over the counter from Sunday 18:00 New York time to Friday 17:00 New York time, with a
// daily settlement break 17:00–18:00 New York time (Monday–Thursday). New York's UTC offset follows US
// daylight saving time (second Sunday of March 02:00 local to first Sunday of November 02:00 local). The
// rule is computed here so it does not depend on the ICU time-zone data a Node build ships with.
// Exchange holidays are not modelled; bars on such days are caught by the stale-quote detector instead.

import { TF_MS, type Timeframe } from "./types.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** UTC ms of the n-th (1-based) given weekday of a month at a UTC hour. */
function nthWeekdayUtc(year: number, month: number, weekday: number, n: number, hourUtc: number): number {
  const first = new Date(Date.UTC(year, month, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return Date.UTC(year, month, 1 + shift + (n - 1) * 7, hourUtc);
}

/** Whether US daylight saving time is in force at the UTC instant. */
export function isUsDst(utcMs: number): boolean {
  const year = new Date(utcMs).getUTCFullYear();
  // 02:00 EST = 07:00 UTC on the second Sunday of March; 02:00 EDT = 06:00 UTC on the first Sunday of November.
  const start = nthWeekdayUtc(year, 2, 0, 2, 7);
  const end = nthWeekdayUtc(year, 10, 0, 1, 6);
  return utcMs >= start && utcMs < end;
}

/** New York local wall-clock parts of a UTC instant. */
export function newYorkParts(utcMs: number): { dow: number; minutes: number; dateKey: string } {
  const offset = isUsDst(utcMs) ? -4 * HOUR : -5 * HOUR;
  const local = new Date(utcMs + offset);
  return {
    dow: local.getUTCDay(),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
    dateKey: local.toISOString().slice(0, 10),
  };
}

const NY_CLOSE = 17 * 60;
const NY_REOPEN = 18 * 60;

/** Whether the spot market is open at the instant. */
export function isMarketOpenAt(utcMs: number): boolean {
  const { dow, minutes } = newYorkParts(utcMs);
  if (dow === 6) return false; // Saturday
  if (dow === 0) return minutes >= NY_REOPEN; // Sunday reopen
  if (dow === 5) return minutes < NY_CLOSE; // Friday close
  return minutes < NY_CLOSE || minutes >= NY_REOPEN; // daily break
}

/** Whether a bar starting at `ts` lies (at least partly) inside open market hours. */
export function isBarInMarketHours(ts: number, tf: Timeframe): boolean {
  const len = TF_MS[tf];
  if (len <= 15 * MINUTE) return isMarketOpenAt(ts);
  // Longer bars: open if any 15-minute slice inside is open.
  for (let t = ts; t < ts + len; t += 15 * MINUTE) if (isMarketOpenAt(t)) return true;
  return false;
}

/** Minutes until the next market close (daily break or weekend) from an open instant; 0 when closed. */
export function minutesToClose(utcMs: number): number {
  if (!isMarketOpenAt(utcMs)) return 0;
  let t = utcMs;
  for (let i = 0; i < 60 * 24 * 3; i++) {
    t += MINUTE;
    if (!isMarketOpenAt(t)) return i + 1;
  }
  return 60 * 24 * 3;
}

/** Whether the next close is the weekend close (Friday) rather than the daily break. */
export function nextCloseIsWeekend(utcMs: number): boolean {
  return newYorkParts(utcMs).dow === 5;
}

/** Start (UTC ms) of the bar containing `ts`. 4h bars are aligned to 00:00 UTC; 1d to 00:00 UTC. */
export function floorTo(ts: number, tf: Timeframe): number {
  const len = TF_MS[tf];
  return Math.floor(ts / len) * len;
}

/** Whether the bar starting at `ts` has closed by `now` (with a safety lag for late provider updates). */
export function isClosed(ts: number, tf: Timeframe, now: number, lagMs = 0): boolean {
  return ts + TF_MS[tf] + lagMs <= now;
}

export type TradingSession = "asia" | "london" | "overlap" | "newyork" | "closed";

/**
 * Liquidity session of an instant by UTC hour: Asia 22:00–07:00, London 07:00–12:00,
 * London/New York overlap 12:00–16:00, New York 16:00–21:00 (or the daily break when closed).
 */
export function sessionOf(utcMs: number): TradingSession {
  if (!isMarketOpenAt(utcMs)) return "closed";
  const h = new Date(utcMs).getUTCHours();
  if (h >= 7 && h < 12) return "london";
  if (h >= 12 && h < 16) return "overlap";
  if (h >= 16 && h < 22) return "newyork";
  return "asia";
}

export const SESSION_CODES: Readonly<Record<TradingSession, number>> = {
  asia: 0,
  london: 1,
  overlap: 2,
  newyork: 3,
  closed: 4,
};

/** Number of swap rollovers (17:00 New York, Monday–Friday) in (fromMs, toMs], Wednesday counted triple. */
export function rolloversBetween(fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 0;
  let count = 0;
  const startKey = newYorkParts(fromMs).dateKey;
  for (let day = Date.parse(`${startKey}T00:00:00Z`); ; day += 24 * HOUR) {
    const roll = isUsDst(day + 21 * HOUR) ? day + 21 * HOUR : day + 22 * HOUR;
    if (roll > toMs) break;
    if (roll > fromMs) {
      const dow = new Date(day).getUTCDay();
      if (dow >= 1 && dow <= 5) count += dow === 3 ? 3 : 1;
    }
  }
  return count;
}

export function isoUtc(ts: number): string {
  return new Date(ts).toISOString().replace(".000Z", "Z");
}

/** UTC calendar day key (YYYY-MM-DD). */
export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Monday 00:00 UTC of the week containing `ts`. */
export function utcWeekStart(ts: number): number {
  const d = new Date(ts);
  const dow = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
}

export function utcDayStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
