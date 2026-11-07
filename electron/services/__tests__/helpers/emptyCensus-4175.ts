/**
 * BACKLOG-4175: the census input for tests that do not look at the census.
 * `scoreRun` requires one, so the production handler cannot leave it out.
 */
import { BUNDLED_SENDER_RULES } from "../../../utils/senderFilter/bundledRules";
import { NO_KEEP } from "../../../utils/senderFilter/senderFilter";
import type { SenderCensusInput } from "../../learn/scoring";

export const EMPTY_CENSUS: SenderCensusInput = { rules: BUNDLED_SENDER_RULES, keep: NO_KEEP, linked: [] };
