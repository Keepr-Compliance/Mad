# BACKLOG-3797 — installed admin portal, phone checklist

Run on the Vercel preview of this branch, on **an iPhone (Safari) AND an Android phone (Chrome)**.
Copy this list into the PR body and tick it per phone.

**Any failure in item 3 = STOP.** Report it on the backlog item; ship no workaround without SR re-review.

1. **Install.** iPhone: Share > Add to Home Screen. Android: menu > Install app. The icon shows the K mark; the label reads "Keepr Admin".
   If either phone truncates the label (for example "Keepr Ad…"), record it: the fix is short_name and the iOS title "Admin" (name stays "Keepr Admin").
2. **Opens as an app.** No browser address bar. Status bar is dark. The top bar is not under the notch.
3. **Sign-in inside the installed app** — run each of these, signed out first:
   - [ ] iPhone — Microsoft
   - [ ] iPhone — Google
   - [ ] Android — Microsoft
   - [ ] Android — Google

   Each must end signed in, on the dashboard, **inside the installed app**.
   **Accepted, not a fail:** on iPhone a browser bar may show after the sign-in redirect until the app is relaunched.
   Fail if:
   - (a) the app lands on `/login?error=auth_failed`;
   - (b) sign-in finishes in Safari / Chrome instead, and the installed app is still on `/login`;
   - (c) Microsoft hands off to the Microsoft Authenticator app and never comes back;
   - (d) after kill and reopen (below) the app is signed out.

   Then, on each phone: kill the app from the app switcher, reopen it — **still signed in**.
4. **Ticket reply.** Open a support ticket, tap the reply box: the page does not zoom, and the box is above the keyboard.
5. **Offline screen.** Airplane mode, open a page: the "You're offline" screen shows and names Keepr Admin. Network back on, tap Retry: the page loads.
6. **Nothing shown after sign-out.** Sign out in the app, turn on airplane mode, reopen the app: the offline screen shows, with no user or organization data visible.
7. **Signed out lands on login.** Signed out, network on, open the app: it lands on `/login`.
8. **Non-staff account is refused, not shown as offline.** If an account without an internal role is available: sign in with it in the installed app. The login page shows the "not authorized" message, inside the app — never the offline screen. If no such account is available, record "not run" here.
9. **Clean up.** Delete the preview icon after QA. Reinstall from the production domain after release.

Desktop Chrome DevTools on the preview, once:
- Application > Manifest: no installability errors; maskable preview keeps the whole mark.
- Application > Service Workers: `/sw.js` activated, scope `/`.
- Application > Cache Storage: **0 entries** after browsing dashboard, users and a ticket.
- Network > Offline, reload: the offline screen.
- `curl -sI <preview>/sw.js` shows `Cache-Control: no-cache, no-store, must-revalidate`; `curl -sI <preview>/login` CSP contains `manifest-src 'self'`.

Not changed by this PR: the browser's own HTTP cache behaves as it does in mobile Safari / Chrome today.
