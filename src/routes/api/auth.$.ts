import { createFileRoute } from "@tanstack/react-router";

// Email + password auth endpoints used by the browser auth shim.
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const auth = await import("@/integrations/d1/auth.server");
        const action = (params as { _splat?: string })._splat ?? "";
        const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string; data?: Record<string, unknown> };
        const noStore = { headers: { "cache-control": "no-store" } };
        try {
          if (action === "signup") return Response.json({ session: await auth.signUp(body.email ?? "", body.password ?? "", body.data ?? {}) }, noStore);
          if (action === "signin") return Response.json({ session: await auth.signIn(body.email ?? "", body.password ?? "") }, noStore);
          if (action === "signout") {
            const token = auth.bearer(request);
            if (token) await auth.signOut(token);
            return Response.json({ ok: true }, noStore);
          }
          if (action === "me") {
            const user = await auth.userFromToken(auth.bearer(request));
            return Response.json({ user }, noStore);
          }
          return Response.json({ error: "Not found" }, { status: 404 });
        } catch (e) {
          const message = e instanceof auth.AuthError ? e.message : "Authentication failed";
          if (!(e instanceof auth.AuthError)) console.error("auth error", e);
          return Response.json({ error: message }, { status: e instanceof auth.AuthError ? 400 : 500 });
        }
      },
    },
  },
});
