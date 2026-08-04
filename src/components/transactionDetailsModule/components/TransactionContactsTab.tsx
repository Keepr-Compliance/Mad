/**
 * TransactionContactsTab Component
 * Contacts tab content showing AI suggestions and contact assignments
 */
import React from "react";
import { formatRoleLabel } from "../../../utils/transactionRoleUtils";
import {
  labelForTransactionContact,
  labelForContact,
  UNRESOLVED_CONTACT_LABEL,
} from "../../../utils/contactDisplayLabel";
import type { ResolvedSuggestedContact, ContactAssignment } from "../types";

interface TransactionContactsTabProps {
  resolvedSuggestions: ResolvedSuggestedContact[];
  contactAssignments: ContactAssignment[];
  loading: boolean;
  processingContactId: string | null;
  processingAll: boolean;
  onAcceptSuggestion: (suggestion: ResolvedSuggestedContact) => void;
  onRejectSuggestion: (suggestion: ResolvedSuggestedContact) => void;
  onAcceptAll: () => void;
  /** Callback to open the edit contacts modal */
  onEditContacts?: () => void;
}

export function TransactionContactsTab({
  resolvedSuggestions,
  contactAssignments,
  loading,
  processingContactId,
  processingAll,
  onAcceptSuggestion,
  onRejectSuggestion,
  onAcceptAll,
  onEditContacts,
}: TransactionContactsTabProps): React.ReactElement {
  return (
    <div>
      {/* AI Suggested Contacts Section */}
      {resolvedSuggestions.length > 0 && (
        <SuggestedContactsSection
          suggestions={resolvedSuggestions}
          processingContactId={processingContactId}
          processingAll={processingAll}
          onAcceptSuggestion={onAcceptSuggestion}
          onRejectSuggestion={onRejectSuggestion}
          onAcceptAll={onAcceptAll}
        />
      )}

      {/* Header with Edit Contacts button */}
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-lg font-semibold text-gray-900">
          Contact Assignments
        </h4>
        {onEditContacts && (
          <button
            onClick={onEditContacts}
            className="px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-1.5"
            data-testid="edit-contacts-button"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
            Edit Contacts
          </button>
        )}
      </div>
      {loading ? (
        <div className="text-center py-8">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto"></div>
        </div>
      ) : contactAssignments.length === 0 ? (
        <p className="text-gray-600 text-center py-8">
          No contacts assigned to this transaction
        </p>
      ) : (
        <div className="space-y-4">
          {contactAssignments.map((assignment) => (
            <ContactAssignmentCard key={assignment.id} assignment={assignment} />
          ))}
        </div>
      )}
    </div>
  );
}

// Sub-component for AI suggested contacts section
function SuggestedContactsSection({
  suggestions,
  processingContactId,
  processingAll,
  onAcceptSuggestion,
  onRejectSuggestion,
  onAcceptAll,
}: {
  suggestions: ResolvedSuggestedContact[];
  processingContactId: string | null;
  processingAll: boolean;
  onAcceptSuggestion: (suggestion: ResolvedSuggestedContact) => void;
  onRejectSuggestion: (suggestion: ResolvedSuggestedContact) => void;
  onAcceptAll: () => void;
}) {
  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <svg
            className="w-5 h-5 text-purple-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
            />
          </svg>
          <h4 className="text-lg font-semibold text-gray-900">
            AI Suggested Contacts
          </h4>
          <span className="inline-block px-2 py-0.5 bg-purple-100 text-purple-700 text-xs font-medium rounded-full">
            {suggestions.length} suggestion{suggestions.length !== 1 ? "s" : ""}
          </span>
        </div>
        <button
          onClick={onAcceptAll}
          disabled={processingAll || !!processingContactId}
          className="px-3 py-1.5 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
        >
          {processingAll ? (
            <>
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
              Processing...
            </>
          ) : (
            <>
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              Accept All
            </>
          )}
        </button>
      </div>
      <div className="space-y-3">
        {suggestions.map((suggestion) => (
          <SuggestedContactCard
            key={suggestion.contact_id}
            suggestion={suggestion}
            isProcessing={processingContactId === suggestion.contact_id}
            isDisabled={processingAll}
            onAccept={() => onAcceptSuggestion(suggestion)}
            onReject={() => onRejectSuggestion(suggestion)}
          />
        ))}
      </div>
    </div>
  );
}

