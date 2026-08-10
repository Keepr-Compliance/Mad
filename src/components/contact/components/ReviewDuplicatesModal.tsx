import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ResponsiveModal } from "../../common/ResponsiveModal";
import { ContactCompareSources } from "../../shared/ContactCompareSources";
import type {
  ContactReviewCluster,
  ContactReviewItem,
} from "@/types/contactProvenance";

/**
 * Review possible duplicates (BACKLOG-2410)
 *
 * ===========================================================================
 * WHAT THIS SCREEN IS
 * ===========================================================================
 * The linker refuses to guess. When a match would reassign an identifier
 * already held by someone else — or when a name is not unique enough to trust —
 * the link is withheld. Before this screen, "withheld" meant counted, logged,
 * and then nothing: the one band where a human adds information was discarded on
 * every sync.
 *
 * It is also the only place a WRONG merge can be reported. No product in the
 * public record proactively detects a false merge; the person harmed by it does.
 * That only works if we ask.
 *
 * ===========================================================================
 * THE TUCKED REVIEW CARD (BACKLOG-2502 R2)
 * ===========================================================================
 * Founder design, 7 Aug. The contact is a card; the question is an amber card
 * tucked directly under it, always open, no strip and no caret. THE REASON IS
 * THE HEADING — "Possible duplicate 1" named the row without telling anyone what
 * to weigh, and at five candidates it was five labels and no information.
 *
 * The list therefore groups by CONTACT, not by cluster. A cluster is a fact
 * about the linker's reasoning (which records competed for which name); a card
 * is a question put to a person, and the person is answering about one contact
 * at a time. Every candidate under a card answers INDEPENDENTLY — accepting the
 * Outlook record must not decide the Mac one, because with two records that
 * could both be him, they usually both are.
 *
 * ===========================================================================
 * WHY THE CORRECTION IS HERE AND NOT AT THE SOURCE
 * ===========================================================================
 * Four of the six prose blocks this card replaces are frozen into
 * `contact_link_proposals.evidence_json` when the proposal is written, and that
 * freeze is deliberate — `databaseService.ts:3150`: *"a verdict is a labelled
 * training/regression example and a label is only usable with the features AS
 * THEY WERE WHEN THE HUMAN SAW THEM"*. Recomputing a proposal's evidence would
 * relabel history, and rows already sitting in the founder's queue carry the old
 * strings either way. So every correction across 2502 lands in what this screen
 * RENDERS. NOTHING in this file may write back to an evidence producer.
 *
 * The frozen prose is not deleted: it is still reachable behind the compare
 * screen's "How we decided this", which is where a reader who wants the full
 * argument goes.
 *
 * ===========================================================================
 * AMBER, LIKE THE OTHER REVIEW SURFACE
 * ===========================================================================
 * Matches the palette and icon grammar of `NeedsReviewSection` (BACKLOG-2319) so
 * the two review surfaces read as one system — `text-gray-400` icon buttons
 * going green on accept and red on reject — while staying strictly separate:
 * that one is emails↔transaction, this one is contacts↔source records. Its
 * `needs-review-*` test ids are deliberately not reused.
 */

interface ReviewDuplicatesModalProps {
  userId: string;
  onClose: () => void;
  /** Fired after any answer, so the caller can refresh the count and the list. */
  onResolved?: () => void;
  /**
   * BACKLOG-2502 — `Confirm & edit`, which LEAVES this screen.
   *
   * Founder ruling, 2026-08-09: the two entry paths land in different places on
   * purpose. `Confirm` keeps the user in the queue (the answered row is gone
   * when the list reloads); `Confirm & edit` opens the contact card and its
   * form, *"exactly as confirm-and-edit does when a contact is opened from the
   * main list. Same destination, same behaviour — not a variant."*
   *
   * Which is why this is a callback and not a destination built here: the owner
   * of the card is `Contacts.tsx`, and it hands BOTH routes the same function,
   * so there is no second implementation to drift from the first.
   */
  onConfirmedAndEdit?: (contactId: string) => void;
}

/**
 * One contact card and everything still to answer about it.
 *
 * `exclusive` is carried down from the CLUSTER because grouping by contact would
 * otherwise drop it: a `record:` cluster is one source record several contacts
 * are competing for, so after regrouping its members land on different cards and
 * the fact that answering one settles the rest has nowhere else to live.
 */
