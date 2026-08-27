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

/**
 * BACKLOG-2863: how many rows a section shows before "Show more".
 *
 * The founder agreed to this cap in the same breath as dropping the counts, and
 * it is worth being clear that it buys NO performance: the row queries already
 * return in ~0 ms under `LIMIT` and an index, and all `limit` rows have been
 * fetched by the time this component renders. It is a shorter panel, nothing
 * more.
 */
const COLLAPSED_ROWS = 5;

/**
 * Group header. BACKLOG-2863 REMOVED THE COUNT BADGE that used to sit here.
 *
 * The number behind it came from six uncapped `SELECT COUNT(*)` queries, one per
 * section, ~190-210 ms each on every keystroke — and unlike the row queries they
 * could not stop early, because proving a total means visiting every match.
 * Founder, offered capped counts that would read "200+" instead: *"i'm also fine
 * with just show more and not counting it."*
 */
function GroupHeader({ label }: { label: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 border-b border-gray-100">
      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
        {label}
      </span>
    </div>
  );
}

/** The rows a section actually renders — capped until the user expands it. */
function visibleRows<T>(items: T[], expanded: boolean): T[] {
  return expanded ? items : items.slice(0, COLLAPSED_ROWS);
}

/**
 * The control under a section: a "Show more" button, a muted note, or nothing.
 *
 * IT IS NEVER A DEAD CONTROL (BACKLOG-2791). The button renders only while there
 * are fetched rows it can actually reveal. Once the section is showing everything
 * that was fetched and the database still held more, there is nothing a click
 * could do — so that case is a sentence, not a disabled button.
 */
function SectionFooter({
  shown,
  fetched,
  hasMore,
  onShowMore,
  testId,
}: {
  shown: number;
  fetched: number;
  hasMore: boolean;
  onShowMore: () => void;
  testId: string;
}): React.ReactElement | null {
  if (fetched > shown) {
    return (
      <button
        type="button"
        onClick={onShowMore}
        data-testid={testId}
        className="w-full text-left text-xs font-medium text-blue-600 hover:text-blue-800 hover:bg-gray-50 px-3 py-1.5 bg-gray-50 border-t border-gray-100"
      >
        Show more
      </button>
    );
  }
  if (hasMore) {
    return (
      <p
        className="text-xs text-gray-400 px-3 py-1.5 bg-gray-50 border-t border-gray-100"
        data-testid={`${testId}-refine`}
      >
        More matches — keep typing to narrow them down.
      </p>
    );
  }
  return null;
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

  // BACKLOG-2863: which sections the user has expanded past COLLAPSED_ROWS.
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
  const isExpanded = (section: string): boolean => expanded.has(section);
  const expand = (section: string): void =>
    { setExpanded((prev) => new Set(prev).add(section)); };

  const isGlobal = scope.type === "global";
  // BACKLOG-2248: term to highlight within result rows. Results only render while
  // `!searching`, by which point `query` equals the searched term (debounce settled),
  // so highlighting stays consistent with the displayed hits.
  const term = query.trim();

  // A new search is a new result set, so a section expanded for the previous one
  // must not stay expanded for this one — the user asked to see more of a
  // different list. Keyed on the settled term, which is what `results` describes.
  React.useEffect(() => {
    setExpanded(new Set());
  }, [term, scope.type]);

  // BACKLOG-2858: `groupChats` belongs in this test, and its absence would be a
  // silent regression on the founder's OWN case — a group-chat NAME match puts
  // rows in `groupChats` and none in `texts`, so a panel that ignored it would
  // fall through to "No matches" over a section that has rows.
  //
  // BACKLOG-2863: asked of the ROWS rather than of a count. Same answer, and it
  // no longer depends on a number the search stopped computing.
  const hasAnyMatch =
    !!results &&
    ((results.transactions?.items.length ?? 0) > 0 ||
      results.contacts.items.length > 0 ||
      results.emails.items.length > 0 ||
      results.texts.items.length > 0 ||
      results.groupChats.items.length > 0 ||
      (results.unattached?.items.length ?? 0) > 0);

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
              {results.transactions && results.transactions.items.length > 0 && (
                <div data-testid="linked-group-transactions">
                  <GroupHeader label="Transactions" />
                  <ul>
                    {visibleRows(results.transactions.items, isExpanded("transactions")).map((t) => (
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
                  <SectionFooter
                    shown={visibleRows(results.transactions.items, isExpanded("transactions")).length}
                    fetched={results.transactions.items.length}
                    hasMore={results.transactions.hasMore}
                    onShowMore={() => { expand("transactions"); }}
                    testId="show-more-transactions"
                  />
                </div>
              )}

              {/* Contacts group */}
              {results.contacts.items.length > 0 && (
                <div data-testid="linked-group-contacts">
                  <GroupHeader label="Contacts" />
                  <ul>
                    {visibleRows(results.contacts.items, isExpanded("contacts")).map((c) => (
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
                  <SectionFooter
                    shown={visibleRows(results.contacts.items, isExpanded("contacts")).length}
                    fetched={results.contacts.items.length}
                    hasMore={results.contacts.hasMore}
                    onShowMore={() => { expand("contacts"); }}
                    testId="show-more-contacts"
                  />
                </div>
              )}

              {/* Emails group */}
              {results.emails.items.length > 0 && (
                <div data-testid="linked-group-emails">
                  <GroupHeader label="Emails" />
                  <ul>
                    {visibleRows(results.emails.items, isExpanded("emails")).map((e) => (
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
                  <SectionFooter
                    shown={visibleRows(results.emails.items, isExpanded("emails")).length}
                    fetched={results.emails.items.length}
                    hasMore={results.emails.hasMore}
                    onShowMore={() => { expand("emails"); }}
                    testId="show-more-emails"
                  />
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
              {results.groupChats.items.length > 0 && (
                <div data-testid="linked-group-groupchats">
                  <GroupHeader label="Group chats" />
                  <ul>
                    {visibleRows(results.groupChats.items, isExpanded("groupChats")).map((t) => (
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
                  <SectionFooter
                    shown={visibleRows(results.groupChats.items, isExpanded("groupChats")).length}
                    fetched={results.groupChats.items.length}
                    hasMore={results.groupChats.hasMore}
                    onShowMore={() => { expand("groupChats"); }}
                    testId="show-more-groupchats"
                  />
                </div>
              )}

              {/* Texts group */}
              {results.texts.items.length > 0 && (
                <div data-testid="linked-group-texts">
                  <GroupHeader label="Texts" />
                  <ul>
                    {visibleRows(results.texts.items, isExpanded("texts")).map((t) => (
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
                  <SectionFooter
                    shown={visibleRows(results.texts.items, isExpanded("texts")).length}
                    fetched={results.texts.items.length}
                    hasMore={results.texts.hasMore}
                    onShowMore={() => { expand("texts"); }}
                    testId="show-more-texts"
                  />
                </div>
              )}

              {/* Unattached bucket (global only) — inert rows (P1: no standalone viewer). */}
              {results.unattached && results.unattached.items.length > 0 && (
                <div data-testid="linked-group-unattached">
                  <GroupHeader label="Unattached" />
                  <ul>
                    {visibleRows(results.unattached.items, isExpanded("unattached")).map((u) => (
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
                  <SectionFooter
                    shown={visibleRows(results.unattached.items, isExpanded("unattached")).length}
                    fetched={results.unattached.items.length}
                    hasMore={results.unattached.hasMore}
                    onShowMore={() => { expand("unattached"); }}
                    testId="show-more-unattached"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
