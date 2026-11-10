/**
 * BACKLOG-4181: THE FINAL GATE for Sentry Logs — a transport wrapper that
 * rebuilds every log item at SEND time.
 *
 * Why the transport and not `beforeSendLog`: three paths never reach
 * `beforeSendLog` or reach it too early —
 *   - scope attributes are merged at serialization, after it returns;
 *   - renderer / utility logs are pushed straight into main's log buffer;
 *   - a log captured while sharing was ON waits in the buffer (up to 5 s) or
 *     in the sealed offline queue across launches.
 * All of them converge on the transport.
 *
 * Composition (installSentry.ts):
 *   filterDiagnosticLogs(makeElectronOfflineTransport(
 *     gateBaseTransport(filterDiagnosticLogs(makeElectronTransport))))
 * The OUTER copy means the offline queue only ever stores filtered logs; the
 * INNER copy re-checks the live switch and the device id when the queue is
 * replayed (the sealed store hands back a parsed envelope, the same shape).
 *
 * For each envelope item of type "log":
 *   - dropped entirely while "Share diagnostics with Keepr" is OFF;
 *   - otherwise only logs with `keepr.diag === true`, a known `keepr.op` and
 *     `keepr.deviceId` equal to the CURRENT device id are kept;
 *   - each kept log is rebuilt: body := op; attributes := only the keys
 *     allowed for that op, each value re-validated;
 *   - an item left with no logs is removed.
 * Non-log items (events, sessions, client reports) pass through untouched. An
 * envelope left with no items answers 200 without a request, so the offline
 * wrapper does not queue it. The envelope handed in is never mutated.
 */

import { DIAG_BASE_FORMATS, DIAG_STRING_FIELDS, allowedAttributeKeys } from "./fields";
import { getDiagnosticsDeviceId, isDiagnosticsSharingEnabled } from "../diagnosticsSharingPreference";

type ItemHeader = { type?: unknown; item_count?: unknown; [key: string]: unknown };
type EnvelopeItem = [ItemHeader, unknown];
type Envelope = [Record<string, unknown>, EnvelopeItem[]];
type SerializedAttribute = { value?: unknown; type?: unknown };
type SerializedLog = {
  timestamp?: unknown;
  level?: unknown;
  trace_id?: unknown;
  severity_number?: unknown;
  attributes?: Record<string, SerializedAttribute | undefined>;
};

const BASE_FORMATS: Record<string, RegExp> = DIAG_BASE_FORMATS;

function attrValue(attrs: SerializedLog["attributes"], key: string): unknown {
  const a = attrs?.[key];
  return a && typeof a === "object" ? a.value : undefined;
}

function valueAllowed(key: string, value: unknown): boolean {
  if (key === "keepr.diag") return value === true;
  if (key === "keepr.op") return typeof value === "string";
  if (key === "sentry.timestamp.sequence") return typeof value === "number" && Number.isInteger(value);
  const base = BASE_FORMATS[key];
  if (base) return typeof value === "string" && base.test(value);
  const field = key.startsWith("keepr.") ? key.slice("keepr.".length) : key;
  const format = DIAG_STRING_FIELDS[field];
  if (format) return typeof value === "string" && format.test(value);
  return (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean";
}

function rebuildLog(raw: unknown, deviceId: string): SerializedLog | null {
  if (!raw || typeof raw !== "object") return null;
  const log = raw as SerializedLog;
  const attrs = log.attributes;
  if (attrValue(attrs, "keepr.diag") !== true) return null;
  const op = attrValue(attrs, "keepr.op");
  if (typeof op !== "string") return null;
  const allowed = allowedAttributeKeys(op);
  if (!allowed) return null;
  if (attrValue(attrs, "keepr.deviceId") !== deviceId) return null;
  const out: Record<string, SerializedAttribute> = {};
  for (const [key, attr] of Object.entries(attrs ?? {})) {
    if (!allowed.has(key) || !attr || typeof attr !== "object") continue;
    if (!valueAllowed(key, attr.value)) continue;
    out[key] = { value: attr.value, type: attr.type };
  }
  const rebuilt: SerializedLog & { body: string } = {
    timestamp: log.timestamp,
    level: log.level,
    body: op,
    attributes: out,
  };
  if (typeof log.trace_id === "string") rebuilt.trace_id = log.trace_id;
  if (typeof log.severity_number === "number") rebuilt.severity_number = log.severity_number;
  return rebuilt;
}

/** Filter one envelope's log items. Returns a NEW envelope, or null when nothing is left. */
export function filterEnvelopeLogs(envelope: Envelope): Envelope | null {
  const [headers, items] = envelope;
  const enabled = isDiagnosticsSharingEnabled();
  const deviceId = enabled ? getDiagnosticsDeviceId() : "";
  const kept: EnvelopeItem[] = [];
  for (const item of items) {
    const [header, payload] = item;
    if (header?.type !== "log") {
      kept.push(item);
      continue;
    }
    if (!enabled) continue;
    const logs = (payload as { items?: unknown } | null)?.items;
    if (!Array.isArray(logs)) continue;
    const rebuilt = logs.map((l) => rebuildLog(l, deviceId)).filter((l): l is SerializedLog => l !== null);
    if (rebuilt.length === 0) continue;
    kept.push([{ ...header, item_count: rebuilt.length }, { items: rebuilt }]);
  }
  return kept.length > 0 ? [headers, kept] : null;
}

/**
 * Wrap a transport factory so log items are filtered before `send`. Every
 * other member (flush) is passed through.
 */
export function filterDiagnosticLogs<O, T extends { send: (envelope: never) => PromiseLike<unknown> }>(
  makeBase: (options: O) => T,
): (options: O) => T {
  return (options: O): T => {
    const base = makeBase(options);
    return {
      ...base,
      send: ((envelope: Envelope) => {
        // Not an envelope this filter can read (no item list): it holds no log
        // items it could recognise, so it is handed on unchanged.
        if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) {
          return base.send(envelope as never);
        }
        let filtered: Envelope | null;
        try {
          filtered = filterEnvelopeLogs(envelope);
        } catch {
          // A filter that throws must never let an unfiltered log out: drop
          // the log items, keep the rest.
          const rest = envelope[1].filter((item) => !Array.isArray(item) || item[0]?.type !== "log");
          filtered = rest.length > 0 ? [envelope[0], rest] : null;
        }
        return filtered ? base.send(filtered as never) : Promise.resolve({ statusCode: 200 });
      }) as T["send"],
    };
  };
}
