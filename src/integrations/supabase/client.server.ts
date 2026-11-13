// Server-side "Supabase" client, now backed by Cloudflare D1.
// Same API surface the app already uses: supabaseAdmin.from(...)/.rpc(...).
// Load inside server handlers: const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
import { createDbClient } from "@/integrations/d1/postgrest";
import { execute } from "@/integrations/d1/executor.server";
import { ensureRpcs } from "@/integrations/d1/rpc.server";

ensureRpcs();

export const supabaseAdmin = createDbClient((q) => execute({ kind: "admin" }, q));

/** Read-only client with the old anon (public) permissions. */
export const supabaseAnon = createDbClient((q) => execute({ kind: "anon" }, q));

/** Client scoped to one signed-in user (emulates the old RLS policies). */
export const supabaseForUser = (userId: string) => createDbClient((q) => execute({ kind: "user", userId }, q));

// Lets the isomorphic browser client run queries in-process during SSR.
(globalThis as { __d1AnonExec?: unknown }).__d1AnonExec = (q: unknown) => execute({ kind: "anon" }, q as never);