interface ContactGroup {
  contactId: string;
  contactName: string;
  contactCompany: string | null;
  items: ContactReviewItem[];
  exclusive: boolean;
}

export function ReviewDuplicatesModal({
  userId,
  onClose,
  onResolved,
  onConfirmedAndEdit,
}: ReviewDuplicatesModalProps): React.ReactElement {
  const [clusters, setClusters] = useState<ContactReviewCluster[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * BACKLOG-2502 — the CONTACT whose compare screen is open, and which of its
   * candidates was opened.
   *
   * The card settles what it can; this is where the rest goes. The compare
   * screen is the SHIPPED component (BACKLOG-2471), given the candidates as more
   * columns — not a second detail view built here.
   *
   * R5: THE CANDIDATES ARE DERIVED FROM THE LIVE QUEUE, NOT FROZEN HERE. Holding
   * the `ContactReviewItem` objects in state would leave a candidate on screen
   * after it was answered — including the siblings an exclusive cluster answers
   * for us, which this component is not told about and must not guess. Keeping
   * only the two ids means every answer re-reads the queue and the screen shows
   * exactly what is still open, which is also what makes each answer visibly
   * independent of the others.
   *
   * `proposalId` is the candidate the user opened, and it selects the frozen
   * evidence behind "How we decided this". It is a preference, not a key: when
   * that candidate is the one answered, the first still-open candidate takes
   * over rather than the disclosure emptying.
   */
  const [comparing, setComparing] = useState<{
    contactId: string;
    proposalId: string;
  } | null>(null);
  /**
   * An OUTCOME to report, not a load failure — kept apart from `error` because
   * the answer succeeded and the list is about to reload, and `load()` clears
   * `error`. A message that a successful reload wipes is a message nobody reads.
   */
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await window.api.contacts.getReviewQueue(userId);
      if (result.success) {
        setClusters(result.clusters ?? []);
        setError(null);
      } else {
        setError(result.error ?? "Could not load the review list.");
        setClusters([]);
      }
    } catch {
      setError("Could not load the review list.");
      setClusters([]);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const answer = useCallback(
    async (item: ContactReviewItem, verdict: "same" | "different") => {
      setBusyId(item.proposalId);
      setNotice(null);
      try {
        // The two channels are called on separate branches rather than through
        // one ternary because their response shapes DIFFER: `contacts:reject-link`
        // returns `{ success, error }` and carries no `linked`. Collapsing them
        // into a union is what hides that difference.
        const result =
          verdict === "same"
            ? await window.api.contacts.confirmLink(userId, item.proposalId)
            : {
                ...(await window.api.contacts.rejectLink(
                  userId,
                  item.proposalId,
                )),
                linked: true,
              };
        if (!result.success) {
          setError(result.error ?? "That answer could not be saved.");
        } else if (verdict === "same" && result.linked === false) {
          /*
            BACKLOG-2502 — `ok: true` DOES NOT MEAN LINKED.

            `confirmProposal` returns `{ ok: true, linked: false }` when the
            record is already claimed by a DIFFERENT contact: it records the
            verdict, creates no link, and skips the sibling rejection. That is
            the merge guard working — re-pointing a claimed record is out of
            scope across this whole epic — but a caller that reads `success`
            alone tells the user two records were joined when they were not.

            The card still leaves the queue (the proposal IS resolved), so the
            list reloads; the sentence is what stops it being a silent no-op.
          */
          setNotice(
            "That record is already saved to a different contact, so it was not joined here.",
          );
          onResolved?.();
          await load();
        } else {
          setError(null);
          onResolved?.();
          // Reload rather than splice the answered row out locally: confirming
          // one option in a multiple-choice cluster also answers its siblings,
          // and only the main process knows which. A local splice would leave
          // questions on screen that have already been settled.
          await load();
        }
      } catch {
        setError("That answer could not be saved.");
      } finally {
        setBusyId(null);
      }
    },
    [userId, onResolved, load],
  );

  /**
   * Clusters in, contact cards out.
   *
   * Insertion order is preserved (a `Map` keyed by contact id) so the list does
   * not reshuffle under the user between reloads — the queue's own ORDER BY is
   * stable, and re-sorting here would undo it.
   */
  const groups = useMemo<ContactGroup[]>(() => {
    const byContact = new Map<string, ContactGroup>();
    for (const cluster of clusters ?? []) {
      const clusterIsExclusive = cluster.exclusive && cluster.items.length > 1;
      for (const item of cluster.items) {
        let group = byContact.get(item.contactId);
        if (!group) {
          group = {
            contactId: item.contactId,
            contactName: item.contactName,
            contactCompany: item.contactCompany ?? null,
            items: [],
            exclusive: false,
          };
          byContact.set(item.contactId, group);
        }
        group.items.push(item);
        group.exclusive = group.exclusive || clusterIsExclusive;
      }
    }
    return [...byContact.values()];
  }, [clusters]);

  const total = (clusters ?? []).reduce((sum, c) => sum + c.items.length, 0);

  /*
    THE COMPARE SCREEN'S CANDIDATES, READ OFF THE LIVE QUEUE (R5).

    Derived, never stored. Answering a candidate reloads the queue, this group
    loses that item, and the compare screen re-renders with the rest — which is
    what makes "answering one leaves the others pending" fall out of the existing
    answer path instead of needing a rule of its own. It is also the only way the
    exclusive-cluster case can be right: confirming a `record:` candidate rejects
    its siblings in the main process, and a frozen list here would keep drawing
    questions that have already been settled.

    Group gone -> every question about that contact is answered, and the compare
    screen has nothing left to show.
  */
  const compareGroup = comparing
    ? (groups.find((g) => g.contactId === comparing.contactId) ?? null)
    : null;
  const openedItem = compareGroup
    ? (compareGroup.items.find((i) => i.proposalId === comparing?.proposalId) ??
      compareGroup.items[0])
    : null;

  useEffect(() => {
    // The id outlived what it pointed at. Cleared so the LIST's `×` — gated on
    // this screen not being open — comes back; leaving it set would take the
    // list's only way out with it.
    if (comparing && clusters !== null && !compareGroup) setComparing(null);
  }, [comparing, clusters, compareGroup]);

  return (
    <>
      <ResponsiveModal
        onClose={onClose}
        panelClassName="max-w-2xl max-h-[80vh]"
        testId="review-duplicates-modal"
      >
        {/*
        BACKLOG-2502 — A LIFO STACK OF LAYERS, AND THE `×` POPS ONE OF THEM.

        Founder model, 2026-08-09, in his own words: *"just like the texts
        preview on transaction details"*. Last in, first out. The compare screen
        renders INSIDE this modal, so these two are a stack of two, and the `×`
        belonging to the TOP layer is the one that acts:

          list only         -> this `×` closes the list
          compare, over it  -> COMPARE's `×` closes compare, and the list is
                               still underneath, exactly as the user left it

        Which is why this one is gated on `!comparing`: it is the LIST's control,
        not the modal's. Rendering it under an open compare screen would put two
        dismissals on screen meaning two different things — the confusion that
        made him ask for one in the first place. There is still exactly one `×`
        at any moment; it just belongs to whichever layer is on top.

        `useContactCommViewers` already makes this promise on the transaction
        card: the viewer mounted over the card owns its own close, and closing it
        returns the card rather than dismissing everything. This is that rule,
        not a second mechanism — the layer that renders the control is the layer
        the control pops.

        What is NOT here any more: the `Done` footer (it held nothing but `Done`;
        the decision buttons live in the compare screen's own footer and in each
        candidate row, and none of them moved) and `← Back to the list`, whose
        behaviour this rule restores without needing a second control.
      */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-gray-900">
              Possible duplicates
            </h2>
            {/*
            BACKLOG-2502 — THE PROMISE IS MADE ONCE, HERE.

            The founder got it per candidate: a frozen-audit sentence repeated
            verbatim on every row, plus a "nothing has been linked" sentence the
            header already made. At five candidates that is ten sentences saying
            what these two say. Both still exist, frozen in each proposal's
            evidence, and both are reachable from the compare screen's
            "How we decided this" — they are no longer the default view.
          */}
            <p
              className="text-sm text-gray-600 mt-1"
              data-testid="review-duplicates-subtext"
            >
              These were <span className="font-semibold">not</span> linked
              automatically because we could not tell. Nothing changes until you
              answer.
            </p>
          </div>
          {!compareGroup && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close possible duplicates"
              data-testid="review-duplicates-close"
              className="flex-shrink-0 rounded px-1.5 text-xl leading-none text-gray-400 transition-colors hover:text-gray-900"
            >
              ×
            </button>
          )}
        </div>

        {/*
        THE LIST BODY IS NOT HIDDEN WHILE COMPARE IS OPEN. Compare is a separate
        overlay now (below, outside this modal), so the queue stays visible and
        dimmed behind it — which is what makes the two-layer model readable
        rather than looking like one window whose contents changed.
      */}
        <div className="px-6 py-4 overflow-y-auto">
          {/*
            THE MESSAGE FOLLOWS THE TOP LAYER (R5). Rendered here only while the
            compare screen is down; with it open the same two messages render
            over it instead (below), because a candidate can now be answered from
            up there and an outcome the user cannot see is an outcome they will
            act on twice. Rendered in ONE place either way — two copies would be
            two elements answering to one test id.
          */}
          {!compareGroup && <QueueMessages notice={notice} error={error} />}

          {clusters === null && (
            <div
              className="text-center py-8"
              data-testid="review-duplicates-loading"
            >
              <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin mx-auto" />
            </div>
          )}

          {clusters !== null && total === 0 && (
            <div
              className="text-center py-8 text-sm text-gray-500"
              data-testid="review-duplicates-empty"
            >
              Nothing to review. Every contact link we made was one we were sure
              about.
            </div>
          )}

          <div className="space-y-2">
            {groups.map((group) => (
              <ContactReviewCard
                key={group.contactId}
                group={group}
                busyId={busyId}
                onCompare={(item) =>
                  setComparing({
                    contactId: item.contactId,
                    proposalId: item.proposalId,
                  })
                }
                onSame={(item) => void answer(item, "same")}
                onDifferent={(item) => void answer(item, "different")}
              />
            ))}
          </div>
        </div>
      </ResponsiveModal>

      {/*
        BACKLOG-2502 ROUND 4 — COMPARE IS ITS OWN POPUP, ABOVE THE LIST.

        Founder, 2026-08-09, testing `223be9fb`: *"I still see the compare screen
        within the 'Possible duplicates / These were not linked automatically…'
        screen, rather than its own popup."* The layer BEHAVIOUR was right; the
        rendering was not. It sat in the list modal's body, under the list's
        heading, so it read as one window whose contents had changed.

        It is now a SIBLING overlay at `z-[60]`, which is how every other stacked
        layer in this app is built — `ResponsiveModal` with a `zIndex`, rendered
        beside the layer it covers, not inside it. It is the same construction
        `useContactCommViewers` uses for the email and text viewers it mounts
        over the contact card (`z-[90]` / `z-[80]`), which is the surface the
        founder named as the reference.

        `z-[60]` places it above the list (`z-50`, ResponsiveModal's default) and
        below `ContactFormModal` (`z-[70]`), which `Confirm & edit` opens once
        BOTH of these layers are gone.

        `panelBg="bg-transparent"` because `ContactCompareSources` draws its own
        white rounded frame — a white panel around it would be a card inside a
        card. `panelClassName` is WIDTH-ONLY on purpose: it keeps
        `ResponsiveModal`'s centred-card defaults (`sm:h-auto sm:max-h-[90vh]
        sm:overflow-y-auto`), which a `max-h-` of our own would suppress and
        leave the panel stretched full height (the BACKLOG-2292 trap).

        `proposalId` present routes its Confirm to the SHIPPED
        `contacts:confirm-link`, and its `Different people` to
        `contacts:reject-link` — the same two channels the cards use, so there is
        one resolution path and not three.
      */}
      {compareGroup && openedItem && (
        <ResponsiveModal
          /*
            POPS ONE LAYER, NOT THE STACK — the backdrop click and the compare
            screen's own `×` are the same action, and both land back on the list,
            which is still mounted with its clusters in state and is deliberately
            NOT re-read: nothing was answered, so there is nothing to re-read, and
            a reload here would reshuffle a queue the user is part-way through.
          */
          onClose={() => setComparing(null)}
          zIndex="z-[60]"
          panelBg="bg-transparent"
          panelClassName="max-w-4xl"
          testId="review-compare-overlay"
        >
          <div data-testid="review-compare-pane">
            <QueueMessages notice={notice} error={error} />
            <ContactCompareSources
              userId={userId}
              contactId={compareGroup.contactId}
              /*
                EVERY OPEN CANDIDATE, NOT JUST THE ONE THAT WAS CLICKED (R5).

                Founder, on a contact with four: *"we don't have the unlink /
                not-the-same button for each one of them"*. With one candidate
                per screen, three of his four questions had no column and so no
                way to be answered from here at all. The order is the list's
                order, so the third card below is the third column above.

                `proposalId` rides along on each so the compare screen can name
                the candidate it is answering without parsing a column key.
              */
              proposedSources={compareGroup.items.map((item) => ({
                sourceType: item.sourceType,
                sourceRecordId: item.sourceRecordId,
                proposalId: item.proposalId,
              }))}
              proposalId={openedItem.proposalId}
              /*
                ANSWERED HERE, BY THE SAME FUNCTION THE ROWS BELOW USE. `answer`
                already owns the two channels, the busy flag, the merge-guard
                notice and the reload — a second implementation for this screen
                would be a second set of rules about what happens after a press.
              */
              onCandidateSame={(proposalId) => {
                const item = compareGroup.items.find((i) => i.proposalId === proposalId);
                if (item) void answer(item, "same");
              }}
              onCandidateDifferent={(proposalId) => {
                const item = compareGroup.items.find((i) => i.proposalId === proposalId);
                if (item) void answer(item, "different");
              }}
              answeringProposalId={busyId}
              why={
                openedItem.evidence
                  ? {
                      summary: openedItem.evidence.summary,
                      details: openedItem.evidence.details ?? [],
                    }
                  : undefined
              }
              onClose={() => setComparing(null)}
              /*
                BACKLOG-2502 — CONFIRM RETURNS TO THE QUEUE, and the answered row
                is gone from it.

                `setComparing(null)` takes this overlay down and `load()` re-reads
                the list underneath, which is what removes the row — deliberately
                not a local splice: confirming one option in an exclusive cluster
                also answers its siblings, and only the main process knows which.
              */
              onConfirmed={() => {
                setComparing(null);
                onResolved?.();
                void load();
              }}
              /*
                `Confirm & edit` LEAVES the queue for the contact card. The write
                has already happened by the time this fires, so the caller is only
                being told where to go; it owns closing this modal.
              */
              onConfirmedAndEdit={() => {
                const { contactId } = compareGroup;
                setComparing(null);
                onResolved?.();
                onConfirmedAndEdit?.(contactId);
              }}
              onRejected={() => {
                setComparing(null);
                onResolved?.();
                void load();
              }}
            />
          </div>
        </ResponsiveModal>
      )}
    </>
  );
}

/**
 * The queue's two messages — an outcome to report and a load failure — drawn
 * wherever the user is currently looking (R5).
 *
 * One component with one pair of test ids, mounted on exactly one layer at a
 * time. `notice` is deliberately NOT an error: it reports an answer that
 * SUCCEEDED and changed less than the user expects (the merge guard), and
 * dressing it in red would read as "your answer failed".
 */
function QueueMessages({
  notice,
  error,
}: {
  notice: string | null;
  error: string | null;
}): React.ReactElement | null {
  if (!notice && !error) return null;
  return (
    <>
      {notice && (
        <div
          className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900"
          data-testid="review-duplicates-notice"
        >
          {notice}
        </div>
      )}
      {error && (
        <div
          className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800"
          data-testid="review-duplicates-error"
        >
          {error}
        </div>
      )}
    </>
  );
}

/** The letter in the avatar. Empty names fall back rather than render a blank circle. */
function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "?";
}

