import { useState, useCallback, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import {
  signInWithGoogle,
  signInWithMicrosoft,
  signInWithEmail,
} from '../services/authService';
import { colors } from '../theme/colors';
import { textStyles } from '../theme/typography';
import { borderRadius, spacing } from '../theme/spacing';
import { Button, Card, Wordmark } from '../components/ui';

// Canonical Keepr brand mark (white K + orange dot on indigo) — BACKLOG-2245.
const brandMark = require('../assets/icon.png') as number;

export default function LoginScreen(): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState<'google' | 'microsoft' | 'email' | null>(null);
  const [emailSent, setEmailSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Warm up the in-app browser for faster OAuth flow
  useEffect(() => {
    WebBrowser.warmUpAsync();
    return () => {
      WebBrowser.coolDownAsync();
    };
  }, []);

  const handleGoogleSignIn = useCallback(async (): Promise<void> => {
    setError(null);
    setLoading('google');
    try {
      const result = await signInWithGoogle();
      if (result.error) {
        setError(result.error);
      }
      // On success (error === null), the auth state change listener
      // in _layout.tsx will detect the new session and redirect automatically.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign in with Google');
    } finally {
      setLoading(null);
    }
  }, []);

  const handleMicrosoftSignIn = useCallback(async (): Promise<void> => {
    setError(null);
    setLoading('microsoft');
    try {
      const result = await signInWithMicrosoft();
      if (result.error) {
        setError(result.error);
      }
      // On success (error === null), the auth state change listener
      // in _layout.tsx will detect the new session and redirect automatically.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign in with Microsoft');
    } finally {
      setLoading(null);
    }
  }, []);

  const handleEmailSignIn = useCallback(async (): Promise<void> => {
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Please enter your email address');
      return;
    }

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('Please enter a valid email address');
      return;
    }

    setError(null);
    setLoading('email');
    try {
      const result = await signInWithEmail(trimmed);
      if (result.error) {
        setError(result.error);
      } else {
        setEmailSent(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send magic link');
    } finally {
      setLoading(null);
    }
  }, [email]);

  // -------------------------------------------------------
  // Render: Magic link sent confirmation
  // -------------------------------------------------------

  if (emailSent) {
    return (
      <View style={styles.screen}>
        <View style={styles.centered}>
          <Text style={styles.checkIcon}>{'✉️'}</Text>
          <Text style={styles.title}>Check your email</Text>
          <Text style={styles.description}>
            We sent a sign-in link to{'\n'}
            <Text style={styles.emailHighlight}>{email.trim()}</Text>
          </Text>
          <Text style={styles.subdescription}>
            Tap the link in the email to sign in to your Keepr account.
          </Text>
          <View style={styles.emailSentActions}>
            <Button
              title="Back to Sign In"
              variant="outline"
              onPress={() => {
                setEmailSent(false);
                setEmail('');
              }}
            />
          </View>
        </View>
      </View>
    );
  }

  // -------------------------------------------------------
  // Render: Login form
  // -------------------------------------------------------

  return (
    <View style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Logo / brand area */}
          <View style={styles.brandSection}>
            <Image
              source={brandMark}
              style={styles.logoImage}
              accessibilityLabel="Keepr"
              resizeMode="cover"
            />
            <Wordmark size={32} style={styles.brandWordmark} />
            <Text style={styles.description}>
              Sign in to your Keepr account to connect this device.
            </Text>
          </View>

          {/* Error display */}
          {error != null && (
            <Card style={styles.errorCard}>
              <Text style={styles.errorText}>{error}</Text>
            </Card>
          )}

          {/* OAuth buttons */}
          <View style={styles.oauthSection}>
            <Button
              title="Sign in with Google"
              variant="outline"
              onPress={handleGoogleSignIn}
              loading={loading === 'google'}
              disabled={loading != null}
              fullWidth
              size="lg"
            />
            <View style={styles.buttonSpacer} />
            <Button
              title="Sign in with Microsoft"
              variant="outline"
              onPress={handleMicrosoftSignIn}
              loading={loading === 'microsoft'}
              disabled={loading != null}
              fullWidth
              size="lg"
            />
          </View>

          {/* Divider */}
          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* Email magic link */}
          <View style={styles.emailSection}>
            <TextInput
              style={styles.emailInput}
              placeholder="you@example.com"
              placeholderTextColor={colors.gray[400]}
              value={email}
              onChangeText={(text) => {
                setEmail(text);
                if (error) setError(null);
              }}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              editable={loading == null}
            />
            <View style={styles.buttonSpacer} />
            <Button
              title="Continue with Email"
              onPress={handleEmailSignIn}
              loading={loading === 'email'}
              disabled={loading != null}
              fullWidth
              size="lg"
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.gray[50],
  },
  flex: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[6],
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing[6],
  },
  brandSection: {
    alignItems: 'center',
    marginBottom: spacing[8],
  },
  logoImage: {
    width: 88,
    height: 88,
    borderRadius: borderRadius['2xl'],
    marginBottom: spacing[4],
  },
  brandWordmark: {
    textAlign: 'center',
    marginBottom: spacing[2],
  },
  title: {
    ...textStyles.heading,
    color: colors.gray[900],
    textAlign: 'center',
    marginBottom: spacing[2],
  },
  description: {
    ...textStyles.body,
    color: colors.gray[600],
    textAlign: 'center',
  },
  subdescription: {
    ...textStyles.caption,
    color: colors.gray[400],
    textAlign: 'center',
    marginTop: spacing[3],
  },
  emailHighlight: {
    ...textStyles.body,
    fontWeight: '600',
    color: colors.primary[600],
  },
  checkIcon: {
    fontSize: 48,
    marginBottom: spacing[5],
  },
  emailSentActions: {
    marginTop: spacing[8],
  },
  errorCard: {
    backgroundColor: colors.danger[50],
    borderColor: colors.danger[400],
    marginBottom: spacing[4],
  },
  errorText: {
    ...textStyles.label,
    color: colors.danger[700],
    textAlign: 'center',
    paddingVertical: spacing[1],
  },
  oauthSection: {
    marginBottom: spacing[5],
  },
  buttonSpacer: {
    height: spacing[3],
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing[5],
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.gray[200],
  },
  dividerText: {
    ...textStyles.caption,
    color: colors.gray[400],
    marginHorizontal: spacing[4],
  },
  emailSection: {
    marginBottom: spacing[6],
  },
  emailInput: {
    width: '100%',
    height: 52,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.gray[200],
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[4],
    ...textStyles.body,
    color: colors.gray[900],
  },
});
