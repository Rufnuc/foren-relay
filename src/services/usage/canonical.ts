// Deterministic JSON serialization — byte-for-byte identical to the Foren
// client's src/usage/canonical.ts. Used to (a) recompute the exact bytes a
// client signed, and (b) hash a weekly report reproducibly for the on-chain
// commitment. Keys sorted lexicographically, no insignificant whitespace,
// integers only.

export function canonicalize(value: unknown): string {
  return ser(value);
}

function ser(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return JSON.stringify(v);
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(v as number) || !Number.isInteger(v as number)) {
      throw new Error("canonicalize: only finite integers are allowed");
    }
    return String(v);
  }
  if (Array.isArray(v)) return "[" + v.map(ser).join(",") + "]";
  if (t === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + ser(obj[k])).join(",") + "}";
  }
  throw new Error(`canonicalize: unsupported type ${t}`);
}

/**
 * ISO-8601 week label for a UTC instant, e.g. "2026-W39". Weeks start Monday;
 * the week-year can differ from the calendar year around the new year. We bucket
 * by the SERVER'S receipt time so a client clock can't move activity between
 * weeks.
 */
export function isoWeek(atMs: number): string {
  const d = new Date(atMs);
  // Shift to Thursday of the current week to get the ISO week-year right.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7; // Sun=0 -> 7
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Monday 00:00 UTC … Sunday 23:59:59 UTC date range for a "YYYY-Www" label. */
export function isoWeekRange(week: string): { startMs: number; endMs: number } {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw new Error(`bad week label: ${week}`);
  const year = Number(m[1]);
  const wk = Number(m[2]);
  // ISO week 1 contains Jan 4th. Find that week's Monday, then add (wk-1) weeks.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const startMs = week1Monday.getTime() + (wk - 1) * 7 * 86400000;
  const endMs = startMs + 7 * 86400000 - 1;
  return { startMs, endMs };
}
