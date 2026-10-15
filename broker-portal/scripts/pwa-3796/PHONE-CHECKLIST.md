# BACKLOG-3796 — installed portal, phone checklist

Run on the Vercel preview of this branch, on **an iPhone (Safari) AND an Android phone (Chrome)**.
Copy this list into the PR body and tick it per phone.

**Any failure in item 3 = STOP.** Report it on the backlog item; ship no workaround without SR re-review.

1. **Install.** iPhone: Share > Add to Home Screen. Android: menu > Install app. The icon shows the K mark; the label reads "Keepr".
2. **Opens as an app.** No browser address bar. Status bar is dark. The top bar is not under the notch.
3. **Sign-in inside the installed app** — run each of these, signed out first:
   - [ ] iPhone — Microsoft
   - [ ] iPhone — Google
   - [ ] Android — Microsoft
   - [ ] Android — Google

   Each must end signed in, on the dashboard, **inside the installed app**. Watch for:
   - (a) the app lands on `/login?error=auth_failed`;
   - (b) sign-in finishes in Safari / Chrome instead, and the installed app is still on `/login`;
   - (c) Microsoft hands off to the Microsoft Authenticator app and never comes back.

   Then, on each phone: kill the app from the app switcher, reopen it — **still signed in**.
4. **Review bar.** Open a submission: the review bar is fully visible and Reject is tappable above the home indicator.
5. **Offline screen.** Airplane mode, open a submission: the "You're offline" screen shows. Network back on, tap Retry: the page loads.
6. **Nothing shown after sign-out.** Sign out in the app, turn on airplane mode, reopen the app: the offline screen shows, with no transaction or user data visible.
7. **Signed out lands on login.** Signed out, network on, open the app: it lands on `/login`.
8. **Clean up.** Delete the preview icon after QA. Reinstall from the production domain after release.

Desktop Chrome DevTools on the preview, once:
- Application > Manifest: no installability errors; maskable preview keeps the whole mark.
- Application > Service Workers: `/sw.js` activated, scope `/`.
- Application > Cache Storage: **0 entries** after browsing dashboard, a submission and users.
- Network > Offline, reload: the offline screen.
- `curl -sI <preview>/sw.js` shows `Cache-Control: no-cache, no-store, must-revalidate`; `curl -sI <preview>/dashboard` CSP contains `manifest-src 'self'`.

Not changed by this PR: the browser's own HTTP cache behaves as it does in mobile Safari / Chrome today.
