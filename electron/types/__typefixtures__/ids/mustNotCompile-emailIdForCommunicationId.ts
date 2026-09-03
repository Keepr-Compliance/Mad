/**
 * CONTROL 2 — fixture B. BACKLOG-3067.
 *
 * Fixture A proves a bare `string` is refused. That is the shape the real defect
 * has today, but its diagnostic can only say "string is not assignable to
 * CommunicationId" — it cannot name the kind of id that was actually passed.
 *
 * This fixture makes the diagnostic name BOTH types, which is the assertion that
 * distinguishes "the brand works" from "some string somewhere was rejected":
 *
 *     Argument of type 'EmailId' is not assignable to parameter of type 'CommunicationId'
 *
 * `declare const` conjures the value with zero runtime and zero fixture setup, so
 * the only thing under test is assignability. An `EmailId` is what
 * `emailDbService.getEmailById()` hands back, so this is not a hypothetical value —
 * it is the exact type the real caller would be holding once the emails it iterates
 * are read through the db layer rather than passed around as bare strings.
 */
import { linkCommunicationToTransaction } from "../../../services/db/communicationDbService";
import type { EmailId, TransactionId } from "../../ids";

declare const emailId: EmailId;
declare const transactionId: TransactionId;

void linkCommunicationToTransaction(emailId, transactionId);
