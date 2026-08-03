/**
 * RoleAssignment Component
 * Single role assignment with contact selection
 * Extracted from AuditTransactionModal as part of TASK-974 decomposition
 *
 * Contact Loading Optimization:
 * Now receives contacts as props from parent (ContactAssignmentStep).
 * This prevents N API calls (one per role) - contacts are loaded once at the parent level.
 */
import React from "react";
import { getRoleDisplayName } from "../../utils/transactionRoleUtils";
import ContactSelectModal from "../ContactSelectModal";
import type { Contact } from "../../../electron/types/models";
import type { ContactAssignment } from "../../hooks/useAuditTransaction";
import { labelForContact, UNRESOLVED_CONTACT_LABEL } from "../../utils/contactDisplayLabel";

interface RoleAssignmentProps {
  role: string;
  required: boolean;
  multiple: boolean;
  assignments: ContactAssignment[];
  onAssign: (
    role: string,
    contactId: string,
    isPrimary: boolean,
    notes: string,
  ) => void;
  onRemove: (role: string, contactId: string) => void;
  /** Contacts loaded by parent, passed as prop */
  contacts: Contact[];
  /** Callback to refresh contacts (e.g., after import) */
  onRefreshContacts: () => void;
  userId: string;
  propertyAddress: string;
  transactionType: string;
}

function RoleAssignment({
  role,
  required,
  multiple,
  assignments,
  onAssign,
  onRemove,
  contacts,
  onRefreshContacts,
  userId,
  propertyAddress,
  transactionType,
}: RoleAssignmentProps): React.ReactElement {
  const [showContactSelect, setShowContactSelect] =
    React.useState<boolean>(false);

  // Derive "no contacts" state from props
  const hasNoContacts = contacts.length === 0;

  const handleContactsSelected = (selectedContacts: Contact[]): void => {
    selectedContacts.forEach((contact: Contact, index: number) => {
      const isPrimary = assignments.length === 0 && index === 0; // First contact is primary
      onAssign(role, contact.id, isPrimary, "");
    });
    setShowContactSelect(false);
  };

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-gray-900">
            {getRoleDisplayName(role, transactionType as "purchase" | "sale")}
          </label>
          {required && (
            <span className="text-xs text-red-500 font-semibold">*</span>
          )}
          {multiple && (
            <span className="text-xs text-gray-500">(can assign multiple)</span>
          )}
        </div>
      </div>

      {/* No Contacts Message - only show if contacts array is empty */}
      {hasNoContacts && (
        <div className="mb-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
          <div className="flex items-start gap-2">
            <svg
              className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <div className="flex-1">
              <p className="text-sm font-medium text-yellow-900">
                No contacts imported yet. Click &quot;Select Contact&quot; to import contacts from your address book.
              </p>
              <p className="text-xs text-yellow-700 mt-1">
                You can import contacts from macOS Contacts or create them manually.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Assigned Contacts */}
      {assignments.length > 0 && (
        <div className="mb-3 space-y-2">
          {assignments.map((assignment: ContactAssignment, index: number) => {
            const contact = contacts.find(
              (c: Contact) => c.id === assignment.contactId,
            );
            return (
              <div
                key={index}
                className="bg-white border border-gray-200 rounded-lg p-3 flex items-center justify-between"
              >
                <div className="flex-1">
                  <p className="font-medium text-gray-900">
                    {contact ? labelForContact(contact) : UNRESOLVED_CONTACT_LABEL}
                  </p>
                  {contact?.email && (
                    <p className="text-xs text-gray-500">{contact.email}</p>
                  )}
                  {assignment.notes && (
                    <p className="text-xs text-gray-600 mt-1">
                      {assignment.notes}
                    </p>
                  )}
                  {assignment.isPrimary && (
                    <span className="inline-block mt-1 text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded">
                      Primary
                    </span>
                  )}
                </div>
                <button
                  onClick={() => onRemove(role, assignment.contactId)}
                  className="text-red-500 hover:text-red-700 transition-colors"
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
            );
          })}
        </div>
      )}

      {/* Add Contact Button (if multiple allowed or no contact assigned) */}
      {(multiple || assignments.length === 0) && (
        <button
          onClick={() => setShowContactSelect(true)}
          className="w-full px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 bg-indigo-500 text-white hover:bg-indigo-600"
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
              d="M12 6v6m0 0v6m0-6h6m-6 0H6"
            />
          </svg>
          {multiple ? "Select Contacts" : "Select Contact"}
        </button>
      )}

      {/* Contact Select Modal */}
      {showContactSelect && (
        <ContactSelectModal
          contacts={contacts as unknown as never[]}
          excludeIds={
            assignments.map(
              (a: ContactAssignment) => a.contactId,
            ) as unknown as never[]
          }
          multiple={multiple}
          onSelect={handleContactsSelected as unknown as never}
          onClose={() => setShowContactSelect(false)}
          propertyAddress={propertyAddress}
          userId={userId}
          onRefreshContacts={onRefreshContacts}
        />
      )}
    </div>
  );
}

export default RoleAssignment;
