/**
 * LinkedContentSearch (BACKLOG-1866, generalized in BACKLOG-1876)
 *
 * One search bar, two scopes:
 *   - Transaction scope (details overview): searches ONLY content linked to THIS
 *     transaction — assigned contacts, linked emails, linked texts. Three groups,
 *     no attribution badges. Behavior identical to the original BACKLOG-1866 UI.
 *   - Global scope (transaction list): searches ALL of the user's content and
 *     shows five groups — Transactions, Contacts, Emails, Texts, and an
 *     Unattached bucket. Each attributable hit is badged with its owning
 *     transaction's address (or "Not attached"). Clicking navigates: a
 *     transaction/contact/email/text hit opens the owning transaction (email/text
 *     deep-navigate to the BACKLOG-1869 viewer); unattached hits are inert (P1).
 *
 * Results panel styled after the admin portal's support/ticket search UI.
 */
import React from "react";
import { highlightMatch } from "@/utils/highlightMatch";
import {
  useLinkedContentSearch,
  type SearchScope,
} from "../hooks/useLinkedContentSearch";
import type {
  GlobalTransactionAttribution,
  GlobalEmailHit,
  GlobalTextHit,
} from "@electron/types/ipc/window-api-transactions";

interface LinkedContentSearchProps {
  /** Search scope — a single transaction (details) or global (list). */
  scope: SearchScope;
  /** Open a matched contact (list scope passes the owning transaction). */
  onNavigateContact: (
    contactId: string,
    attribution?: GlobalTransactionAttribution | null,
  ) => void;
  /** Navigate to a matched email (details: Emails tab; list: owning txn viewer). */
  onNavigateEmail: (
    emailId: string,
    attribution?: GlobalTransactionAttribution | null,
  ) => void;
  /** Navigate to a matched text (details: Texts tab; list: owning txn viewer). */
  onNavigateText: (
    textId: string,
    attribution?: GlobalTransactionAttribution | null,
  ) => void;
  /** Global scope only: open a matched transaction directly. */
  onNavigateTransaction?: (transactionId: string) => void;
}