/** "Paul Dorian" → "Paul", for "Accept the ones that are this Paul." */
function firstNameOf(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first || name.trim();
}

const NUMBER_WORDS = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
];

/**
 * THE REASON, WHICH IS THE HEADING.
 *
 * Written ONLY from what the queue can prove — the number of candidates and
 * `matched_on`, the field the rule actually compared. The founder's design reads
 * *"Your Outlook has a Jane Seller with an email address you don't have for this
 * contact"*; the queue does not project the contact's own addresses, so that
 * exact claim is not checkable here and is not made. `matched_on === "name"`
 * does prove the narrower statement these sentences make: the name is the field
 * that matched.
 *
 * A sentence that overstates is the failure mode this whole epic exists to
 * avoid — the review queue's credibility is the only thing that makes a user
 * answer it a second time.
 */
function reasonFor(group: ContactGroup): string {
  const items = group.items;
  const nameOnly = (m: string | null): boolean =>
    m === "name" || m === "unique_name";

  if (items.length > 1) {
    const count = NUMBER_WORDS[items.length] ?? String(items.length);
    if (items.every((i) => nameOnly(i.matchedOn))) {
      return `${count} records share this name. Accept the ones that are this ${firstNameOf(group.contactName)}.`;
    }
    return `${count} records could be this contact. Answer each one on its own.`;
  }

  const first = items[0];
  const who = first.sourceName ? `a ${first.sourceName}` : "an entry";
  switch (first.matchedOn) {
    case "email":
      return `Your ${first.sourceLabel} has ${who} with the same email address as this contact.`;
    case "phone":
      return `Your ${first.sourceLabel} has ${who} with the same phone number as this contact.`;
    case "name":
    case "unique_name":
      return `Your ${first.sourceLabel} has ${who} with the same full name as this contact. The name is all that matched.`;
    default:
      return `Your ${first.sourceLabel} has ${who} that could be this contact.`;
  }
}

