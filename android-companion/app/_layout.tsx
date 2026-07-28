import '../services/cryptoPolyfill';
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  View,
  StyleSheet,
  Platform,
  AppState,
  type AppStateStatus,
} from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as NavigationBar from 'expo-navigation-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { onAuthStateChange, getSession } from '../services/authService';
import { registerAppStateCatchup } from '../services/appStateCatchup';
import { reconcilePairingForAuthChange } from '../services/pairingManager';
import { colors } from '../theme/colors';
import type { Session } from '@supabase/supabase-js';

/**
 * Sentry DSN for the Android companion.
 *
 * BACKLOG-2197: This is the PUBLIC client DSN of the existing `electron`
 * Sentry project (org keeprcompliancecom). Public/client DSNs are designed to
 * ship in client binaries — they only permit sending events, not reading them —
 * so committing it is safe and standard for mobile/RN apps.
 *
 * Why reuse the electron project instead of a new RN project: the org disables
 * project creation for members (founder-approved decision). Android events are
 * distinguished inside the shared project by the `app: android-companion` tag
 * set in `initialScope` below, so they can be filtered apart from desktop
 * errors. Override per-build with the EXPO_PUBLIC_SENTRY_DSN env var if a
 * dedicated RN project is ever provisioned.
 */
const SENTRY_DSN =
  process.env.EXPO_PUBLIC_SENTRY_DSN ??
  'https://3ad649526bc88f8e51702b9138f30672@o4510880506183680.ingest.us.sentry.io/4510880579518464';

// App version (e.g. "1.0.0") used for Sentry release/dist. Mirrors the version
// resolution already used in settings.tsx / HelpModal.tsx.
const APP_VERSION =
  Constants.expoConfig?.version ??
  Constants.manifest2?.extra?.expoClient?.version ??
  'unknown';

Sentry.init({
  dsn: SENTRY_DSN,
  // Send events in production builds; stay silent in dev to avoid noise.
  enabled: !__DEV__,
  environment: __DEV__ ? 'development' : 'production',
  release: `keepr-companion@${APP_VERSION}`,
  dist: APP_VERSION,
  tracesSampleRate: 1.0,
  // Tag every event so Android companion telemetry is filterable within the
  // shared `electron` Sentry project (BACKLOG-2197).
  initialScope: {
    tags: { app: 'android-companion' },
  },
});

const ONBOARDING_COMPLETE_KEY = '@keepr/onboarding-complete';

/**
 * Root stack layout with auth gate.
 *
 * Routing logic:
 * - No session       -> login screen
 * - Session, not onboarded -> onboarding flow
 * - Session + onboarded    -> main app
 */
