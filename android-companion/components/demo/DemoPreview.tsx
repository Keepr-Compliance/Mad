/**
 * In-app preview of what Keepr Companion does — BACKLOG-3027.
 *
 * ## The problem this solves
 *
 * A Google Play reviewer installs this app with only a phone. They are asked for
 * `READ_SMS` — permitted here only by the "Cross-device synchronization or
 * transfer of SMS or calls" exception, which is subject to Play review and
 * requires the core functionality to be prominently documented — and then, on
 * every forward path, they need a Keepr desktop on the same local network to see
 * anything at all. BACKLOG-2956 removed the hard wall (pair-device grew a
 * "Continue without a computer" escape), but what it escapes TO is `home.tsx`'s
 * "Not Paired" empty state, which shows a reviewer nothing about why the
 * permission exists. This component is the answer to the reviewer's question.
 *
 * ## Four properties it must have, and how each is kept
 *
 * 1. **It reads nothing real.** No SMS query, no contacts read, no socket, no
 *    storage. The data is `sampleConversations.ts`, a module that imports
 *    nothing; this file imports that fixture, React Native and the theme, and
 *    nothing else. The "sync" is `setTimeout` and component state. There is
 *    nothing here to grant a permission for, so a reviewer can reach it before
 *    granting anything — which is the whole point of hosting it on `login` and
 *    on `permissions`, not only on the pairing screen the item named.
 *
 * 2. **It is unmistakably a demo.** A reviewer who concluded this showed real
 *    messages would be a worse outcome than the wall it replaces. So it says so
 *    in a sticky bar that is on screen at every scroll position, in the opening
 *    paragraph, on the transfer card, and in the closing line.
 *
 * 3. **It shows the transfer, not just the data.** The staged "Send to my
 *    computer" walk-through — read on the phone, encrypt on the phone, send over
 *    your own Wi-Fi, file it against a transaction — is the cross-device
 *    synchronization the permission is actually granted for. A message list on
 *    its own would show a reviewer the sensitive data and not the justification.
 *
 * 4. **It cannot affect a real user.** It is a `Modal`, not a route: it has no
 *    path, so nothing can deep-link into it and no navigator can land on it. It
 *    is mounted closed and opens only from an explicit tap. It writes no
 *    AsyncStorage, so it cannot disturb the pairing record, the device identity
 *    or the sync cursor — the three pieces of state a stray write would corrupt.
 *
 * ## The one factual claim in here, and where it was checked
 *
 * The "In the real app" card says "Nothing is read until you allow it and pair
 * a computer". Both halves were traced before they were written, because this
 * is Play-facing copy and the disclosure screen (BACKLOG-2956) set the
 * precedent that every claim on it cites its source:
 *
 *   - "until you allow it" — the runtime permission gate in
 *     `services/permissions.ts`, plus the consent guard in
 *     `app/onboarding/permissions.tsx`.
 *   - "and pair a computer" — `runSyncCycle` in `services/backgroundSync.ts`
 *     returns at its `loadPairingInfo()` gate (`stoppedAt: "pairing"`) BEFORE
 *     the SMS read and BEFORE the contacts read further down the same function.
 *     Those two call sites are the ONLY callers of `readSmsMessages` and
 *     `readContacts` outside tests, and `getUnreadSmsCount` has no callers at
 *     all — so an unpaired phone, including one that took BACKLOG-2956's
 *     "Continue without a computer", reads nothing even with permission granted.
 *
 * If a future change adds a reader call that is NOT behind that pairing gate,
 * this sentence becomes false and must be split into two independently true
 * clauses ("nothing is read until you allow it, and nothing leaves this phone
 * until you pair a computer" — the second half is true by construction, since
 * `syncService` cannot address a desktop without a pairing record).
 *
 * ## The claim this screen deliberately does NOT make
 *
 * An earlier draft said "They are not sent to Keepr's servers", and the sync
 * step said "never to Keepr's servers". Both were FALSE and both are gone.
 * Submitting a transaction uploads message bodies to Supabase
 * (`submissionService.ts` sets `body_text` and inserts `submission_messages`);
 * measured against live data there are 2,483 message bodies up there, 221 of
 * them SMS.
 *
 * They were not replaced with a more accurate version of the same promise, and
 * a future edit should not add one. Founder's call, 2026-09-01: **the phone does
 * not control the desktop, so the phone does not get to promise anything on the
 * desktop's behalf.** This app's job is to say what THIS PHONE does — it reads
 * your texts and sends them to the computer you pair with. What that computer
 * then does with them (store, export, submit to a brokerage) belongs to the
 * desktop's own disclosure and to the privacy policy, not to a screen here.
 *
 * That is also the more defensible position for review: a reviewer who exercises
 * the desktop cannot falsify a sentence that was only ever about the phone.
 *
 * ## Why the card says "background syncing", not "syncing"
 *
 * The Settings control is labelled "Background Sync" and it gates exactly that.
 * Traced rather than assumed:
 *
 *   - `getBackgroundSyncEnabled()` has ONE service-side reader,
 *     `backgroundSync.startBackgroundSync()`, which registers/unregisters the
 *     expo-background-fetch task. Nothing else in `services/` consults it;
 *     home and settings read it only to render state.
 *   - The sync itself is `performSync` -> `runOnce` -> `runSyncUnderLock` ->
 *     `runSyncCycle`, and NO step in that chain checks the flag. Its only gate
 *     is `loadPairingInfo()`.
 *   - `appStateCatchup.runCatchupSync()` calls `performSync()` directly, and
 *     `registerAppStateCatchup()` is armed on session + onboarded only.
 *     `backgroundSync.ts` says so in its own words: "an immediate sync every
 *     time the user foregrounds the app, so a killed background task self-heals
 *     on next open."
 *
 * So with the toggle OFF, opening the app still reads texts and sends them. An
 * unqualified "you can turn syncing off" would be false for a user doing nothing
 * unusual — a worse failure than the servers claim above, which needed a
 * deliberate submit. One word fixes it, and it also settles a contradiction with
 * the result box ("this repeats in the background"), which describes the thing
 * the toggle really does control.
 *
 * ## Two desktop-side claims that are deliberately KEPT
 *
 * `DEMO_SYNC_STEPS[3]` ("Filed on your computer / Attached to 148 Alder Court")
 * and the result box ("where they can be reviewed and exported") also describe
 * the desktop. They are the same SHAPE as the promise deleted above and they are
 * staying, by decision, not by oversight.
 *
 * The difference is register. Those two sit inside labelled sample fiction, next
 * to an invented desktop at an invented address, describing what happens to
 * invented messages — a reviewer reads them as "here is what the product is
 * for". The deleted sentence sat under a heading that said "In the real app",
 * which is the app speaking about the user's own data. Removing these would also
 * gut the thing the preview exists to show: that texts become part of a
 * transaction record, which is the READ_SMS justification itself.
 *
 * Do not "finish the job" by deleting them, and do not read them as promises
 * that were checked. They are illustration.
 *
 * If you are here because `app/onboarding/disclosure.tsx` still carries the
 * stronger version of this claim — yes, and it is knowingly out of scope. That
 * screen is the shipped prominent disclosure; its rewrite is BACKLOG-3045.
 *
 * `DemoPreview` is the whole thing (link + modal) so a host screen adds one
 * line. `DemoPreviewModal` is exported separately so its content can be tested
 * without going through a host.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  DEMO_CONVERSATIONS,
  DEMO_DESKTOP_ADDRESS,
  DEMO_DESKTOP_NAME,
  DEMO_MESSAGE_COUNT,
  DEMO_SYNC_STEPS,
  DEMO_TRANSACTION_DETAIL,
  DEMO_TRANSACTION_LABEL,
  type DemoConversation,
} from './sampleConversations';
import { colors } from '../../theme/colors';
import { textStyles } from '../../theme/typography';
import { borderRadius, spacing } from '../../theme/spacing';

/** The one label a reviewer must not be able to miss. */
export const DEMO_BANNER_TEXT = 'Sample data — not the messages on this phone';