/** Group header with a coloured count badge — mirrors the admin portal section headers. */
function GroupHeader({
  label,
  total,
  badgeClass,
}: {
  label: string;
  total: number;
  badgeClass: string;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 border-b border-gray-100">
      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
        {label}
      </span>
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${badgeClass}`}
      >
        {total}
      </span>
    </div>
  );
}

/** Attribution pill: owning transaction address, or a muted "Not attached". */
function AttributionBadge({
  attribution,
}: {
  attribution: GlobalTransactionAttribution | null;
}): React.ReactElement {
  if (!attribution) {
    return (
      <span
        className="text-xs text-gray-400 italic flex-shrink-0"
        data-testid="attribution-none"
      >
        Not attached
      </span>
    );
  }
  return (
    <span
      className="text-xs text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded flex-shrink-0 truncate max-w-[45%]"
      data-testid="attribution-badge"
      title={attribution.propertyAddress}
    >
      {attribution.propertyAddress}
    </span>
  );
}

/**
 * BACKLOG-1870 Phase 1.5: subtle indicator showing the attachment filename(s) that
 * matched the query, so the user sees WHY an email/text surfaced when the term only
 * appears in an attachment name. Renders nothing when no filename matched (results
 * that matched on subject/body stay clean).
 *
 * BACKLOG-2248: the matched search term is highlighted within the filename line so
 * the user can see exactly what matched inside the attachment name.
 */
function MatchedAttachments({
  filenames,
  term,
}: {
  filenames?: string[];
  term: string;
}): React.ReactElement | null {
  if (!filenames || filenames.length === 0) return null;
  const joined = filenames.join(", ");
  return (
    <span
      className="block text-xs text-gray-400 truncate"
      data-testid="matched-attachment"
      title={joined}
    >
      📎 {highlightMatch(joined, term)}
    </span>
  );
}

function emailPrimaryLine(hit: GlobalEmailHit): string {
  return hit.subject?.trim() || "(no subject)";
}

/**
 * BACKLOG-2816 (founder ruling, 2026-08-23): a group-chat-name hit is headed by
 * the GROUP'S NAME. It is the thing that matched, and it is the name he gave the
 * conversation — "it should just show the group chat name just like if i lookup a
 * contact it has a section for the contact".
 *
 * Message hits are unchanged: still the sender.
 */
function textPrimaryLine(hit: GlobalTextHit): string {
  const threadName = hit.threadDisplayName?.trim();
  if (threadName) return threadName;
  return hit.sender?.trim() || "Unknown sender";
}

/**
 * BACKLOG-2816: the member line under a group-chat-name hit — "a few of the
 * members of the group chat (with name not numbers)".
 *
 * Returns null when no member resolved to a contact, so the row shows the group
 * name alone rather than a list of raw digits. The handler has already dropped
 * unresolved members; this only decides whether there is anything left to show.
 */
function textMemberLine(hit: GlobalTextHit): string | null {
  if (!hit.threadDisplayName) return null;
  const names = (hit.memberNames ?? []).filter((n) => n.trim());
  return names.length > 0 ? names.join(", ") : null;
}

/** Compose the email secondary line (sender + snippet) shown under the subject. */
function emailSecondaryLine(hit: GlobalEmailHit): string {
  const sender = hit.sender ? `${hit.sender}${hit.snippet ? " — " : ""}` : "";
  return `${sender}${hit.snippet ?? ""}`;
}

export function LinkedContentSearch({
  scope,
  onNavigateContact,
  onNavigateEmail,
  onNavigateText,
  onNavigateTransaction,
}: LinkedContentSearchProps): React.ReactElement {
  const { query, setQuery, results, searching, unavailable, clear } =
    useLinkedContentSearch(scope);

  const isGlobal = scope.type === "global";
  // BACKLOG-2248: term to highlight within result rows. Results only render while
  // `!searching`, by which point `query` equals the searched term (debounce settled),
  // so highlighting stays consistent with the displayed hits.
  const term = query.trim();

  // BACKLOG-2858: `groupChats` belongs in this sum, and its absence would be a
  // silent regression on the founder's OWN case. Searching a group chat's name
  // now leaves `texts.total` at 0 (that count went to the Group chats badge with
  // the rows), so a name-only hit would fall through to "No matches" and the
  // whole results panel would never render.
  const hasAnyMatch =
    !!results &&
    ((results.transactions?.total ?? 0) > 0 ||
      results.contacts.total > 0 ||
      results.emails.total > 0 ||
      results.texts.total > 0 ||
      results.groupChats.total > 0 ||
      (results.unattached?.total ?? 0) > 0);

  return (
    <div className="mb-6" data-testid="linked-content-search">
      {/* Search input */}
      <div className="relative">
        <input
          type="text"
          placeholder={
            isGlobal
              ? "Search transactions, contacts, emails, and texts..."
              : "Search linked contacts, emails, and texts..."
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full border border-gray-300 rounded-md pl-9 pr-8 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 min-h-[38px]"
          data-testid="linked-search-input"
          aria-label={isGlobal ? "Search all transactions" : "Search this transaction"}
        />
        {/* Left: search icon or loading spinner */}
        {searching ? (
          <div
            className="absolute left-3 top-0 bottom-0 flex items-center"
            data-testid="linked-search-spinner"
          >
            <svg
              className="w-4 h-4 animate-spin text-blue-500"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
          </div>
        ) : (
          <svg
            className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        )}
        {/* Right: clear button */}
        {query.length > 0 && (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            data-testid="linked-search-clear"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm leading-none"
          >
            &times;
          </button>
        )}
      </div>

      {/* Results panel */}
      {query.trim().length > 0 && !searching && (
        <div className="mt-2" data-testid="linked-search-panel">
          {/* Error / unavailable state */}
          {unavailable && (
            <p
              className="text-xs text-amber-600 py-2 px-3 bg-amber-50 border border-amber-200 rounded-md"
              data-testid="linked-search-unavailable"
            >
              Search is temporarily unavailable. Please try again.
            </p>
          )}

          {/* No matches */}
          {!unavailable && !hasAnyMatch && results !== null && (
            <p
              className="text-sm text-gray-500 py-3 text-center"
              data-testid="linked-search-empty"
            >
              No matches for &ldquo;{query.trim()}&rdquo;.
            </p>
          )}

          {/* Grouped results — ticket-search style: white card, group headers, clean rows */}
          {!unavailable && hasAnyMatch && results && (
            <div
              className="border border-gray-200 rounded-md bg-white overflow-hidden divide-y divide-gray-100"
              data-testid="linked-search-results"
            >
              {/* Transactions group (global only) */}
              {results.transactions && results.transactions.total > 0 && (
                <div data-testid="linked-group-transactions">
                  <GroupHeader
                    label="Transactions"
                    total={results.transactions.total}
                    badgeClass="bg-indigo-100 text-indigo-700"
                  />
                  <ul>
                    {results.transactions.items.map((t) => (
                      <li key={t.id} className="border-b border-gray-50 last:border-0">
                        <button
                          type="button"
                          onClick={() => onNavigateTransaction?.(t.id)}
                          data-testid="transaction-result"
                          className="w-full text-left px-3 py-2 hover:bg-indigo-50 transition-colors"
                        >
                          <span className="block text-sm font-medium text-gray-900 truncate">
                            {highlightMatch(t.propertyAddress, term)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Contacts group */}
              {results.contacts.total > 0 && (
                <div data-testid="linked-group-contacts">
                  <GroupHeader
                    label="Contacts"
                    total={results.contacts.total}
                    badgeClass="bg-blue-100 text-blue-700"
                  />
                  <ul>
                    {results.contacts.items.map((c) => (
                      <li key={c.contactId} className="border-b border-gray-50 last:border-0">
                        <button
                          type="button"
                          onClick={() => onNavigateContact(c.contactId, c.attribution)}
                          data-testid="contact-result"
                          className="w-full text-left px-3 py-2 hover:bg-blue-50 transition-colors flex items-center gap-2"
                        >
                          <span className="text-sm font-medium text-gray-900 truncate flex-1">
                            {highlightMatch(c.displayName, term)}
                          </span>
                          {isGlobal ? (
                            <AttributionBadge attribution={c.attribution} />
                          ) : (
                            c.role && (
                              <span className="text-xs text-gray-400 flex-shrink-0">
                                {c.role}
                              </span>
                            )
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Emails group */}
              {results.emails.total > 0 && (
                <div data-testid="linked-group-emails">
                  <GroupHeader
                    label="Emails"
                    total={results.emails.total}
                    badgeClass="bg-green-100 text-green-700"
                  />
                  <ul>
                    {results.emails.items.map((e) => (
                      <li key={e.id} className="border-b border-gray-50 last:border-0">
                        <button
                          type="button"
                          onClick={() => { onNavigateEmail(e.id, e.attribution); }}
                          data-testid="email-result"
                          className="w-full text-left px-3 py-2 hover:bg-green-50 transition-colors"
                        >
                          <span className="flex items-center gap-2">
                            <span className="block text-sm font-medium text-gray-900 truncate flex-1">
                              {highlightMatch(emailPrimaryLine(e), term)}
                            </span>
                            {isGlobal && <AttributionBadge attribution={e.attribution} />}
                          </span>
                          {(e.sender || e.snippet) && (
                            <span className="block text-xs text-gray-400 truncate">
                              {highlightMatch(emailSecondaryLine(e), term)}
                            </span>
                          )}
                          <MatchedAttachments
                            filenames={e.matchedAttachmentFilenames}
                            term={term}
                          />
                        </button>
                      </li>
                    ))}
                  </ul>
                  {results.emails.total > results.emails.items.length && (
                    <p className="text-xs text-gray-400 px-3 py-1.5 bg-gray-50 border-t border-gray-100">
                      +{results.emails.total - results.emails.items.length} more
                    </p>
                  )}
                </div>
              )}

              {/* Group chats group (BACKLOG-2858).
                  Founder, verbatim: "group chat in the search should show up as a
                  separate category called Group chats. (not under texts where it
                  shows now)".

                  Gated on `total > 0` like every other section, so an empty one
                  renders NO heading — a heading over nothing is a control that
                  opens an empty screen (BACKLOG-2791).

                  Placed immediately BEFORE Texts because that is where these rows
                  already sat: BACKLOG-2816 put thread rows at the head of the
                  texts list, a named conversation being a more specific answer to
                  "Kingfisher Lane Closing" than any one message inside it. */}
              {results.groupChats.total > 0 && (
                <div data-testid="linked-group-groupchats">
                  <GroupHeader
                    label="Group chats"
                    total={results.groupChats.total}
                    badgeClass="bg-teal-100 text-teal-700"
                  />
                  <ul>
                    {results.groupChats.items.map((t) => (
                      <li key={t.id} className="border-b border-gray-50 last:border-0">
                        <button
                          type="button"
                          onClick={() => { onNavigateText(t.id, t.attribution); }}
                          data-testid="group-chat-result"
                          className="w-full text-left px-3 py-2 hover:bg-teal-50 transition-colors"
                        >
                          <span className="flex items-center gap-2">
                            <span className="block text-sm font-medium text-gray-900 truncate flex-1">
                              {highlightMatch(textPrimaryLine(t), term)}
                            </span>
                            {isGlobal && <AttributionBadge attribution={t.attribution} />}
                          </span>
                          {/* Members, never body text: nothing in any message's
                              body caused this hit, and `snippet` is null on these
                              rows by construction (the query does not project a
                              body). */}
                          {textMemberLine(t) && (
                            <span
                              className="block text-xs text-gray-400 truncate"
                              data-testid="group-chat-result-members"
                            >
                              {textMemberLine(t)}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {results.groupChats.total > results.groupChats.items.length && (
                    <p className="text-xs text-gray-400 px-3 py-1.5 bg-gray-50 border-t border-gray-100">
                      +{results.groupChats.total - results.groupChats.items.length} more
                    </p>
                  )}
                </div>
              )}

              {/* Texts group */}
              {results.texts.total > 0 && (
                <div data-testid="linked-group-texts">
                  <GroupHeader
                    label="Texts"
                    total={results.texts.total}
                    badgeClass="bg-purple-100 text-purple-700"
                  />
                  <ul>
                    {results.texts.items.map((t) => (
                      <li key={t.id} className="border-b border-gray-50 last:border-0">
                        <button
                          type="button"
                          onClick={() => { onNavigateText(t.id, t.attribution); }}
                          data-testid="text-result"
                          className="w-full text-left px-3 py-2 hover:bg-purple-50 transition-colors"
                        >
                          <span className="flex items-center gap-2">
                            <span className="block text-sm font-medium text-gray-900 truncate flex-1">
                              {highlightMatch(textPrimaryLine(t), term)}
                            </span>
                            {isGlobal && <AttributionBadge attribution={t.attribution} />}
                          </span>
                          {/* BACKLOG-2816: a group-name row shows members, never
                              body text — `snippet` is null on those rows by
                              construction (the query does not project a body). */}
                          {textMemberLine(t) && (
                            <span
                              className="block text-xs text-gray-400 truncate"
                              data-testid="text-result-members"
                            >
                              {textMemberLine(t)}
                            </span>
                          )}
                          {t.snippet && (
                            <span className="block text-xs text-gray-400 truncate">
                              {highlightMatch(t.snippet, term)}
                            </span>
                          )}
                          <MatchedAttachments
                            filenames={t.matchedAttachmentFilenames}
                            term={term}
                          />
                        </button>
                      </li>
                    ))}
                  </ul>
                  {results.texts.total > results.texts.items.length && (
                    <p className="text-xs text-gray-400 px-3 py-1.5 bg-gray-50 border-t border-gray-100">
                      +{results.texts.total - results.texts.items.length} more
                    </p>
                  )}
                </div>
              )}

              {/* Unattached bucket (global only) — inert rows (P1: no standalone viewer). */}
              {results.unattached && results.unattached.total > 0 && (
                <div data-testid="linked-group-unattached">
                  <GroupHeader
                    label="Unattached"
                    total={results.unattached.total}
                    badgeClass="bg-gray-200 text-gray-600"
                  />
                  <ul>
                    {results.unattached.items.map((u) => (
                      <li
                        key={`${u.kind}-${u.id}`}
                        className="px-3 py-2 flex items-center gap-2"
                        data-testid="unattached-result"
                        title="Not linked to a transaction"
                      >
                        <span className="text-[10px] font-semibold uppercase text-gray-400 flex-shrink-0">
                          {u.kind}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-gray-700 truncate">
                            {highlightMatch(
                              u.title?.trim() ||
                                (u.kind === "email" ? "(no subject)" : "Unknown sender"),
                              term,
                            )}
                          </span>
                          {u.snippet && (
                            <span className="block text-xs text-gray-400 truncate">
                              {highlightMatch(u.snippet, term)}
                            </span>
                          )}
                        </span>
                        <span className="text-xs text-gray-400 italic flex-shrink-0">
                          Not attached
                        </span>
                      </li>
                    ))}
                  </ul>
                  {results.unattached.total > results.unattached.items.length && (
                    <p className="text-xs text-gray-400 px-3 py-1.5 bg-gray-50 border-t border-gray-100">
                      +{results.unattached.total - results.unattached.items.length} more
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
