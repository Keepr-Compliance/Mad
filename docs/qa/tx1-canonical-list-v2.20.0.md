# TX1 (742 Birchwood Lane NE) — Canonical Expected-Linked Email Checklist

Permanent ceremony checklist for the v2.20.0 email auto-link verification.

## Method & caveats

- **Corpus:** `~/Downloads/demo-mailbox/*.eml` (190 files). Headers parsed with Python `email` (RFC 2822), addresses via `getaddresses` over From/To/Cc/**Bcc**.
- **Expected (filter-OFF) rule:** an email is expected iff any From/To/Cc/Bcc address is in the transaction's contact-address set.
- **Contact set (9 addresses) — DB-CONFIRMED** via `transaction_contacts -> contact_emails` on the decrypted QA copy: identical to the list below (no extras, none missing). User's own mailbox address (agent@izzyrescue.org) excluded per app logic.
  - amanda@cascadetitle.com, david.patterson@gmail.com, emily.patt@gmail.com, jennifer@nwpremierrealty.com, kate.mcdonald@cascaderealty.com, lisa.chen@pacificcoastmtg.com, mark.sullivan@pacificcoastmtg.com, rachel@cascadetitle.com, tom@pugetsoundinspections.com
- **Filter-ON (address-mention) rule (mirrors app SQL):** `LOWER(subject || ' ' || body_plain)` contains `742` AND `birchwood` AND `lane` AND `ne` (each as a substring). Street tokens derived from `normalizeAddress('742 Birchwood Lane NE, ...')`. Body decoded from MIME (matches app `body_plain`).
- **Date shift:** corpus Date +12 months (2025 -> 2026).
- **Message-ID:** corpus `.eml` files carry NO Message-ID header; the M365 seed lets Graph assign `internetMessageId` server-side, so DB `message_id_header` will NOT equal any corpus value. Set matching must therefore use (subject, shifted-date), NOT Message-ID.

## Counts

- Expected linked (filter-OFF): **69**
- Address-mention subset (filter-ON): **37**

## Checklist

`DB` column: verified against decrypted QA copy, ceremony transaction `dda5188c-4d5b-48a7-8a51-bd60378cf44b` — **all 69 FOUND, 0 missing, 0 extra**.

| # | .eml file | Subject | Shifted date | Matched contact(s) & role | ON-subset | DB |
|---|-----------|---------|--------------|---------------------------|-----------|----|
| 1 | MISC_09_2025-01-05_sarah_annual-review-lender.eml | Happy New Year! 2025 Goals + Partnership | 2026-01-05 | To:mark.sullivan | no | FOUND |
| 2 | MISC_10_2025-01-06_mark_happy-new-year.eml | Re: Happy New Year! 2025 Goals + Partnership | 2026-01-06 | From:mark.sullivan | no | FOUND |
| 3 | TX2_21_2025-01-31_tom_inspection-maple.eml | Inspection Report - 1523 Maple Ridge Dr SW | 2026-01-31 | From:tom | no | FOUND |
| 4 | TX1_13_2025-02-07_sarah_showing-feedback.eml | 742 Birchwood Lane showing today - thoughts? | 2026-02-07 | To:david.patterson; Cc:emily.patt | YES | FOUND |
| 5 | TX1_14_2025-02-07_emily_love-it.eml | Re: 742 Birchwood Lane showing today - thoughts? | 2026-02-07 | From:emily.patt; Cc:david.patterson | YES | FOUND |
| 6 | TX1_15_2025-02-08_sarah_offer-strategy.eml | Re: 742 Birchwood Lane - Offer Strategy | 2026-02-08 | To:david.patterson; Cc:emily.patt | YES | FOUND |
| 7 | TX1_16_2025-02-08_docusign_offer-signature.eml | Sarah Mitchell sent you a document to review and sign - Purchase and Sale Agreement | 2026-02-08 | To:david.patterson; Cc:emily.patt | YES | FOUND |
| 8 | TX1_18_2025-02-08_sarah_offer-submitted.eml | Offer Submitted - 742 Birchwood Lane NE - Patterson Buyers | 2026-02-08 | To:jennifer; Cc:mark.sullivan | YES | FOUND |
| 9 | TX1_19_2025-02-09_jennifer_mutual-acceptance.eml | RE: 742 Birchwood Lane - MUTUAL ACCEPTANCE! | 2026-02-09 | From:jennifer | YES | FOUND |
| 10 | TX1_20_2025-02-09_sarah_ma-congrats-buyers.eml | 742 Birchwood Lane - YOUR OFFER WAS ACCEPTED! | 2026-02-09 | To:david.patterson; Cc:emily.patt | YES | FOUND |
| 11 | TX1_21_2025-02-09_david_schedule-inspector.eml | Re: 742 Birchwood Lane - YOUR OFFER WAS ACCEPTED! | 2026-02-09 | From:david.patterson | YES | FOUND |
| 12 | TX1_22_2025-02-10_rachel_escrow-opened.eml | Escrow Opened - Patterson/Chen - 742 Birchwood Lane NE \| File: CT-28451 | 2026-02-10 | From:rachel; Cc:amanda,jennifer | YES | FOUND |
| 13 | TX1_23_2025-02-10_amanda_wire-instructions.eml | [SECURE] Wire Instructions - File CT-28451 - Patterson/Chen | 2026-02-10 | To:david.patterson; Cc:emily.patt | no | FOUND |
| 14 | TX1_25_2025-02-10_tom_inspection-confirmed.eml | Inspection Confirmed - 742 Birchwood Lane NE - Wed Feb 12 at 10am | 2026-02-10 | From:tom | YES | FOUND |
| 15 | TX2_25_2025-02-10_lisa_appraisal-ordered-maple.eml | Rivera - Appraisal Ordered - 1523 Maple Ridge Dr SW | 2026-02-10 | From:lisa.chen | no | FOUND |
| 16 | TX3_19_2025-02-10_rachel_escrow-westview.eml | Escrow Opened - Nguyen/Hoffman - 890 Westview Terrace \| CT-28390 | 2026-02-10 | From:rachel; Cc:amanda | no | FOUND |
| 17 | TX1_24_2025-02-11_amanda_emd-received.eml | EMD Received - Patterson/Chen - CT-28451 | 2026-02-11 | From:amanda; Cc:jennifer | no | FOUND |
| 18 | TX4_22_2025-02-12_tom_inspection-sunset.eml | Inspection Report - 3267 Sunset Blvd, Centralia | 2026-02-12 | From:tom | no | FOUND |
| 19 | TX1_26_2025-02-13_tom_inspection-report.eml | Inspection Report - 742 Birchwood Lane NE - Tumwater | 2026-02-13 | From:tom; Cc:david.patterson,emily.patt | YES | FOUND |
| 20 | TX1_27_2025-02-14_sarah_inspection-response-strategy.eml | Re: 742 Birchwood Lane - Inspection Results - My Recommendations | 2026-02-14 | To:david.patterson; Cc:emily.patt | YES | FOUND |
| 21 | TX1_28_2025-02-14_david_go-ahead.eml | Re: 742 Birchwood Lane - Inspection Results - My Recommendations | 2026-02-14 | From:david.patterson | YES | FOUND |
| 22 | TX1_34_2025-02-14_rachel_title-report.eml | Preliminary Title Report - 742 Birchwood Lane NE \| CT-28451 | 2026-02-14 | From:rachel; Cc:amanda,jennifer | YES | FOUND |
| 23 | TX1_29_2025-02-15_sarah_inspection-response-to-jennifer.eml | 742 Birchwood Lane - Buyer Inspection Response | 2026-02-15 | To:jennifer | YES | FOUND |
| 24 | TX1_30_2025-02-17_jennifer_seller-agrees-repairs.eml | Re: 742 Birchwood Lane - Seller Agrees to Repairs | 2026-02-17 | From:jennifer | YES | FOUND |
| 25 | TX2_26_2025-02-17_mark_appraisal-value-maple.eml | Rivera - Appraisal In at Value! - 1523 Maple Ridge Dr SW | 2026-02-17 | From:mark.sullivan | no | FOUND |
| 26 | TX1_36_2025-02-18_kate_docs-received.eml | Re: 742 Birchwood Lane - Docs Received | 2026-02-18 | From:kate.mcdonald | YES | FOUND |
| 27 | TX1_37_2025-02-18_sarah_wire-fraud-signed.eml | Re: 742 Birchwood Lane - Docs Received | 2026-02-18 | To:kate.mcdonald | YES | FOUND |
| 28 | TX5_11_2025-02-19_mark_preapproval-brooks.eml | Pre-Approval Confirmed - Brooks - 4801 Evergreen Way | 2026-02-19 | From:mark.sullivan; Cc:lisa.chen | no | FOUND |
| 29 | TX5_22_2025-02-19_rachel_escrow-evergreen.eml | Escrow Opened - Brooks/Yamamoto - 4801 Evergreen Way \| CT-28475 | 2026-02-19 | From:rachel; Cc:amanda | no | FOUND |
| 30 | TX1_31_2025-02-20_sarah_insurance-reminder.eml | 742 Birchwood Lane - Homeowner's Insurance Needed | 2026-02-20 | To:david.patterson; Cc:emily.patt | YES | FOUND |
| 31 | TX4_25_2025-02-20_lisa_va-loan-status-sunset.eml | Torres VA Loan - Status Update - 3267 Sunset Blvd | 2026-02-20 | From:lisa.chen; Cc:mark.sullivan | no | FOUND |
| 32 | TX1_32_2025-02-24_david_insurance-done.eml | Re: 742 Birchwood Lane - Homeowner's Insurance Needed | 2026-02-24 | From:david.patterson | YES | FOUND |
| 33 | TX4_26_2025-02-25_pest_clear.eml | Pest Inspection Report - 3267 Sunset Blvd, Centralia WA | 2026-02-25 | Cc:lisa.chen | no | FOUND |
| 34 | TX1_33_2025-02-28_lisa_loan-update.eml | Patterson Loan Update - 742 Birchwood Lane - Appraisal Ordered | 2026-02-28 | From:lisa.chen | YES | FOUND |
| 35 | MISC_06_2025-03-01_sarah_kate-multiple-files.eml | Multiple files update - March status | 2026-03-01 | To:kate.mcdonald | no | FOUND |
| 36 | TX4_05_2025-03-01_mark_appraisal-low.eml | Torres/Phillips Estate - Appraisal Below Contract - 3267 Sunset Blvd | 2026-03-01 | From:mark.sullivan; Cc:lisa.chen | no | FOUND |
| 37 | TX1_38_2025-03-05_jennifer_closing-date-change.eml | 742 Birchwood Lane - Closing Date Extension Request | 2026-03-05 | From:jennifer | YES | FOUND |
| 38 | TX1_39_2025-03-05_sarah_ok-delay.eml | Re: 742 Birchwood Lane - Closing Date Extension Request | 2026-03-05 | To:jennifer; Cc:mark.sullivan | YES | FOUND |
| 39 | TX3_07_2025-03-05_rachel_westview-recorded.eml | RECORDED/CLOSED File: CT-28390 - 890 Westview Terrace / Hoffman - Nguyen | 2026-03-05 | From:rachel; Cc:kate.mcdonald | no | FOUND |
| 40 | TX5_26_2025-03-05_mark_appraisal-evergreen.eml | Brooks - VA Appraisal In at Value - 4801 Evergreen Way | 2026-03-05 | From:mark.sullivan; Cc:lisa.chen | no | FOUND |
| 41 | TX1_01_2025-03-10_lisa-chen_appraisal-results-742-birchwood.eml | Patterson/Chen - Appraisal Results - 742 Birchwood Lane NE, Tumwater | 2026-03-10 | From:lisa.chen; To:jennifer; Cc:mark.sullivan | YES | FOUND |
| 42 | TX1_02_2025-03-10_sarah_fwd-appraisal-conditions.eml | Re: Patterson/Chen - Appraisal Results - 742 Birchwood Lane NE, Tumwater | 2026-03-10 | To:jennifer; Cc:lisa.chen | YES | FOUND |
| 43 | TX1_03_2025-03-11_jennifer_seller-contractor-schedule.eml | Re: Patterson/Chen - Appraisal Results - 742 Birchwood Lane NE, Tumwater | 2026-03-11 | From:jennifer; Cc:lisa.chen | YES | FOUND |
| 44 | TX1_04_2025-03-11_sarah_buyer-update-appraisal.eml | 742 Birchwood Lane - Appraisal Update | 2026-03-11 | To:david.patterson; Cc:emily.patt | YES | FOUND |
| 45 | TX1_05_2025-03-12_david_garage-question.eml | Re: 742 Birchwood Lane - Appraisal Update | 2026-03-12 | From:david.patterson; Cc:emily.patt | YES | FOUND |
| 46 | TX1_06_2025-03-12_sarah_contractor-rec-plumber.eml | Re: 742 Birchwood Lane - Appraisal Update | 2026-03-12 | To:david.patterson; Cc:emily.patt | YES | FOUND |
| 47 | TX2_01_2025-03-14_mark_clear-to-close.eml | Clear to Close - Rivera/Wright - 1523 Maple Ridge Dr SW | 2026-03-14 | From:mark.sullivan; Cc:lisa.chen | no | FOUND |
| 48 | MISC_03_2025-03-15_kate_general-docs.eml | Missing W-9s | 2026-03-15 | From:kate.mcdonald | no | FOUND |
| 49 | TX1_07_2025-03-18_mark_repair-status-followup.eml | RE: Repair Status - 742 Birchwood Lane NE, Tumwater | 2026-03-18 | From:mark.sullivan; Cc:jennifer,lisa.chen | YES | FOUND |
| 50 | TX1_08_2025-03-18_jennifer_repairs-complete.eml | RE: Repair Status - 742 Birchwood Lane NE, Tumwater | 2026-03-18 | From:jennifer; To:mark.sullivan; Cc:lisa.chen | YES | FOUND |
| 51 | TX2_02_2025-03-18_diana_released-to-record.eml | File: PT-55291 - 1523 Maple Ridge Dr SW / Rivera - Wright | 2026-03-18 | Cc:mark.sullivan | no | FOUND |
| 52 | TX2_03_2025-03-18_diana_recorded-closed.eml | RECORDED/CLOSED File: PT-55291 - 1523 Maple Ridge Dr SW / Rivera - Wright | 2026-03-18 | Cc:kate.mcdonald,mark.sullivan | no | FOUND |
| 53 | TX2_05_2025-03-18_stephanie_settlement-statement.eml | SS for RIVERA Purchase \| Add 1523 Maple Ridge Dr SW, Olympia WA \| File: PT-55291 | 2026-03-18 | Cc:kate.mcdonald | no | FOUND |
| 54 | TX3_29_2025-03-18_tom_inspection-harbor.eml | Inspection Report - 2145 Harbor View Ct, Shelton | 2026-03-18 | From:tom | no | FOUND |
| 55 | TX5_27_2025-03-18_rachel_prelim-ss-evergreen.eml | Prelim SS - Brooks/Yamamoto \| 4801 Evergreen Way \| CT-28475 | 2026-03-18 | From:rachel; Cc:amanda | no | FOUND |
| 56 | TX1_09_2025-03-19_paperless-pipeline_doc-request.eml | Do you have these documents for this file? - Birchwood Lane NE, 742 Tumwater WA... | 2026-03-19 | Cc:kate.mcdonald | YES | FOUND |
| 57 | TX2_33_2025-03-19_kate_file-complete-maple.eml | File Complete - 1523 Maple Ridge Dr SW - Rivera | 2026-03-19 | From:kate.mcdonald | no | FOUND |
| 58 | MISC_04_2025-03-20_sarah_mark-pipeline-check.eml | Quick Pipeline Check - Our Active Files | 2026-03-20 | To:mark.sullivan | no | FOUND |
| 59 | MISC_05_2025-03-20_mark_pipeline-response.eml | Re: Quick Pipeline Check - Our Active Files | 2026-03-20 | From:mark.sullivan | no | FOUND |
| 60 | TX1_10_2025-03-20_rachel_prelim-settlement.eml | Preliminary SS - Patterson/Chen \| 742 Birchwood Lane NE \| File: CT-28451 | 2026-03-20 | From:rachel; Cc:amanda,jennifer | YES | FOUND |
| 61 | TX1_11_2025-03-21_mark_reinspection-cleared.eml | RE: 742 Birchwood Lane - Reinspection CLEARED - All conditions met | 2026-03-21 | From:mark.sullivan; Cc:jennifer,lisa.chen,rachel | YES | FOUND |
| 62 | TX5_28_2025-03-25_rachel_recorded-evergreen.eml | RECORDED/CLOSED File: CT-28475 - 4801 Evergreen Way / Brooks - Yamamoto | 2026-03-25 | From:rachel; Cc:kate.mcdonald,mark.sullivan | no | FOUND |
| 63 | MISC_11_2025-04-01_sarah_q1-production.eml | Q1 Production Summary Request | 2026-04-01 | To:kate.mcdonald | no | FOUND |
| 64 | MISC_12_2025-04-01_kate_q1-numbers.eml | Re: Q1 Production Summary | 2026-04-01 | From:kate.mcdonald | no | FOUND |
| 65 | TX1_40_2025-04-12_sarah_final-walkthrough.eml | 742 Birchwood Lane - Final Walkthrough Monday April 14 at 4pm | 2026-04-12 | To:david.patterson; Cc:emily.patt | YES | FOUND |
| 66 | TX1_41_2025-04-12_emily_walkthrough-confirmed.eml | Re: 742 Birchwood Lane - Final Walkthrough Monday April 14 at 4pm | 2026-04-12 | From:emily.patt | YES | FOUND |
| 67 | TX1_42_2025-04-14_sarah_walkthrough-complete.eml | Re: 742 Birchwood Lane - Walkthrough Complete - All Good! | 2026-04-14 | To:jennifer | YES | FOUND |
| 68 | TX1_43_2025-04-14_rachel_signing-reminder.eml | SIGNING REMINDER - Patterson/Chen - Tomorrow 4/15 at 10:00 AM \| CT-28451 | 2026-04-14 | From:rachel; Cc:amanda | no | FOUND |
| 69 | TX4_31_2025-04-15_mike_recorded-sunset.eml | RECORDED/CLOSED - Torres - 3267 Sunset Blvd \| HT-9912 | 2026-04-15 | Cc:kate.mcdonald,mark.sullivan | no | FOUND |

## DB verification result (v2.20.0 ceremony, 2026-07-05)

- Ceremony transaction: `dda5188c-4d5b-48a7-8a51-bd60378cf44b` (`property_address='742 Birchwood'`, started 2026-01-01, closed 2026-05-20, created 2026-07-06 05:01Z).
- Linked emails in DB: **69**, all `link_source='auto'` — **EXACT SET MATCH** with this checklist (subject-level multiset diff: 0 missing / 0 extra).
- Replayed auto-link algorithm on the DB (email_participants junction + date range + user-email exclusion): derived OFF = **69** (identical ID set to linked), derived ON (address filter `%742%` AND `%birchwood%` over subject+body_plain) = **37** — both equal to the founder-observed counts. Note: DB `property_address` is `742 Birchwood` (no "Lane NE"), so the effective ON tokens are `742`+`birchwood` only; corpus-side rule with `742 birchwood lane ne` yields the same 37 files.
- Total emails cached: **190** (= corpus size); `email_participants` rows: 523; ghost scan: **0** emails outside 2026-01..2026-05.
- All 190 cached emails have Graph-assigned `message_id_header` (corpus .emls carry none) — matching is by subject/date as documented above.
- Date caveat: 4 checklist rows land +1 day in DB `sent_at` (UTC) because their corpus Date is >= 16:00 -0800 (PST evening rolls into next UTC day): rows for "742 Birchwood Lane showing today" (x2), "Pest Inspection Report - 3267 Sunset Blvd", "Re: 742 Birchwood Lane - Walkthrough Complete". Subjects match exactly; not discrepancies.
- Second (stale) transaction `113c5903-...` (created 04:52Z, same address) holds **81** links = these 69 + 12 Torres-buyer emails (michelle.torres@gmail.com / ryan.torres.mil@gmail.com participants). Those contacts are no longer in its transaction_contacts — links persisted from an earlier assignment during the ceremony. Not the transaction the founder measured.
