/**
 * Result shapes of the Keepr MCP data tools (BACKLOG-4244), version 1.
 *
 * Deal shape source: supabase/contracts/cloud-deal-shape-v1.json. Identity follows its identity.rule:
 * a deal is found by deal_id (cloud_deals.id) only; source_install_id only labels a deal (saved_from)
 * and a deal without one is returned with saved_from null. deal.details, the email and phone elements
 * and details_withheld follow its deal.details and party sections (parity test:
 * __tests__/mcp/data-tools-parity.test.ts).
 *
 * One description per shape gives both:
 * - the strict check of what the database returns (`checkShape`): exactly these keys, these types;
 *   anything else is treated as a failed call. A change of keys or types in the readers changes `v`
 *   (supabase/migrations/20261114110000_backlog_4244_mcp_data_tools.sql), and this file with it.
 * - the declared `outputSchema` (`toJsonSchema`): every key required; objects do not forbid extra keys,
 *   so a key added in a later version does not fail a client that validates against a cached schema.
 *
 * Version rule: the portal accepts only the `v` values listed here (an unknown `v` is a failed call), and
 * never an unknown key inside a known `v`. Any change to a result shape changes `v`. Deploy order for a
 * shape change: (1) the portal accepting v and v+1, (2) the migration emitting v+1, (3) the portal
 * without v. For this first version: the migration is applied to the database first, then the portal
 * change is merged.
 */

export type Shape =
  | { t: 'string'; nullable?: boolean; pattern?: RegExp; values?: readonly string[] }
  | { t: 'integer'; nullable?: boolean; values?: readonly number[] }
  | { t: 'number'; nullable?: boolean }
  | { t: 'boolean'; nullable?: boolean }
  | { t: 'object'; props: Readonly<Record<string, Shape>> }
  | { t: 'array'; items: Shape };

const str = (nullable = false): Shape => ({ t: 'string', nullable });
const int = (nullable = false): Shape => ({ t: 'integer', nullable });
const bool = (nullable = false): Shape => ({ t: 'boolean', nullable });
const num = (): Shape => ({ t: 'number', nullable: true });
const obj = (props: Record<string, Shape>): Shape => ({ t: 'object', props });
const arr = (items: Shape): Shape => ({ t: 'array', items });
const oneOf = (values: readonly string[], nullable = false): Shape => ({ t: 'string', values, nullable });

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const id = (): Shape => ({ t: 'string', pattern: UUID });
const day = (): Shape => ({ t: 'string', pattern: DAY, nullable: true });
const instant = (nullable = false): Shape => ({ t: 'string', pattern: INSTANT, nullable });

const DEAL_BASE = {
  deal_id: id(),
  address: str(true),
  street: str(true),
  city: str(true),
  state: str(true),
  zip: str(true),
  transaction_type: str(true),
  status: str(true),
  started_on: day(),
  closed_on: day(),
  found_by: oneOf(['person', 'keepr'], true),
  locked: str(true),
  saved_at: instant(),
  fully_saved_at: instant(true),
  copy_state: oneOf(['never_fully_saved', 'fully_saved', 'changed_since_full_save']),
  saved_from: int(true),
};

const frame = (kind: string, props: Record<string, Shape>): Shape =>
  obj({ kind: oneOf([kind]), v: { t: 'integer', values: [1] }, about: str(), ...props });

/** the date keys of deal.details, also returned on each list_deals row as deadlines */
export const DEADLINE_PROPS = {
  mutual_acceptance_date: day(),
  inspection_deadline: day(),
  financing_deadline: day(),
  closing_deadline: day(),
  representation_start_date: day(),
};

export const LIST_DEALS_SHAPE = frame('keepr.list_deals', {
  copy: obj({ deals_saved: int(), not_shown_unconfirmed: int(), newest_saved_at: instant(true), computers: int() }),
  deals: arr(obj({ ...DEAL_BASE, deadlines: obj(DEADLINE_PROPS), people: int(), todos_open_required: int(), todos_total: int() })),
  page: obj({ limit: int(), next_cursor: str(true) }),
});

