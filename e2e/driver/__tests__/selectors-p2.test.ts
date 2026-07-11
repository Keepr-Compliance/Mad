/**
 * Pure-Node unit proofs for the BACKLOG-1976 (P2-F1) cross-cutting selector groups.
 *
 * These are the foundation selectors the Phase-2 cells share (Nav / TxList / BulkDelete). This
 * suite pins the STABLE-id contract so a rename in src/ (the testids) or a drift in the driver
 * selector builders is caught here rather than as a mysterious runtime miss inside a live cell.
 *
 * Pure module → no app launch, no Playwright. Runs under `npm test` and the CI Node jest run
 * (jest.config.js CI testMatch drags e2e/driver/__tests__/** into the Node suite).
 */
import { BulkDelete, Nav, Testids, TxList, TX_ROW_PREFIX } from '../selectors';

describe('BACKLOG-1976 cross-cutting selectors', () => {
  describe('Nav', () => {
    it('clientsContacts points at the existing dashboard testid', () => {
      expect(Nav.clientsContacts).toBe('nav-clients-contacts');
      expect(Nav.clientsContacts).toBe(Testids.navClientsContacts);
    });
  });

  describe('TxList', () => {
    it('rowByIndex mirrors the shared tx-row prefix', () => {
      expect(TxList.rowByIndex(0)).toBe('tx-row-0');
      expect(TxList.rowByIndex(3)).toBe(`${TX_ROW_PREFIX}3`);
    });

    it('rowByTxId builds a stable data-tx-id CSS selector (independent of list position)', () => {
      const sel = TxList.rowByTxId('abc-123');
      expect(sel).toBe(`[data-testid^="${TX_ROW_PREFIX}"][data-tx-id="abc-123"]`);
      // It keys off data-tx-id, NOT the index-based testid value, so filtering/sorting can't break it.
      expect(sel).toContain('data-tx-id="abc-123"');
      expect(sel).not.toContain('tx-row-0');
    });

    it('selectionToggle points at the toolbar Edit/Done toggle testid', () => {
      expect(TxList.selectionToggle).toBe('tx-selection-toggle');
      expect(TxList.selectionToggle).toBe(Testids.txSelectionToggle);
    });
  });

  describe('BulkDelete', () => {
    it('exposes the three delete-confirmation testids added attribute-only in src/', () => {
      expect(BulkDelete.deleteButton).toBe('bulk-delete-button');
      expect(BulkDelete.confirm).toBe('bulk-delete-confirm');
      expect(BulkDelete.singleConfirm).toBe('delete-transaction-confirm');
    });

    it('keeps the bulk-delete confirm distinct from the single-delete confirm', () => {
      expect(BulkDelete.confirm).not.toBe(BulkDelete.singleConfirm);
    });
  });
});
