/** Server-only helpers for the public REST API's bearer-token authentication. */
const PREFIX = "chs_live_";

export function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${PREFIX}${hex}`;
}

export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type ApiCaller = {
  keyId: string;
  userId: string;
  name: string;
  scopes: string[];
};

export type ApiResponseMeta = { requestId: string };

export async function authenticateApiRequest(
  request: Request,
  requestId?: string,
): Promise<{ caller: ApiCaller } | { error: Response }> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : (request.headers.get("x-api-key") ?? "").trim();

  const meta: ApiResponseMeta = { requestId: requestId ?? crypto.randomUUID() };

  if (!token) {
    return {
      error: apiError(
        401,
        "missing_token",
        "Provide an API token: Authorization: Bearer chs_live_…",
        meta,
      ),
    };
  }
  if (!token.startsWith(PREFIX)) {
    return { error: apiError(401, "invalid_token", "Malformed API token.", meta) };
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("api_keys")
    .select("id, user_id, revoked, name, scopes")
    .eq("key_hash", await hashApiKey(token))
    .maybeSingle();

  if (error) return { error: apiError(500, "auth_failed", "Could not verify the API token.", meta) };
  if (!data) return { error: apiError(401, "invalid_token", "Unknown API token.", meta) };
  if (data.revoked)
    return { error: apiError(401, "revoked_token", "This API token was revoked.", meta) };

  void supabaseAdmin
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(() => undefined);

  return {
    caller: {
      keyId: data.id,
      userId: data.user_id,
      name: data.name,
      scopes: data.scopes ?? ["read"],
    },
  };
}

export async function logApiRequest(input: {
  caller: ApiCaller;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId: string;
}): Promise<void> {
  try {
    // One row per key per hour (D1 free plan: 100k writes/day), not one per request.
    const { run } = await import("@/integrations/d1/rpc.server");
    await run(
      `INSERT INTO api_request_logs (id, key_id, user_id, hour, requests, errors, duration_ms, method, path, status, request_id)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key_id, hour) DO UPDATE SET requests = requests + 1, errors = errors + excluded.errors,
         duration_ms = duration_ms + excluded.duration_ms, method = excluded.method, path = excluded.path,
         status = excluded.status, request_id = excluded.request_id`,
      crypto.randomUUID(),
      input.caller.keyId,
      input.caller.userId,
      new Date().toISOString().slice(0, 13),
      input.status >= 400 ? 1 : 0,
      Math.round(input.durationMs),
      input.method,
      input.path.slice(0, 300),
      input.status,
      input.requestId,
    );
  } catch {
    /* logging must never break a response */
  }
}

export function apiError(
  status: number,
  code: string,
  message: string,
  meta?: ApiResponseMeta,
): Response {
  return Response.json(
    { error: { code, message, request_id: meta?.requestId } },
    { status, headers: responseHeaders(meta) },
  );
}

export function apiJson(body: unknown, status = 200, meta?: ApiResponseMeta): Response {
  return Response.json(body, { status, headers: responseHeaders(meta) });
}

function responseHeaders(meta?: ApiResponseMeta): Record<string, string> {
  const headers: Record<string, string> = { ...corsHeaders() };
  if (meta?.requestId) headers["X-Request-Id"] = meta.requestId;
  return headers;
}

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "x-request-id",
    "Cache-Control": "no-store",
  };
}
