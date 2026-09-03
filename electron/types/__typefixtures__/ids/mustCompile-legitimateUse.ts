/**
 * CONTROL 3 — fixture C, the must-NOT-fire case. BACKLOG-3067.
 *
 * A brand nothing can satisfy passes controls 1 and 2 and is worthless. Worse: a
 * brand that breaks ORDINARY STRING USE gets cast away everywhere inside a week,
 * at which point the repo carries the ceremony and none of the guarantee. So this
 * fixture is deliberately as long as the failing ones, and it must compile with
 * **exit 0 and zero casts**, under the same compiler settings as A and B — which
 * is also what proves A and B fail because of the brand rather than because the
 * fixture environment is broken.
 *
 * Two things are under test here:
 *   1. Satisfiability — the legitimate path from a database read into the write.
 *   2. Erasure — a branded id is still a `string` in every position a string is
 *      legitimate. (Runtime erasure is a separate proof:
 *      electron/types/__tests__/brandedIds.runtimeIdentity.test.ts.)
 */
import {
  createCommunication,
  getCommunicationById,
  linkCommunicationToTransaction,
} from "../../../services/db/communicationDbService";
import { getTransactionById } from "../../../services/db/transactionDbService";
import { getEmailById } from "../../../services/db/emailDbService";
import type { CommunicationId, EmailId } from "../../ids";
import type { NewCommunication } from "../../models";

// ---------------------------------------------------------------------------
// 1. SATISFIABILITY — the ordinary path, with no cast anywhere in it.
// ---------------------------------------------------------------------------

/** Read the row, then write. The read is what earns the brand. */
export async function relinkByReading(
  rawCommunicationId: string,
  rawTransactionId: string,
): Promise<void> {
  // The lookups take plain `string` on purpose — a renderer id, an IPC argument,
  // a value off a URL. Nothing has to be branded to ASK.
  const communication = await getCommunicationById(rawCommunicationId);
  const transaction = await getTransactionById(rawTransactionId);
  if (!communication || !transaction) return;

  // ...and the write demands brands, which both rows already carry. No cast.
  await linkCommunicationToTransaction(communication.id, transaction.id);
}

/** A freshly created row is branded at birth, so it can be written immediately. */
export async function linkOnCreate(
  data: NewCommunication,
  rawTransactionId: string,
): Promise<void> {
  const created = await createCommunication(data);
  const transaction = await getTransactionById(rawTransactionId);
  if (!transaction) return;
  await linkCommunicationToTransaction(created.id, transaction.id);
}

/** An email read yields an EmailId, which is a different type — and still a string. */
export async function emailIdIsItsOwnKind(rawEmailId: string): Promise<string> {
  const email = await getEmailById(rawEmailId);
  if (!email) return "";
  const id: EmailId = email.id;
  return id;
}

/** A branded row is still assignable to the unbranded type it extends. */
export async function rowFlowsIntoUnbrandedShape(
  rawCommunicationId: string,
): Promise<{ id: string; transaction_id?: string } | null> {
  return await getCommunicationById(rawCommunicationId);
}

// ---------------------------------------------------------------------------
// 2. ERASURE — every ordinary thing you do with a string must still work.
// ---------------------------------------------------------------------------

declare const id: CommunicationId;
declare function takesAPlainString(value: string): void;
declare function logContext(context: Record<string, unknown>): void;

// Passed to a plain `string` parameter.
takesAPlainString(id);

// Template literal.
export const inATemplate = `communication ${id} was linked`;

// Concatenation.
export const concatenated: string = id + "-suffix";

// Serialised — this is how ids reach the renderer and the logs.
export const serialised = JSON.stringify({ communicationId: id });
logContext({ communicationId: id });

// String methods and properties.
export const upper: string = id.toUpperCase();
export const startsWithPrefix: boolean = id.startsWith("comm-");
export const width: number = id.length;
export const sliced: string = id.slice(0, 8);

// Object key, Map key, Set member — the three ways ids get used as identities.
export const asObjectKey: Record<string, number> = { [id]: 1 };
export const inAMap = new Map<CommunicationId, number>([[id, 1]]);
export const readBack: number | undefined = inAMap.get(id);
export const inAStringKeyedMap = new Map<string, number>([[id, 1]]);
export const inASet = new Set<string>([id]);

// Comparison against a string, and membership in a string array.
export const equalsALiteral: boolean = id === "some-uuid";
export const inAnArray: boolean = ["a", "b"].includes(id);

// Collected into a plain string array — the shape most call sites actually use.
export const collected: string[] = [id];

// Narrowing and optional chaining behave normally.
declare const maybeId: CommunicationId | null;
export const narrowed: string = maybeId ? maybeId : "none";
export const chained: number | undefined = maybeId?.length;