/**
 * The value under the source label — an email or a phone, in the user's own
 * data rather than a description of it.
 *
 * When the rule compared a specific identifier, that identifier is what the user
 * is being asked to judge, so it wins. On a name match neither list matched, and
 * the record's first address is simply what tells one candidate from another —
 * which is exactly the job this line does on a card with two of them.
 */
function candidateValue(item: ContactReviewItem): string | null {
  const emails = item.recordEmails ?? [];
  const phones = item.recordPhones ?? [];
  if (item.matchedOn === "email" && emails.length > 0) return emails[0];
  if (item.matchedOn === "phone" && phones.length > 0) return phones[0];
  return emails[0] ?? phones[0] ?? item.sourceName ?? null;
}

function ContactReviewCard({
  group,
  busyId,
  onCompare,
  onSame,
  onDifferent,
}: {
  group: ContactGroup;
  busyId: string | null;
  onCompare: (item: ContactReviewItem) => void;
  onSame: (item: ContactReviewItem) => void;
  onDifferent: (item: ContactReviewItem) => void;
}): React.ReactElement {
  return (
    // `relative` on the wrapper gives the two children one stacking context, so
    // the negative margin below reads as "tucked under" rather than "overlapped
    // by".
    <div className="relative" data-testid={`review-contact-${group.contactId}`}>
      <div className="relative z-10 flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-3">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-purple-500 to-pink-600 text-sm font-bold text-white">
          {initialOf(group.contactName)}
        </div>
        <div className="min-w-0 flex-1">
          {/*
            The contact name opens the comparison, as it does today. The card
            answers what it can; the whole record is one click away and the
            reject is permanent, which is why the way in stays on the card.
          */}
          <button
            type="button"
            onClick={() => onCompare(group.items[0])}
            className="block truncate text-left text-sm font-medium text-gray-900 hover:text-purple-700"
            data-testid={`review-contact-name-${group.contactId}`}
          >
            {group.contactName}
          </button>
          {group.contactCompany && (
            <div
              className="truncate text-xs text-gray-400"
              data-testid={`review-contact-company-${group.contactId}`}
            >
              {group.contactCompany}
            </div>
          )}
        </div>
        {/*
          COMPARE LIVES ON THE WHITE CONTACT ROW, outside the amber area — the
          founder's rule. It opens the contact's side-by-side view; the eye on
          each candidate below opens that same screen for THAT record, which is
          the only way to reach the second and third candidates' comparison.
        */}
        <button
          type="button"
          onClick={() => onCompare(group.items[0])}
          className="flex-shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
          data-testid={`review-compare-${group.contactId}`}
        >
          Compare
        </button>
      </div>

      {/*
        THE TUCK. `-mt-2` pulls the amber card under the white one, which is
        below it in z-order, so the question reads as belonging to the contact
        above rather than as the next item in a list.
      */}
      <div
        className="relative z-0 -mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 pb-2.5 pt-2"
        data-testid={`review-tuck-${group.contactId}`}
      >
        <p
          className="mb-2 mt-1.5 text-[0.82rem] leading-snug text-amber-900"
          data-testid={`review-reason-${group.contactId}`}
        >
          {reasonFor(group)}
        </p>

        {group.exclusive && (
          <p
            className="mb-2 text-xs text-amber-800"
            data-testid={`review-exclusive-${group.contactId}`}
          >
            Only one contact can be this record — answering here answers the
            others.
          </p>
        )}

        {group.items.map((item) => (
          <CandidateRow
            key={item.proposalId}
            item={item}
            busy={busyId === item.proposalId}
            onView={() => onCompare(item)}
            onSame={() => onSame(item)}
            onDifferent={() => onDifferent(item)}
          />
        ))}
      </div>
    </div>
  );
}

