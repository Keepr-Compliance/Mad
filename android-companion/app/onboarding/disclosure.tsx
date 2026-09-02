/**
 * Prominent Disclosure & Consent — BACKLOG-2956.
 *
 * Google Play requires this screen before an app may request SMS or contacts
 * access and send that data off the device. It must be in-app (a privacy policy
 * or store listing does not satisfy it), it must be shown immediately BEFORE the
 * runtime permission prompt, it must state what is collected / why / that it is
 * transmitted, and the user must press something. It applies here with no
 * exemption because the companion also syncs from a background task.
 *
 * Voice follows the desktop's `src/components/onboarding/steps/FdaSafetySheet.tsx`
 * — name the worry, answer it plainly — but NOT its text. The desktop's "nothing
 * is uploaded, ever" is FALSE on Android: this app's whole job is to send your
 * messages to your desktop. The claim here is narrower and true: the data goes to
 * YOUR computer over YOUR network, and not to Keepr's servers.
 *
 * Every factual claim below was verified against the code before it was written:
 *
 *  - "text messages (SMS)" and NOT MMS: `services/smsReader.ts` reads only
 *    `box: "inbox"` and `box: "sent"` through react-native-get-sms-android, and
 *    the repo contains no MMS reader at all. `app.json` declares READ_SMS,
 *    RECEIVE_SMS and READ_CONTACTS — no MMS permission. Saying "MMS" here would
 *    overstate collection and would contradict the Play Data Safety form.
 *  - "sent to your computer, not to Keepr's servers": `services/syncService.ts`
 *    POSTs message and contact payloads to `http://<ip>:<port>/sync/messages`
 *    and `/sync/contacts` — the address scanned from the desktop's QR code.
 *    Supabase sees only the account id and access token, at `/register`, for the
 *    account-match check. No message or contact content goes to Keepr.
 *  - "encrypted before it leaves this phone": `syncService` derives a transport
 *    key via `deriveTransportKeys(secret)` and sends `encrypt(...)` envelopes.
 *  - "in the background": `services/backgroundSync.ts` registers an
 *    expo-background-fetch task that syncs while the app is closed.
 *  - "Keepr Companion never sends text messages": there is no send path in the
 *    codebase; SEND_SMS is not among the declared permissions.
 *
 * The privacy policy is deliberately NOT linked from this screen. As of
 * 2026-08-28 https://keeprcompliance.com/privacy is still marked "Draft —
 * pending final legal review", and while its Section 5 does cover SMS ingested
 * from "a companion application", it covers contacts ONLY as Google Contacts and
 * Outlook/Microsoft contacts — not this phone's own address book — and says
 * nothing about local-network transmission to a desktop. Linking it would point
 * the user at a page that contradicts this screen on contacts.
 */

