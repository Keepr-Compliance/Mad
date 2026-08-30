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
  /**
   * BACKLOG-2986: is the Android companion the ACTIVE message import source?
   *
   * Decides only whether the Android re-import affordance can point at a
   * control that is on the page. `Settings.tsx` renders `AndroidMessagesSettings`
   * — and with it the Force Re-import button — solely when the active source is
   * `android-companion`, so a button that scrolled there unconditionally would
   * land the user on the macOS panel instead. Defaults to `false` because the
   * active source is loaded asynchronously and is `null` until it arrives; an
   * absent answer must not draw a control that goes nowhere.
   */
  androidCompanionActive?: boolean;
}

export function ContactsSettings({
  userId,
  initialPreferences,
  isMicrosoftConnected,
  isGoogleConnected,
  androidCompanionActive = false,
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
  /**
   * BACKLOG-2986: the Android Contacts switch.
   *
   * Same shape as `iphoneContacts` above and for the same reason — an absent
   * key goes through the rule the MAIN PROCESS applies to it
   * (`preferenceHelper.ts` -> `isContactSourceOnByDefault`), not through the
   * blanket `true` the toggles above it use. `androidContacts` joined
   * `BACKEND_DERIVED_DEFAULT_KEYS` in the same change, so drawing this switch
   * ON for an absent key would paint it ON while the backend read the same key
   * as OFF.
   *
   * Until this change Settings could not write the key at all — onboarding was
   * its only writer, and only for a user who declared an Android phone — so a
   * user whose Android contacts were importing had no way to stop them.
   */
  const [androidContactsEnabled, setAndroidContactsEnabled] = useState<boolean>(() => {
    const val = initialPreferences?.contactSources?.direct?.androidContacts;
    if (typeof val === "boolean") return val;
    return isContactSourceOnByDefault("androidContacts", {
      platform: isMacOS ? "macos" : "windows",
      phoneType,
      // Not read by the androidContacts arm of the rule; see its switch case.
      authProvider: null,
    });
  });
  /**
   * BACKLOG-2986: does this user have an Android relationship at all?
   *
   * TRUE when they declared an Android phone, or when a preference for the key
   * has ever been stored. The child ORs in "and/or android_sync contacts
   * exist", which it can see and this component cannot.
   *
   * The stored-preference clause is load-bearing rather than defensive: the
   * founder's own state is `phone_type: "iphone"` with a stored
   * `androidContacts`, and after an Android Force Re-import his contact count
   * is 0 — so a gate of "declared Android OR count > 0" alone would hide the
   * switch from exactly the person who reported its absence, in exactly the
   * window where he needs it.
   */
  const androidContactsDeclared =
    phoneType === "android" ||
    typeof initialPreferences?.contactSources?.direct?.androidContacts === "boolean";
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
      androidContacts: setAndroidContactsEnabled,
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
          androidContactsEnabled={androidContactsEnabled}
          androidContactsDeclared={androidContactsDeclared}
          androidCompanionActive={androidCompanionActive}
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
