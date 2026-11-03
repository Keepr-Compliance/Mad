/**
 * BACKLOG-3965 PR-4b: the ONE helper Dashboard rows call writes the open
 * request AND opens the Transactions view — never one without the other
 * (SR d8e39054 / PM 07689ecc (a)).
 */
import {
  clearOpenTransactionRequest,
  getOpenTransactionRequest,
  makeOpenTransactionAt,
} from "../openTransactionRequest";

beforeEach(() => clearOpenTransactionRequest());

it.each([
  ["txn-1", "overview"],
  ["txn-2", "checklist"],
] as const)("%s on %s: request written, then the view opened", (id, tab) => {
  const order: string[] = [];
  const openTransactions = jest.fn(() => {
    order.push(`open:${JSON.stringify(getOpenTransactionRequest())}`);
  });
  makeOpenTransactionAt(openTransactions)(id, tab);
  expect(getOpenTransactionRequest()).toEqual({ id, tab });
  expect(openTransactions).toHaveBeenCalledTimes(1);
  // The view opens with the request already in the store.
  expect(order).toEqual([`open:${JSON.stringify({ id, tab })}`]);
});
