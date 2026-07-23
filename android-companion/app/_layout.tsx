import '../services/cryptoPolyfill';
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { onAuthStateChange, getSession } from '../services/authService';
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
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="onboarding" />
      <Stack.Screen name="(main)" />
    </Stack>
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
