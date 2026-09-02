import { useState, useCallback, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Linking,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  requestSmsPermissions,
  requestContactsPermissions,
  checkSmsPermissions,
  checkContactsPermissions,
} from '../../services/permissions';
import type {
  SmsPermissionResult,
  ContactsPermissionResult,
} from '../../services/permissions';
import { setOnboardingStep } from '../../services/onboardingProgress';
import { hasDisclosureConsent } from '../../services/disclosureConsent';
import { colors } from '../../theme/colors';
import { textStyles } from '../../theme/typography';
import { borderRadius, spacing } from '../../theme/spacing';
import { Button } from '../../components/ui';
import OnboardingSignOutLink from '../../components/ui/OnboardingSignOutLink';
import DemoPreview from '../../components/demo/DemoPreview';

export default function PermissionsScreen(): React.JSX.Element {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [smsResult, setSmsResult] = useState<SmsPermissionResult | null>(null);
  const [contactsResult, setContactsResult] = useState<ContactsPermissionResult | null>(null);
  const [attempted, setAttempted] = useState(false);

  // BACKLOG-2216: mark this as the current onboarding step so an interruption
  // resumes here instead of restarting the flow.
  useEffect(() => {
    void setOnboardingStep('permissions');
  }, []);

  const handleRequestPermissions = useCallback(async (): Promise<void> => {
    // BACKLOG-2956: Google Play's Prominent Disclosure rule requires the
    // disclosure to be shown IMMEDIATELY BEFORE the runtime permission prompt.
    // The stack order in _layout.tsx expresses that, but it does not enforce it:
    // a deep link, or a resume marker persisted by an older build that predates
    // the disclosure step, can land a user directly on this screen. This guard is
    // the enforcement. It runs BEFORE any request* call, so the OS dialog cannot
    // appear without a recorded consent, and it sends the user to the disclosure
    // rather than silently doing nothing.
    //
    // `hasDisclosureConsent` fails CLOSED (storage error / older consent version
    // both read as "no consent"), so an unreadable store gates rather than leaks.
    if (!(await hasDisclosureConsent())) {
      router.replace('/onboarding/disclosure');
      return;
    }

    setLoading(true);
    try {
      // Request permissions with a 10-second timeout per request
      const withTimeout = <T,>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
        Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

      const smsFallback: SmsPermissionResult = { readSms: 'denied', receiveSms: 'denied', allGranted: false };
      const contactsFallback: ContactsPermissionResult = { readContacts: 'denied', granted: false };

      // BACKLOG-1483: Request SEQUENTIALLY — Android can only show one permission dialog at a time.
      // Promise.all caused the second dialog (contacts) to be silently dropped.
      const sms = await withTimeout(requestSmsPermissions(), 10000, smsFallback);
      setSmsResult(sms);

      const contacts = await withTimeout(requestContactsPermissions(), 10000, contactsFallback);
      setContactsResult(contacts);
      setAttempted(true);

      // If all permissions granted, auto-advance to pair-device
      // BACKLOG-1473: permissions is now step 1, pair-device is step 2
      if (sms.allGranted && contacts.granted) {
        router.replace('/onboarding/pair-device');
      }
    } catch (error) {
      console.error('[Onboarding] Permission request error:', error);
      setAttempted(true);
    } finally {
      setLoading(false);
    }
  }, [router]);

  const handleContinueAnyway = useCallback((): void => {
    // BACKLOG-1473: Skip to pair-device (step 2) instead of first-sync
    router.replace('/onboarding/pair-device');
  }, [router]);

  const handleOpenSettings = useCallback((): void => {
    if (Platform.OS === 'android') {
      Linking.openSettings();
    }
  }, []);

  const handleCheckPermissions = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [sms, contacts] = await Promise.all([
        checkSmsPermissions(),
        checkContactsPermissions(),
      ]);
      setSmsResult(sms);
      setContactsResult(contacts);

      if (sms.allGranted && contacts.granted) {
        router.replace('/onboarding/pair-device');
      }
    } finally {
      setLoading(false);
    }
  }, [router]);

  // BACKLOG-2196: `allGranted` MUST be declared before it is read below.
  // Previously it was declared after `hasDeniedPermissions`, which caused a
  // temporal-dead-zone `ReferenceError: Cannot access 'allGranted' before
  // initialization` under Hermes the instant `attempted` flipped true (i.e. as
  // soon as the user denied/partially granted) — crashing the recovery screen.
  const allGranted =
    smsResult?.allGranted === true && contactsResult?.granted === true;

  // BACKLOG-2223: a permission is permanently blocked once Android returns
  // never_ask_again — RN derives this from shouldShowRequestPermissionRationale
  // === false after a deny; expo-contacts maps canAskAgain === false. A blocked
  // permission can no longer be re-requested in-app; only device Settings can
  // re-grant it.
  const hasBlockedPermissions =
    smsResult?.readSms === 'never_ask_again' ||
    smsResult?.receiveSms === 'never_ask_again' ||
    contactsResult?.readContacts === 'never_ask_again';

  // BACKLOG-2223: distinguish a SOFT denial (still re-askable in-app) from a
  // permanently-blocked one so we show the right recovery affordance.
  //
  // - canRetryInApp: the user denied but nothing is permanently blocked yet, so
  //   the OS will still surface its prompt again. Offer an in-app "Try Again"
  //   that re-requests the permission (re-triggers the OS dialog) instead of
  //   sending the user to Settings for a case they can resolve in one tap.
  // - mustOpenSettings: at least one permission is never_ask_again. A blocked
  //   permission cannot be re-requested in-app, so Settings is the only path —
  //   this also covers the mixed blocked+soft case (Settings is the safe
  //   umbrella). On modern Android (11+, incl. Samsung) a deny can flip to
  //   never_ask_again quickly (often the 2nd deny), so a "Try Again" that gets
  //   hard-denied transitions the screen here automatically (no stuck loop).
  //
  // The render's final `else` (after !attempted, allGranted and canRetryInApp are
  // ruled out) is exactly the blocked/mixed case → "Open Settings".
  const canRetryInApp = attempted && !allGranted && !hasBlockedPermissions;

  return (
    <View style={styles.screen}>
      {/* Step indicator */}
      <View style={styles.stepIndicator}>
        <Text style={styles.stepText}>Step 2 of 4</Text>
      </View>

      <View style={styles.content}>
        <Text style={styles.stepIcon}>{'🔐'}</Text>
        <Text style={styles.title}>App Permissions</Text>
        <Text style={styles.description}>
          Keepr Companion needs access to your SMS messages and contacts to sync
          them with the desktop app.
        </Text>

        {/* Permission items */}
        <View style={styles.permissionsCard}>
          <PermissionItem
            label="Read SMS"
            description="Read messages from your phone"
            status={smsResult?.readSms ?? null}
          />
          <View style={styles.itemDivider} />
          <PermissionItem
            label="Receive SMS"
            description="Get notified of new messages"
            status={smsResult?.receiveSms ?? null}
          />
          <View style={styles.itemDivider} />
          <PermissionItem
            label="Contacts"
            description="Sync contacts with desktop app"
            status={contactsResult?.readContacts ?? null}
          />
        </View>

        {/* Actions */}
        {!attempted ? (
          <Button
            title="Grant Permissions"
            onPress={handleRequestPermissions}
            loading={loading}
            disabled={loading}
            size="lg"
            fullWidth
          />
        ) : allGranted ? (
          <Button
            title="Continue"
            onPress={() => router.replace('/onboarding/pair-device')}
            size="lg"
            fullWidth
          />
        ) : canRetryInApp ? (
          // BACKLOG-2223: soft denial (still re-askable) — re-request in-app.
          <View style={styles.blockedSection}>
            <Text style={styles.blockedText}>
              Some permissions weren&apos;t granted. Tap Try Again to re-request
              them, or continue without them for now.
            </Text>
            <Button
              title="Try Again"
              onPress={handleRequestPermissions}
              loading={loading}
              disabled={loading}
              size="lg"
              fullWidth
            />
            <View style={styles.buttonSpacer} />
            <Button
              title="Skip for Now"
              variant="secondary"
              onPress={handleContinueAnyway}
              size="sm"
              fullWidth
            />
          </View>
        ) : (
          // BACKLOG-2223: mustOpenSettings — at least one permission is
          // permanently blocked (never_ask_again). It can only be re-granted from
          // device Settings, so Try Again is intentionally NOT offered here.
          <View style={styles.blockedSection}>
            <Text style={styles.blockedText}>
              Some permissions were permanently denied. Please enable them in your
              device settings, then return to continue.
            </Text>
            <Button
              title="Open Settings"
              onPress={handleOpenSettings}
              size="lg"
              fullWidth
            />
            <View style={styles.buttonSpacer} />
            <Button
              title="I Updated Settings"
              variant="outline"
              onPress={handleCheckPermissions}
              loading={loading}
              size="lg"
              fullWidth
            />
            <View style={styles.buttonSpacer} />
            <Button
              title="Skip for Now"
              variant="secondary"
              onPress={handleContinueAnyway}
              size="sm"
              fullWidth
            />
          </View>
        )}

        {/* BACKLOG-3027: hosted HERE, and not only on pair-device, because the
            forward path off this screen is the `!attempted` branch above — a
            single "Grant Permissions" button. "Skip for Now" appears only in the
            denied branches, i.e. only AFTER the OS dialog has fired. So this is
            the last screen where the product can be seen with NOTHING granted,
            which is the strongest form of the answer to "why does this app want
            to read my texts". */}
        <DemoPreview />

        {/* BACKLOG-2956: the only escape from onboarding before this existed was
            clearing app storage in Android Settings. */}
        <OnboardingSignOutLink />
      </View>
    </View>
  );
}

