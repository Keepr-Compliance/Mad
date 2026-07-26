import { useState, useCallback, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as WebBrowser from 'expo-web-browser';
import {
  signInWithGoogle,
  signInWithMicrosoft,
  signInWithEmail,
} from '../services/authService';
import { colors } from '../theme/colors';
import { textStyles } from '../theme/typography';
import { borderRadius, spacing } from '../theme/spacing';
import { BrandMark, GoogleIcon, MicrosoftIcon } from '../components/ui';

// External legal links (open in the device browser) — BACKLOG-2253.
const TERMS_URL = 'https://keeprcompliance.com/terms';
const PRIVACY_URL = 'https://keeprcompliance.com/privacy';

interface OAuthButtonProps {
  icon: React.JSX.Element;
  label: string;
  onPress: () => void;
  loading: boolean;
  disabled: boolean;
}

/** Portal OAuth button: white, 1px #E7E8F0, radius 12, icon + 15/600 label. */
function OAuthButton({
  icon,
  label,
  onPress,
  loading,
  disabled,
}: OAuthButtonProps): React.JSX.Element {
  return (
    <TouchableOpacity
      style={[styles.oauthButton, disabled && styles.buttonDisabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {loading ? (
        <ActivityIndicator size="small" color={colors.login.ink} />
      ) : (
        <>
          <View style={styles.oauthIcon}>{icon}</View>
          <Text style={styles.oauthLabel}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

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

  // Brand header — portal: the mark carries the brand, the heading is the sole
  // "Keepr", the eyebrow names the platform ("Android Companion").
  const brandHeader = (
    <View style={styles.brandSection}>
      <View style={styles.logoImage}>
        <BrandMark size={60} />
      </View>
      <Text style={styles.heading}>Sign in to Keepr</Text>
      <Text style={styles.eyebrow}>Android Companion</Text>
    </View>
  );

  // -------------------------------------------------------
  // Render: Magic link sent confirmation
  // -------------------------------------------------------

  if (emailSent) {
    return (
      <LinearGradient
        colors={[colors.login.glow, 'transparent']}
        locations={[0, 0.55]}
        style={styles.screen}
        pointerEvents="box-none"
      >
        <View style={styles.centerWrap}>
          <View style={styles.card}>
            {brandHeader}
            <Text style={styles.checkIcon}>{'✉️'}</Text>
            <Text style={styles.confirmTitle}>Check your email</Text>
            <Text style={styles.confirmBody}>
              We sent a sign-in link to{'\n'}
              <Text style={styles.emailHighlight}>{email.trim()}</Text>
            </Text>
            <Text style={styles.confirmSub}>
              Tap the link in the email to sign in to your Keepr account.
            </Text>
            <View style={styles.confirmActions}>
              <TouchableOpacity
                style={styles.oauthButton}
                onPress={() => {
                  setEmailSent(false);
                  setEmail('');
                }}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Back to Sign In"
              >
                <Text style={styles.oauthLabel}>Back to Sign In</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </LinearGradient>
    );
  }

  // -------------------------------------------------------
  // Render: Login form (portal order — OAuth first, email last)
  // -------------------------------------------------------

  return (
    <LinearGradient
      colors={[colors.login.glow, 'transparent']}
      locations={[0, 0.55]}
      style={styles.screen}
      pointerEvents="box-none"
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.card}>
            {brandHeader}

            {/* Error display — portal red-50 box */}
            {error != null && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            {/* OAuth buttons — Google then Microsoft, 12px gap */}
            <View style={styles.oauthSection}>
              <OAuthButton
                icon={<GoogleIcon />}
                label="Continue with Google"
                onPress={handleGoogleSignIn}
                loading={loading === 'google'}
                disabled={loading != null}
              />
              <View style={styles.buttonSpacer} />
              <OAuthButton
                icon={<MicrosoftIcon />}
                label="Continue with Microsoft"
                onPress={handleMicrosoftSignIn}
                loading={loading === 'microsoft'}
                disabled={loading != null}
              />
            </View>

            {/* Divider: line with a white "or" chip */}
            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <View style={styles.dividerChip}>
                <Text style={styles.dividerText}>or</Text>
              </View>
            </View>

            {/* Email form — solid indigo submit */}
            <View style={styles.emailSection}>
              <TextInput
                style={styles.emailInput}
                placeholder="Enter your email address"
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
              <TouchableOpacity
                style={[styles.submitButton, loading != null && styles.buttonDisabled]}
                onPress={handleEmailSignIn}
                disabled={loading != null}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Continue with email"
              >
                {loading === 'email' ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <Text style={styles.submitButtonText}>Continue with email</Text>
                )}
              </TouchableOpacity>
            </View>

            {/* Legal footer — external links open in the device browser */}
            <Text style={styles.legal}>
              By continuing you agree to Keepr&apos;s{' '}
              <Text
                style={styles.legalLink}
                onPress={() => void Linking.openURL(TERMS_URL)}
                accessibilityRole="link"
              >
                Terms
              </Text>
              {' '}and{' '}
              <Text
                style={styles.legalLink}
                onPress={() => void Linking.openURL(PRIVACY_URL)}
                accessibilityRole="link"
              >
                Privacy Policy
              </Text>
              .
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    // The LinearGradient paints the top indigo glow; this base color shows
    // through the "transparent" stop to complete the portal background.
    backgroundColor: colors.login.background,
  },
  flex: {
    flex: 1,
  },
  centerWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[4],
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing[4],
  },
  card: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: colors.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.login.cardBorder,
    paddingHorizontal: 36,
    paddingTop: 40,
    paddingBottom: 32,
    // 0 12px 34px -12px rgba(20,22,43,0.16)
    shadowColor: colors.login.cardShadow,
    shadowOpacity: 0.16,
    shadowRadius: 17,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  brandSection: {
    alignItems: 'center',
    marginBottom: 28,
  },
  logoImage: {
    width: 60,
    height: 60,
    // Indigo glow behind the SVG mark (approx drop-shadow_0_8px_18px).
    shadowColor: colors.brand.indigo,
    shadowOpacity: 0.3,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  heading: {
    marginTop: 16,
    fontSize: 21,
    fontWeight: '800',
    letterSpacing: -0.42,
    color: colors.login.ink,
    textAlign: 'center',
  },
  eyebrow: {
    marginTop: 10,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1.43,
    color: colors.login.muted,
    textAlign: 'center',
  },
  errorBox: {
    marginBottom: spacing[6],
    padding: spacing[4],
    backgroundColor: colors.login.errorBg,
    borderWidth: 1,
    borderColor: colors.login.errorBorder,
    borderRadius: borderRadius.lg,
  },
  errorText: {
    ...textStyles.label,
    color: colors.login.errorText,
    textAlign: 'center',
  },
  oauthSection: {
    // no bottom margin; divider carries the my-24 spacing
  },
  buttonSpacer: {
    height: 12,
  },
  oauthButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.login.cardBorder,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  oauthIcon: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  oauthLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.login.ink,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 24,
  },
  dividerLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.login.cardBorder,
  },
  dividerChip: {
    backgroundColor: colors.white,
    paddingHorizontal: spacing[8],
  },
  dividerText: {
    fontSize: 14,
    color: colors.login.muted,
  },
  emailSection: {
    marginBottom: spacing[2],
  },
  emailInput: {
    width: '100%',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.login.cardBorder,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 15,
    color: colors.login.inputText,
  },
  submitButton: {
    width: '100%',
    backgroundColor: colors.login.primary,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitButtonText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '600',
  },
  legal: {
    marginTop: spacing[6],
    textAlign: 'center',
    fontSize: 12,
    lineHeight: 18,
    color: colors.login.muted,
  },
  legalLink: {
    color: colors.login.link,
    textDecorationLine: 'underline',
  },

  // Magic-link confirmation styles
  checkIcon: {
    fontSize: 48,
    textAlign: 'center',
    marginBottom: spacing[4],
  },
  confirmTitle: {
    fontSize: 21,
    fontWeight: '800',
    letterSpacing: -0.42,
    color: colors.login.ink,
    textAlign: 'center',
    marginBottom: spacing[2],
  },
  confirmBody: {
    ...textStyles.body,
    color: colors.login.muted,
    textAlign: 'center',
  },
  confirmSub: {
    ...textStyles.caption,
    color: colors.login.muted,
    textAlign: 'center',
    marginTop: spacing[3],
  },
  emailHighlight: {
    ...textStyles.body,
    fontWeight: '600',
    color: colors.login.ink,
  },
  confirmActions: {
    marginTop: spacing[6],
  },
});
