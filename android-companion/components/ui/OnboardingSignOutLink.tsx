/**
 * OnboardingSignOutLink — BACKLOG-2956.
 *
 * Before this component there was NO way out of onboarding. A grep across all
 * onboarding screens found zero sign-out calls, zero back navigation and zero
 * switch-account affordance, so a user who signed in with the wrong account had
 * exactly one escape: clearing the app's storage from Android's system settings.
 * The founder hit that himself.
 *
 * Follows the pattern already used by `app/(main)/account.tsx`: a confirmation
 * Alert, then `signOut()`, and NO explicit navigation — the auth gate in
 * `app/_layout.tsx` observes the session going null and redirects to /login. A
 * navigate here would race that gate.
 *
 * Two clears happen alongside the sign-out, and both matter for the next user of
 * this phone:
 *   - the onboarding STEP marker, so the next account starts at step 1 rather
 *     than resuming mid-flow past a disclosure it never saw;
 *   - the disclosure CONSENT, so the next account gives its own consent rather
 *     than inheriting the previous user's.
 * The pairing itself is already cleared on a sign-out by
 * `reconcilePairingForAuthChange` in the root layout's auth listener.
 */

import { useCallback, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, Alert } from 'react-native';
import { signOut } from '../../services/authService';
import { clearOnboardingStep } from '../../services/onboardingProgress';
import { clearDisclosureConsent } from '../../services/disclosureConsent';
import { colors } from '../../theme/colors';
import { textStyles } from '../../theme/typography';
import { spacing } from '../../theme/spacing';

export interface OnboardingSignOutLinkProps {
  /** Override the link text (default: "Signed in with the wrong account?"). */
  label?: string;
}

export default function OnboardingSignOutLink({
  label = 'Signed in with the wrong account? Sign out',
}: OnboardingSignOutLinkProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);

  const performSignOut = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      // Clear this phone's onboarding state BEFORE the session goes away, so the
      // next account cannot inherit it. Both are best-effort and never throw.
      await clearOnboardingStep();
      await clearDisclosureConsent();

      const result = await signOut();
      if (result.error) {
        Alert.alert('Sign Out Failed', result.error);
        setBusy(false);
      }
      // On success the auth gate in app/_layout.tsx routes to /login. We do not
      // navigate here and we leave `busy` set, so the button cannot be pressed
      // twice while the redirect lands.
    } catch (error) {
      console.error('[Onboarding] Sign out failed:', error);
      Alert.alert('Sign Out Failed', 'Please try again.');
      setBusy(false);
    }
  }, []);

  const handlePress = useCallback((): void => {
    Alert.alert(
      'Sign Out',
      'You will be signed out of Keepr Companion and returned to the sign-in screen. Nothing on this phone is deleted.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: () => {
            void performSignOut();
          },
        },
      ],
    );
  }, [performSignOut]);

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel="Sign out"
      style={styles.link}
      activeOpacity={0.7}
    >
      <Text style={styles.linkText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  link: {
    marginTop: spacing[6],
    alignSelf: 'center',
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[4],
  },
  linkText: {
    ...textStyles.caption,
    color: colors.gray[500],
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
});
