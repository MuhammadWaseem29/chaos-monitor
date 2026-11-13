// Lovable's OAuth broker is not available outside Lovable Cloud.
// Google sign-in returns a clear error until a Google OAuth client is configured.

type SignInOptions = {
  redirect_uri?: string;
  extraParams?: Record<string, string>;
};

type OAuthResult = { redirected?: boolean; error?: Error };

export const lovable = {
  auth: {
    signInWithOAuth: async (
      _provider: "google" | "apple" | "microsoft" | "lovable",
      _opts?: SignInOptions,
    ): Promise<OAuthResult> => ({
      error: new Error("Google sign-in is not set up yet. Use email and password."),
    }),
  },
};
