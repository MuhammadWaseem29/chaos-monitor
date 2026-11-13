// Browser "Supabase" client, now backed by Cloudflare D1 through /api/db and
// our own email/password auth (/api/auth/*). Keeps the supabase-js surface the
// app uses: supabase.from(...), supabase.rpc(...), supabase.auth.*.
import { createDbClient, fail, type PgResult, type Query, type RpcCall } from "@/integrations/d1/postgrest";

type AuthUser = { id: string; email: string; user_metadata: Record<string, unknown>; app_metadata?: Record<string, unknown>; created_at?: string };
export type AuthSession = { access_token: string; token_type: "bearer"; expires_at: number; user: AuthUser };
type AuthEvent = "INITIAL_SESSION" | "SIGNED_IN" | "SIGNED_OUT" | "TOKEN_REFRESHED" | "USER_UPDATED";
type Listener = (event: AuthEvent, session: AuthSession | null) => void;

const STORAGE_KEY = "chaos-auth-session";
const listeners = new Set<Listener>();

function readSession(): AuthSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as AuthSession;
    if (!s?.access_token || (s.expires_at && s.expires_at * 1000 < Date.now())) return null;
    return s;
  } catch {
    return null;
  }
}

function writeSession(s: AuthSession | null, event: AuthEvent) {
  try {
    if (s) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage blocked */
  }
  for (const l of listeners) l(event, s);
}

async function authCall(path: string, body: unknown, token?: string) {
  try {
    const res = await fetch(`/api/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    const json = (await res.json().catch(() => ({}))) as { session?: AuthSession; user?: AuthUser; error?: string };
    if (!res.ok || json.error) return { data: null, error: { message: json.error ?? `HTTP ${res.status}`, status: res.status } };
    return { data: json, error: null };
  } catch (e) {
    return { data: null, error: { message: e instanceof Error ? e.message : "Network error", status: 0 } };
  }
}

const auth = {
  async getSession() {
    return { data: { session: readSession() }, error: null };
  },
  async getUser() {
    const s = readSession();
    return { data: { user: s?.user ?? null }, error: null };
  },
  onAuthStateChange(cb: Listener) {
    listeners.add(cb);
    queueMicrotask(() => cb("INITIAL_SESSION", readSession()));
    return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
  },
  async signInWithPassword({ email, password }: { email: string; password: string }) {
    const r = await authCall("signin", { email, password });
    if (r.error || !r.data?.session) return { data: { user: null, session: null }, error: r.error ?? { message: "Sign in failed" } };
    writeSession(r.data.session, "SIGNED_IN");
    return { data: { user: r.data.session.user, session: r.data.session }, error: null };
  },
  async signUp({ email, password, options }: { email: string; password: string; options?: { data?: Record<string, unknown>; emailRedirectTo?: string } }) {
    const r = await authCall("signup", { email, password, data: options?.data ?? {} });
    if (r.error || !r.data?.session) return { data: { user: null, session: null }, error: r.error ?? { message: "Sign up failed" } };
    writeSession(r.data.session, "SIGNED_IN");
    return { data: { user: r.data.session.user, session: r.data.session }, error: null };
  },
  async signOut() {
    const s = readSession();
    if (s) await authCall("signout", {}, s.access_token);
    writeSession(null, "SIGNED_OUT");
    return { error: null };
  },
  async setSession(_tokens: unknown) {
    return { data: { session: readSession() }, error: null };
  },
  async getClaims() {
    const s = readSession();
    return { data: s ? { claims: { sub: s.user.id, email: s.user.email } } : null, error: null };
  },
};

function encode(q: Query | RpcCall) {
  const json = JSON.stringify(q);
  const b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return b64;
}

async function browserExec(q: Query | RpcCall): Promise<PgResult> {
  const serverExec = (globalThis as { __d1AnonExec?: (q: Query | RpcCall) => Promise<PgResult> }).__d1AnonExec;
  if (typeof window === "undefined" && serverExec) return serverExec(q);
  try {
    const isRead = q.kind === "rpc" || q.kind === "select";
    const token = readSession()?.access_token;
    const res = isRead
      ? await fetch(`/api/db?q=${encode(q)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
      : await fetch("/api/db", {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(q),
        });
    return (await res.json()) as PgResult;
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Network error", "FETCH", 0) as PgResult;
  }
}

const db = createDbClient(browserExec);

export const supabase = {
  from: db.from,
  rpc: db.rpc,
  auth,
};
