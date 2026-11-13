// Server function auth: resolves the bearer session token (our D1 sessions)
// and injects the same context the app used with Supabase:
// { supabase: user-scoped client, userId, claims }.
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const { bearer, userFromToken } = await import("@/integrations/d1/auth.server");
  const { supabaseForUser } = await import("./client.server");

  const request = getRequest();
  if (!request?.headers) throw new Error("Unauthorized: No request headers available");
  const token = bearer(request);
  if (!token) throw new Error("Unauthorized: No authorization header provided");

  const user = await userFromToken(token);
  if (!user) throw new Error("Unauthorized: Invalid token");

  return next({
    context: {
      supabase: supabaseForUser(user.id),
      userId: user.id,
      claims: { sub: user.id, email: user.email, role: user.role },
    },
  });
});
