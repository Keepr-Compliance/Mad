import '../services/cryptoPolyfill';
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
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
import { onAuthStateChange, getSession } from '../services/authService';
import {
  getResumeStep,
  isOnboardingComplete,
  ONBOARDING_ROUTES,
  type OnboardingStep,
} from '../services/onboardingProgress';
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

/**
 * Root stack layout with auth gate.
 *
 * Routing logic:
 * - No session       -> login screen
 * - Session, not onboarded -> onboarding flow (RESUMED at the persisted step)
 * - Session + onboarded    -> main app
 */
export default function RootLayout(): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [onboarded, setOnboarded] = useState(false);
  // BACKLOG-2216: the onboarding step to resume at when the user is not yet
  // onboarded. Loaded once during init; the gate only uses it for the INITIAL
  // redirect into onboarding (after that `inOnboardingGroup` is true and the
  // gate stops steering, so intra-flow navigation is owned by the screens).
  const [resumeStep, setResumeStep] = useState<OnboardingStep>('permissions');
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const segments = useSegments();

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
        const [currentSession, onboardingComplete, step] = await Promise.all([
          getSession(),
          isOnboardingComplete(),
          // BACKLOG-2216: resume an interrupted onboarding at the last step
          // reached instead of restarting from the beginning.
          getResumeStep(),
        ]);

        if (!mounted) return;
        setSession(currentSession);
        setOnboarded(onboardingComplete);
        setResumeStep(step);
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
      setSession(newSession);
      // BACKLOG-2249: keep Sentry's user in sync on login/logout (id ONLY).
      Sentry.setUser(newSession ? { id: newSession.user.id } : null);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  // Re-check onboarding status when navigating (catches AsyncStorage updates from first-sync)
  useEffect(() => {
    if (loading || !session) return;
    const checkOnboarding = async () => {
      const complete = await isOnboardingComplete();
      if (complete && !onboarded) {
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
      // Authenticated but not onboarded -> go to onboarding.
      // BACKLOG-2216: resume at the furthest persisted step (defaults to
      // permissions, step 1, on a fresh run) instead of always restarting.
      //
      // Exception: don't redirect when already in the main group. The ONLY way
      // to reach `(main)` is by completing onboarding (which persists the
      // complete flag before navigating), so `inMainGroup && !onboarded` is the
      // brief window where `onboarded` is still catching up via the re-check
      // effect. Bouncing back into the flow there would re-enter the resumed
      // step (first-sync, which auto-syncs) — so we let the catch-up settle.
      if (!inOnboardingGroup && !inMainGroup) {
        router.replace(ONBOARDING_ROUTES[resumeStep]);
      }
    } else {
      // Authenticated and onboarded -> go to main app
      if (!inMainGroup) {
        router.replace('/(main)/home');
      }
    }
  }, [session, onboarded, resumeStep, loading, segments, router]);

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
