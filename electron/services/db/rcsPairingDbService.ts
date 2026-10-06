/**
 * BACKLOG-3666: the extension pairing store (table rcs_extension_pairings,
 * schema.sql). The session key lives only in this encrypted database.
 */
import { dbGet, dbRun, ensureDb } from "./core/dbConnection";
import { sql } from "./core/sqlText";
import type { PairingStore, RcsPairing } from "../rcsPairingAuth";

export function getRcsPairing(pairId: string): RcsPairing | null {
  try {
    const row = dbGet<{ pairId: string; userId: string; keyHex: string }>(
      sql`SELECT pair_id AS pairId, user_id AS userId, key_hex AS keyHex FROM rcs_extension_pairings WHERE pair_id = ?`,
      [pairId],
    );
    return row ?? null;
  } catch {
    return null; // no table yet: not paired
  }
}

/** Saves the pairing; the user's earlier pairings go (a re-pair replaces). */
export function saveRcsPairing(p: RcsPairing): void {
  const db = ensureDb();
  db.transaction(() => {
    dbRun(sql`DELETE FROM rcs_extension_pairings WHERE user_id = ?`, [p.userId]);
    dbRun(sql`INSERT INTO rcs_extension_pairings (pair_id, user_id, key_hex) VALUES (?, ?, ?)`, [p.pairId, p.userId, p.keyHex]);
  })();
}

export function rcsPairingExistsForUser(userId: string): boolean {
  try {
    return !!dbGet(sql`SELECT 1 FROM rcs_extension_pairings WHERE user_id = ?`, [userId]);
  } catch {
    return false;
  }
}

export function deleteRcsPairingsForUser(userId: string): void {
  try {
    dbRun(sql`DELETE FROM rcs_extension_pairings WHERE user_id = ?`, [userId]);
  } catch {
    /* no table yet: nothing to remove */
  }
}

export const rcsPairingStore: PairingStore = {
  get: getRcsPairing,
  save: saveRcsPairing,
  existsForUser: rcsPairingExistsForUser,
  deleteForUser: deleteRcsPairingsForUser,
};
