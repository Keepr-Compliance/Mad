/**
 * OAuth callback handler for Supabase auth.
 *
 * With the expo-web-browser integration, token extraction now happens
 * directly in authService.ts via WebBrowser.openAuthSessionAsync().
 *
 * This route is kept as a fallback in case the URL scheme redirect
 * hits it (e.g. from magic link emails). It simply redirects to the
 * root, where the auth gate in _layout.tsx handles routing.
 */

import { useEffect } from 'react';
import { View, ActivityIndicator, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, spacing, textStyles } from '../../theme';

export default function AuthCallback(): React.JSX.Element {
  const router = useRouter();

  useEffect(() => {
    // Redirect to root — the auth gate in _layout.tsx handles routing
    // based on session state. A short delay ensures navigation is ready.
    const timer = setTimeout(() => router.replace('/'), 500);
    return () => clearTimeout(timer);
  }, [router]);

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
