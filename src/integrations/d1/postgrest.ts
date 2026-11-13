// A tiny supabase-js compatible query builder. It only *describes* a query
// (as a plain JSON object); an executor runs it — directly against D1 on the
// server, or via /api/db from the browser. Keeps the original Lovable call
// sites (`supabase.from("x").select(...).eq(...)`) working unchanged.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "is" | "in";
export type Filter =
  | { col: string; op: FilterOp; val: unknown; negate?: boolean | undefined }
  | { or: string };

export type Query = {
  kind: "select" | "insert" | "upsert" | "update" | "delete";
  table: string;
  columns?: string | undefined;
  count?: "exact" | "planned" | "estimated" | undefined;
  head?: boolean | undefined;
  filters: Filter[];
  order: Array<{ col: string; asc: boolean; nullsFirst?: boolean | undefined }>;
  limit?: number | undefined;
  offset?: number | undefined;
  single?: "one" | "maybe" | undefined;
  values?: Record<string, unknown> | Record<string, unknown>[] | undefined;
  onConflict?: string | undefined;
  ignoreDuplicates?: boolean | undefined;
  returning?: string | undefined;
};

export type RpcCall = { kind: "rpc"; fn: string; args: Record<string, unknown>; head?: boolean | undefined; count?: string | undefined };

export type PgError = { message: string; code?: string; details?: string | null; hint?: string | null };
export type PgResult<T = any> = {
  data: T;
  error: PgError | null;
  count: number | null;
  status: number;
  statusText: string;
};

export type Executor = (q: Query | RpcCall) => Promise<PgResult>;

type Row = Record<string, any>;

class Builder<T = Row[]> implements PromiseLike<PgResult<T>> {
  constructor(
    private q: Query,
    private exec: Executor,
  ) {}

  private f(col: string, op: FilterOp, val: unknown, negate = false) {
    this.q.filters.push({ col, op, val, negate });
    return this;
  }

  select(columns = "*", opts?: { count?: "exact" | "planned" | "estimated"; head?: boolean }) {
    if (this.q.kind === "select") {
      this.q.columns = columns;
      if (opts?.count) this.q.count = opts.count;
      if (opts?.head) this.q.head = true;
    } else {
      this.q.returning = columns;
    }
    return this;
  }
  eq(col: string, val: unknown) { return this.f(col, "eq", val); }
  neq(col: string, val: unknown) { return this.f(col, "neq", val); }
  gt(col: string, val: unknown) { return this.f(col, "gt", val); }
  gte(col: string, val: unknown) { return this.f(col, "gte", val); }
  lt(col: string, val: unknown) { return this.f(col, "lt", val); }
  lte(col: string, val: unknown) { return this.f(col, "lte", val); }
  like(col: string, val: string) { return this.f(col, "like", val); }
  ilike(col: string, val: string) { return this.f(col, "ilike", val); }
  is(col: string, val: unknown) { return this.f(col, "is", val); }
  in(col: string, vals: readonly unknown[]) { return this.f(col, "in", [...vals]); }
  not(col: string, op: string, val: unknown) { return this.f(col, op as FilterOp, val, true); }
  filter(col: string, op: string, val: unknown) { return this.f(col, op as FilterOp, val); }
  match(obj: Record<string, unknown>) {
    for (const [k, v] of Object.entries(obj)) this.f(k, "eq", v);
    return this;
  }
  or(expr: string) {
    this.q.filters.push({ or: expr });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.q.order.push({ col, asc: opts?.ascending ?? true, nullsFirst: opts?.nullsFirst });
    return this;
  }
  limit(n: number) {
    this.q.limit = n;
    return this;
  }
  range(from: number, to: number) {
    this.q.offset = from;
    this.q.limit = to - from + 1;
    return this;
  }
  single() {
    this.q.single = "one";
    return this as unknown as Builder<any>;
  }
  maybeSingle() {
    this.q.single = "maybe";
    return this as unknown as Builder<any>;
  }
  abortSignal() { return this; }
  returns<U>() { return this as unknown as Builder<U>; }
  throwOnError() { return this; }

  then<R1 = PgResult<T>, R2 = never>(
    onfulfilled?: ((v: PgResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.exec(this.q).then(onfulfilled as any, onrejected);
  }
}

class Table {
  constructor(
    private table: string,
    private exec: Executor,
  ) {}
  private base(kind: Query["kind"]): Query {
    return { kind, table: this.table, filters: [], order: [] };
  }
  select(columns = "*", opts?: { count?: "exact" | "planned" | "estimated"; head?: boolean }) {
    return new Builder(this.base("select"), this.exec).select(columns, opts);
  }
  insert(values: Record<string, unknown> | Record<string, unknown>[], _opts?: unknown) {
    return new Builder({ ...this.base("insert"), values }, this.exec);
  }
  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    opts?: { onConflict?: string; ignoreDuplicates?: boolean },
  ) {
    return new Builder(
      { ...this.base("upsert"), values, onConflict: opts?.onConflict, ignoreDuplicates: opts?.ignoreDuplicates },
      this.exec,
    );
  }
  update(values: Record<string, unknown>) {
    return new Builder({ ...this.base("update"), values }, this.exec);
  }
  delete() {
    return new Builder(this.base("delete"), this.exec);
  }
}

class RpcBuilder implements PromiseLike<PgResult<any[] & any>> {
  constructor(
    private call: RpcCall,
    private exec: Executor,
  ) {}
  single() { return this; }
  maybeSingle() { return this; }
  then<R1 = PgResult<any[] & any>, R2 = never>(
    onfulfilled?: ((v: PgResult<any[] & any>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.exec(this.call).then(onfulfilled as any, onrejected);
  }
}

export type DbClient = {
  from: (table: string) => Table;
  rpc: (fn: string, args?: Record<string, unknown>, opts?: { head?: boolean; count?: string }) => RpcBuilder;
};

export function createDbClient(exec: Executor): DbClient {
  return {
    from: (table: string) => new Table(table, exec),
    rpc: (fn, args = {}, opts) => new RpcBuilder({ kind: "rpc", fn, args, ...opts }, exec),
  };
}

export const ok = <T>(data: T, count: number | null = null): PgResult<T> => ({
  data,
  error: null,
  count,
  status: 200,
  statusText: "OK",
});

export const fail = (message: string, code = "D1ERR", status = 400): PgResult<null> => ({
  data: null,
  error: { message, code, details: null, hint: null },
  count: null,
  status,
  statusText: "Error",
});