/** deal.details keys (the contract's deal.details.keys without v, which is details_version) */
export const DETAILS_PROPS = {
  listing_price: num(),
  sale_price: num(),
  earnest_money_amount: num(),
  commission_offered_rate: num(),
  commission_actual_rate: num(),
  commission_gross_amount: num(),
  ...DEADLINE_PROPS,
  stage: str(true),
  submission_status: str(true),
  export_status: str(true),
};

export const EMAIL_PROPS = { email: str(true), is_primary: bool(true), label: str(true) };
export const PHONE_PROPS = { e164: str(true), display: str(true), is_primary: bool(true), label: str(true) };
export const PERSON_PROPS = {
  person_id: id(),
  details_withheld: bool(),
  name: str(true),
  company: str(true),
  role: str(true),
  role_category: str(true),
  specific_role: str(true),
  is_primary: bool(true),
  emails: arr(obj(EMAIL_PROPS)),
  phones: arr(obj(PHONE_PROPS)),
  notes: str(true),
  contact_deleted: bool(),
};

export const GET_DEAL_SHAPE = frame('keepr.get_deal', {
  deal: obj({ ...DEAL_BASE, details_version: { t: 'integer', values: [1], nullable: true }, details: obj(DETAILS_PROPS) }),
  people: arr(obj(PERSON_PROPS)),
  people_total: int(),
  people_returned: int(),
});

export const CHECKLISTS_SHAPE = frame('keepr.get_deal_checklists', {
  deal_id: id(),
  checklists: arr(
    obj({
      checklist_id: id(),
      name: str(true),
      private: bool(),
      items: arr(
        obj({
          item_id: id(),
          title: str(true),
          description: str(true),
          required: bool(true),
          done: bool(true),
          done_at: instant(true),
          note: str(true),
          expected_document: str(true),
        })
      ),
    })
  ),
  items_total: int(),
  items_open_required: int(),
  items_returned: int(),
  more: bool(),
});

export const STATUS_SHAPE = obj({
  connected: bool(),
  provider: oneOf(['anthropic', 'openai']),
  entitled: bool(),
  reason: str(true),
  protocolVersion: str(),
  serverVersion: str(),
});

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** true when v has exactly the shape: every key present, no other key, every type as stated. */
export function checkShape(v: unknown, s: Shape): boolean {
  switch (s.t) {
    case 'object': {
      if (!isPlainObject(v)) return false;
      const keys = Object.keys(s.props);
      if (Object.keys(v).length !== keys.length) return false;
      return keys.every((k) => Object.prototype.hasOwnProperty.call(v, k) && checkShape(v[k], s.props[k]));
    }
    case 'array':
      return Array.isArray(v) && v.every((x) => checkShape(x, s.items));
    case 'string':
      if (v === null) return s.nullable === true;
      return typeof v === 'string' && (!s.pattern || s.pattern.test(v)) && (!s.values || s.values.includes(v));
    case 'integer':
      if (v === null) return s.nullable === true;
      return typeof v === 'number' && Number.isInteger(v) && (!s.values || s.values.includes(v));
    case 'number':
      if (v === null) return s.nullable === true;
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      if (v === null) return s.nullable === true;
      return typeof v === 'boolean';
  }
}

type JsonSchema = Record<string, unknown>;

/** The declared JSON Schema of a shape. Objects list every key as required and do not forbid others. */
export function toJsonSchema(s: Shape): JsonSchema {
  switch (s.t) {
    case 'object':
      return {
        type: 'object',
        properties: Object.fromEntries(Object.entries(s.props).map(([k, p]) => [k, toJsonSchema(p)])),
        required: Object.keys(s.props),
      };
    case 'array':
      return { type: 'array', items: toJsonSchema(s.items) };
    default: {
      const type = s.nullable ? [s.t, 'null'] : s.t;
      const out: JsonSchema = { type };
      if ('values' in s && s.values) out.enum = s.nullable ? [...s.values, null] : [...s.values];
      return out;
    }
  }
}
