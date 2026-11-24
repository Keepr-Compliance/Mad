# Two-session lock wait for T-N (dry-run database only; NOT run without the coordinator's go)

What one call cannot show: while T-N's transaction holds its lock, a new connect waits, and an approval-page view after
T-N commits answers version 2. These scripts show the first half only, because nothing here commits T-N: session 1
applies T-N's text and holds it for 6 seconds, then RAISEs (rolled back); session 2, started about 1 second later,
begins a request and must wait until session 1 ends (about 5 seconds), then sees version 1 (T-N was rolled back).

1. `nas-sql session1.sql > s1.txt &` (guarded copy; marker substituted as for the harness).
2. After 1 second: `nas-sql session2.sql > s2.txt`.
3. Expected: s2 reports `waited_ms` >= 4000 and `version` 1; s1 ends `T4263N_SESSION1_DONE`. Both end `kt-sql: HTTP 400`.
The expiry-before-lock order (a request begun and viewed while T-N runs) is the same shape with session 2 also viewing;
add it only with the same go.
