import type { D1Database, Fetcher } from "@cloudflare/workers-types";
import { AsyncLocalStorage } from "node:async_hooks";

// Access to the Cloudflare bindings from anywhere on the server.
// nitro's cloudflare preset stores the env on globalThis.__env__ for every
// request; the worker entry does the same for cron/internal invocations.

export interface CfEnv {
  DB: D1Database;
  SELF?: Fetcher;
  ASSETS?: Fetcher;
  [key: string]: unknown;
}

export function cfEnv(): CfEnv {
  const env = (globalThis as { __env__?: CfEnv }).__env__;
  if (!env?.DB) throw new Error("D1 binding DB is not available");
  return env;
}

/** Secrets and vars: Worker env first, then process.env (nodejs_compat). */
export function secret(name: string): string | undefined {
  const env = (globalThis as { __env__?: Record<string, unknown> }).__env__;
  const v = env?.[name];
  if (typeof v === "string" && v) return v;
  const p = typeof process !== "undefined" ? process.env?.[name] : undefined;
  return p || undefined;
}

type Usage = { read: number; written: number };
const usageStore = new AsyncLocalStorage<Usage>();
const globalUsage: Usage = { read: 0, written: 0 };

/** D1 usage of the current request (isolated per request: requests share isolates). */
export const usage: Usage = {
  get read() {
    return (usageStore.getStore() ?? globalUsage).read;
  },
  set read(v: number) {
    (usageStore.getStore() ?? globalUsage).read = v;
  },
  get written() {
    return (usageStore.getStore() ?? globalUsage).written;
  },
  set written(v: number) {
    (usageStore.getStore() ?? globalUsage).written = v;
  },
};

/** Runs fn with its own usage counter and returns both. */
export async function withUsage<T>(fn: () => Promise<T>): Promise<{ result: T; usage: Usage }> {
  const store: Usage = { read: 0, written: 0 };
  const result = await usageStore.run(store, fn);
  return { result, usage: store };
}

export function track(meta: { rows_read?: number; rows_written?: number } | undefined) {
  const u = usageStore.getStore() ?? globalUsage;
  u.read += meta?.rows_read ?? 0;
  u.written += meta?.rows_written ?? 0;
}

export const nowIso = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();
