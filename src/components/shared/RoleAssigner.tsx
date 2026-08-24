/**
 * RoleAssigner Component
 *
 * Step 2 of the 2-step contact selection flow.
 * Receives selected contacts and allows the user to assign roles to them.
 *
 * Contact-Centric Design:
 * - Displays selected contacts as a simple list
 * - Each contact has a role dropdown next to it
 * - One role per contact (simplification)
 * - Clean, minimal UI
 *
 * @see TASK-1760: RoleAssigner Redesign - Contact-Centric Approach
 * @see BACKLOG-418: Redesign Contact Selection UX
 */

import React, { useMemo, useCallback } from "react";
import type { ExtendedContact } from "../../types/components";
import { AUDIT_WORKFLOW_STEPS } from "../../constants/contactRoles";
import { labelForContact } from "../../utils/contactDisplayLabel";
import {
  buildRoleOptions,
  getRoleDisplayName,
} from "../../utils/transactionRoleUtils";

/**
 * Role assignments mapping: role -> array of contact IDs
 */
export interface RoleAssignments {
  [role: string]: string[];
}

/**
 * Role configuration from workflow steps
 */
interface RoleConfig {
  role: string;
  required: boolean;
  multiple: boolean;
}

export interface RoleAssignerProps {
  /** Contacts that were selected in step 1 */
  selectedContacts: ExtendedContact[];
  /** Transaction type for role filtering */
  transactionType: "purchase" | "sale" | "other";
  /** Current role assignments */
  assignments: RoleAssignments;
  /** Callback when assignments change */
  onAssignmentsChange: (assignments: RoleAssignments) => void;
  /** Optional className for styling */
  className?: string;
}

/**
 * Contact role row component - shows a contact with a role dropdown
 */
interface ContactRoleRowProps {
  contact: ExtendedContact;
  currentRole: string;
  roleOptions: Array<{ value: string; label: string }>;
  onRoleChange: (role: string) => void;
}

function ContactRoleRow({
  contact,
  currentRole,
  roleOptions,
  onRoleChange,
}: ContactRoleRowProps): React.ReactElement {
  // BACKLOG-2461: see src/utils/contactDisplayLabel.ts.
  const displayName = labelForContact(contact);
  const initial = displayName.charAt(0).toUpperCase();
  // BACKLOG-2461: suppressed when the label already fell back to the email —
  // printing it on both lines reads as a rendering fault, not as a contact.
  const rawEmail = contact.email || (contact.allEmails?.[0] ?? null);
  const email = rawEmail === displayName ? null : rawEmail;

  return (
    <div
      className="flex items-center gap-4 p-3 bg-white border border-gray-200 rounded-lg"
      data-testid={`contact-role-row-${contact.id}`}
    >
      {/* Avatar */}
      <div className="w-8 h-8 bg-gradient-to-br from-purple-500 to-pink-600 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
        {initial}
      </div>

      {/* Contact Info */}
      <div className="flex-1 min-w-0">
        <div className="font-medium text-gray-900 text-sm truncate">
          {displayName}
        </div>
        {email && <div className="text-xs text-gray-500 truncate">{email}</div>}
      </div>

      {/* Role Dropdown */}
      <select
        className="px-3 py-2.5 text-sm border border-gray-300 rounded-lg bg-white text-gray-900 focus:ring-2 focus:ring-purple-500 focus:border-purple-500 focus:outline-none min-w-[160px] min-h-[44px]"
        value={currentRole}
        onChange={(e) => onRoleChange(e.target.value)}
        aria-label={`Role for ${displayName}`}
        data-testid={`role-select-${contact.id}`}
      >
        <option value="">Select role...</option>
        {roleOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * RoleAssigner - Main component
 *
 * Contact-centric approach: shows selected contacts with role dropdowns
 */
export function RoleAssigner({
  selectedContacts,
  transactionType,
  assignments,
  onAssignmentsChange,
  className,
}: RoleAssignerProps): React.ReactElement {
  // The roles this picker offers — one shared definition across all pickers
  // (BACKLOG-2859).
  const roleOptions = useMemo(
    () => buildRoleOptions(transactionType),
    [transactionType]
  );

  // Get the current role for a contact
  const getContactRole = useCallback(
    (contactId: string): string => {
      for (const [role, ids] of Object.entries(assignments)) {
        if (ids.includes(contactId)) {
          return role;
        }
      }
      return ""; // No role assigned
    },
    [assignments]
  );

  // Handle role change for a contact
  const handleRoleChange = useCallback(
    (contactId: string, newRole: string) => {
      // Build new assignments object
      const newAssignments: RoleAssignments = {};

      // First, copy all existing assignments except this contact
      Object.entries(assignments).forEach(([role, ids]) => {
        newAssignments[role] = ids.filter((id) => id !== contactId);
      });

      // Then add contact to new role (if not empty)
      if (newRole) {
        newAssignments[newRole] = [
          ...(newAssignments[newRole] || []),
          contactId,
        ];
      }

      // Clean up empty arrays
      Object.keys(newAssignments).forEach((role) => {
        if (newAssignments[role].length === 0) {
          delete newAssignments[role];
        }
      });

      onAssignmentsChange(newAssignments);
    },
    [assignments, onAssignmentsChange]
  );

  // Calculate assignment stats
  const assignedCount = useMemo(() => {
    return selectedContacts.filter((c) => getContactRole(c.id) !== "").length;
  }, [selectedContacts, getContactRole]);

  return (
    <div
      className={`border border-gray-200 rounded-lg overflow-hidden bg-white ${
        className || ""
      }`}
      data-testid="role-assigner"
    >
      {/* Header */}
      <div className="p-4 border-b border-gray-200 bg-gray-50">
        <h3 className="font-semibold text-gray-900">
          Assign Roles to Contacts
        </h3>
        <p className="text-sm text-gray-500 mt-1">
          {assignedCount} of {selectedContacts.length} contacts have roles
          assigned
        </p>
      </div>

      {/* Contact List */}
      <div className="p-4">
        {selectedContacts.length === 0 ? (
          <div className="text-center text-gray-500 py-8">
            <svg
              className="w-12 h-12 mx-auto mb-3 text-gray-300"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
              />
            </svg>
            <p>No contacts selected</p>
          </div>
        ) : (
          <div className="space-y-2">
            {selectedContacts.map((contact) => (
              <ContactRoleRow
                key={contact.id}
                contact={contact}
                currentRole={getContactRole(contact.id)}
                roleOptions={roleOptions}
                onRoleChange={(role) => handleRoleChange(contact.id, role)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default RoleAssigner;
