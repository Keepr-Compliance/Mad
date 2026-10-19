/**
 * The `auth:deep-link-callback` payload electron/main.ts sends the renderer
 * when a browser sign-in completes.
 *
 * Extracted (BACKLOG-3956) so the `provider` field is under test: it used to be
 * the raw Supabase value, which is "azure" for a Microsoft sign-in. The
 * renderer's contact-source defaults compare to "microsoft", so a Microsoft
 * user's Outlook contacts started OFF.
 */
import { normalizeOAuthProvider } from "./normalizeOAuthProvider";

export interface DeepLinkAuthPayloadInput<L, D> {
  accessToken: string;
  refreshToken: string;
  localUserId: string;
  userEmail: string;
  /** The Supabase auth user (as returned by setSession / getUser). */
  supabaseUser: {
    user_metadata?: Record<string, unknown>;
    app_metadata?: Record<string, unknown>;
  };
  licenseStatus: L;
  device: D;
  isNewUser: boolean;
}

export function buildDeepLinkAuthPayload<L, D>(input: DeepLinkAuthPayloadInput<L, D>) {
  return {
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    userId: input.localUserId,
    user: {
      id: input.localUserId,
      email: input.userEmail,
      name: input.supabaseUser.user_metadata?.full_name as string | undefined,
    },
    // azure -> microsoft; same helper and same "google" default as the local
    // user record main.ts writes for this sign-in.
    provider: normalizeOAuthProvider(input.supabaseUser.app_metadata?.provider) || "google",
    licenseStatus: input.licenseStatus,
    device: input.device,
    isNewUser: input.isNewUser,
  };
}
