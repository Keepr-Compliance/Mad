/**
 * BACKLOG-2865 — the word beside the card's email figure has to name what the
 * figure counts.
 *
 * THE FIXTURE IS THE POINT. `email_count` is 5 and the deal holds 2
 * conversations. Every assertion below is written against numbers that DIFFER,
 * because on a one-email-per-conversation deal "5 Emails" and "5 Email threads"
 * are both arithmetically true and no test can tell an email count from a
 * thread count. The pairing is not decorative: 5 and 2 come from the T_LINKED
 * deal in `transactionDbService.cardScope-2865.test.ts`, where the same numbers
 * are produced by the real query against real rows.
 *
 * WHAT THE ITEM GOT WRONG, CORRECTED HERE. BACKLOG-2865 was filed saying all
 * three cards render "Email threads", naming TransactionMobileCard.tsx:205.
 * They do not. `TransactionMobileCard` — the ONLY card any screen renders
 * (TransactionList.tsx, Transactions.tsx) — renders a bare number beside an
 * envelope with no unit word at all. The wrong word lived only in
 * `TransactionListCard` and `TransactionCard`, which BACKLOG-2838 established
 * are dead: nothing but the barrel `index.ts` references either.
 *
 * They are reworded rather than deleted (deletion is a separate decision), and
 * covered here rather than left uncovered, because an unrendered component with
 * a wrong label is what the next card gets copied from.
 *
 * The unit itself was settled by BACKLOG-2838, not chosen here: `email_count`
 * is `COUNT`-of-emails, and that item moved the WORD to fit the VALUE on the
 * submit summary after ruling out re-unitting the number.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionMobileCard } from "../TransactionMobileCard";
import { TransactionListCard } from "../TransactionListCard";
import TransactionCard from "../TransactionCard";
import type { Transaction } from "@/types";

/** 5 emails across 2 conversations — the two numbers must not coincide. */
const EMAILS = 5;
const CONVERSATIONS = 2;

const transaction = {
  id: "t-2865",
  user_id: "u-2865",
  property_address: "18 Bellweather Lane",
  transaction_type: "purchase",
  status: "active",
  email_count: EMAILS,
  text_thread_count: 3,
  created_at: "2026-06-01T00:00:00.000Z",
  updated_at: "2026-06-02T00:00:00.000Z",
} as unknown as Transaction;

const formatDate = (): string => "Jun 2";
const formatCurrency = (): string => "$0";

describe("BACKLOG-2865 — the email figure on a transaction card names emails", () => {
  it("the fixture can tell the two units apart", () => {
    // If this ever becomes an equality, every assertion below stops proving
    // anything and starts passing on either label.
    expect(EMAILS).not.toBe(CONVERSATIONS);
  });

  describe("TransactionMobileCard — the card the list actually renders", () => {
    const renderCard = () =>
      render(
        <TransactionMobileCard
          transaction={transaction}
          selectionMode={false}
          isSelected={false}
          onTransactionClick={jest.fn()}
          onCheckboxClick={jest.fn()}
          formatDate={formatDate}
        />,
      );

    it("shows the email count, and shows the EMAIL count rather than a thread count", () => {
      renderCard();
      // Scoped to the counter node: a bare "5" anywhere on a card could be a
      // price, a day or a text count, so `getByText("5")` would prove nothing.
      expect(screen.getByTestId("tx-card-email-count")).toHaveTextContent(
        String(EMAILS),
      );
      expect(
        screen.getByTestId("tx-card-email-count"),
      ).not.toHaveTextContent(String(CONVERSATIONS));
    });

    it("carries no unit word — so it cannot acquire the wrong one unnoticed", () => {
      const { container } = renderCard();
      // This card is icon-only by design (BACKLOG-2838). If a word is ever added
      // beside the envelope it must be "email", never "thread", and this goes red
      // until someone makes that choice deliberately.
      expect(container.textContent).not.toMatch(/thread/i);
    });
  });

  describe("TransactionListCard (dead code, reworded)", () => {
    it('reads "5 Emails", never "5 Email threads"', () => {
      render(
        <TransactionListCard
          transaction={transaction}
          selectionMode={false}
          isSelected={false}
          onTransactionClick={jest.fn()}
          onCheckboxClick={jest.fn()}
          onQuickExport={jest.fn()}
          formatCurrency={formatCurrency}
          formatDate={formatDate}
        />,
      );

      expect(screen.getByText(`${EMAILS} Emails`)).toBeInTheDocument();
      // The specific wrong string, named. A /email/i query would match either.
      expect(
        screen.queryByText(`${EMAILS} Email threads`),
      ).not.toBeInTheDocument();
    });
  });

  describe("TransactionCard (dead code, reworded)", () => {
    it('reads "5 Emails", never "5 Email threads"', () => {
      render(
        <TransactionCard
          transaction={transaction}
          selectionMode={false}
          isSelected={false}
          onTransactionClick={jest.fn()}
          onCheckboxClick={jest.fn()}
          formatCurrency={formatCurrency}
          formatDate={formatDate}
        />,
      );

      expect(screen.getByText(`${EMAILS} Emails`)).toBeInTheDocument();
      expect(
        screen.queryByText(`${EMAILS} Email threads`),
      ).not.toBeInTheDocument();
    });
  });
});