import { useState, useCallback, useEffect } from 'react';
import { StyleSheet, View, Text, ScrollView, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { recordDisclosureConsent } from '../../services/disclosureConsent';
import { setOnboardingStep } from '../../services/onboardingProgress';
import { colors } from '../../theme/colors';
import { textStyles } from '../../theme/typography';
import { borderRadius, spacing } from '../../theme/spacing';
import { Button } from '../../components/ui';
import OnboardingSignOutLink from '../../components/ui/OnboardingSignOutLink';
import DemoPreview from '../../components/demo/DemoPreview';

export default function DisclosureScreen(): React.JSX.Element {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  // BACKLOG-2216: mark this as the current onboarding step so an interruption
  // resumes here. This is the ONLY thing that happens on mount — consent is
  // never recorded and we never navigate from here, because consent that the
  // user did not actively give is not consent.
  useEffect(() => {
    void setOnboardingStep('disclosure');
  }, []);

  const handleAgree = useCallback(async (): Promise<void> => {
    setSaving(true);
    try {
      await recordDisclosureConsent();
      router.replace('/onboarding/permissions');
    } catch (error) {
      // A failed write must NOT advance the user: the permissions screen would
      // then gate them straight back here, and worse, an unrecorded consent is
      // an ungranted consent. Keep them here and say so.
      console.error('[Onboarding] Failed to record disclosure consent:', error);
      Alert.alert(
        'Could not save your choice',
        'Something went wrong saving your consent on this phone. Please try again.',
      );
      setSaving(false);
    }
  }, [router]);

  return (
    <View style={styles.screen}>
      <View style={styles.stepIndicator}>
        <Text style={styles.stepText}>Step 1 of 4</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>Before you continue</Text>
        <Text style={styles.title}>
          Your texts go to your own computer — and nowhere else.
        </Text>

        <Text style={styles.lede}>
          Keepr Companion collects your text messages and contacts from this
          phone and sends them to the Keepr app on your own computer, so your
          client conversations become part of your transaction records —
          including in the background, when this app is closed.
        </Text>

        {/* What is collected */}
        <View style={styles.card}>
          <Text style={styles.cardHeading}>What this app reads</Text>
          <Text style={styles.bullet}>
            <Text style={styles.bulletLead}>Your text messages. </Text>
            The message text, who it was to or from, and when it was sent — from
            the messages you have received and the ones you have sent.
          </Text>
          <Text style={styles.bullet}>
            <Text style={styles.bulletLead}>Your contacts. </Text>
            Names and phone numbers from this phone&apos;s address book, so
            Keepr can tell you who each message is from instead of showing a
            bare number.
          </Text>
        </View>

        {/* Where it goes — the transmission disclosure */}
        <View style={[styles.card, styles.cardAccent]}>
          <Text style={styles.cardHeading}>Where it goes</Text>
          <Text style={styles.bullet}>
            It is encrypted on this phone and sent over your local network to
            the Keepr app on the computer you pair with.
          </Text>
          <Text style={styles.bullet}>
            It is <Text style={styles.bulletLead}>not</Text> sent to Keepr&apos;s
            servers. Your messages and contacts are stored on your computer, not
            in the cloud.
          </Text>
          <Text style={styles.bullet}>
            This runs <Text style={styles.bulletLead}>in the background</Text>,
            on a schedule, including when you are not using the app — that is how
            new messages get captured without you opening it.
          </Text>
        </View>

        {/* What it never does */}
        <View style={styles.card}>
          <Text style={styles.cardHeading}>What this app never does</Text>
          <Text style={styles.bullet}>
            It never sends, forwards or replies to a text message.
          </Text>
          <Text style={styles.bullet}>
            It does not read picture or group messages (MMS).
          </Text>
          <Text style={styles.bullet}>
            It does not sell or share your messages or contacts with anyone.
          </Text>
        </View>

        <Text style={styles.consentLine}>
          By tapping Agree and Continue you consent to Keepr Companion
          collecting the text messages and contacts on this phone and
          transmitting them to your own computer, as described above.
        </Text>

        <Button
          title="Agree and Continue"
          onPress={() => {
            void handleAgree();
          }}
          loading={saving}
          disabled={saving}
          size="lg"
          fullWidth
        />

        <Text style={styles.footnote}>
          You choose which computer to pair with in the next steps, and you can
          turn syncing off at any time in Settings.
        </Text>

        {/* BACKLOG-3027: below the consent action on purpose — it must not
            compete with the disclosure Play requires, only offer a way to SEE
            what is being consented to before consenting. */}
        <DemoPreview />

        <OnboardingSignOutLink />
      </ScrollView>
    </View>
  );
}

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
    padding: spacing[6],
    paddingBottom: spacing[12],
  },
  eyebrow: {
    ...textStyles.caption,
    color: colors.gray[400],
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontWeight: '700',
    marginBottom: spacing[1],
  },
  title: {
    ...textStyles.heading,
    color: colors.gray[900],
    marginBottom: spacing[3],
  },
  lede: {
    ...textStyles.body,
    color: colors.gray[600],
    marginBottom: spacing[6],
  },
  card: {
    width: '100%',
    backgroundColor: colors.white,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.gray[200],
    padding: spacing[4],
    marginBottom: spacing[4],
  },
  cardAccent: {
    borderColor: colors.primary[200],
    backgroundColor: colors.primary[50],
  },
  cardHeading: {
    ...textStyles.label,
    color: colors.gray[900],
    marginBottom: spacing[2],
  },
  bullet: {
    ...textStyles.body,
    color: colors.gray[700],
    marginBottom: spacing[2],
  },
  bulletLead: {
    fontWeight: '700',
    color: colors.gray[900],
  },
  consentLine: {
    ...textStyles.caption,
    color: colors.gray[600],
    marginBottom: spacing[4],
  },
  footnote: {
    ...textStyles.caption,
    color: colors.gray[500],
    textAlign: 'center',
    marginTop: spacing[3],
  },
});
