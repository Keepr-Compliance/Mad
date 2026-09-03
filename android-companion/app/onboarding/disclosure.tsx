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
 * — name the worry, answer it plainly — but NOT its text. That sheet's "nothing
 * is uploaded, ever" is false on the desktop too (submitting a transaction
 * uploads message bodies); it is filed as BACKLOG-3082 and must not be borrowed
 * here.
 *
 * ## The scope rule this screen keeps — BACKLOG-3045
 *
 * Founder's call, 2026-09-01, already recorded in `components/demo/DemoPreview.tsx`:
 * **the phone does not control the desktop, so the phone does not get to promise
 * anything on the desktop's behalf.** Every claim here is about what THIS PHONE
 * does — it reads your texts and sends them to the computer you pair with. What
 * that computer then does with them (store, export, submit to a brokerage)
 * belongs to the desktop's own disclosure, not to this screen. A reviewer who
 * exercises the desktop cannot falsify a sentence that was only ever about the
 * phone.
 *
 * Three claims were retired under that rule and must not come back in any form,
 * including a narrower or more accurate version of the same promise:
 *
 *   1. Title: "Your texts go to your own computer — and nowhere else."
 *   2. "It is not sent to Keepr's servers. Your messages and contacts are stored
 *      on your computer, not in the cloud."
 *   3. "you can turn syncing off at any time in Settings"
 *
 * (1) and (2) are promises about a destination this app does not control: the
 * desktop uploads message bodies to Supabase when the user submits a transaction
 * (`electron/services/submissionService.ts` sets `body_text` at `:1216` and
 * inserts `submission_messages` at `:1300`). (3) was simply untrue — see below.
 * `app/onboarding/__tests__/disclosure.test.tsx` pins all three as absent.
 *
 * ## A fourth defect, found in SR review — UNDER-statement (BACKLOG-3045)
 *
 * The contacts bullet said "Names and phone numbers from this phone's address
 * book". `services/contactReader.ts:40-46` requests SIX fields — FirstName,
 * LastName, PhoneNumbers, **Emails, Company, JobTitle** — `mapToSyncContact`
 * (`:159-183`) maps `emails`, `company` and `title` into `SyncContact`
 * (`types/contacts.ts`), and `syncService.sendContacts` puts the whole
 * `SyncContact[]` on the wire with NO field filter (`:355`). The screen named
 * two of the six.
 *
 * A disclosure that under-reports collection fails Play the same way a false one
 * does — it is just the quieter direction, and it is exactly what a Data Safety
 * mismatch looks like to a reviewer. Email address is its own Data Safety type.
 * The replacement wording is the founder's, used verbatim, and BACKLOG-2966's
 * input list was corrected in the same pass.
 *
 * The lesson worth keeping: this bullet was not rewritten in the first pass
 * because it was INHERITED and assumed true. Every claim on this screen is
 * load-bearing whether or not this task touched it.
 *
 * Every factual claim below was verified against the code before it was written:
 *
 *  - "text messages (SMS)" and NOT MMS: `services/smsReader.ts` reads only
 *    `box: "inbox"` and `box: "sent"` through react-native-get-sms-android, and
 *    the repo contains no MMS reader at all. That absence is the whole argument:
 *    on Android MMS is read through the SAME `READ_SMS` grant and the SMS
 *    content provider, so "we declare no MMS permission" would be support this
 *    claim does not have — there is no separate MMS permission to declare.
 *    Saying "MMS" here would overstate collection and contradict the Play Data
 *    Safety form.
 *    Re-verified on this branch 2026-09-02: still no MMS reader, still no MMS
 *    permission. NOTE for whoever lands BACKLOG-2973/2974/2975 (MMS ingestion,
 *    in flight on other branches) — "It does not read picture or group messages
 *    (MMS)" becomes FALSE the moment that work merges, and the disclosure and
 *    the Data Safety form (BACKLOG-2966) must change in the same PR.
 *  - "sent over your local network to the Keepr app on the computer you pair
 *    with": `services/syncService.ts` POSTs message and contact payloads to
 *    `http://<ip>:<port>/sync/messages` (`:260`) and `/sync/contacts` (`:355`)
 *    — the address scanned from the desktop's QR code. `/register` (`:455`) and
 *    `/ping` (`:536`) are that same desktop, NOT Supabase; an earlier version of
 *    this comment had `/register` as a Supabase call and was wrong.
 *  - "this app does not send your messages or contacts to Keepr": scoped to THIS
 *    APP, and to messages/contacts, on purpose. The phone DOES talk to Keepr's
 *    Supabase — three kinds of traffic, none of it message or contact content.
 *    An earlier version of this comment said "authentication only" and "no
 *    `.from()` call anywhere in `services/`". BOTH WERE FALSE; enumerated here
 *    so the next reader does not inherit them:
 *      1. Auth — `services/authService.ts`: `auth.signInWithOAuth`,
 *         `auth.signInWithOtp`, `auth.setSession`, `auth.getSession`,
 *         `auth.signOut`, plus the `mark_companion_session` RPC.
 *      2. A preferences READ — `services/syncWindow.ts:366` is the one
 *         `supabase.from()` in `services/`: `.from("user_preferences")
 *         .select("preferences").eq("user_id", userId)`, resolving the sync
 *         lookback window. Reachable, not dead: imported by
 *         `backgroundSync.ts:28` and `deviceIdentity.ts:73`. It reads the
 *         signed-in user's own row and sends no message or contact.
 *      3. In-app support tickets — `components/ui/HelpModal.tsx` (outside
 *         `services/`, which is why a `services/`-scoped grep missed it):
 *         `supabase.rpc('support_create_ticket', …)` at `:281` sends subject,
 *         description, requester name and email, and `uploadDiagnostics`
 *         (`:188-207`) puts a `diagnostics.json` in the `support-attachments`
 *         bucket with app version, device model, OS version, paired flag,
 *         paired device name, last sync time and permission states. User-
 *         initiated, and it carries no message or contact content.
 *    So the USER-FACING sentence stands — none of the three sends a message
 *    body, phone number or contact record. The screen still does not say "not
 *    sent to Keepr's servers" unscoped, because the desktop uploads bodies on
 *    submission (see the scope rule above). Do not widen this clause back out,
 *    and do not re-narrow it to "authentication only".
 *    BACKLOG-2966 must declare 2 and 3; they are collected data under Play's
 *    definitions even though they are not messages.
 *  - "encrypted before it leaves this phone": `syncService` derives a transport
 *    key via `deriveTransportKeys(secret)` and sends `encrypt(...)` envelopes.
 *  - "in the background": `services/backgroundSync.ts` registers an
 *    expo-background-fetch task that syncs while the app is closed.
 *  - "Keepr Companion never sends text messages": there is no send path in the
 *    codebase; SEND_SMS is not among the declared permissions.
 *  - "turn off scheduled background syncing … Unpair Device stops syncing
 *    altogether" — BACKLOG-3045, traced rather than assumed, and the reason the
 *    old unqualified "turn syncing off" was FALSE:
 *      · `getBackgroundSyncEnabled()` has exactly ONE service-side reader,
 *        `backgroundSync.startBackgroundSync()` (`:1318-1327`), which only
 *        registers or unregisters the expo-background-fetch task. `performSync`
 *        -> `runOnce` -> `runSyncUnderLock` -> `runSyncCycle` never consults it;
 *        its only gate is `loadPairingInfo()`.
 *      · `getSyncInterval()` has the SAME single-reader shape — its only non-UI
 *        reader is `backgroundSync.ts:1321`, also inside `startBackgroundSync()`
 *        — so setting the interval to "Manual only" does not stop the foreground
 *        catch-up either.
 *      · `appStateCatchup.runCatchupSync()` calls `performSync()` directly on
 *        every background -> active transition, armed in `app/_layout.tsx` on
 *        session + onboarded.
 *      · NEITHER Settings sync control stops the app syncing. With Background
 *        Sync OFF, or the interval on "Manual only", or both, opening the app
 *        still reads texts and sends them. Both controls gate the SCHEDULE,
 *        which is what their labels say, and the copy now says so too. That a
 *        control a user reads as "off" does not exist short of unpairing is a
 *        PRODUCT defect, not something copy can fix: filed as BACKLOG-3084.
 *      · Unpair genuinely stops everything: `app/(main)/settings.tsx` removes
 *        `@keepr/pairing` (`:222`) after `stopBackgroundSync()` +
 *        `resetAllSyncData()`, and `runSyncCycle` then returns at its
 *        `loadPairingInfo()` gate with `stoppedAt: "pairing"`
 *        (`backgroundSync.ts:720-730`) BEFORE the SMS read. `resetAllSyncData`
 *        (`smsQueueService.ts:678-689`) clears queue/cursor/stats/interval/flag
 *        and never rewrites the pairing key, so it cannot resurrect a pairing.
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
          Your texts go to the computer you pair with.
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
            Names, phone numbers, email addresses, and any company or job title
            saved with them — so Keepr can tell you who each message is from
            instead of showing a bare number.
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
            That computer is the{' '}
            <Text style={styles.bulletLead}>only</Text> place this app sends
            them. Signing in goes through your Keepr account, but your messages
            and contacts do not.
          </Text>
          <Text style={styles.bullet}>
            What happens to them once they reach your computer — filing them
            against a transaction, exporting them, or submitting a transaction to
            your brokerage — is done by the Keepr app there, not by this app.
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
          You choose which computer to pair with in the next steps. In Settings,
          Background Sync and Sync Interval control the scheduled sync — Keepr
          Companion still syncs when you open it. Unpair Device stops syncing
          altogether.
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