/** Shared shell for the three icon buttons, so hover/focus/disabled are stated once. */
function IconButton({
  title,
  ariaLabel,
  onClick,
  disabled,
  hoverClass,
  testId,
  children,
}: {
  title: string;
  ariaLabel: string;
  onClick: () => void;
  disabled: boolean;
  hoverClass: string;
  testId: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-center rounded p-1 text-gray-400 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-amber-500 disabled:opacity-50 ${hoverClass}`}
      data-testid={testId}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}

/**
 * One candidate record, answered on its own.
 *
 * The three buttons are icon-only and share the email needs-review card's
 * grammar — `text-gray-400` at rest, green on accept, red on reject — so a user
 * who has answered one review surface already knows this one. Words instead of
 * icons would double the height of a two-candidate card, which is exactly the
 * case where a wall of choices is worst.
 *
 * "Same person" and "Not this person", never "approve": approve reads like
 * sign-off on a document, and "Not this person" is already the phrase the
 * contact card uses to detach a source. One phrase for one concept.
 */
function CandidateRow({
  item,
  busy,
  onView,
  onSame,
  onDifferent,
}: {
  item: ContactReviewItem;
  busy: boolean;
  onView: () => void;
  onSame: () => void;
  onDifferent: () => void;
}): React.ReactElement {
  const value = candidateValue(item);
  return (
    <div
      className="mb-1.5 flex items-center gap-2.5 rounded-md border border-amber-300 bg-white px-2 py-2 last:mb-0"
      data-testid={`review-item-${item.proposalId}`}
    >
      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500 text-xs font-bold text-white">
        {initialOf(item.sourceName ?? item.contactName)}
      </div>
      <div className="min-w-0 flex-1">
        {/*
          `sourceLabel` verbatim, even where the design draws the shorter
          "Outlook" and the shipped vocabulary says "Outlook contacts". ONE
          VOCABULARY BEATS A DRAWING — the Sources panel two clicks away already
          uses these words, and a second set of names is how two screens start
          disagreeing about what the user's address book is called.
        */}
        <div
          className="font-mono text-[0.64rem] uppercase tracking-[0.05em] text-gray-400"
          data-testid={`review-source-${item.proposalId}`}
        >
          {item.sourceLabel}
        </div>
        {value && (
          <div
            className="break-all font-mono text-[0.73rem] text-gray-600"
            data-testid={`review-value-${item.proposalId}`}
          >
            {value}
          </div>
        )}
      </div>
      <div className="flex flex-shrink-0 gap-0.5">
        <IconButton
          title="View this record in full"
          ariaLabel="View this record in full"
          onClick={onView}
          disabled={busy}
          hoverClass="hover:bg-purple-50 hover:text-purple-600"
          testId={`review-view-${item.proposalId}`}
        >
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </IconButton>
        <IconButton
          title="Same person — link them"
          ariaLabel="Same person, link them"
          onClick={onSame}
          disabled={busy}
          hoverClass="hover:bg-green-50 hover:text-green-600"
          testId={`review-confirm-${item.proposalId}`}
        >
          <polyline points="20 6 9 17 4 12" />
        </IconButton>
        <IconButton
          title="Not this person"
          ariaLabel="Not this person"
          onClick={onDifferent}
          disabled={busy}
          hoverClass="hover:bg-red-50 hover:text-red-600"
          testId={`review-reject-${item.proposalId}`}
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </IconButton>
      </div>
    </div>
  );
}
