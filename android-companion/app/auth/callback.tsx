/**
 * OAuth / magic-link callback handler for Supabase auth.
 *
 * For the OAuth buttons, token extraction happens directly in authService.ts via
 * WebBrowser.openAuthSessionAsync(), so the session is already set before this
 * route is ever reached. This route is the landing spot for the URL-scheme
 * redirect — most importantly the magic-link email, whose deep link
 * (keepr-companion://auth/callback#access_token=…) can ONLY be completed here.
 *
 * BACKLOG-2215: previously this screen unconditionally redirected to `/` after
 * 500ms with no failure branch — so a callback that carried a provider error, or
 * that never established a session (e.g. an expired magic link), silently dropped
 * the user onto a broken home screen. It now resolves the callback and routes
 * deliberately: success -> `/` (the auth gate takes over); failure -> the login
 * screen WITH an explanatory notice, where the sign-in options are the retry.
 */

import { useEffect } from 'react';
import { View, ActivityIndicator, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useURL } from 'expo-linking';
import { getSession, extractSessionFromUrl } from '../../services/authService';
import { colors, spacing, textStyles } from '../../theme';

/** Params in a callback URL can live in the `#` hash and/or the `?` query. */
function hashParams(url: string): URLSearchParams {
  const i = url.indexOf('#');
  return new URLSearchParams(i === -1 ? '' : url.substring(i + 1));
}

function queryParams(url: string): URLSearchParams {
  const q = url.indexOf('?');
  if (q === -1) return new URLSearchParams('');
  const h = url.indexOf('#');
  const end = h !== -1 && h > q ? h : url.length;
  return new URLSearchParams(url.substring(q + 1, end));
}

/** True when the callback URL carries an explicit provider error. */
function hasAuthError(url: string): boolean {
  const hash = hashParams(url);
  const query = queryParams(url);
  return (
    hash.get('error') !== null ||
    hash.get('error_description') !== null ||
    query.get('error') !== null ||
    query.get('error_description') !== null
  );
}

/** True when the callback URL hash carries a full token pair (magic link). */
function hasTokens(url: string): boolean {
  const hash = hashParams(url);
  return hash.get('access_token') !== null && hash.get('refresh_token') !== null;
}

/**
 * Resolve the callback to a single decision: `true` = a session is established
 * (go home), `false` = failure (go to login with a notice).
 */
async function resolveCallback(url: string | null): Promise<boolean> {
  // 1. An explicit provider error always fails, regardless of anything else.
  if (url && hasAuthError(url)) return false;

  // 2. Magic-link tokens present -> establish the session here (the only place
  //    that can). A setSession failure is a callback failure.
  if (url && hasTokens(url)) {
    const error = await extractSessionFromUrl(url);
    return error === null;
  }

  // 3. No error, no tokens: the OAuth path already set the session upstream —
  //    confirm one actually exists rather than blindly assuming success.
  const session = await getSession();
  return session !== null;
}

export default function AuthCallback(): React.JSX.Element {
  const router = useRouter();
  const url = useURL();

  useEffect(() => {
    let cancelled = false;

    // A short delay preserves the prior "navigation is ready" grace and gives
    // useURL() a tick to surface the deep link that opened this route.
    const timer = setTimeout(() => {
      void resolveCallback(url).then((ok) => {
        if (cancelled) return;
        if (ok) {
          // Session established — hand back to the auth gate in _layout.tsx.
          router.replace('/');
        } else {
          // Failure — go to login WITH an explanation; the sign-in options
          // there are the retry affordance.
          router.replace({
            pathname: '/login',
            params: { authError: 'callback' },
          });
        }
      });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url, router]);

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={colors.primary[600]} />
      <Text style={styles.text}>Signing in...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.white,
  },
  text: {
    ...textStyles.body,
    marginTop: spacing[4],
    color: colors.gray[500],
  },
});
