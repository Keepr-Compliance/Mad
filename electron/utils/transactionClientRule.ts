/**
 * A TRANSACTION MAY NOT HAVE ITS LAST CLIENT TAKEN OFF IT (BACKLOG-2681)
 *
 * ===========================================================================
 * THE DEFECT THIS CLOSES
 * ===========================================================================
 * The "at least one contact must be assigned the Buyer (Client) role" rule
 * existed in EXACTLY ONE place in the codebase: `useAuditSteps.ts`, the
 * new-transaction wizard's step-3 gate. Grepped repo-wide — no equivalent
 * anywhere in the main process.
 *
 * So the rule held at the moment a deal was created, on one screen, and nowhere
 * afterwards. Sam creates a deal for his client Dana; the wizard makes him give
 * someone the Client role. A week later he opens the deal, presses Edit
 * Contacts, changes Dana from Client to Buyer Agent because he misremembered
 * which side he was on, and saves. The deal now has NO Client — a state the
 * wizard would have refused to create, reached in two clicks from the deal it
 * refused to create it for.
 *
 * `transactions:batchUpdateContacts` validated `action` and `contactId` and
 * nothing else. `transactions:create-audited` requires a non-empty `role`
 * string per assignment with no enum check and no Client check.
 *
 * ===========================================================================
 * WHY IT IS ENFORCED HERE AND NOT ONLY IN THE MODAL
 * ===========================================================================
 * BACKLOG-2681 is explicit: "the check belongs in the main process where every
 * route passes through, not duplicated in two renderers that will drift (they
 * already have)". The renderer copy in `EditContactsModal` exists so the user
 * gets a named reason rather than a raw failure toast — it is a message. This
 * is the enforcement, and it refuses the save whether or not a renderer asked.
 *
 * That is the same lesson as BACKLOG-2684 one file over: a rule that lives in
 * the caller cannot protect a caller that does not go through it.
 *
 * ===========================================================================
 * WHY "REMOVE THE LAST CLIENT" AND NOT "MUST HAVE A CLIENT"
 * ===========================================================================
 * A blanket invariant would refuse EVERY future edit to any transaction that
 * already has no Client — auto-detected deals, imported deals, and every deal
 * created before this rule existed. That set cannot be bounded from here: it
 * lives in each user's local SQLite. A user whose deal is already in that state
 * would find Edit Contacts permanently broken, with a message telling them to
 * do the thing the save is refusing to let them do.
 *
 * Refusing only the TRANSITION — had a Client, would have none — cannot strand
 * a deal that is already there, and still closes the reported defect. It is the
 * narrow reading, and it is chosen deliberately over the broad one.
 *
 * The founder's own words on why the rule is real at all, from the BACKLOG-2677
 * decision: *"Do not delete that check — it still guards a transaction whose
 * roles were all changed away from Client by hand."*
 */

/** The specific role, matching the wizard's gate exactly. */
export const CLIENT_ROLE = "client";

export const LAST_CLIENT_REMOVED_ERROR =
  "This transaction would be left with no Client. Assign the Client role to someone before saving.";

/** A row of `transaction_contacts`, narrowed to what the rule reads. */
export interface AssignedContactRow {
  contact_id: string;
  role?: string | null;
  specific_role?: string | null;
}

/** One staged add/remove, narrowed to what the rule reads. */
export interface ContactOperation {
  action: "add" | "remove";
  contactId: string;
  role?: string;
  specificRole?: string;
}

/** The role a row or an operation actually carries. */
function roleOf(x: {
  role?: string | null;
  specific_role?: string | null;
  specificRole?: string;
}): string | null {
  const raw = x.role ?? x.specific_role ?? x.specificRole ?? null;
  const trimmed = (raw || "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The contact ids holding the Client role in a set of rows. */
export function clientHoldersOf(rows: AssignedContactRow[]): Set<string> {
  const held = new Set<string>();
  for (const row of rows) {
    if (roleOf(row) === CLIENT_ROLE) held.add(row.contact_id);
  }
  return held;
}

/**
 * Would applying these operations take the LAST Client off the transaction?
 *
 * The operations are replayed in order against the current holders, because
 * order decides the answer and a set-difference would get it wrong: a batch
 * that removes Dana-as-Client and then adds Dana-as-Client back — which is
 * exactly what `EditContactsModal` emits for an unchanged row when some other
 * contact changed — leaves the deal with a Client and must be allowed.
 *
 * `schema.sql` declares `UNIQUE(transaction_id, contact_id)`, so a contact
 * holds at most one role and an `add` REPLACES whatever it held before. That is
 * why an add of a non-Client role deletes the contact from the holder set
 * rather than being ignored: changing Dana from Client to Buyer Agent arrives
 * as an add, and it is the reported defect.
 */
export function wouldRemoveLastClient(
  current: AssignedContactRow[],
  operations: ContactOperation[],
): boolean {
  const holders = clientHoldersOf(current);

  // Nothing to lose. A deal with no Client stays editable — see the header.
  if (holders.size === 0) return false;

  for (const op of operations) {
    if (op.action === "remove") {
      /**
       * A role-scoped remove only removes the row when the role matches, which
       * mirrors `batchUpdateContactAssignments`'s own predicate. An unscoped
       * remove takes the contact off the deal entirely.
       */
      const scoped = roleOf(op);
      if (scoped === null || scoped === CLIENT_ROLE) {
        holders.delete(op.contactId);
      }
    } else {
      if (roleOf(op) === CLIENT_ROLE) holders.add(op.contactId);
      else holders.delete(op.contactId);
    }
  }

  return holders.size === 0;
}