export default function RootLayout(): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [onboarded, setOnboarded] = useState(false);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const segments = useSegments();
  // BACKLOG-2203/2224: the last Supabase user id observed via onAuthStateChange,
  // so we can detect a sign-out (id -> null) or an account switch (id -> a
  // different id) and clear the pairing accordingly.
  const previousUserIdRef = useRef<string | null>(null);

  // BACKLOG-2255: enforce DARK navigation-bar buttons at runtime (Android).
  //
  // The build-time theme sets android:windowLightNavigationBar=true, but on
  // some devices (Samsung / Android 14, 3-button nav) RN's own window setup
  // resets the WindowInsetsController appearance after first frame, leaving
  // white buttons invisible on our light bar. `setButtonStyleAsync('dark')`
  // drives APPEARANCE_LIGHT_NAVIGATION_BARS directly and — unlike the color
  // APIs — is NOT a no-op under edge-to-edge (verified in the installed
  // expo-navigation-bar source: it calls straight through to native with no
  // isEdgeToEdge() guard). Applied after first frame and re-applied whenever
  // the app returns to the foreground (OEMs can reset it after modals).
  useEffect(() => {
    if (Platform.OS !== 'android') return;

    const applyDarkButtons = (): void => {
      // requestAnimationFrame lands the call after RN's own window setup.
      requestAnimationFrame(() => {
        NavigationBar.setButtonStyleAsync('dark').catch(() => {
          /* non-fatal: theme default still applies */
        });
      });
    };

    applyDarkButtons();

    const sub = AppState.addEventListener(
      'change',
      (state: AppStateStatus) => {
        if (state === 'active') applyDarkButtons();
      },
    );
    return () => sub.remove();
  }, []);

  // Load session + onboarding status on mount
  useEffect(() => {
    let mounted = true;

    async function init(): Promise<void> {
      try {
        const [currentSession, onboardingComplete] = await Promise.all([
          getSession(),
          AsyncStorage.getItem(ONBOARDING_COMPLETE_KEY),
        ]);

        if (!mounted) return;
        setSession(currentSession);
        setOnboarded(onboardingComplete === 'true');
        // BACKLOG-2249: attach the Supabase user id (id ONLY — no email/name/
        // username, per SOC2 posture) so support can look up a user's errors.
        Sentry.setUser(
          currentSession ? { id: currentSession.user.id } : null,
        );
      } catch (error) {
        console.error('[Auth] Failed to initialize:', error);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    init();

    // Subscribe to auth state changes
    const subscription = onAuthStateChange((_event, newSession) => {
      if (!mounted) return;

      // BACKLOG-2203/2224: reconcile the pairing with the auth transition BEFORE
      // updating state. Sign-out or account switch clears the pairing so a fresh
      // pair is forced (which re-runs the desktop account-match). Fire-and-forget
      // — pairing teardown must not block the session/UI update — and only when
      // the user id actually changed (skips token-refresh churn).
      const newUserId = newSession?.user.id ?? null;
      const prevUserId = previousUserIdRef.current;
      previousUserIdRef.current = newUserId;
      if (newUserId !== prevUserId) {
        void reconcilePairingForAuthChange(newUserId, prevUserId).catch(
          (error) => {
            Sentry.captureException(error, {
              tags: { component: 'pairingManager' },
            });
          },
        );
      }

      setSession(newSession);
      // BACKLOG-2249: keep Sentry's user in sync on login/logout (id ONLY).
      Sentry.setUser(newSession ? { id: newSession.user.id } : null);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  // BACKLOG-2204: AppState catch-up. Once the user is signed in + onboarded,
  // foregrounding the app triggers an immediate catch-up sync so anything the
  // OS missed while backgrounded/Doze'd is captured the moment Keepr is opened.
  // performSync is serialised by the 2200 mutex, so this can never race the
  // background task or a manual "Sync Now".
  useEffect(() => {
    if (loading || !session || !onboarded) return;
    const unregister = registerAppStateCatchup();
    return unregister;
  }, [loading, session, onboarded]);

  // Re-check onboarding status when navigating (catches AsyncStorage updates from first-sync)
  useEffect(() => {
    if (loading || !session) return;
    const checkOnboarding = async () => {
      const complete = await AsyncStorage.getItem(ONBOARDING_COMPLETE_KEY);
      if (complete === 'true' && !onboarded) {
        setOnboarded(true);
      }
    };
    checkOnboarding();
  }, [segments, loading, session, onboarded]);

  // Handle routing based on auth state
  useEffect(() => {
    if (loading) return;

    const inLoginGroup = segments[0] === 'login';
    const inOnboardingGroup = segments[0] === 'onboarding';
    const inMainGroup = segments[0] === '(main)';

    if (!session) {
      // Not authenticated -> go to login
      if (!inLoginGroup) {
        router.replace('/login');
      }
    } else if (!onboarded) {
      // Authenticated but not onboarded -> go to onboarding
      if (!inOnboardingGroup) {
        // BACKLOG-1473: permissions is now step 1 (before pair-device)
        router.replace('/onboarding/permissions');
      }
    } else {
      // Authenticated and onboarded -> go to main app
      if (!inMainGroup) {
        router.replace('/(main)/home');
      }
    }
  }, [session, onboarded, loading, segments, router]);

  // Show loading spinner while checking auth state
  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.primary[600]} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="login" />
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="(main)" />
      </Stack>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.gray[50],
  },
});
