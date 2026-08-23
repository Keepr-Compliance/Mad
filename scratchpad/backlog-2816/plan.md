## BACKLOG-2816 (SEARCH HALF) — implementation plan

**Branch:** `feat/BACKLOG-2816-group-name-search` from `21ce7e006` (approved head of PR #2368 / BACKLOG-2814). Stacks on #2368; merges after it.

**Scope:** SEARCH ONLY. Export / submission / audit-package filenames (items 1-3 of the item body) are NOT in this PR — they depend on the export-naming work in PR #2369 and land separately.

### Surface census (verified in code, not assumed)

Typed-query surfaces over text threads — 3 UI entry points, 4 predicates:

| # | Surface | Predicate | Fix |
|---|---------|-----------|-----|
| 1 | Attach-Messages picker (contact roster) | `AttachMessagesModal.tsx:455-467` (renderer, `MergedContact`) | widen filter + plumb names |
| 2 | Global search, Texts group (`TransactionList`) | `buildGlobalTextQuery` `transactionSearchDbService.ts:766-767` | add EXISTS clause |
| 2b | Global search, Unattached bucket | `buildUnattachedTextQuery` `:912-913` | add EXISTS clause |
| 3 | Transaction-scoped search, Texts group (Overview tab) | `buildTextQuery` `:403-404` | add EXISTS clause |

Checked and NOT search surfaces (no typed input over threads): Texts tab in transaction detail (date-range filter only, no `<input>`); review / needs-review queues (filter by `kind`); removed-messages section (no search box); `conversationHandlers.get-conversations` (userId only, no query param); export / submit modals (date ranges only); contact-side searches (`Contacts`, `ContactSearchList`, `LinkSourceSearch`, `ContactAssignmentStep`, `contactPickerList`) search people, not threads; `AttachEmailsModal` and `searchLocalEmailCache` are email-side.

Note vs the item body: the body says two queries read `message_thread_names`; the verified count on this base is **three** (`communicationDbService.ts:805`, `emailLinkingHandlers.ts:637`, `reviewStateService.ts:424`). The body predates #2368's final commits. Does not change the work.

### Changes

**A. `electron/services/db/transactionSearchDbService.ts`**
- New predicate constant `TEXT_THREAD_NAME_MATCH`, mirroring `TEXT_ATTACHMENT_MATCH`:
  `EXISTS (SELECT 1 FROM message_thread_names tn WHERE tn.thread_id = m.thread_id AND tn.user_id = m.user_id AND tn.display_name LIKE ? ESCAPE '\')`
  Join key is `(user_id, thread_id)` — the table PK. macOS thread ids are unique per machine only; a `thread_id`-only join leaks one user's group name into another's search results. All three existing joins carry this rule.
- Add `OR ${TEXT_THREAD_NAME_MATCH}` to the match block of `buildTextQuery`, `buildGlobalTextQuery`, `buildUnattachedTextQuery`; append one `pat` to each builder's whereParams/matchParams. Each builder shares its `where`/`match` string between `sql` and `countSql`, so rows and totals cannot drift.
- Semantics: `LIKE '%term%'` on the same escaped pattern as body/participants — case-insensitive for ASCII, substring, identical rule to the neighbouring clauses. No fuzzy, no scoring, no new projection.

**B. Attach-Messages picker (renderer filter + its data)**
- `messageDbService.getMessageContacts` returns `threadNames: string[]` per roster entry — distinct group names of the unlinked sms/imessage threads that contact appears in. Second query (not a `group_concat`) so message counts cannot fan out and a name containing a comma cannot be mis-split; same `transaction_id IS NULL` / channel / reaction-exclusion filters as the roster query itself, joined on `(user_id, thread_id)`.
- Pass-through, unchanged in meaning: `databaseService.getMessageContacts` -> `transactionService.getMessageContacts` (preserve `threadNames` through the name-enrichment map) -> `transactions:get-message-contacts` handler -> `window-api-transactions` type.
- `AttachMessagesModal`: `ContactInfo` and `MergedContact` gain `threadNames`; the merge unions them across a contact's handles; the filter gains `c.threadNames.some(n => n.toLowerCase().includes(query))` — same `toLowerCase().includes` rule as the existing `displayName` clause.

### Controls (one per surface; each must be measured, not assumed)

Real-driver suite (Electron runner) against a real sqlite db, mirroring `reviewStateService.threadNameIsolation-2814.test.ts`:
1. `buildTextQuery`: a linked thread whose only possible match is its group name is returned — assert the exact **id set**, not a count.
2. `buildGlobalTextQuery`: same, global scope.
3. `buildUnattachedTextQuery`: same, unattached bucket.
4. Each of the three: an unnamed group is unaffected; a 1:1 thread is unaffected; a body/participant query returns exactly what it returned before.
5. Cross-user isolation: another user's name on the same `thread_id` does NOT make the thread findable.
6. Modal (RTL): a roster entry whose only match is a group name is shown — assert by entry identity; entries with no thread names unaffected; a contact-name query matches as before.

Mutation, run and recorded per surface: delete the clause from ONE builder -> only that builder's test reds. Delete the modal's `threadNames` clause -> only the modal test reds. Replace `tn.user_id = m.user_id` with `1=1` -> the isolation test reds.

PII: invented group names in fixtures only; `npm run check:pii` before push.

### Gates
`npm run type-check`, `type-check:electron`, `type-check:tests`, `lint`, `npm run build`, affected suites under both the mocked-driver jest tier and the Electron real-driver runner.
