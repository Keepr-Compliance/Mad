import React, { useState } from "react";
import { ContactsImportSettings } from "./MacOSContactsImportSettings";
import { settingsService } from '../../services';
import { usePlatform } from "../../contexts/PlatformContext";
import {
  isContactSourceOnByDefault,
  normalizePhoneType,
} from "../../utils/contactSourceDefaults";
import type { PreferencesResult } from './types';

interface ContactsSettingsProps {
  userId: string;
  initialPreferences: PreferencesResult['preferences'];
  isMicrosoftConnected: boolean;
  isGoogleConnected: boolean;
}

export function ContactsSettings({
  userId,
  initialPreferences,
  isMicrosoftConnected,
  isGoogleConnected,
}: ContactsSettingsProps) {
  const { isMacOS } = usePlatform();
  // BACKLOG-2486: the phone type the user declared at onboarding decides both
  // whether the iPhone switch is worth showing and, when no preference is
  // stored, which way it points.
  const phoneType = normalizePhoneType(initialPreferences?.phone_type);
  // Contact source preferences - direct imports
  const [outlookContactsEnabled, setOutlookContactsEnabled] = useState<boolean>(() => {
    const val = initialPreferences?.contactSources?.direct?.outlookContacts;
    return typeof val === "boolean" ? val : true;
  });
  const [gmailContactsEnabled, setGmailContactsEnabled] = useState<boolean>(() => {
    const val = initialPreferences?.contactSources?.direct?.gmailContacts;
    return typeof val === "boolean" ? val : true;
  });
  // TASK-2303: Google Contacts toggle (backed by googleContacts preference key)
  const [googleContactsEnabled, setGoogleContactsEnabled] = useState<boolean>(() => {
    const val = initialPreferences?.contactSources?.direct?.googleContacts;
    return typeof val === "boolean" ? val : true;
  });
  const [macosContactsEnabled, setMacosContactsEnabled] = useState<boolean>(() => {
    const val = initialPreferences?.contactSources?.direct?.macosContacts;
    return typeof val === "boolean" ? val : true;
  });
  /**
   * BACKLOG-2486: the iPhone Contacts switch.
   *
   * Until this change, onboarding was the ONLY writer of `iphoneContacts` and
   * Settings had no control for it. That was survivable while the backend OR'd
   * the key with `macosContacts` — the value barely mattered. Now that
   * `iphoneContacts` alone decides whether iPhone contacts are imported, an
   * absent-or-off key with no way to switch it on is a one-way door: a macOS
   * user with iCloud contact sync turned off, who skipped the onboarding step,
   * could never get their iPhone contacts at all.
   *
   * The absent case does NOT default to `true` like the toggles above it. It
   * goes through the SAME rule the main process applies to an absent key
   * (`preferenceHelper.ts:60-75` -> `isContactSourceOnByDefault`), so the switch
   * shows what the backend will actually do. Defaulting to `true` here would
   * paint the switch ON while the backend read the same absent key as OFF on
   * macOS — a control that disagrees with its own effect.
   */
  const [iphoneContactsEnabled, setIphoneContactsEnabled] = useState<boolean>(() => {
    const val = initialPreferences?.contactSources?.direct?.iphoneContacts;
    if (typeof val === "boolean") return val;
    return isContactSourceOnByDefault("iphoneContacts", {
      platform: isMacOS ? "macos" : "windows",
      phoneType,
      // Not read by the iphoneContacts arm of the rule; see its switch case.
      authProvider: null,
    });
  });
  // Contact source preferences - inferred from conversations
  const [outlookEmailsInferred, setOutlookEmailsInferred] = useState<boolean>(() => {
    const val = initialPreferences?.contactSources?.inferred?.outlookEmails;
    return typeof val === "boolean" ? val : false;
  });
  const [gmailEmailsInferred, setGmailEmailsInferred] = useState<boolean>(() => {
    const val = initialPreferences?.contactSources?.inferred?.gmailEmails;
    return typeof val === "boolean" ? val : false;
  });
  const [messagesInferred, setMessagesInferred] = useState<boolean>(() => {
    const val = initialPreferences?.contactSources?.inferred?.messages;
    return typeof val === "boolean" ? val : false;
  });

  const handleContactSourceToggle = async (
    category: "direct" | "inferred",
    key: string,
    currentValue: boolean,
  ): Promise<void> => {
    const setters: Record<string, React.Dispatch<React.SetStateAction<boolean>>> = {
      outlookContacts: setOutlookContactsEnabled,
      macosContacts: setMacosContactsEnabled,
      iphoneContacts: setIphoneContactsEnabled,
      gmailContacts: setGmailContactsEnabled,
      googleContacts: setGoogleContactsEnabled,
      outlookEmails: setOutlookEmailsInferred,
      gmailEmails: setGmailEmailsInferred,
      messages: setMessagesInferred,
    };
    const newValue = !currentValue;
    setters[key](newValue);
    try {
      await settingsService.updatePreferences(userId, {
        contactSources: { [category]: { [key]: newValue } },
      });
    } catch {
      // Silently handle
    }
  };

  return (
    <div id="settings-contacts" className="mb-8">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Contacts</h3>
      <div className="space-y-4">
        <ContactsImportSettings
          userId={userId}
          isMicrosoftConnected={isMicrosoftConnected}
          isGoogleConnected={isGoogleConnected}
          outlookContactsEnabled={outlookContactsEnabled}
          macosContactsEnabled={macosContactsEnabled}
          iphoneContactsEnabled={iphoneContactsEnabled}
          // BACKLOG-2486: an Android user has no iPhone to import from, so the
          // switch is pointless for them. Anyone else — including a user whose
          // phone type was never recorded — gets it, because on macOS the
          // derived default is OFF and hiding the control would leave them no
          // way back.
          showIphoneContacts={phoneType !== "android"}
          gmailContactsEnabled={gmailContactsEnabled}
          googleContactsEnabled={googleContactsEnabled}
          outlookEmailsInferred={outlookEmailsInferred}
          gmailEmailsInferred={gmailEmailsInferred}
          messagesInferred={messagesInferred}
          loadingPreferences={false}
          onToggleSource={(category, key, currentValue) => {
            handleContactSourceToggle(category, key, currentValue);
          }}
        />
      </div>
    </div>
  );
}
