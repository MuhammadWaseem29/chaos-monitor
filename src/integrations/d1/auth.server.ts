// Email + password accounts and bearer sessions stored in D1 (replaces Supabase Auth).
import { nowIso, uuid } from "./env.server";
import { run, sql, sql1 } from "./rpc.server";

const ITERATIONS = 20_000; // kept modest: the Workers free plan allows ~10 ms CPU per request
const SESSION_DAYS = 30;
const enc = new TextEncoder();

const hex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return hex(bits);
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${hex(salt)}$${await pbkdf2(password, salt, ITERATIONS)}`;
}

async function verifyPassword(password: string, stored: string) {
  const [, it, saltHex, hash] = stored.split("$");
  const salt = new Uint8Array((saltHex ?? "").match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
  const got = await pbkdf2(password, salt, Number(it));
  if (got.length !== (hash ?? "").length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ hash!.charCodeAt(i);
  return diff === 0;
}

export const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

type UserRow = { id: string; email: string; user_metadata: string; created_at: string };

function sessionPayload(user: UserRow, token: string, expires: Date) {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(user.user_metadata || "{}");
  } catch {
    meta = {};
  }
  return {
    access_token: token,
    token_type: "bearer" as const,
    expires_at: Math.floor(expires.getTime() / 1000),
    user: { id: user.id, email: user.email, user_metadata: meta, app_metadata: {}, created_at: user.created_at },
  };
}

async function newSession(user: UserRow) {
  const token = `chs_sess_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", await sha256(token), user.id, expires.toISOString());
  return sessionPayload(user, token, expires);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function signUp(emailRaw: string, password: string, data: Record<string, unknown> = {}) {
  const email = String(emailRaw ?? "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 255) throw new AuthError("Please enter a valid email address.");
  if (typeof password !== "string" || password.length < 8 || password.length > 72) throw new AuthError("Password must be 8–72 characters.");
  if (await sql1("SELECT id FROM users WHERE email = ?", email)) throw new AuthError("User already registered");
  const id = uuid();
  const meta = JSON.stringify(data ?? {});
  await run("INSERT INTO users (id, email, password_hash, user_metadata) VALUES (?, ?, ?, ?)", id, email, await hashPassword(password), meta);
  const displayName = (data?.full_name as string) || (data?.name as string) || email.split("@")[0];
  await run("INSERT OR IGNORE INTO profiles (id, email, display_name, avatar_url) VALUES (?, ?, ?, ?)", id, email, displayName, (data?.avatar_url as string) ?? null);
  // The first account becomes the admin (can add/delete domains and programs).
  const admin = await sql1("SELECT id FROM user_roles WHERE role = 'admin' LIMIT 1");
  await run("INSERT OR IGNORE INTO user_roles (id, user_id, role) VALUES (?, ?, ?)", uuid(), id, admin ? "user" : "admin");
  const user = (await sql1<UserRow>("SELECT id, email, user_metadata, created_at FROM users WHERE id = ?", id))!;
  return newSession(user);
}

export async function signIn(emailRaw: string, password: string) {
  const email = String(emailRaw ?? "").trim().toLowerCase();
  const user = await sql1<UserRow & { password_hash: string }>("SELECT * FROM users WHERE email = ?", email);
  if (!user || !(await verifyPassword(String(password ?? ""), user.password_hash))) throw new AuthError("Invalid login credentials");
  return newSession(user);
}

export async function signOut(token: string) {
  await run("DELETE FROM sessions WHERE token_hash = ?", await sha256(token));
}

export type AuthUser = { id: string; email: string; role: "admin" | "user" };

/** Resolves a bearer token to a user (or null). */
export async function userFromToken(token: string | null | undefined): Promise<AuthUser | null> {
  if (!token || !token.startsWith("chs_sess_")) return null;
  const row = await sql1<{ id: string; email: string; expires_at: string; role: string | null }>(
    `SELECT u.id, u.email, s.expires_at,
            (SELECT role FROM user_roles r WHERE r.user_id = u.id ORDER BY role = 'admin' DESC LIMIT 1) AS role
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    await sha256(token),
  );
  if (!row || row.expires_at < nowIso()) return null;
  return { id: row.id, email: row.email, role: row.role === "admin" ? "admin" : "user" };
}

export async function isAdmin(userId: string) {
  return Boolean(await sql1("SELECT 1 AS ok FROM user_roles WHERE user_id = ? AND role = 'admin'", userId));
}

export async function requireAdmin(userId: string) {
  if (!(await isAdmin(userId))) throw new Error("Forbidden: only the site admin can do this");
}

export const bearer = (req: Request) => {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
};

export class AuthError extends Error {}

export async function cleanupSessions() {
  await sql("DELETE FROM sessions WHERE expires_at < ?", nowIso());
}
