/**
 * BACKLOG-4185: how much Keepr data this device holds, for the devices row's
 * hardware profile. Runs ON THE CONTACT WORKER only (query type
 * "deviceDataSize"); there is no main-thread caller and no main fallback.
 * Each COUNT uses its table's user_id index.
 */
import { sql } from "./core/sqlText";
import type { MessageScanRunner } from "./wizardMessageScansDb";

export interface DeviceDataSize {
  messages: number;
  contacts: number;
  addressBook: number;
  mailAccounts: number;
}

/** Four bound parameters, all the user id. One row. */
export const DEVICE_DATA_SIZE_SQL = sql`
SELECT (SELECT COUNT(*) FROM messages WHERE user_id = ?) AS messages,
       (SELECT COUNT(*) FROM contacts WHERE user_id = ?) AS contacts,
       (SELECT COUNT(*) FROM external_contacts WHERE user_id = ?) AS addressBook,
       (SELECT COUNT(*) FROM oauth_tokens WHERE user_id = ? AND purpose = 'mailbox' AND is_active = 1) AS mailAccounts`;

export function readDeviceDataSizeOn(db: MessageScanRunner, userId: string): DeviceDataSize {
  const row = db.prepare(DEVICE_DATA_SIZE_SQL).all(userId, userId, userId, userId)[0] as Partial<DeviceDataSize> | undefined;
  return {
    messages: Number(row?.messages) || 0,
    contacts: Number(row?.contacts) || 0,
    addressBook: Number(row?.addressBook) || 0,
    mailAccounts: Number(row?.mailAccounts) || 0,
  };
}
