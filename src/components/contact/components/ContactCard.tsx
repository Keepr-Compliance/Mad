import React from "react";
import { SourcePill, mapToSourcePillSource } from "../../shared/SourcePill";
import type { ExtendedContact } from "../../../types/components";
import { labelForContact } from "../../../utils/contactDisplayLabel";

export interface ContactCardProps {
  /** Contact data to display */
  contact: ExtendedContact;
  /** Callback when card is clicked */
  onClick: (contact: ExtendedContact) => void;
  /** Callback when import button is clicked (external contacts only) */
  onImport?: (contact: ExtendedContact) => void;
}

/**
 * Gets the display name for a contact, preferring display_name over name
 */
function getDisplayName(contact: ExtendedContact): string {
  // BACKLOG-2461: fall through to organisation, phone, then email before
  // giving up. See src/utils/contactDisplayLabel.ts.
  return labelForContact(contact);
}

/**
 * Gets the first initial from a name for avatar display
 */
function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

/**
 * Checks if a contact is external (message-derived, can be imported)
 * External contacts are those derived from message participants rather than explicitly imported
 */
function isExternalContact(contact: ExtendedContact): boolean {
  // is_message_derived can be number (1) or boolean (true)
  return contact.is_message_derived === 1 || contact.is_message_derived === true;
}

/**
 * ContactCard Component
 * Displays a single contact in a card format with avatar, name, source pill,
 * and optional import button for external contacts.
 *
 * @example
 * // Basic usage
 * <ContactCard
 *   contact={contact}
 *   onClick={(c) => openDetails(c)}
 * />
 *
 * @example
 * // With import button for external contacts
 * <ContactCard
 *   contact={externalContact}
 *   onClick={(c) => openDetails(c)}
 *   onImport={(c) => importContact(c)}
 * />
 */
function ContactCard({ contact, onClick, onImport }: ContactCardProps) {
  const displayName = getDisplayName(contact);
  const initial = getInitial(displayName);
  const isExternal = isExternalContact(contact);
  const sourcePillSource = mapToSourcePillSource(contact.source, isExternal);

  const handleImportClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent card click
    onImport?.(contact);
  };

  // Get emails to display
  const emails =
    contact.source === "contacts_app" &&
    contact.allEmails &&
    contact.allEmails.length > 0
      ? contact.allEmails
      : contact.email
        ? [contact.email]
        : [];

  // Get phones to display
  const phones =
    contact.source === "contacts_app" &&
    contact.allPhones &&
    contact.allPhones.length > 0
      ? contact.allPhones
      : contact.phone
        ? [contact.phone]
        : [];

  return (
    <div
      onClick={() => onClick(contact)}
      className="bg-white border-2 border-gray-200 rounded-xl p-4 sm:p-6 hover:border-purple-400 hover:shadow-xl transition-all flex flex-col h-full cursor-pointer"
      data-testid={`contact-card-${contact.id}`}
    >
      {/* Contact Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div
            className="w-12 h-12 bg-gradient-to-br from-purple-500 to-pink-600 rounded-full flex items-center justify-center text-white font-bold text-lg"
            data-testid="contact-card-avatar"
          >
            {initial}
          </div>
          <div>
            <h3
              className="font-semibold text-gray-900"
              data-testid="contact-card-name"
            >
              {displayName}
            </h3>
            <SourcePill source={sourcePillSource} size="sm" />
          </div>
        </div>
      </div>

      {/* Contact Details */}
      <div className="space-y-2 mb-4 text-sm flex-1">
        {/* Emails */}
        {emails.map((email: string, idx: number) => (
          <div
            key={`email-${idx}`}
            className="flex items-center gap-2 text-gray-600"
            data-testid={`contact-card-email-${idx}`}
          >
            <svg
              className="w-4 h-4 text-gray-400 flex-shrink-0"
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
            <span className="truncate">{email}</span>
          </div>
        ))}

        {/* Phones */}
        {phones.map((phone: string, idx: number) => (
          <div
            key={`phone-${idx}`}
            className="flex items-center gap-2 text-gray-600"
            data-testid={`contact-card-phone-${idx}`}
          >
            <svg
              className="w-4 h-4 text-gray-400 flex-shrink-0"
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
            <span>{phone}</span>
          </div>
        ))}

        {/* Company */}
        {contact.company && (
          <div
            className="flex items-center gap-2 text-gray-600"
            data-testid="contact-card-company"
          >
            <svg
              className="w-4 h-4 text-gray-400 flex-shrink-0"
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
            <span className="truncate">{contact.company}</span>
          </div>
        )}

        {/* Title */}
        {contact.title && (
          <div
            className="flex items-center gap-2 text-gray-600"
            data-testid="contact-card-title"
          >
            <svg
              className="w-4 h-4 text-gray-400 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
            <span className="truncate">{contact.title}</span>
          </div>
        )}
      </div>

      {/* Footer with import button for external contacts */}
      {isExternal && onImport && (
        <div className="pt-3 border-t border-gray-100 flex justify-end">
          <button
            type="button"
            onClick={handleImportClick}
            className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-purple-600 hover:text-purple-700 hover:bg-purple-50 rounded-lg transition-colors"
            aria-label={`Import ${displayName}`}
            data-testid={`import-button-${contact.id}`}
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
                d="M12 4v16m8-8H4"
              />
            </svg>
            Import
          </button>
        </div>
      )}
    </div>
  );
}

export default ContactCard;