// Sub-component for individual suggested contact cards
function SuggestedContactCard({
  suggestion,
  isProcessing,
  isDisabled,
  onAccept,
  onReject,
}: {
  suggestion: ResolvedSuggestedContact;
  isProcessing: boolean;
  isDisabled: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const contact = suggestion.contact;
  // BACKLOG-2461: see src/utils/contactDisplayLabel.ts.
  // BACKLOG-2461: an ABSENT record is a different condition from a record
  // with an empty name — see UNRESOLVED_CONTACT_LABEL.
  const displayName = contact ? labelForContact(contact) : UNRESOLVED_CONTACT_LABEL;
  const displayEmail = contact?.email || "";
  const displayCompany = contact?.company || "";

  return (
    <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <span className="inline-block px-3 py-1 bg-purple-100 text-purple-800 text-xs font-semibold rounded-full">
              {formatRoleLabel(suggestion.role)}
            </span>
            {suggestion.is_primary && (
              <span className="inline-block px-2 py-1 bg-blue-100 text-blue-800 text-xs font-semibold rounded-full">
                Primary
              </span>
            )}
            <span className="inline-block px-2 py-0.5 bg-yellow-100 text-yellow-800 text-xs font-medium rounded-full">
              AI Suggested
            </span>
          </div>
          <h5 className="font-semibold text-gray-900 text-lg">{displayName}</h5>
          {displayEmail && (
            <p className="text-sm text-gray-600 mt-1">
              <svg
                className="w-4 h-4 inline mr-1"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                />
              </svg>
              {displayEmail}
            </p>
          )}
          {displayCompany && (
            <p className="text-sm text-gray-600 mt-1">
              <svg
                className="w-4 h-4 inline mr-1"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                />
              </svg>
              {displayCompany}
            </p>
          )}
          {suggestion.notes && (
            <p className="text-sm text-gray-700 mt-2 italic">
              Note: {suggestion.notes}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 ml-4">
          <button
            onClick={onAccept}
            disabled={isProcessing || isDisabled}
            className="p-2 text-green-600 hover:bg-green-100 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Accept suggestion"
          >
            {isProcessing ? (
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
            ) : (
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            )}
          </button>
          <button
            onClick={onReject}
            disabled={isProcessing || isDisabled}
            className="p-2 text-red-600 hover:bg-red-100 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Reject suggestion"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// Sub-component for contact assignment cards
function ContactAssignmentCard({
  assignment,
}: {
  assignment: ContactAssignment;
}) {
  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <span className="inline-block px-3 py-1 bg-green-100 text-green-800 text-xs font-semibold rounded-full">
              {formatRoleLabel(assignment.specific_role || assignment.role || "Unknown Role")}
            </span>
            {assignment.is_primary === 1 && (
              <span className="inline-block px-2 py-1 bg-blue-100 text-blue-800 text-xs font-semibold rounded-full">
                Primary
              </span>
            )}
          </div>
          <h5 className="font-semibold text-gray-900 text-lg">
            {labelForTransactionContact(assignment)}
          </h5>
          {assignment.contact_email && (
            <p className="text-sm text-gray-600 mt-1">
              <svg
                className="w-4 h-4 inline mr-1"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                />
              </svg>
              {assignment.contact_email}
            </p>
          )}
          {assignment.contact_phone && (
            <p className="text-sm text-gray-600 mt-1">
              <svg
                className="w-4 h-4 inline mr-1"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
                />
              </svg>
              {assignment.contact_phone}
            </p>
          )}
          {assignment.contact_company && (
            <p className="text-sm text-gray-600 mt-1">
              <svg
                className="w-4 h-4 inline mr-1"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                />
              </svg>
              {assignment.contact_company}
            </p>
          )}
          {assignment.notes && (
            <p className="text-sm text-gray-700 mt-2 italic">
              Note: {assignment.notes}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
