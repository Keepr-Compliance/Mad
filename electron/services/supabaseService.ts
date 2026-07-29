/**
 * Supabase Service
 * Handles all cloud database operations and sync
 * Uses SUPABASE_ANON_KEY (public/publishable key) for all client operations.
 * RLS policies provide security at the database level.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/electron/main";
import { User, SubscriptionTier, Subscription } from "../types/models";
import type { AuditLogEntry } from "./auditService";
import logService from "./logService";
import sessionService from "./sessionService";

/**
 * User data for sync operations
 */
interface UserSyncData {
  email: string;
  first_name?: string;
  last_name?: string;
  display_name?: string;
  avatar_url?: string;
  oauth_provider: string;
  oauth_id: string;
  subscription_tier?: SubscriptionTier;
}

/**
 * Device information
 */
interface DeviceInfo {
  device_id: string;
  device_name: string;
  os: string;
  app_version: string;
}

/**
 * Device record from database
 */
interface DeviceRecord {
  id: string;
  user_id: string;
  device_id: string;
  device_name: string;
  os: string;
  app_version: string;
  last_seen_at?: string;
}

/**
 * Device limit check result
 */
interface DeviceLimitCheck {
  allowed: boolean;
  current: number;
  max: number;
  isCurrentDevice?: boolean;
}

/**
 * API usage check result
 */
interface ApiUsageCheck {
  allowed: boolean;
  current: number;
  limit: number;
  remaining: number;
}

/**
 * Tier limits for API usage
 */
interface TierLimits {
  free: number;
  pro: number;
  enterprise: number;
}

/**
 * Supabase Auth Session (BACKLOG-390)
 * Stores the current authenticated session for RLS
 */
interface SupabaseAuthSession {
  userId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

class SupabaseService {
  private client: SupabaseClient | null = null;
  private initialized = false;
  /** BACKLOG-390: Store Supabase Auth session for RLS-enabled queries */
  private authSession: SupabaseAuthSession | null = null;
  /** TASK-2040: Auth state change subscription for cleanup on logout/quit */
  private authSubscription: { unsubscribe: () => void } | null = null;
  /** BACKLOG-1632: In-memory storage to replace localStorage and prevent UTF-8 corruption */
  private _memoryStorage = new Map<string, string>();

