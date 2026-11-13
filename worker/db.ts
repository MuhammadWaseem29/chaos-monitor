import { today } from "./env";

export type Counters = {
  new_subs: number;
  probed: number;
  live: number;
  takeovers: number;
  roots_checked: number;
  errors: number;
};

/** Thin D1 wrapper that tallies rows read/written so the free-tier budget can be enforced. */
export class Db {
  read = 0;
  written = 0;
  counters: Counters = { new_subs: 0, probed: 0, live: 0, takeovers: 0, roots_checked: 0, errors: 0 };

  constructor(public d1: D1Database) {}

  private track(meta: { rows_read?: number; rows_written?: number } | undefined) {
    this.read += meta?.rows_read ?? 0;
    this.written += meta?.rows_written ?? 0;
  }

  stmt(sql: string, ...args: unknown[]) {
    return this.d1.prepare(sql).bind(...args);
  }

  async all<T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T[]> {
    const r = await this.stmt(sql, ...args).all<T>();
    this.track(r.meta);
    return r.results ?? [];
  }

  async first<T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T | null> {
    const rows = await this.all<T>(sql, ...args);
    return rows[0] ?? null;
  }

  async run(sql: string, ...args: unknown[]) {
    const r = await this.stmt(sql, ...args).run();
    this.track(r.meta);
    return r;
  }

  async batch(stmts: D1PreparedStatement[], size = 50) {
    for (let i = 0; i < stmts.length; i += size) {
      const rs = await this.d1.batch(stmts.slice(i, i + size));
      for (const r of rs) this.track(r.meta);
    }
  }

  async meta(keys: string[]): Promise<Record<string, string | null>> {
    const rows = await this.all<{ key: string; value: string | null }>(
      `SELECT key, value FROM meta WHERE key IN (${keys.map(() => "?").join(",")})`,
      ...keys,
    );
    const out: Record<string, string | null> = {};
    for (const k of keys) out[k] = null;
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  setMetaStmt(key: string, value: string) {
    return this.stmt(
      "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  async usageToday() {
    return (
      (await this.first<{ rows_written: number; rows_read: number }>(
        "SELECT rows_written, rows_read FROM daily WHERE day = ?",
        today(),
      )) ?? { rows_written: 0, rows_read: 0 }
    );
  }

  usage() {
    return { read: this.read, written: this.written, counters: { ...this.counters } };
  }

  /** Folds a child invocation's usage into this one, so only the dispatcher writes stats. */
  absorb(u: { read?: number; written?: number; counters?: Partial<Counters> } | undefined) {
    if (!u) return;
    this.read += u.read ?? 0;
    this.written += u.written ?? 0;
    for (const k of Object.keys(this.counters) as Array<keyof Counters>) this.counters[k] += u.counters?.[k] ?? 0;
  }

  /** Persists this invocation's counters and D1 usage into today's row (one write). */
  async flush() {
    const c = this.counters;
    await this.stmt(
      `INSERT INTO daily (day, new_subs, probed, live, takeovers, roots_checked, errors, rows_written, rows_read, invocations)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(day) DO UPDATE SET
         new_subs = new_subs + excluded.new_subs,
         probed = probed + excluded.probed,
         live = live + excluded.live,
         takeovers = takeovers + excluded.takeovers,
         roots_checked = roots_checked + excluded.roots_checked,
         errors = errors + excluded.errors,
         rows_written = rows_written + excluded.rows_written,
         rows_read = rows_read + excluded.rows_read,
         invocations = invocations + 1`,
      today(),
      c.new_subs,
      c.probed,
      c.live,
      c.takeovers,
      c.roots_checked,
      c.errors,
      this.written + 1,
      this.read,
    ).run();
  }
}
