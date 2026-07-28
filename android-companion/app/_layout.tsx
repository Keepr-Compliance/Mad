import '../services/cryptoPolyfill';
import * as Sentry from '@sentry/react-native';
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
import { onAuthStateChange, getSession } from '../services/authService';
import {
  markHadSession,
  clearHadSession,
  consumeHadSession,
  takeDeliberateSignOut,
} from '../services/authSessionState';
import { registerAppStateCatchup } from '../services/appStateCatchup';
import { reconcilePairingForAuthChange } from '../services/pairingManager';
import {
  getResumeStep,
  isOnboardingComplete,
  ONBOARDING_ROUTES,
  type OnboardingStep,
} from '../services/onboardingProgress';
import { colors } from '../theme/colors';
import { initSentry } from '../services/sentry';
import type { Session } from '@supabase/supabase-js';

// Initialize Sentry (JS + native crash capture) as early as possible, before
// the first render. DSN / release / dist / native-crash config and the
// build-time source-map wiring all live in services/sentry.ts (BACKLOG-2197 /
// BACKLOG-2222). `Sentry.setUser` / `captureException` are still called
// directly from the component below via the namespace import above.
initSentry();

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
  // BACKLOG-2215: true when we reach the login screen because a PRIOR session
  // was lost (refresh failed / token revoked), as opposed to a first run. Drives
  // the "your session expired" notice on login so the bounce isn't silent. Set
  // synchronously (init for startup, the auth listener for live loss) so it is
  // already true in the same render batch as `session` going null — the routing
  // effect then carries the notice to login on the first navigation.
  const [sessionExpired, setSessionExpired] = useState(false);
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
        // BACKLOG-2215: distinguish expiry from first-run at startup. If we have
        // a session, remember it (so a later loss reads as expiry). If we don't,
        // check the marker: a set marker means a prior session was lost while the
        // app was closed (expired/revoked) -> show the notice; an unset marker
        // means this is a genuine first run -> silent login as before.
        if (currentSession) {
          void markHadSession();
        } else {
          const hadPriorSession = await consumeHadSession();
          if (mounted && hadPriorSession) setSessionExpired(true);
        }
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
    const subscription = onAuthStateChange((event, newSession) => {
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

      // BACKLOG-2215: track expiry across LIVE auth transitions. A new session
      // clears any pending expiry notice and re-arms the marker. A session that
      // goes away AFTER mount (event !== INITIAL_SESSION — the startup case is
      // owned by init() above) is an expiry UNLESS the user deliberately signed
      // out. Decided SYNCHRONOUSLY — `prevUserId` proves a session existed and
      // takeDeliberateSignOut() rules out a user-initiated sign-out — so
      // `sessionExpired` is set in the same batch as `session` going null and
      // the routing effect carries the notice to login on the first navigation.
      if (newSession) {
        setSessionExpired(false);
        void markHadSession();
      } else if (event !== 'INITIAL_SESSION' && prevUserId != null) {
        if (takeDeliberateSignOut()) {
          // User tapped Sign Out — normal login, no expiry notice.
        } else {
          setSessionExpired(true);
          // Consume the persisted marker too, so the one-shot notice does not
          // also fire on the next app launch.
          void clearHadSession();
        }
      }

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

    // BACKLOG-2215: leave the OAuth/magic-link callback screen alone while it
    // resolves. It owns its own terminal navigation (home on success, login
    // with an error on failure); without this the auth gate would redirect the
    // null-session callback route to a bare /login and clobber that outcome.
    if (segments[0] === 'auth') return;

    const inLoginGroup = segments[0] === 'login';
    const inOnboardingGroup = segments[0] === 'onboarding';
    const inMainGroup = segments[0] === '(main)';

    if (!session) {
      // Not authenticated -> go to login. BACKLOG-2215: when the session was
      // LOST (expired/revoked) rather than never present, carry an `authError`
      // param so login can explain the bounce instead of failing silently.
      if (!inLoginGroup) {
        router.replace(
          sessionExpired
            ? { pathname: '/login', params: { authError: 'expired' } }
            : '/login',
        );
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
  }, [session, onboarded, resumeStep, loading, segments, router, sessionExpired]);

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