  /**
   * Initialize Supabase client
   * Uses SUPABASE_ANON_KEY (public/publishable key) for client operations.
   * This is safe to include in packaged builds as it's meant for public use.
   * RLS policies provide security at the database level.
   */
  initialize(): void {
    if (this.initialized) {
      return;
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    // Use anon key (public/publishable) only - never fall back to service_role key.
    // The service_role key bypasses all RLS and must never be used in client code.
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      const missing = [];
      if (!supabaseUrl) missing.push("SUPABASE_URL");
      if (!supabaseKey) missing.push("SUPABASE_ANON_KEY");
      logService.error(
        `[Supabase] Missing required environment variable(s): ${missing.join(", ")}. Check .env.development or .env.production file.`,
        "Supabase"
      );
      throw new Error(
        `Supabase credentials not configured: missing ${missing.join(", ")}`
      );
    }

    logService.info("[Supabase] Initializing with URL:", "Supabase", { supabaseUrl });

    this.client = createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: false,
        // BACKLOG-1632: Provide an explicit in-memory storage adapter to prevent
        // the SDK from ever touching localStorage (even with persistSession:false,
        // some internal SDK paths may still attempt storage access).
        storage: {
          getItem: (key: string) => this._memoryStorage.get(key) ?? null,
          setItem: (key: string, value: string) => { this._memoryStorage.set(key, value); },
          removeItem: (key: string) => { this._memoryStorage.delete(key); },
        },
      },
    });

    // TASK-2040: Listen for auth state changes to keep local session cache
    // in sync when the SDK auto-refreshes the token
    this._setupAuthStateListener();

    this.initialized = true;
    logService.debug("[Supabase] Initialized successfully", "Supabase");
  }

  // ============================================
  // SUPABASE AUTH (BACKLOG-390: B2B Portal)
  // ============================================

  /**
   * Sign in with ID token from direct OAuth (Google/Microsoft)
   *
   * BACKLOG-390: After existing OAuth completes, call this to create a Supabase
   * Auth session so RLS policies work correctly with auth.uid().
   *
   * This method is "additive" - it doesn't change the existing OAuth flow,
   * just tells Supabase about the authenticated user.
   *
   * @param provider - OAuth provider ('google' or 'azure' for Microsoft)
   * @param idToken - The ID token from the OAuth flow
   * @returns Session info or null if auth failed (graceful fallback)
   */
  async signInWithIdToken(
    provider: "google" | "azure",
    idToken: string
  ): Promise<SupabaseAuthSession | null> {
    const client = this._ensureClient();

    try {
      logService.info(
        `[Supabase] Signing in with ID token (provider: ${provider})`,
        "Supabase"
      );

      const { data, error } = await client.auth.signInWithIdToken({
        provider,
        token: idToken,
      });

      if (error) {
        // Log but don't throw - graceful fallback to service key
        logService.warn(
          `[Supabase] signInWithIdToken failed: ${error.message}`,
          "Supabase",
          { provider, error: error.message }
        );
        return null;
      }

      if (!data.session || !data.user) {
        logService.warn(
          "[Supabase] signInWithIdToken returned no session/user",
          "Supabase"
        );
        return null;
      }

      // Store session for RLS queries
      this.authSession = {
        userId: data.user.id,
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at
          ? new Date(data.session.expires_at * 1000)
          : undefined,
      };

      logService.info(
        "[Supabase] Successfully signed in with ID token",
        "Supabase",
        { userId: data.user.id, provider }
      );

      return this.authSession;
    } catch (error) {
      // Graceful fallback - log warning and continue with service key
      logService.warn(
        "[Supabase] signInWithIdToken exception (falling back to service key)",
        "Supabase",
        { error: error instanceof Error ? error.message : "Unknown error" }
      );
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "signInWithIdToken" },
      });
      return null;
    }
  }

  /**
   * TASK-2045: Sign out from all devices (global session invalidation)
   * Calls Supabase with scope: 'global' to invalidate all active sessions.
   * Must be called BEFORE clearing the local session (needs active token).
   * @returns Success status and optional error message
   */
  async signOutGlobal(): Promise<{ success: boolean; error?: string }> {
    const client = this._ensureClient();

    try {
      // TASK-2056: 15-second timeout to prevent hanging when offline
      const timeoutMs = 15000;
      const result = await Promise.race([
        client.auth.signOut({ scope: 'global' }),
        new Promise<{ error: Error }>((resolve) =>
          setTimeout(() => resolve({ error: new Error(`Sign-out request timed out after ${timeoutMs / 1000}s`) }), timeoutMs)
        ),
      ]);
      if (result.error) throw result.error;
      logService.info("[Supabase] Global sign-out successful", "SupabaseService");
      return { success: true };
    } catch (error) {
      logService.error("[Supabase] Global sign-out failed", "SupabaseService", { error });
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "signOutGlobal" },
      });
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Sign out from Supabase Auth
   * Clears the auth session (service key still works for admin operations)
   */
  async signOut(): Promise<void> {
    const client = this._ensureClient();

    try {
      const { error } = await client.auth.signOut();
      if (error) {
        logService.warn(
          `[Supabase] signOut failed: ${error.message}`,
          "Supabase"
        );
      }
      this.authSession = null;
      logService.info("[Supabase] Signed out from Supabase Auth", "Supabase");
    } catch (error) {
      this.authSession = null;
      logService.warn("[Supabase] signOut exception", "Supabase", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "signOut" },
      });
    }
    // TASK-2040: Note -- we do NOT unsubscribe the auth listener here.
    // The listener must remain active to detect future sign-in events.
    // It is cleaned up via destroy() on app quit.
  }

  /**
   * Get current auth session.
   * Returns local cache if available, otherwise queries Supabase SDK.
   * This ensures deep link auth sessions are discovered even if local cache wasn't set.
   *
   * @returns The auth session or null if not authenticated
   */
  async getAuthSession(): Promise<SupabaseAuthSession | null> {
    // Fast path: return local cache if available
    if (this.authSession) {
      return this.authSession;
    }

    // Fallback: query Supabase SDK (handles deep link auth case)
    try {
      const { data } = await this._ensureClient().auth.getSession();
      if (data?.session?.user) {
        // Cache for future calls
        this.authSession = {
          userId: data.session.user.id,
          accessToken: data.session.access_token,
          refreshToken: data.session.refresh_token,
          expiresAt: data.session.expires_at
            ? new Date(data.session.expires_at * 1000)
            : undefined,
        };
        return this.authSession;
      }
    } catch (error) {
      logService.warn("[Supabase] Failed to get session from SDK", "Supabase", {
        error: error instanceof Error ? error.message : String(error)
      });
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "getAuthSession" },
      });
    }

    return null;
  }

  /**
   * Get current authenticated user ID from Supabase Auth
   * @returns User UUID or null if not authenticated
   */
  getAuthUserId(): string | null {
    return this.authSession?.userId ?? null;
  }

  /**
   * Check if authenticated with Supabase Auth (not just service key)
   * @returns true if signed in with user credentials
   */
  isAuthenticated(): boolean {
    return this.authSession !== null;
  }

  /**
   * Get active organization membership for a user
   * Used to determine team license status
   * @param userId - User UUID to check
   * @returns Organization membership data or null if not a team member
   */
  async getActiveOrganizationMembership(
    userId: string
  ): Promise<{ organization_id: string; organization_name?: string } | null> {
    try {
      const client = this._ensureClient();
      // Use limit(1) instead of maybeSingle() to handle users with multiple org memberships
      // Filter by active license_status to only consider valid memberships
      const { data, error } = await client
        .from("organization_members")
        .select("organization_id, organizations(name)")
        .eq("user_id", userId)
        .eq("license_status", "active")
        .limit(1);

      if (error) {
        logService.warn(
          `[Supabase] Failed to get org membership: ${error.message}`,
          "SupabaseService"
        );
        return null;
      }

      // data is now an array, get first element
      const membership = data?.[0];
      if (!membership) {
        return null;
      }

      return {
        organization_id: membership.organization_id,
        organization_name: (membership.organizations as { name?: string } | null)?.name,
      };
    } catch (err) {
      logService.error("[Supabase] Error checking org membership", "SupabaseService", { err });
      Sentry.captureException(err, {
        tags: { service: "supabase-service", operation: "getActiveOrganizationMembership" },
      });
      return null;
    }
  }

  /**
   * TASK-2040: Set up auth state change listener.
   * Keeps the local authSession cache in sync when the Supabase SDK
   * auto-refreshes the access token (which happens proactively before
   * the 1-hour JWT expiry).
   * @private
   */
  private _setupAuthStateListener(): void {
    if (!this.client) return;

    const { data } = this.client.auth.onAuthStateChange((event, session) => {
      if (event === "TOKEN_REFRESHED" && session) {
        this.authSession = {
          userId: session.user.id,
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
          expiresAt: session.expires_at
            ? new Date(session.expires_at * 1000)
            : undefined,
        };
        logService.info(
          "[Supabase] Token auto-refreshed successfully",
          "SupabaseService",
          { userId: session.user.id }
        );
        // BACKLOG-2332: the SDK runs persistSession:false with an in-memory storage adapter, so
        // session.json is the ONLY durable copy of the tokens — and it was written once at login
        // and never updated on refresh. After a rotation (~hourly) a restart would restore a USED
        // refresh token and GoTrue reuse-detection would revoke the family (forced re-login). Now
        // that BACKLOG-2332 gives the desktop a stable own session that actually survives to
        // rotate, persist the rotated tokens. Fire-and-forget: never block the refresh; updateSession
        // returns false (no throw) if session.json is absent (e.g. a refresh before initial save).
        void sessionService
          .updateSession({
            supabaseTokens: {
              access_token: session.access_token,
              refresh_token: session.refresh_token,
            },
          })
          .catch((error) => {
            logService.warn(
              "[Supabase] Failed to persist refreshed tokens to session.json (non-fatal)",
              "SupabaseService",
              { error: error instanceof Error ? error.message : "Unknown error" }
            );
          });
      } else if (event === "SIGNED_OUT") {
        this.authSession = null;
        logService.info(
          "[Supabase] Auth state: signed out",
          "SupabaseService"
        );
      }
    });

    this.authSubscription = data.subscription;
  }

  /**
   * TASK-2040: Clean up auth state listener and resources.
   * Must be called on app quit to prevent memory leaks.
   */
  destroy(): void {
    if (this.authSubscription) {
      this.authSubscription.unsubscribe();
      this.authSubscription = null;
      logService.debug(
        "[Supabase] Auth state listener unsubscribed",
        "SupabaseService"
      );
    }
    this.authSession = null;
  }

  /**
   * Get the Supabase client (public access for storage service)
   * BACKLOG-393: Needed by supabaseStorageService for file uploads
   * @returns Initialized Supabase client
   * @throws {Error} If client cannot be initialized
   */
  getClient(): SupabaseClient {
    return this._ensureClient();
  }

  /**
   * Ensure client is initialized and return it
   * @private
   * @throws {Error} If client cannot be initialized
   */
  private _ensureClient(): SupabaseClient {
    if (!this.initialized || !this.client) {
      this.initialize();
    }
    if (!this.client) {
      throw new Error("Supabase client is not initialized");
    }
    return this.client;
  }

  // ============================================
  // USER OPERATIONS
  // ============================================

  /**
   * Sync user to cloud (create or update)
   * @param userData - User data to sync
   * @returns Synced user data
   */
  async syncUser(userData: UserSyncData): Promise<User> {
    const client = this._ensureClient();

    try {
      // BACKLOG-551: Get auth.uid() to use as canonical user ID
      const { data: sessionData } = await client.auth.getSession();
      const authUserId = sessionData?.session?.user?.id;
      if (!authUserId) {
        throw new Error("No authenticated session - cannot sync user");
      }

      // First check if user exists by auth.uid() (canonical ID)
      let existingUser: User | null = null;
      const { data: userById, error: byIdError } = await client
        .from("users")
        .select("*")
        .eq("id", authUserId)
        .single();

      if (!byIdError) {
        existingUser = userById as User;
      } else if (byIdError.code !== "PGRST116") {
        throw byIdError;
      }

      // If not found by ID, check by oauth_provider/oauth_id (legacy lookup)
      if (!existingUser) {
        const { data: userByOAuth, error: fetchError } = await client
          .from("users")
          .select("*")
          .eq("oauth_provider", userData.oauth_provider)
          .eq("oauth_id", userData.oauth_id)
          .single();

        if (fetchError && fetchError.code !== "PGRST116") {
          throw fetchError;
        }

        if (userByOAuth) {
          // Found user with wrong ID - needs migration
          existingUser = userByOAuth as User;
          if (existingUser.id !== authUserId) {
            logService.info("[Supabase] User ID mismatch detected, will migrate", "Supabase", {
              oldId: existingUser.id.substring(0, 8) + "...",
              newId: authUserId.substring(0, 8) + "...",
            });
            // Migration: Create new user with correct ID, then delete old
            existingUser = await this._migrateUserToAuthId(existingUser, authUserId);
          }
        }
      }

      let result: User;

      if (existingUser) {
        // Update existing user
        const { data, error } = await client
          .from("users")
          .update({
            email: userData.email,
            first_name: userData.first_name,
            last_name: userData.last_name,
            display_name: userData.display_name,
            avatar_url: userData.avatar_url,
            last_login_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingUser.id)
          .select()
          .single();

        if (error) throw error;

        // Increment login count
        await client.rpc("increment", {
          row_id: existingUser.id,
          x: 1,
          table_name: "users",
          column_name: "login_count",
        });

        result = data as User;
        logService.info("[Supabase] User updated:", "Supabase", { userId: result.id });
      } else {
        // BACKLOG-551: Create new user with auth.uid() as canonical ID
        const { data, error } = await client
          .from("users")
          .insert({
            id: authUserId, // Use auth.uid() as canonical ID
            email: userData.email,
            first_name: userData.first_name,
            last_name: userData.last_name,
            display_name: userData.display_name,
            avatar_url: userData.avatar_url,
            oauth_provider: userData.oauth_provider,
            oauth_id: userData.oauth_id,
            subscription_tier: userData.subscription_tier || "free",
            subscription_status: "trial",
            trial_ends_at: new Date(
              Date.now() + 14 * 24 * 60 * 60 * 1000,
            ).toISOString(), // 14 days from now
            login_count: 1,
            last_login_at: new Date().toISOString(),
            signup_source: "desktop_app",
          })
          .select()
          .single();

        if (error) throw error;
        result = data as User;
        logService.info("[Supabase] New user created:", "Supabase", { userId: result.id });
      }

      return result;
    } catch (error) {
      logService.error("[Supabase] Failed to sync user:", "Supabase", { error });
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "syncUser" },
      });
      throw error;
    }
  }

  /**
   * BACKLOG-551: Migrate user from old auto-generated ID to auth.uid()
   * This handles the case where a user was created with a random UUID
   * instead of the canonical auth.uid().
   *
   * @param oldUser - User with wrong ID
   * @param authUserId - The correct auth.uid() to migrate to
   * @returns Migrated user with correct ID
   */
  private async _migrateUserToAuthId(oldUser: User, authUserId: string): Promise<User> {
    const client = this._ensureClient();

    try {
      logService.info("[Supabase] Migrating user to auth.uid()", "Supabase", {
        oldId: oldUser.id.substring(0, 8) + "...",
        newId: authUserId.substring(0, 8) + "...",
      });

      // 1. Create new user record with correct ID
      const { data: newUser, error: insertError } = await client
        .from("users")
        .insert({
          id: authUserId,
          email: oldUser.email,
          first_name: oldUser.first_name,
          last_name: oldUser.last_name,
          display_name: oldUser.display_name,
          avatar_url: oldUser.avatar_url,
          oauth_provider: oldUser.oauth_provider,
          oauth_id: oldUser.oauth_id,
          subscription_tier: oldUser.subscription_tier,
          subscription_status: oldUser.subscription_status,
          trial_ends_at: oldUser.trial_ends_at,
          terms_accepted_at: oldUser.terms_accepted_at,
          terms_version_accepted: oldUser.terms_version_accepted,
          privacy_policy_accepted_at: oldUser.privacy_policy_accepted_at,
          privacy_policy_version_accepted: oldUser.privacy_policy_version_accepted,
          email_onboarding_completed_at: oldUser.email_onboarding_completed_at,
          login_count: (oldUser as unknown as Record<string, unknown>).login_count as number || 0,
          last_login_at: new Date().toISOString(),
          signup_source: (oldUser as unknown as Record<string, unknown>).signup_source as string || "desktop_app",
          created_at: oldUser.created_at,
        })
        .select()
        .single();

      if (insertError) {
        throw insertError;
      }

      // 2. Update FK references in child tables
      // Note: These updates may fail if user has no records in these tables,
      // which is OK - we just need to update what exists
      const tablesToUpdate = ["devices", "user_licenses", "api_usage", "analytics_events"];
      for (const table of tablesToUpdate) {
        try {
          await client
            .from(table)
            .update({ user_id: authUserId })
            .eq("user_id", oldUser.id);
        } catch {
          // Table may not have records for this user - that's OK
        }
      }

      // 3. Delete old user record
      const { error: deleteError } = await client
        .from("users")
        .delete()
        .eq("id", oldUser.id);

      if (deleteError) {
        logService.warn("[Supabase] Failed to delete old user record", "Supabase", {
          error: deleteError.message,
        });
        // Don't throw - migration succeeded even if cleanup failed
      }

      logService.info("[Supabase] User migration complete", "Supabase", {
        newId: authUserId.substring(0, 8) + "...",
      });

      return newUser as User;
    } catch (error) {
      logService.error("[Supabase] User migration failed", "Supabase", { error });
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "_migrateUserToAuthId" },
      });
      throw error;
    }
  }

  /**
   * Get user by ID
   * @param userId - User UUID
   * @returns User data
   */
  async getUserById(userId: string): Promise<User> {
    const client = this._ensureClient();

    try {
      const { data, error } = await client
        .from("users")
        .select("*")
        .eq("id", userId)
        .single();

      if (error) throw error;
      return data as User;
    } catch (error) {
      logService.error("[Supabase] Failed to get user:", "Supabase", { error });
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "getUserById" },
      });
      throw error;
    }
  }

  /**
   * Sync terms acceptance to cloud
   * @param userId - User UUID
   * @param termsVersion - Version of Terms of Service accepted
   * @param privacyVersion - Version of Privacy Policy accepted
   */
  async syncTermsAcceptance(
    userId: string,
    termsVersion: string,
    privacyVersion: string,
  ): Promise<User> {
    const client = this._ensureClient();

    try {
      const { data, error } = await client
        .from("users")
        .update({
          terms_accepted_at: new Date().toISOString(),
          terms_version_accepted: termsVersion,
          privacy_policy_accepted_at: new Date().toISOString(),
          privacy_policy_version_accepted: privacyVersion,
          updated_at: new Date().toISOString(),
        })
        .eq("id", userId)
        .select()
        .single();

      if (error) throw error;
      logService.info("[Supabase] Terms acceptance synced for user:", "Supabase", { userId });
      return data as User;
    } catch (error) {
      logService.error("[Supabase] Failed to sync terms acceptance:", "Supabase", { error });
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "syncTermsAcceptance" },
      });
      throw error;
    }
  }

  /**
   * Sync email onboarding completion to cloud
   * @param userId - User UUID
   */
  async completeEmailOnboarding(userId: string): Promise<void> {
    const client = this._ensureClient();

    try {
      const { error } = await client
        .from("users")
        .update({
          email_onboarding_completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", userId);

      if (error) throw error;
      logService.info(
        "[Supabase] Email onboarding completion synced for user:",
        "Supabase",
        { userId }
      );
    } catch (error) {
      logService.error(
        "[Supabase] Failed to sync email onboarding completion:",
        "Supabase",
        { error }
      );
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "completeEmailOnboarding" },
      });
      throw error;
    }
  }

  /**
   * Validate user's subscription status
   * @param userId - User UUID
   * @returns Subscription status
   */
  async validateSubscription(userId: string): Promise<Subscription> {
    const client = this._ensureClient();

    try {
      const user = await this.getUserById(userId);

      const now = new Date();
      const trialEndsAt = user.trial_ends_at
        ? new Date(user.trial_ends_at)
        : null;

      const subscription: Subscription = {
        tier: user.subscription_tier,
        status: user.subscription_status,
        isActive: user.subscription_status === "active",
        isTrial: user.subscription_status === "trial",
        trialEnded: trialEndsAt ? trialEndsAt < now : false,
        trialDaysRemaining: trialEndsAt
          ? Math.max(
              0,
              Math.ceil(
                (trialEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
              ),
            )
          : 0,
      };

      // If trial has ended, update status
      if (subscription.isTrial && subscription.trialEnded) {
        await client
          .from("users")
          .update({ subscription_status: "expired" })
          .eq("id", userId);

        subscription.status = "expired";
        subscription.isActive = false;
      }

      return subscription;
    } catch (error) {
      logService.error("[Supabase] Failed to validate subscription:", "Supabase", { error });
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "validateSubscription" },
      });
      throw error;
    }
  }

  // ============================================
  // DEVICE OPERATIONS
  // ============================================

  /**
   * Register a device for a user
   * @param userId - User UUID
   * @param deviceInfo - Device information
   * @returns Device record
   */
  async registerDevice(
    userId: string,
    deviceInfo: DeviceInfo,
  ): Promise<DeviceRecord> {
    const client = this._ensureClient();

    try {
      // TASK-1507G: Use auth.uid() for RLS compliance
      // The devices table RLS requires user_id = auth.uid()
      // The passed userId may be from public.users which has a different ID
      const { data: sessionData } = await client.auth.getSession();
      const authUserId = sessionData?.session?.user?.id || userId;

      // Check if device already registered
      const { data: existing, error: fetchError } = await client
        .from("devices")
        .select("*")
        .eq("user_id", authUserId)
        .eq("device_id", deviceInfo.device_id)
        .single();

      if (fetchError && fetchError.code !== "PGRST116") {
        throw fetchError;
      }

      if (existing) {
        // Update last_seen_at
        const { data, error } = await client
          .from("devices")
          .update({
            device_name: deviceInfo.device_name,
            os: deviceInfo.os,
            app_version: deviceInfo.app_version,
            last_seen_at: new Date().toISOString(),
          })
          .eq("id", existing.id)
          .select()
          .single();

        if (error) throw error;
        logService.info("[Supabase] Device updated:", "Supabase", { deviceId: data.id });
        return data as DeviceRecord;
      } else {
        // Create new device
        const { data, error } = await client
          .from("devices")
          .insert({
            user_id: authUserId,  // Use auth.uid() for RLS compliance
            device_id: deviceInfo.device_id,
            device_name: deviceInfo.device_name,
            os: deviceInfo.os,
            app_version: deviceInfo.app_version,
          })
          .select()
          .single();

        if (error) throw error;
        logService.info("[Supabase] Device registered:", "Supabase", { deviceId: data.id });
        return data as DeviceRecord;
      }
    } catch (error) {
      logService.error("[Supabase] Failed to register device:", "Supabase", { error });
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "registerDevice" },
      });
      throw error;
    }
  }

  /**
   * Check if user has reached device limit
   * @param userId - User UUID
   * @param deviceId - Current device ID
   * @returns Device limit check result
   */
  async checkDeviceLimit(
    userId: string,
    deviceId: string,
  ): Promise<DeviceLimitCheck> {
    const client = this._ensureClient();

    try {
      // Get user's active license
      const { data: license } = await client
        .from("licenses")
        .select("max_devices")
        .eq("user_id", userId)
        .eq("status", "active")
        .single();

      const maxDevices = license?.max_devices || 2; // Default to 2 devices

      // Count active devices
      const { data: devices, error: devicesError } = await client
        .from("devices")
        .select("device_id")
        .eq("user_id", userId);

      if (devicesError) throw devicesError;

      const deviceCount = devices?.length || 0;
      const isCurrentDevice =
        devices?.some((d: { device_id: string }) => d.device_id === deviceId) ||
        false;

      return {
        allowed: isCurrentDevice || deviceCount < maxDevices,
        current: deviceCount,
        max: maxDevices,
        isCurrentDevice,
      };
    } catch (error) {
      logService.error("[Supabase] Failed to check device limit:", "Supabase", { error });
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "checkDeviceLimit" },
      });
      // If error, allow access (fail open)
      return { allowed: true, current: 0, max: 2 };
    }
  }

  // ============================================
  // ANALYTICS OPERATIONS
  // ============================================

  /**
   * Track an analytics event
   * @param userId - User UUID
   * @param eventName - Event name
   * @param eventData - Event data
   * @param deviceId - Device ID
   * @param appVersion - App version
   */
  async trackEvent(
    userId: string,
    eventName: string,
    eventData: Record<string, any> = {},
    deviceId: string | null = null,
    appVersion: string | null = null,
  ): Promise<void> {
    const client = this._ensureClient();

    try {
      await client.from("analytics_events").insert({
        user_id: userId,
        event_name: eventName,
        event_data: eventData,
        device_id: deviceId,
        app_version: appVersion,
      });

      logService.info("[Supabase] Event tracked:", "Supabase", { eventName });
    } catch (error) {
      // Don't throw - analytics failures shouldn't break the app
      logService.error("[Supabase] Failed to track event:", "Supabase", { error });
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "trackEvent" },
      });
    }
  }

  // ============================================
  // API USAGE TRACKING
  // ============================================

  /**
   * Track API usage for rate limiting
   * @param userId - User UUID
   * @param apiName - API name (e.g., 'google_maps')
   * @param endpoint - Endpoint called
   * @param estimatedCost - Estimated cost in USD
   */
  async trackApiUsage(
    userId: string,
    apiName: string,
    endpoint: string,
    estimatedCost: number = 0,
  ): Promise<void> {
    const client = this._ensureClient();

    try {
      await client.from("api_usage").insert({
        user_id: userId,
        api_name: apiName,
        endpoint: endpoint,
        estimated_cost: estimatedCost,
      });

      logService.info("[Supabase] API usage tracked:", "Supabase", { apiName, endpoint });
    } catch (error) {
      // Don't throw - tracking failures shouldn't break the app
      logService.error("[Supabase] Failed to track API usage:", "Supabase", { error });
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "trackApiUsage" },
      });
    }
  }

  /**
   * Check API usage limit for current month
   * @param userId - User UUID
   * @param apiName - API name
   * @param tierLimits - Limits by subscription tier
   * @returns Usage check result
   */
  async checkApiLimit(
    userId: string,
    apiName: string,
    tierLimits: TierLimits = { free: 10, pro: 100, enterprise: 1000 },
  ): Promise<ApiUsageCheck> {
    const client = this._ensureClient();

    try {
      // Get start of current month
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      // Count API calls this month
      const { count, error } = await client
        .from("api_usage")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("api_name", apiName)
        .gte("created_at", startOfMonth.toISOString());

      if (error) throw error;

      // Get user's subscription tier
      const user = await this.getUserById(userId);
      const limit = tierLimits[user.subscription_tier] || tierLimits.free;

      return {
        allowed: (count || 0) < limit,
        current: count || 0,
        limit: limit,
        remaining: Math.max(0, limit - (count || 0)),
      };
    } catch (error) {
      logService.error("[Supabase] Failed to check API limit:", "Supabase", { error });
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "checkApiLimit" },
      });
      // If error, allow access (fail open)
      return { allowed: true, current: 0, limit: 100, remaining: 100 };
    }
  }

  // ============================================
  // PREFERENCES SYNC
  // ============================================

  /**
   * Sync user preferences to cloud
   * @param userId - User UUID
   * @param preferences - User preferences
   */
  async syncPreferences(
    userId: string,
    preferences: Record<string, any>,
  ): Promise<void> {
    const client = this._ensureClient();

    try {
      const { error } = await client.from("user_preferences").upsert({
        user_id: userId,
        preferences: preferences,
        updated_at: new Date().toISOString(),
      });

      if (error) throw error;
      logService.info("[Supabase] Preferences synced", "Supabase");
    } catch (error) {
      logService.error("[Supabase] Failed to sync preferences:", "Supabase", { error });
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "syncPreferences" },
      });
      throw error;
    }
  }

  /**
   * Get user preferences from cloud
   * @param userId - User UUID
   * @returns User preferences (empty object if not found)
   * @throws Error if there's a database error (not including "not found")
   */
  async getPreferences(userId: string): Promise<Record<string, any>> {
    const client = this._ensureClient();

    const { data, error } = await client
      .from("user_preferences")
      .select("preferences")
      .eq("user_id", userId)
      .single();

    // PGRST116 = "not found" - this is expected for new users
    if (error && error.code !== "PGRST116") {
      logService.error("[Supabase] Failed to get preferences:", "Supabase", { error });
      throw error;
    }

    return data?.preferences || {};
  }

  // ============================================
  // EDGE FUNCTIONS
  // ============================================

  /**
   * Call a Supabase Edge Function
   * @param functionName - Function name
   * @param payload - Request payload
   * @returns Function response
   */
  async callEdgeFunction(
    functionName: string,
    payload: Record<string, any>,
  ): Promise<any> {
    const client = this._ensureClient();

    try {
      const { data, error } = await client.functions.invoke(functionName, {
        body: payload,
      });

      if (error) throw error;
      return data;
    } catch (error) {
      logService.error(
        `[Supabase] Edge function '${functionName}' failed:`,
        "Supabase",
        { error }
      );
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "callEdgeFunction" },
        extra: { functionName },
      });
      throw error;
    }
  }

  // ============================================
  // AUDIT LOG OPERATIONS
  // ============================================

  /**
   * Batch insert audit logs to cloud
   * @param entries - Array of audit log entries to sync
   */
  async batchInsertAuditLogs(entries: AuditLogEntry[]): Promise<void> {
    const client = this._ensureClient();

    if (entries.length === 0) {
      return;
    }

    try {
      // Map entries to database format
      const rows = entries.map((entry) => ({
        id: entry.id,
        timestamp: entry.timestamp.toISOString(),
        user_id: entry.userId,
        session_id: entry.sessionId || null,
        action: entry.action,
        resource_type: entry.resourceType,
        resource_id: entry.resourceId || null,
        metadata: entry.metadata || null,
        ip_address: entry.ipAddress || null,
        user_agent: entry.userAgent || null,
        success: entry.success,
        error_message: entry.errorMessage || null,
      }));

      const { error } = await client.from("audit_logs").upsert(rows, {
        onConflict: "id",
        ignoreDuplicates: true,
      });

      if (error) throw error;

      logService.info(`[Supabase] Synced ${entries.length} audit logs to cloud`, "Supabase");
    } catch (error) {
      logService.error("[Supabase] Failed to sync audit logs:", "Supabase", { error });
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "batchInsertAuditLogs" },
      });
      throw error;
    }
  }

  /**
   * Get audit logs from cloud for a user
   * @param userId - User UUID
   * @param options - Query options
   * @returns Array of audit log entries
   */
  async getAuditLogs(
    userId: string,
    options?: {
      action?: string;
      resourceType?: string;
      startDate?: Date;
      endDate?: Date;
      limit?: number;
      offset?: number;
    },
  ): Promise<AuditLogEntry[]> {
    const client = this._ensureClient();

    try {
      let query = client
        .from("audit_logs")
        .select("*")
        .eq("user_id", userId)
        .order("timestamp", { ascending: false });

      if (options?.action) {
        query = query.eq("action", options.action);
      }

      if (options?.resourceType) {
        query = query.eq("resource_type", options.resourceType);
      }

      if (options?.startDate) {
        query = query.gte("timestamp", options.startDate.toISOString());
      }

      if (options?.endDate) {
        query = query.lte("timestamp", options.endDate.toISOString());
      }

      if (options?.limit) {
        query = query.limit(options.limit);
      }

      if (options?.offset) {
        query = query.range(
          options.offset,
          options.offset + (options.limit || 50) - 1,
        );
      }

      const { data, error } = await query;

      if (error) throw error;

      // Map database rows to AuditLogEntry
      return (data || []).map((row: Record<string, unknown>) => ({
        id: row.id as string,
        timestamp: new Date(row.timestamp as string),
        userId: row.user_id as string,
        sessionId: row.session_id as string | undefined,
        action: row.action as AuditLogEntry["action"],
        resourceType: row.resource_type as AuditLogEntry["resourceType"],
        resourceId: row.resource_id as string | undefined,
        metadata: row.metadata as Record<string, unknown> | undefined,
        ipAddress: row.ip_address as string | undefined,
        userAgent: row.user_agent as string | undefined,
        success: row.success as boolean,
        errorMessage: row.error_message as string | undefined,
      }));
    } catch (error) {
      logService.error("[Supabase] Failed to get audit logs:", "Supabase", { error });
      Sentry.captureException(error, {
        tags: { service: "supabase-service", operation: "getAuditLogs" },
      });
      throw error;
    }
  }
}

// Export singleton instance
export default new SupabaseService();
