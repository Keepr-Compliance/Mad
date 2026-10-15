/** Shared display helpers for billing blocks 4–6 (BACKLOG-3848). UTC, so server and browser agree. */

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}

export function formatUnixDay(sec: number): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(sec * 1000)
  );
}

const BRANDS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
};

export function cardLabel(c: { brand: string; last4: string }): string {
  return `${BRANDS[c.brand] ?? 'Card'} •••• ${c.last4}`;
}
