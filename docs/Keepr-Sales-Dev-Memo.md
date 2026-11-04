# Keepr -- Technical Product Memo for Sales

**Audience:** Sales team (with supplemental technical notes for curious prospects)
**Date:** February 2026
**Classification:** Internal / Shareable with prospects

---

## What Is Keepr?

Keepr is a desktop application that automatically captures, organizes, and audits the communications surrounding a real estate transaction. Agents install it on their Mac or PC, connect their email and phone, and the software builds a complete, exportable audit trail for every deal -- with minimal manual effort.

A companion **Broker Portal** (web-based) lets managing brokers and compliance teams review, approve, and archive agent submissions from any browser.

---

## The Problem We Solve

Real estate agents juggle dozens of deals across email, text, and iMessage. When a compliance audit or legal dispute arises, they have to manually reconstruct months of scattered communications. This process is slow, error-prone, and expensive.

Keepr eliminates that pain by doing three things automatically:

1. **Capture** -- Pulls in emails from Gmail and Outlook, plus SMS and iMessage from their iPhone.
2. **Organize** -- Uses AI to detect transactions, link messages to deals, identify participants, and track deal stages.
3. **Export** -- Generates professional audit packages (PDF, Excel, ZIP) ready for compliance review or legal discovery.

---

## Key Capabilities

### Email & Message Ingestion

- Connects to **Gmail** and **Microsoft 365 / Outlook** via official OAuth APIs -- no passwords stored, no email forwarding required.
- Imports **SMS and iMessage** history from iPhone backup, including group chats and attachments.
- **Incremental sync** keeps the mailbox current in the background without re-downloading everything.
- Built-in **deduplication** ensures no message appears twice, even if it exists in multiple mailboxes.

> *Technical note:* Deduplication uses RFC 5322 Message-ID headers as the primary key, with SHA-256 content hashing as a fallback for messages missing headers. Sync is stateful -- only new or changed messages are fetched on subsequent runs.

### AI-Powered Transaction Detection

- Automatically identifies real estate transactions from email content -- no manual tagging required.
- Extracts property address, sale price, key dates, and transaction stage (pre-listing, active, under contract, pending, closed).
- Assigns contacts to roles: buyer, seller, buyer's agent, listing agent, title company, lender, etc.
- Every AI classification includes a **confidence score**, so users can quickly review low-confidence items.

> *Technical note:* Analysis runs through Claude (Anthropic) and OpenAI models with configurable provider selection. All processing happens locally on the user's machine -- message content is sanitized of PII before any data reaches an external LLM API. Prompts are versioned and batched for cost efficiency.

### Contact Management

- Imports contacts from **iPhone**, **macOS Contacts**, and **Outlook**.
- Automatically merges duplicates across sources.
- Links contacts to transactions with role assignments and source tracking (email, SMS, contacts app, or AI-inferred).

### Audit Package Export

- One-click export to **PDF**, **Excel**, **ZIP**, or folder structure.
- Packages include transaction summary, linked messages, attachments, participant list, and stage timeline.
- Completeness scoring tells the agent how thorough their audit package is before submission.
- Sensitive data can be redacted based on compliance rules.

### Broker Portal (Web)

- **Submission review workflow** -- brokers see agent submissions, can approve, reject, or request changes.
- **Dual-approval mode** for high-value transactions.
- **Organization management** -- invite team members, assign roles (agent, broker, admin, IT admin).
- **SCIM 2.0 provisioning** -- IT departments can auto-provision and deprovision users from Azure AD, just like any other enterprise SaaS app.
- **SLA tracking** -- monitor review deadlines and escalate overdue items.

> *Technical note:* The Broker Portal is a Next.js application backed by Supabase (PostgreSQL). Multi-tenant data isolation is enforced at the database level via Row-Level Security policies -- one brokerage can never see another's data, regardless of application-layer bugs.

---

## Security & Compliance

This is typically the first area enterprise prospects ask about. Here's the summary:

| Layer | What We Do |
|-------|-----------|
| **Data at rest** | Local database is AES-encrypted (SQLite with multiple ciphers). OAuth tokens are separately encrypted. |
| **Data in transit** | All network traffic uses TLS 1.2+. |
| **Authentication** | OAuth 2.0 via Google and Microsoft -- we never see or store user passwords. |
| **Authorization** | Role-based access control. Database-level Row-Level Security in the cloud tier. |
| **PII handling** | Content is sanitized before AI processing. No raw email content leaves the user's machine to LLM providers. |
| **Audit logging** | Append-only logs track every significant action for SOC 2 readiness. |
| **Enterprise SSO** | Azure AD single sign-on with admin consent flow and SCIM 2.0 user provisioning. |
| **Offline capability** | The desktop app works fully offline. Data syncs when connectivity returns. |