// ============================================
// Permission Item Sub-Component
// ============================================

function PermissionItem({
  label,
  description,
  status,
}: {
  label: string;
  description: string;
  status: string | null;
}): React.JSX.Element {
  const statusColor =
    status === 'granted'
      ? colors.success[600]
      : status === 'never_ask_again'
        ? colors.danger[500]
        : status === 'denied'
          ? colors.warning[500]
          : colors.gray[400];

  const statusLabel =
    status === 'granted'
      ? 'Granted'
      : status === 'never_ask_again'
        ? 'Blocked'
        : status === 'denied'
          ? 'Denied'
          : 'Not requested';

  return (
    <View style={styles.permissionItem}>
      <View style={styles.permissionInfo}>
        <Text style={styles.permissionLabel}>{label}</Text>
        <Text style={styles.permissionDescription}>{description}</Text>
      </View>
      <Text style={[styles.permissionStatus, { color: statusColor }]}>
        {statusLabel}
      </Text>
    </View>
  );
}

// ============================================
// Styles
// ============================================

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.gray[50],
  },
  stepIndicator: {
    paddingTop: spacing[16],
    paddingBottom: spacing[2],
    alignItems: 'center',
  },
  stepText: {
    ...textStyles.caption,
    color: colors.primary[600],
    fontWeight: '600',
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[6],
    paddingBottom: spacing[12],
  },
  stepIcon: {
    fontSize: 48,
    marginBottom: spacing[5],
  },
  title: {
    ...textStyles.heading,
    color: colors.gray[900],
    textAlign: 'center',
    marginBottom: spacing[3],
  },
  description: {
    ...textStyles.body,
    color: colors.gray[600],
    textAlign: 'center',
    marginBottom: spacing[8],
  },
  permissionsCard: {
    width: '100%',
    backgroundColor: colors.white,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.gray[200],
    padding: spacing[4],
    marginBottom: spacing[8],
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  permissionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing[3],
  },
  permissionInfo: {
    flex: 1,
    marginRight: spacing[3],
  },
  permissionLabel: {
    ...textStyles.label,
    color: colors.gray[900],
  },
  permissionDescription: {
    ...textStyles.caption,
    color: colors.gray[400],
    marginTop: 2,
  },
  permissionStatus: {
    ...textStyles.label,
  },
  itemDivider: {
    height: 1,
    backgroundColor: colors.gray[100],
  },
  blockedSection: {
    width: '100%',
  },
  blockedText: {
    ...textStyles.caption,
    color: colors.gray[500],
    textAlign: 'center',
    marginBottom: spacing[4],
  },
  buttonSpacer: {
    height: spacing[3],
  },
});