/** The link text hosts show. Kept here so all five hosts cannot drift apart. */
export const DEMO_LINK_TEXT = 'See how Keepr works (sample data)';

/** How long each staged transfer step takes. Timers only — nothing is sent. */
const STEP_DELAY_MS = 700;

// ============================================
// The modal
// ============================================

interface DemoPreviewModalProps {
  visible: boolean;
  onClose: () => void;
}

export function DemoPreviewModal({
  visible,
  onClose,
}: DemoPreviewModalProps): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string>(
    DEMO_CONVERSATIONS[0].id,
  );
  /** How many transfer steps have "completed". 0 = not started. */
  const [stepsDone, setStepsDone] = useState(0);
  const [transferring, setTransferring] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback((): void => {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current = [];
  }, []);

  // A modal that is dismissed mid-transfer must not leave timers running that
  // call setState on an unmounted tree.
  useEffect(() => clearTimers, [clearTimers]);

  const selected: DemoConversation =
    DEMO_CONVERSATIONS.find((c) => c.id === selectedId) ?? DEMO_CONVERSATIONS[0];

  const handleTransfer = useCallback((): void => {
    if (transferring) return;
    clearTimers();
    setTransferring(true);
    setStepsDone(0);
    DEMO_SYNC_STEPS.forEach((_step, index) => {
      timersRef.current.push(
        setTimeout(
          () => {
            setStepsDone(index + 1);
            if (index === DEMO_SYNC_STEPS.length - 1) setTransferring(false);
          },
          STEP_DELAY_MS * (index + 1),
        ),
      );
    });
  }, [transferring, clearTimers]);

  const handleClose = useCallback((): void => {
    clearTimers();
    setTransferring(false);
    setStepsDone(0);
    onClose();
  }, [clearTimers, onClose]);

  const complete = stepsDone >= DEMO_SYNC_STEPS.length;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={handleClose}
      transparent={false}
    >
      <View style={styles.modalRoot}>
        {/* Sticky demo bar. Deliberately outside the ScrollView so it is on
            screen at every scroll position — a label a reviewer can scroll past
            is a label that can be missed. */}
        <View style={styles.demoBar}>
          <Text style={styles.demoBarText}>{DEMO_BANNER_TEXT}</Text>
          <TouchableOpacity
            onPress={handleClose}
            accessibilityRole="button"
            accessibilityLabel="Close the sample"
            style={styles.closeButton}
          >
            <Text style={styles.closeButtonText}>Close</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>What Keepr Companion does</Text>
          <Text style={styles.lede}>
            Everything on this screen is made up, so you can see how the app
            works without pairing a computer and without giving it access to
            anything. These are example conversations for an example home sale —
            no message here came from this phone.
          </Text>

          {/* ---- The threads ---- */}
          <Text style={styles.sectionHeading}>
            Example texts about a home sale
          </Text>
          <Text style={styles.sectionNote}>
            A real estate agent&apos;s deal lives in their texts. Tap a name to
            read the conversation.
          </Text>

          <View style={styles.tabRow}>
            {DEMO_CONVERSATIONS.map((conversation) => {
              const active = conversation.id === selected.id;
              return (
                <TouchableOpacity
                  key={conversation.id}
                  onPress={() => setSelectedId(conversation.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={[styles.tab, active && styles.tabActive]}
                >
                  <Text
                    style={[styles.tabName, active && styles.tabNameActive]}
                  >
                    {conversation.name}
                  </Text>
                  <Text style={styles.tabRole}>{conversation.role}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={styles.thread}>
            <View style={styles.threadHeader}>
              <Text style={styles.threadName}>{selected.name}</Text>
              <Text style={styles.threadPhone}>{selected.displayPhone}</Text>
            </View>
            {selected.messages.map((message) => {
              const outbound = message.direction === 'outbound';
              return (
                <View
                  key={message.id}
                  style={[
                    styles.bubbleRow,
                    outbound ? styles.bubbleRowOut : styles.bubbleRowIn,
                  ]}
                >
                  <View
                    style={[
                      styles.bubble,
                      outbound ? styles.bubbleOut : styles.bubbleIn,
                    ]}
                  >
                    <Text
                      style={[
                        styles.bubbleText,
                        outbound && styles.bubbleTextOut,
                      ]}
                    >
                      {message.body}
                    </Text>
                    <Text
                      style={[
                        styles.bubbleMeta,
                        outbound && styles.bubbleMetaOut,
                      ]}
                    >
                      {message.day} · {message.time}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>

          {/* ---- The transfer: the thing READ_SMS is actually for ---- */}
          <Text style={styles.sectionHeading}>
            How they reach your computer
          </Text>
          <Text style={styles.sectionNote}>
            Keepr Companion&apos;s whole job is to move texts from this phone to
            the Keepr app on your own computer, so they become part of the record
            for a deal. Run the example below to see each step.
          </Text>

          <View style={styles.transferCard}>
            <View style={styles.transferHeader}>
              <Text style={styles.transferTitle}>{DEMO_DESKTOP_NAME}</Text>
              <Text style={styles.transferTag}>Example</Text>
            </View>
            <Text style={styles.transferAddress}>
              {DEMO_DESKTOP_ADDRESS}
            </Text>

            {DEMO_SYNC_STEPS.map((step, index) => {
              const done = index < stepsDone;
              const current = index === stepsDone && transferring;
              return (
                <View key={step.id} style={styles.stepRow}>
                  <Text
                    style={[
                      styles.stepMark,
                      done && styles.stepMarkDone,
                      current && styles.stepMarkCurrent,
                    ]}
                  >
                    {done ? '✓' : current ? '·' : ' '}
                  </Text>
                  <View style={styles.stepBody}>
                    <Text
                      style={[styles.stepLabel, done && styles.stepLabelDone]}
                    >
                      {step.label}
                    </Text>
                    <Text style={styles.stepDetail}>{step.detail}</Text>
                  </View>
                </View>
              );
            })}

            {complete ? (
              <View style={styles.resultBox}>
                <Text style={styles.resultTitle}>
                  {DEMO_MESSAGE_COUNT} messages delivered
                </Text>
                <Text style={styles.resultBody}>
                  They are now on {DEMO_DESKTOP_NAME}, filed against{' '}
                  {DEMO_TRANSACTION_LABEL} ({DEMO_TRANSACTION_DETAIL}), where
                  they can be reviewed and exported as part of the transaction
                  record. In the real app this repeats in the background, so a
                  text sent this afternoon is on the computer tonight.
                </Text>
              </View>
            ) : (
              <TouchableOpacity
                onPress={handleTransfer}
                disabled={transferring}
                accessibilityRole="button"
                style={[
                  styles.transferButton,
                  transferring && styles.transferButtonBusy,
                ]}
              >
                <Text style={styles.transferButtonText}>
                  {transferring ? 'Sending…' : 'Send to my computer'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* ---- What is real, once they do pair ---- */}
          <View style={styles.factsCard}>
            <Text style={styles.factsHeading}>In the real app</Text>
            <Text style={styles.fact}>
              Your texts go from this phone to the Keepr app on the computer you
              pair with, over your own Wi-Fi.
            </Text>
            <Text style={styles.fact}>
              Nothing is read until you allow it and pair a computer, and you
              can turn background syncing off at any time in Settings.
            </Text>
            <Text style={styles.fact}>
              Keepr Companion never sends, forwards or replies to a text message.
            </Text>
          </View>

          <Text style={styles.footer}>
            {DEMO_BANNER_TEXT}. Nothing on this screen was read from this phone,
            and nothing was sent anywhere.
          </Text>

          <TouchableOpacity
            onPress={handleClose}
            accessibilityRole="button"
            style={styles.footerButton}
          >
            <Text style={styles.footerButtonText}>Close the sample</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ============================================
// The host-facing link
// ============================================

interface DemoPreviewProps {
  /** Optional override so a cramped host can shorten the link. */
  label?: string;
  /**
   * Optional link colour.
   *
   * Defaults to the app's primary blue, which is what every onboarding screen
   * and the home screen already use. The LOGIN screen is the exception: it is
   * matched pixel-for-pixel to the broker portal and has its own palette
   * (`colors.login.*`, BACKLOG-2253, marked "do NOT substitute these values").
   * Dropping a Tailwind-blue link onto that card would read as foreign, so
   * login passes its own indigo instead of this default.
   */
  color?: string;
}

/**
 * Drop `<DemoPreview />` into any screen. It renders a link and owns the modal.
 *
 * Mounted CLOSED: `visible` starts false and only the tap sets it true, which is
 * what keeps a normal user — one who signs in and pairs — from ever seeing it.
 */
export default function DemoPreview({
  label = DEMO_LINK_TEXT,
  color,
}: DemoPreviewProps): React.JSX.Element {
  const [visible, setVisible] = useState(false);

  return (
    <>
      <TouchableOpacity
        onPress={() => setVisible(true)}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={styles.link}
      >
        <Text style={[styles.linkText, color != null && { color }]}>
          {label}
        </Text>
      </TouchableOpacity>
      <DemoPreviewModal
        visible={visible}
        onClose={() => setVisible(false)}
      />
    </>
  );
}

// ============================================
// Styles
// ============================================

const styles = StyleSheet.create({
  link: {
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[2],
    alignItems: 'center',
  },
  linkText: {
    ...textStyles.label,
    color: colors.primary[600],
    textDecorationLine: 'underline',
    textAlign: 'center',
  },

  modalRoot: {
    flex: 1,
    backgroundColor: colors.gray[50],
  },

  // The sticky "this is a demo" bar.
  demoBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.warning[50],
    borderBottomWidth: 1,
    borderBottomColor: colors.warning[500],
    paddingTop: spacing[12],
    paddingBottom: spacing[3],
    paddingHorizontal: spacing[4],
  },
  demoBarText: {
    ...textStyles.label,
    color: colors.warning[600],
    flex: 1,
    marginRight: spacing[3],
  },
  closeButton: {
    paddingVertical: spacing[1],
    paddingHorizontal: spacing[3],
    borderRadius: borderRadius.full,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.warning[500],
  },
  closeButtonText: {
    ...textStyles.caption,
    color: colors.warning[600],
    fontWeight: '700',
  },

  content: {
    padding: spacing[5],
    paddingBottom: spacing[16],
  },
  title: {
    ...textStyles.heading,
    color: colors.gray[900],
    marginBottom: spacing[2],
  },
  lede: {
    ...textStyles.body,
    color: colors.gray[600],
    marginBottom: spacing[6],
  },
  sectionHeading: {
    ...textStyles.subheading,
    color: colors.gray[900],
    marginTop: spacing[4],
    marginBottom: spacing[1],
  },
  sectionNote: {
    ...textStyles.caption,
    color: colors.gray[500],
    marginBottom: spacing[3],
  },

  // Conversation picker
  tabRow: {
    flexDirection: 'row',
    marginBottom: spacing[3],
  },
  tab: {
    flex: 1,
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[1],
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.gray[200],
    backgroundColor: colors.white,
    marginRight: spacing[2],
    alignItems: 'center',
  },
  tabActive: {
    borderColor: colors.primary[500],
    backgroundColor: colors.primary[50],
  },
  tabName: {
    ...textStyles.caption,
    color: colors.gray[700],
    fontWeight: '700',
    textAlign: 'center',
  },
  tabNameActive: {
    color: colors.primary[700],
  },
  tabRole: {
    ...textStyles.caption,
    color: colors.gray[400],
    fontSize: 11,
    textAlign: 'center',
  },

  // Thread
  thread: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.gray[200],
    padding: spacing[3],
    marginBottom: spacing[6],
  },
  threadHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: spacing[2],
    marginBottom: spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: colors.gray[100],
  },
  threadName: {
    ...textStyles.label,
    color: colors.gray[900],
  },
  threadPhone: {
    ...textStyles.caption,
    color: colors.gray[400],
  },
  bubbleRow: {
    flexDirection: 'row',
    marginBottom: spacing[2],
  },
  bubbleRowIn: {
    justifyContent: 'flex-start',
  },
  bubbleRowOut: {
    justifyContent: 'flex-end',
  },
  bubble: {
    maxWidth: '84%',
    borderRadius: borderRadius.lg,
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
  },
  bubbleIn: {
    backgroundColor: colors.gray[100],
  },
  bubbleOut: {
    backgroundColor: colors.primary[500],
  },
  bubbleText: {
    ...textStyles.body,
    color: colors.gray[900],
  },
  bubbleTextOut: {
    color: colors.white,
  },
  bubbleMeta: {
    ...textStyles.caption,
    fontSize: 11,
    color: colors.gray[400],
    marginTop: 2,
  },
  bubbleMetaOut: {
    color: colors.primary[100],
  },

  // Transfer
  transferCard: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.gray[200],
    padding: spacing[4],
    marginBottom: spacing[6],
  },
  transferHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  transferTitle: {
    ...textStyles.label,
    color: colors.gray[900],
  },
  transferTag: {
    ...textStyles.caption,
    fontSize: 11,
    fontWeight: '700',
    color: colors.warning[600],
    backgroundColor: colors.warning[50],
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    overflow: 'hidden',
  },
  transferAddress: {
    ...textStyles.caption,
    color: colors.gray[400],
    marginBottom: spacing[3],
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing[1.5],
  },
  stepMark: {
    width: 20,
    ...textStyles.label,
    color: colors.gray[300],
  },
  stepMarkDone: {
    color: colors.success[600],
  },
  stepMarkCurrent: {
    color: colors.primary[600],
  },
  stepBody: {
    flex: 1,
  },
  stepLabel: {
    ...textStyles.body,
    color: colors.gray[400],
  },
  stepLabelDone: {
    color: colors.gray[900],
  },
  stepDetail: {
    ...textStyles.caption,
    color: colors.gray[400],
  },
  transferButton: {
    marginTop: spacing[3],
    backgroundColor: colors.primary[500],
    borderRadius: borderRadius.md,
    paddingVertical: spacing[3],
    alignItems: 'center',
  },
  transferButtonBusy: {
    backgroundColor: colors.primary[300],
  },
  transferButtonText: {
    ...textStyles.button,
    color: colors.white,
  },
  resultBox: {
    marginTop: spacing[3],
    backgroundColor: colors.success[50],
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.success[600],
    padding: spacing[3],
  },
  resultTitle: {
    ...textStyles.label,
    color: colors.success[600],
    marginBottom: spacing[1],
  },
  resultBody: {
    ...textStyles.caption,
    color: colors.gray[700],
  },

  // Facts
  factsCard: {
    backgroundColor: colors.primary[50],
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.primary[200],
    padding: spacing[4],
    marginBottom: spacing[5],
  },
  factsHeading: {
    ...textStyles.label,
    color: colors.gray[900],
    marginBottom: spacing[2],
  },
  fact: {
    ...textStyles.caption,
    color: colors.gray[700],
    marginBottom: spacing[2],
  },

  footer: {
    ...textStyles.caption,
    color: colors.gray[500],
    textAlign: 'center',
    marginBottom: spacing[4],
  },
  footerButton: {
    borderWidth: 1,
    borderColor: colors.gray[300],
    borderRadius: borderRadius.md,
    paddingVertical: spacing[3],
    alignItems: 'center',
    backgroundColor: colors.white,
  },
  footerButtonText: {
    ...textStyles.button,
    color: colors.gray[700],
  },
});
