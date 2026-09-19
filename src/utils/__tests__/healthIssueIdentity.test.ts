/**
 * BACKLOG-3229 — unit controls for the health-issue identity.
 *
 * Every fixture here is TRANSCRIBED from a producer, not invented:
 *   - permission rows from `tests/fixtures/fdaDeniedIssue-3219.ts`, which a
 *     transcription suite pins against the real `permissionService`;
 *   - the contacts row from `permissionService.checkContactsLoading()`'s
 *     `ContactsIssue` shape;
 *   - connection rows from `connectionStatusService`, which writes only
 *     `NOT_CONNECTED`, `TOKEN_REFRESH_FAILED` and `CONNECTION_CHECK_FAILED`.
 *     `TOKEN_EXPIRED` is in the type union and is emitted by nothing.
 */

import { identityOf } from "../healthIssueIdentity";
import type { HealthIssue } from "../../../electron/types/ipc/healthIssue";
import {
  FDA_DENIED_BANNER_ISSUE,
  CONTACTS_DENIED_PERMISSION_RESULT,
  CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT,
} from "../../../tests/fixtures/fdaDeniedIssue-3219";

const contactsLoadingFailed: HealthIssue = {
  type: "CONTACTS_LOADING_FAILED",
  title: "Cannot Load Contacts",
  message: "Could not load contacts from Contacts app",
  details: "",
  action: "Grant Full Disk Access",
  actionHandler: "open-system-settings",
  severity: "warning",
};

const brokenMailbox = (
  provider: "google" | "microsoft",
  type: "TOKEN_REFRESH_FAILED" | "CONNECTION_CHECK_FAILED",
): HealthIssue => ({
  type,
  provider,
  severity: "error",
  userMessage: "Reconnect to keep capturing email.",
  action: "Reconnect",
  actionHandler: `reconnect-${provider}`,
});

describe("identityOf", () => {
  it("keys a permission row on its errorCode", () => {
    expect(identityOf(FDA_DENIED_BANNER_ISSUE as HealthIssue)).toBe(
      "permission:FULL_DISK_ACCESS_DENIED",
    );
    expect(
      identityOf({
        ...CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT,
      } as HealthIssue),
    ).toBe("permission:CONTACTS_STORE_NOT_FOUND");
  });

  it("keys a contacts-probe row on its type", () => {
    expect(identityOf(contactsLoadingFailed)).toBe("probe:CONTACTS_LOADING_FAILED");
  });

  /**
   * The ruling this rests on: every broken-token error for one provider carries
   * the same `reconnect-<provider>` button, so they are ONE row to the user.
   * BACKLOG-3244 documents the classifier flapping between these types; keying
   * on `type` would let a flap resurrect a row the user dismissed.
   */
  it("keys a mailbox row on its PROVIDER, not its error type", () => {
    expect(identityOf(brokenMailbox("google", "TOKEN_REFRESH_FAILED"))).toBe(
      "connection:google",
    );
    expect(identityOf(brokenMailbox("google", "CONNECTION_CHECK_FAILED"))).toBe(
      "connection:google",
    );
    expect(identityOf(brokenMailbox("microsoft", "TOKEN_REFRESH_FAILED"))).toBe(
      "connection:microsoft",
    );
  });

  it("separates the two providers, which share a type", () => {
    expect(identityOf(brokenMailbox("google", "TOKEN_REFRESH_FAILED"))).not.toBe(
      identityOf(brokenMailbox("microsoft", "TOKEN_REFRESH_FAILED")),
    );
  });

  it("returns null — NOT a shared fallback — for a row with no identity field", () => {
    expect(
      identityOf({
        hasPermission: false,
        userMessage: "unnameable",
      } as HealthIssue),
    ).toBeNull();
  });

  /**
   * C-b — the whole fix rests on the producer never emitting two rows that share
   * an identity. Asserted over the full set the handler can assemble, rather
   * than checked once by hand, because BACKLOG-3233 will change how the
   * permission rows collapse.
   */
  it("assigns a UNIQUE identity to every row the producer can emit together", () => {
    const everyRow: HealthIssue[] = [
      FDA_DENIED_BANNER_ISSUE as HealthIssue,
      { ...CONTACTS_DENIED_PERMISSION_RESULT } as HealthIssue,
      { ...CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT } as HealthIssue,
      contactsLoadingFailed,
      brokenMailbox("google", "TOKEN_REFRESH_FAILED"),
      brokenMailbox("microsoft", "CONNECTION_CHECK_FAILED"),
    ];

    const identities = everyRow
      .map(identityOf)
      .filter((id): id is string => id !== null);

    expect(identities).toHaveLength(everyRow.length);
    expect(new Set(identities).size).toBe(identities.length);
  });
});
