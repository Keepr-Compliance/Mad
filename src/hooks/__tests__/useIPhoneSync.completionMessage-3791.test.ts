/**
 * BACKLOG-3791 - completion text when the iPhone Contacts source is off.
 */
import { formatStorageCompleteMessage } from "../useIPhoneSync";

describe("formatStorageCompleteMessage", () => {
  it("source off: messages only, says contacts were not imported", () => {
    const msg = formatStorageCompleteMessage({ messagesStored: 668484, contactsStored: 0, contactsSourceOff: true });
    expect(msg).toBe(`Saved ${(668484).toLocaleString()} messages. Contacts not imported (turned off in Settings)`);
    expect(msg).not.toContain("0 contacts");
  });

  it("source on, genuinely zero contacts: keeps today's wording", () => {
    expect(formatStorageCompleteMessage({ messagesStored: 5, contactsStored: 0, contactsSourceOff: false })).toBe(
      "Saved 5 messages and 0 contacts",
    );
  });

  it("flag absent (older main process): keeps today's wording", () => {
    expect(formatStorageCompleteMessage({ messagesStored: 5, contactsStored: 12 })).toBe(
      "Saved 5 messages and 12 contacts",
    );
  });
});
