/**
 * LinkedContentSearch (BACKLOG-1866)
 *
 * Overview-tab search bar that searches ONLY content already linked to THIS
 * transaction — assigned contacts, linked emails, and linked texts. Results are
 * grouped by type with counts. Clicking a result navigates to it.
 *
 * Navigation:
 *   - Contact → opens the contact preview (reuses the Overview's existing handler)
 *   - Email   → switches to the Emails tab
 *   - Text    → switches to the Texts (messages) tab
 * (See the PR notes for the single-item deep-link limitation on emails/texts.)
 */
import React from "react";
import { useLinkedContentSearch } from "../hooks/useLinkedContentSearch";
import type {
  LinkedContentEmailHit,
  LinkedContentTextHit,
} from "@electron/types/ipc/window-api-transactions";

interface LinkedContentSearchProps {
  transactionId: string;
  /** Open the contact preview for a matched, already-assigned contact. */
  onNavigateContact: (contactId: string) => void;
  /** Navigate to the matched email (switches to the Emails tab). */
  onNavigateEmail: (emailId: string) => void;
  /** Navigate to the matched text (switches to the Texts tab). */
  onNavigateText: (textId: string) => void;
}

function GroupHeader({
  label,
  total,
  color,
}: {
  label: string;
  total: number;
  color: string;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2 mb-2">
      <h5 className="text-sm font-semibold text-gray-900">{label}</h5>
      <span
        className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full ${color}`}
      >
        {total}
      </span>
    </div>
  );
}

function emailPrimaryLine(hit: LinkedContentEmailHit): string {
  return hit.subject?.trim() || "(no subject)";
}

function textPrimaryLine(hit: LinkedContentTextHit): string {
  return hit.sender?.trim() || "Unknown sender";
}

export function LinkedContentSearch({
  transactionId,
  onNavigateContact,
  onNavigateEmail,
  onNavigateText,
}: LinkedContentSearchProps): React.ReactElement {
  const { query, setQuery, results, searching, clear } =
    useLinkedContentSearch(transactionId);

  const hasAnyMatch =
    !!results &&
    (results.contacts.total > 0 ||
      results.emails.total > 0 ||
      results.texts.total > 0);

  return (
    <div className="mb-8" data-testid="linked-content-search">
      <h4 className="text-lg font-semibold text-gray-900 mb-3">
        Search this transaction
      </h4>

      {/* Search input — matches the Attach Emails modal house style */}
      <div className="relative">
        <input
          type="text"
          placeholder="Search linked contacts, emails, and texts..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full pl-10 pr-10 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900 bg-white min-h-[44px]"
          data-testid="linked-search-input"
          aria-label="Search this transaction"
        />
        {/* Left: search icon or loading spinner */}
        {searching ? (
          <div
            className="absolute left-3 top-0 bottom-0 flex items-center"
            data-testid="linked-search-spinner"
          >
            <svg
              className="w-5 h-5 animate-spin text-blue-600"
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
            className="w-5 h-5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2"
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
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Results panel — only render once there is an active query result. */}
      {results && (
        <div className="mt-3" data-testid="linked-search-panel">
          {!hasAnyMatch ? (
            <p
              className="text-sm text-gray-500 py-4 text-center"
              data-testid="linked-search-empty"
            >
              No matches in this transaction for &ldquo;{query.trim()}&rdquo;.
            </p>
          ) : (
            <div className="space-y-4 border border-gray-200 rounded-lg p-3 bg-gray-50">
              {/* Contacts */}
              {results.contacts.total > 0 && (
                <div data-testid="linked-group-contacts">
                  <GroupHeader
                    label="Contacts"
                    total={results.contacts.total}
                    color="bg-blue-100 text-blue-700"
                  />
                  <ul className="space-y-1">
                    {results.contacts.items.map((c) => (
                      <li key={c.contactId}>
                        <button
                          type="button"
                          onClick={() => onNavigateContact(c.contactId)}
                          data-testid="contact-result"
                          className="w-full text-left px-3 py-2 rounded-md hover:bg-white bg-white/60 border border-transparent hover:border-gray-200 transition-colors"
                        >
                          <span className="text-sm font-medium text-gray-900">
                            {c.displayName}
                          </span>
                          {c.role && (
                            <span className="ml-2 text-xs text-gray-500">{c.role}</span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Emails */}
              {results.emails.total > 0 && (
                <div data-testid="linked-group-emails">
                  <GroupHeader
                    label="Emails"
                    total={results.emails.total}
                    color="bg-green-100 text-green-700"
                  />
                  <ul className="space-y-1">
                    {results.emails.items.map((e) => (
                      <li key={e.id}>
                        <button
                          type="button"
                          onClick={() => onNavigateEmail(e.id)}
                          data-testid="email-result"
                          className="w-full text-left px-3 py-2 rounded-md hover:bg-white bg-white/60 border border-transparent hover:border-gray-200 transition-colors"
                        >
                          <span className="block text-sm font-medium text-gray-900 truncate">
                            {emailPrimaryLine(e)}
                          </span>
                          {(e.sender || e.snippet) && (
                            <span className="block text-xs text-gray-500 truncate">
                              {e.sender ? `${e.sender} — ` : ""}
                              {e.snippet ?? ""}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {results.emails.total > results.emails.items.length && (
                    <p className="text-xs text-gray-400 mt-1 px-3">
                      +{results.emails.total - results.emails.items.length} more — open the
                      Emails tab to see all
                    </p>
                  )}
                </div>
              )}

              {/* Texts */}
              {results.texts.total > 0 && (
                <div data-testid="linked-group-texts">
                  <GroupHeader
                    label="Texts"
                    total={results.texts.total}
                    color="bg-purple-100 text-purple-700"
                  />
                  <ul className="space-y-1">
                    {results.texts.items.map((t) => (
                      <li key={t.id}>
                        <button
                          type="button"
                          onClick={() => onNavigateText(t.id)}
                          data-testid="text-result"
                          className="w-full text-left px-3 py-2 rounded-md hover:bg-white bg-white/60 border border-transparent hover:border-gray-200 transition-colors"
                        >
                          <span className="block text-sm font-medium text-gray-900 truncate">
                            {textPrimaryLine(t)}
                          </span>
                          {t.snippet && (
                            <span className="block text-xs text-gray-500 truncate">
                              {t.snippet}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {results.texts.total > results.texts.items.length && (
                    <p className="text-xs text-gray-400 mt-1 px-3">
                      +{results.texts.total - results.texts.items.length} more — open the
                      Texts tab to see all
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
