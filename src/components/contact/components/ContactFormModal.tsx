import React, { useState, useEffect, useRef, useCallback } from "react";
import { ResponsiveModal } from "../../common/ResponsiveModal";
import { ExtendedContact, ContactFormData, ContactEmailEntry, ContactPhoneEntry } from "../types";
import { ROLE_DISPLAY_NAMES } from "../../../constants/contactRoles";
import { contactService } from "../../../services/contactService";

interface ContactFormModalProps {
  userId: string;
  contact: ExtendedContact | undefined;
  onClose: () => void;
  onSuccess: (contact?: { id: string }) => void;
}

/**
 * Contact Form Modal
 * Add or edit a contact with multi-email/phone support
 */
function ContactFormModal({
  userId,
  contact,
  onClose,
  onSuccess,
}: ContactFormModalProps) {
  const [formData, setFormData] = useState<ContactFormData>({
    name: contact?.name || contact?.display_name || "",
    email: contact?.email || "",
    phone: contact?.phone || "",
    company: contact?.company || "",
    title: contact?.title || "",
    emails: [],
    phones: [],
    defaultRole: contact?.default_role || "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const newEmailRef = useRef<HTMLInputElement>(null);
  const newPhoneRef = useRef<HTMLInputElement>(null);

  // Load email/phone entries with IDs when editing
  useEffect(() => {
    if (!contact?.id || contact.id.startsWith("msg_")) return;

    setLoadingEntries(true);
    window.api.contacts
      .getEditData(contact.id)
      .then((result: { success: boolean; emails?: { id: string; email: string; is_primary: boolean }[]; phones?: { id: string; phone: string; is_primary: boolean }[] }) => {
        if (result.success) {
          const emails: ContactEmailEntry[] = (result.emails || []).map((e) => ({
            id: e.id,
            email: e.email,
            is_primary: e.is_primary,
          }));
          const phones: ContactPhoneEntry[] = (result.phones || []).map((p) => ({
            id: p.id,
            phone: p.phone,
            is_primary: p.is_primary,
          }));

          // If no entries exist, seed from the single email/phone fields
          if (emails.length === 0 && formData.email) {
            emails.push({ email: formData.email, is_primary: true });
          }
          if (phones.length === 0 && formData.phone) {
            phones.push({ phone: formData.phone, is_primary: true });
          }

          setFormData((prev) => ({ ...prev, emails, phones }));
        }
      })
      .catch(() => {
        // Fallback: seed from single fields
        const emails: ContactEmailEntry[] = formData.email
          ? [{ email: formData.email, is_primary: true }]
          : [];
        const phones: ContactPhoneEntry[] = formData.phone
          ? [{ phone: formData.phone, is_primary: true }]
          : [];
        setFormData((prev) => ({ ...prev, emails, phones }));
      })
      .finally(() => setLoadingEntries(false));
  }, [contact?.id]);

  // For new contacts, seed entries from single fields if not already set
  useEffect(() => {
    if (contact) return; // Only for new contacts
    const emails: ContactEmailEntry[] = [];
    const phones: ContactPhoneEntry[] = [];
    setFormData((prev) => ({ ...prev, emails, phones }));
  }, [contact]);

  // Check if this is an external contact being imported
  const isExternalContact = contact?.id?.startsWith("msg_") || !!contact?.is_message_derived;

  // Multi-entry UI is used for all modes (edit, add, import)
  const useMultiEntry = !loadingEntries;

  const hasEmailEntries = (formData.emails || []).some(e => e.email.trim());
  const hasPhoneEntries = (formData.phones || []).some(p => p.phone.trim());
  const hasContactInfo = hasEmailEntries || hasPhoneEntries;

  const showMissingInfoWarning = isExternalContact && !hasContactInfo;
  const canSave = !!formData.name.trim() && hasContactInfo;

  const handleChange = (field: keyof ContactFormData, value: string) => {
    setFormData({ ...formData, [field]: value });
  };

  // Email entry handlers
  const handleEmailChange = useCallback((index: number, value: string) => {
    setFormData((prev) => {
      const emails = [...(prev.emails || [])];
      emails[index] = { ...emails[index], email: value };
      return { ...prev, emails };
    });
  }, []);

  const handleEmailPrimary = useCallback((index: number) => {
    setFormData((prev) => {
      const emails = (prev.emails || []).map((e, i) => ({
        ...e,
        is_primary: i === index,
      }));
      return { ...prev, emails };
    });
  }, []);

  const handleEmailRemove = useCallback((index: number) => {
    setFormData((prev) => {
      const emails = [...(prev.emails || [])];
      const removed = emails.splice(index, 1)[0];
      // If removed was primary and entries remain, make first one primary
      if (removed.is_primary && emails.length > 0) {
        emails[0] = { ...emails[0], is_primary: true };
      }
      return { ...prev, emails };
    });
  }, []);

  const handleEmailAdd = useCallback(() => {
    setFormData((prev) => {
      const emails = [...(prev.emails || [])];
      emails.push({ email: "", is_primary: emails.length === 0 });
      return { ...prev, emails };
    });
    // Focus the new input after render
    setTimeout(() => newEmailRef.current?.focus(), 50);
  }, []);

  // Phone entry handlers
  const handlePhoneChange = useCallback((index: number, value: string) => {
    setFormData((prev) => {
      const phones = [...(prev.phones || [])];
      phones[index] = { ...phones[index], phone: value };
      return { ...prev, phones };
    });
  }, []);

  const handlePhonePrimary = useCallback((index: number) => {
    setFormData((prev) => {
      const phones = (prev.phones || []).map((p, i) => ({
        ...p,
        is_primary: i === index,
      }));
      return { ...prev, phones };
    });
  }, []);

  const handlePhoneRemove = useCallback((index: number) => {
    setFormData((prev) => {
      const phones = [...(prev.phones || [])];
      const removed = phones.splice(index, 1)[0];
      if (removed.is_primary && phones.length > 0) {
        phones[0] = { ...phones[0], is_primary: true };
      }
      return { ...prev, phones };
    });
  }, []);

  const handlePhoneAdd = useCallback(() => {
    setFormData((prev) => {
      const phones = [...(prev.phones || [])];
      phones.push({ phone: "", is_primary: phones.length === 0 });
      return { ...prev, phones };
    });
    setTimeout(() => newPhoneRef.current?.focus(), 50);
  }, []);

  const handleSave = async () => {
    if (!formData.name.trim()) {
      setError("Name is required");
      return;
    }

    // Validate: no duplicate emails (case-insensitive)
    if (formData.emails && formData.emails.length > 0) {
      const seen = new Set<string>();
      for (const entry of formData.emails) {
        if (!entry.email.trim()) continue;
        const lower = entry.email.toLowerCase().trim();
        if (seen.has(lower)) {
          setError(`Duplicate email: ${entry.email}`);
          return;
        }
        seen.add(lower);
      }
    }

    setSaving(true);
    setError(undefined);

    try {
      // Build clean email/phone arrays (strip empties)
      const cleanEmails = (formData.emails || []).filter((e) => e.email.trim());
      const cleanPhones = (formData.phones || []).filter((p) => p.phone.trim());

      let result: { success: boolean; error?: string };
      let savedContactId: string | undefined;

      if (contact && !isExternalContact) {
        // Update existing contact with multi-entry arrays
        const payload: Record<string, unknown> = {
          name: formData.name,
          company: formData.company,
          title: formData.title,
          emails: cleanEmails,
          phones: cleanPhones,
        };

        result = await window.api.contacts.update(contact.id, payload);
        savedContactId = contact.id;
      } else {
        // Create new contact — extract primary email/phone + allEmails/allPhones
        const primaryEmail = cleanEmails.find((e) => e.is_primary)?.email || cleanEmails[0]?.email || "";
        const primaryPhone = cleanPhones.find((p) => p.is_primary)?.phone || cleanPhones[0]?.phone || "";
        const payload: Record<string, unknown> = {
          name: formData.name,
          email: primaryEmail,
          phone: primaryPhone,
          company: formData.company,
          title: formData.title,
          allEmails: cleanEmails.map((e) => e.email),
          allPhones: cleanPhones.map((p) => p.phone),
        };

        const createResult = await window.api.contacts.create(
          userId,
          payload,
        );
        result = createResult;
        savedContactId = createResult.contact?.id;
      }

      if (result.success) {
        // Update default_role if we have a contact ID
        if (savedContactId) {
          const roleToSave = formData.defaultRole || "";
          await contactService.updateDefaultRole(savedContactId, roleToSave);
        }
        onSuccess(savedContactId ? { id: savedContactId } : undefined);
      } else {
        setError(result.error || "Failed to save contact");
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to save contact";
      setError(errorMessage);
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full px-3 py-2.5 sm:py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-gray-900 bg-white min-h-[44px]";

  return (
    <ResponsiveModal onClose={onClose} zIndex="z-[70]" panelClassName="max-w-md sm:max-h-[90vh]">
        {/* Header */}
        <div className="bg-gradient-to-r from-purple-500 to-pink-600 px-3 sm:px-6 pt-6 sm:pt-4 pb-3 sm:pb-4 sm:rounded-t-xl flex-shrink-0 shadow-lg">
          {/* Mobile */}
          <div className="sm:hidden flex items-center justify-between">
            <button
              onClick={onClose}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-2 py-2 transition-all flex items-center gap-1 font-medium text-sm"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back
            </button>
            <h3 className="text-lg font-bold text-white">
              {contact ? "Edit Contact" : "Add Contact"}
            </h3>
          </div>
          {/* Desktop */}
          <div className="hidden sm:flex items-center justify-between">
            <h3 className="text-lg font-bold text-white">
              {contact ? "Edit Contact" : "Add New Contact"}
            </h3>
            <button
              onClick={onClose}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-all"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Form (scrollable) */}
        <div className="p-3 sm:p-6 space-y-4 overflow-y-auto flex-1">
          {/* Missing contact info warning */}
          {showMissingInfoWarning && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-sm text-amber-800">
                <span className="font-medium">Missing contact information:</span> Please add an email address or phone number to import this contact.
              </p>
            </div>
          )}

          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => handleChange("name", e.target.value)}
              className={inputClass}
              placeholder="John Doe"
            />
          </div>

          {/* Emails */}
          {useMultiEntry ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Emails
              </label>
              <div className="space-y-2">
                {(formData.emails || []).map((entry, index) => (
                  <div key={entry.id || `new-${index}`} className="flex items-center gap-2">
                    <input
                      ref={index === (formData.emails?.length ?? 0) - 1 && !entry.id ? newEmailRef : undefined}
                      type="email"
                      value={entry.email}
                      onChange={(e) => handleEmailChange(index, e.target.value)}
                      className="flex-1 px-3 py-2.5 sm:py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-sm text-gray-900 bg-white min-h-[44px]"
                      placeholder="email@example.com"
                    />
                    <button
                      type="button"
                      onClick={() => handleEmailPrimary(index)}
                      className={`p-1.5 rounded transition-all flex-shrink-0 ${
                        entry.is_primary
                          ? "text-yellow-500 hover:text-yellow-600"
                          : "text-gray-300 hover:text-yellow-400"
                      }`}
                      title={entry.is_primary ? "Primary email" : "Set as primary"}
                    >
                      <svg className="w-4 h-4" fill={entry.is_primary ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleEmailRemove(index)}
                      className="p-1.5 text-gray-400 hover:text-red-500 rounded transition-all flex-shrink-0"
                      title="Remove email"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={handleEmailAdd}
                className="mt-2 text-sm text-purple-600 hover:text-purple-700 font-medium flex items-center gap-1"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add email
              </button>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Email
              </label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => handleChange("email", e.target.value)}
                className={inputClass}
                placeholder="john@example.com"
              />
            </div>
          )}

          {/* Phones */}
          {useMultiEntry ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Phones
              </label>
              <div className="space-y-2">
                {(formData.phones || []).map((entry, index) => (
                  <div key={entry.id || `new-${index}`} className="flex items-center gap-2">
                    <input
                      ref={index === (formData.phones?.length ?? 0) - 1 && !entry.id ? newPhoneRef : undefined}
                      type="tel"
                      value={entry.phone}
                      onChange={(e) => handlePhoneChange(index, e.target.value)}
                      className="flex-1 px-3 py-2.5 sm:py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-sm text-gray-900 bg-white min-h-[44px]"
                      placeholder="(555) 555-0112"
                    />
                    <button
                      type="button"
                      onClick={() => handlePhonePrimary(index)}
                      className={`p-1.5 rounded transition-all flex-shrink-0 ${
                        entry.is_primary
                          ? "text-yellow-500 hover:text-yellow-600"
                          : "text-gray-300 hover:text-yellow-400"
                      }`}
                      title={entry.is_primary ? "Primary phone" : "Set as primary"}
                    >
                      <svg className="w-4 h-4" fill={entry.is_primary ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePhoneRemove(index)}
                      className="p-1.5 text-gray-400 hover:text-red-500 rounded transition-all flex-shrink-0"
                      title="Remove phone"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={handlePhoneAdd}
                className="mt-2 text-sm text-purple-600 hover:text-purple-700 font-medium flex items-center gap-1"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add phone
              </button>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Phone
              </label>
              <input
                type="tel"
                value={formData.phone}
                onChange={(e) => handleChange("phone", e.target.value)}
                className={inputClass}
                placeholder="(555) 555-0112"
              />
            </div>
          )}

          {/* Company */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Company
            </label>
            <input
              type="text"
              value={formData.company}
              onChange={(e) => handleChange("company", e.target.value)}
              className={inputClass}
              placeholder="ABC Real Estate"
            />
          </div>

          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Title
            </label>
            <input
              type="text"
              value={formData.title}
              onChange={(e) => handleChange("title", e.target.value)}
              className={inputClass}
              placeholder="Real Estate Agent"
            />
          </div>

          {/* Default Role */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Default Role
            </label>
            <select
              value={formData.defaultRole || ""}
              onChange={(e) => handleChange("defaultRole", e.target.value)}
              className="w-full px-3 py-2.5 sm:py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-gray-900 bg-white min-h-[44px]"
            >
              <option value="">None</option>
              {Object.entries(ROLE_DISPLAY_NAMES).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              Auto-filled when assigning this contact to transactions
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-4 py-4 sm:px-6 bg-gray-50 sm:rounded-b-xl flex items-center gap-3 justify-end flex-shrink-0 pb-safe">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg font-medium transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !canSave}
            className={`px-4 py-2 rounded-lg font-semibold transition-all ${
              saving || !canSave
                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                : "bg-gradient-to-r from-purple-500 to-pink-600 text-white hover:from-purple-600 hover:to-pink-700"
            }`}
          >
            {saving ? "Saving..." : contact ? "Update Contact" : "Add Contact"}
          </button>
        </div>
    </ResponsiveModal>
  );
}

export default ContactFormModal;
