/**
 * Splits a submission's formatted address into the two lines the list shows:
 * street, and "City, ST ZIP" (BACKLOG-3904).
 *
 * Stored shape: `property_address` is the full formatted string
 * ("<street>, <city>, <ST> <zip>, USA"); `property_city` and `property_state`
 * are separate columns. Anything that does not parse falls back to the whole
 * address on line 1 and the existing "city, state" on line 2.
 */

export interface AddressLines {
  /** Line 1. Never empty. */
  street: string;
  /** Line 2. Null when there is nothing to show, so the caller omits the line. */
  cityLine: string | null;
}

const COUNTRY = /^(USA|US|United States( of America)?)$/i;
const STATE_ZIP = /^([A-Za-z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/;
const NO_ADDRESS = 'Address unavailable';

function clean(value: string | null | undefined): string {
  const text = (value ?? '').trim();
  return text === 'undefined' || text === 'null' ? '' : text;
}

function fallback(address: string, city: string, state: string): AddressLines {
  const cityLine = [city, state].filter(Boolean).join(', ');
  return { street: address || cityLine || NO_ADDRESS, cityLine: address && cityLine ? cityLine : null };
}

export function formatUsAddress(
  rawAddress: string | null | undefined,
  rawCity: string | null | undefined,
  rawState: string | null | undefined
): AddressLines {
  const address = clean(rawAddress);
  const city = clean(rawCity);
  const state = clean(rawState);

  const segments = address.split(',').map((s) => s.trim()).filter(Boolean);
  if (segments.length > 1 && COUNTRY.test(segments[segments.length - 1])) segments.pop();
  // street + city + "ST zip" is the least that can be a US address.
  if (segments.length < 3) return fallback(address, city, state);

  const tail = STATE_ZIP.exec(segments[segments.length - 1]);
  if (!tail) return fallback(address, city, state);

  const citySegment = segments[segments.length - 2];
  // A missing city column never equals a (non-empty) segment, so it falls back here too.
  if (citySegment.toLowerCase() !== city.toLowerCase()) return fallback(address, city, state);

  // Everything before the city is the street, so "Unit 2" stays on line 1.
  const street = segments.slice(0, -2).join(', ');
  const zip = tail[2] ?? '';
  const cityLine = `${city}, ${(state || tail[1]).toUpperCase()}${zip ? ` ${zip}` : ''}`;
  return { street, cityLine };
}