> *Technical note:* The desktop app uses an offline-first architecture -- the encrypted SQLite database is the source of truth, with bidirectional sync to Supabase cloud. Conflict resolution handles simultaneous edits from multiple devices. macOS builds use Hardened Runtime with code signing; credentials are stored in the system Keychain.

---

## Architecture at a Glance

```
+---------------------------------------------------+
|              DESKTOP APP (Electron)                |
|                                                    |
|  +----------+  +----------+  +--------------+     |
|  | Gmail API|  |Graph API |  | iPhone Backup|     |
|  +----+-----+  +----+-----+  +------+-------+     |
|       |              |               |              |
|       v              v               v              |
|  +--------------------------------------------+    |
|  |     Local Processing & AI Analysis         |    |
|  |  (transaction detection, classification)   |    |
|  +------------------+-------------------------+    |
|                     |                               |
|  +------------------v-------------------------+    |
|  |     Encrypted SQLite Database              |    |
|  +------------------+-------------------------+    |
|                     | sync                          |
+---------------------+------------------------------+
                      |
                      v
+-----------------------------------------------------+
|            SUPABASE CLOUD                            |
|  +---------+  +----------+  +----------------+      |
|  | Auth    |  | Database |  | File Storage   |      |
|  | (OAuth) |  | (Postgres|  | (Attachments)  |      |
|  |         |  |  + RLS)  |  |                |      |
|  +---------+  +----+-----+  +----------------+      |
|                     |                                |
+---------------------+-------------------------------+
                      |
                      v
+-----------------------------------------------------+
|          BROKER PORTAL (Next.js Web App)             |
|                                                      |
|  Submission Review . Org Management . SCIM Admin     |
+-----------------------------------------------------+
```

**Key selling point:** Sensitive data (emails, texts, attachments) lives on the agent's own machine in an encrypted database. The cloud layer handles authentication, sync, and broker workflows -- not raw message storage. This is a meaningful privacy advantage over competitors that require uploading everything to a third-party server.

---

## Platform Support

| Platform | Status |
|----------|--------|
| macOS (Intel + Apple Silicon) | Supported |
| Windows (x64) | Supported |
| iPhone (SMS/iMessage import) | Supported |
| Android | Planned |
| Gmail | Supported |
| Microsoft 365 / Outlook | Supported |

---

## Competitive Differentiators -- Talking Points

1. **Privacy-first architecture** -- Messages are processed and stored locally, not uploaded to our servers. AI analysis sanitizes PII before any external API call.

2. **Automatic, not manual** -- Transactions, participants, and stages are detected by AI. Agents don't have to tag, folder, or forward anything.

3. **Enterprise-ready from day one** -- Azure AD SSO, SCIM provisioning, role-based access, append-only audit logs, encrypted storage. IT teams can deploy and manage it like any other enterprise tool.

4. **Multi-channel capture** -- Email *and* text messages in one audit trail. Most competitors only handle email.

5. **Offline-capable** -- Works without internet. Syncs when connected. Critical for agents working in the field.

6. **Broker oversight without friction** -- The web portal gives brokers visibility and approval authority without requiring them to install anything or change their workflow.

---

## Common Prospect Questions

**Q: Do agents have to change how they work?**
No. They keep using their existing email and phone. Keepr connects in the background and organizes everything automatically.

**Q: What if our brokerage uses Google Workspace, not Microsoft?**
Both are fully supported. Agents can connect either Gmail or Outlook (or both).

**Q: Can we control who sees what?**
Yes. The Broker Portal has role-based access (agent, broker, admin, IT admin). Database-level security policies ensure tenants are isolated.

**Q: Is there an API?**
The Broker Portal supports SCIM 2.0 for automated user provisioning. Additional API access is on the roadmap.

**Q: How long does setup take?**
An individual agent can be up and running in under 5 minutes -- install, sign in with Google or Microsoft, and the first sync begins. Enterprise deployment with SSO/SCIM takes a one-time IT admin setup (typically 30 minutes).

---

*Questions? Reach out to the product team for demo scripts, pricing guidance, or deeper technical documentation.*
