# Data Retention Policy

**Keepr - Data Retention and Deletion Policy**

> **NOTICE**: This document requires legal review before publication.

---

## Document Control

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Effective Date** | 2024-01-15 |
| **Last Review Date** | 2024-01-15 |
| **Next Review Date** | 2025-01-15 |
| **Author** | Security Team |
| **Approval Status** | Draft - Pending Legal Review |
| **Classification** | Public |

---

## 1. Purpose and Scope

### 1.1 Purpose

This Data Retention Policy establishes the periods for which Keepr retains different categories of data, the methods used for secure deletion, and the legal basis for each retention period. This policy ensures compliance with applicable privacy regulations while meeting legitimate business and legal requirements.

### 1.2 Scope

This policy applies to all data collected, processed, and stored by Keepr, including:
- Data stored locally on user devices (SQLite database)
- Data synchronized to cloud infrastructure (Supabase)
- Data processed through third-party integrations (Google, Microsoft)
- Backup and archive data
- Logs and analytics data

### 1.3 Principles

- **Data Minimization**: Retain only data necessary for stated purposes
- **Purpose Limitation**: Use data only for purposes disclosed at collection
- **Storage Limitation**: Delete data when retention period expires
- **Security**: Protect data throughout its lifecycle
- **Transparency**: Clearly communicate retention practices to users

---

## 2. Data Retention Schedule

### 2.1 User Account Data

| Data Type | Retention Period | Deletion Method | Legal Basis |
|-----------|------------------|-----------------|-------------|
| User Profile (email, name, avatar) | Until account deletion request + 30 days | Secure wipe from Supabase | Contract performance |
| Authentication Credentials | Until account deletion or credential reset | Immediate overwrite | Contract performance |
| OAuth Tokens (Google, Microsoft) | Until token expiration or revocation | Secure deletion via OS keychain | Contract performance |
| Subscription Status | Until account deletion + 7 years | Archived, then secure wipe | Legal requirement (financial records) |
| Login History | 2 years rolling | Auto-purge | Legitimate interest (security) |
| Device Registration | Until device deauthorization + 90 days | Soft delete, then purge | Contract performance |

### 2.2 Communication Data

| Data Type | Retention Period | Deletion Method | Legal Basis |
|-----------|------------------|-----------------|-------------|
| iMessage Archives (local) | User controlled (no automatic deletion) | User-initiated deletion | User consent |
| Email Content (cached) | User controlled (no automatic deletion) | User-initiated deletion | User consent |
| Email Metadata | User controlled (no automatic deletion) | User-initiated deletion | User consent |
| Communication Attachments | User controlled (no automatic deletion) | User-initiated deletion | User consent |

> **Note**: Communication data is stored locally on user devices. Users maintain full control over retention and deletion. Cloud-synced communication metadata follows the same user-controlled retention.

### 2.3 Transaction Data

| Data Type | Retention Period | Deletion Method | Legal Basis |
|-----------|------------------|-----------------|-------------|
| Transaction Records | 7 years from transaction close | Archived at 7 years, deleted at 10 years | Legal requirement (real estate records) |
| Property Information | 7 years from last transaction update | Archived, then secure wipe | Legal requirement |
| Financial Data (prices, amounts) | 7 years from transaction close | Archived, then secure wipe | Legal requirement (IRS records) |
| Contact Assignments | Tied to transaction retention | Deleted with parent transaction | Contract performance |
| Extracted Data (AI-processed) | Tied to source communication | Deleted with parent communication | Contract performance |

### 2.4 Contact Data

| Data Type | Retention Period | Deletion Method | Legal Basis |
|-----------|------------------|-----------------|-------------|
| Contact Information (name, email, phone) | Until user deletion request | Secure wipe | Contract performance |
| Contact Relationships | Until user deletion request | Secure wipe | Contract performance |
| Professional Roles | Until user deletion request | Secure wipe | Contract performance |
| Import Metadata | 2 years | Auto-purge | Legitimate interest |

### 2.5 Operational Data

| Data Type | Retention Period | Deletion Method | Legal Basis |
|-----------|------------------|-----------------|-------------|
| Application Logs (local) | 14 days rolling — the same desktop log files as the row below (BACKLOG-3819) | Entries older than 14 days are removed at app launch; size rotation at 8 MB | Legitimate interest (debugging) |
| Desktop diagnostic logs (local, `main.log` / `main.old.log`) | 14 days rolling; email addresses and phone numbers are redacted before they are written (BACKLOG-3819) | Entries older than 14 days are removed at app launch; size rotation at 8 MB | Legitimate interest (support) |
| Analytics Events (Supabase) | 90 days | Auto-purge | Legitimate interest (product improvement) |
| API Usage Tracking | 90 days | Auto-purge | Legitimate interest (rate limiting) |
| Audit Logs (Supabase) | 2 years | Append-only, then archive | Compliance requirement |

### 2.6 Legal and Compliance Data

| Data Type | Retention Period | Deletion Method | Legal Basis |
|-----------|------------------|-----------------|-------------|
| Terms of Service Acceptance | Duration of account + 7 years | Archived | Legal requirement |
| Privacy Policy Acceptance | Duration of account + 7 years | Archived | Legal requirement |
| Consent Records | Duration of account + 7 years | Archived | Legal requirement |
| Data Subject Requests | 3 years from request completion | Secure archive | Legal requirement |
| Incident Records | 7 years from incident closure | Secure archive | Legal requirement |

### 2.7 Feedback and Support Data

| Data Type | Retention Period | Deletion Method | Legal Basis |
|-----------|------------------|-----------------|-------------|
| User Feedback (corrections) | 2 years | Anonymization, then deletion | Legitimate interest (ML training) |
| Support Tickets | 3 years from resolution | Archive, then deletion | Legitimate interest |
| Feature Requests | Indefinite (anonymized) | Anonymization at 1 year | Legitimate interest |

---

## 3. Retention Period Summary

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    DATA RETENTION TIMELINE                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Session Data        ████ 30 days                                          │
│  Analytics           ████████ 90 days                                       │
│  Login History       ████████████████████████ 2 years                       │
│  Audit Logs          ████████████████████████ 2 years                       │
│  Support Tickets     ████████████████████████████████ 3 years               │
│  Transaction Records ████████████████████████████████████████████ 7 years   │
│  Legal Acceptances   ████████████████████████████████████████████ 7+ years  │
│  User Content        ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ User controlled                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Deletion Methods

### 4.1 Secure Wipe

Used for sensitive data requiring complete removal:
- Overwrite data with random values before deletion
- Remove from all replicas and backups within backup retention window
- Verify deletion through audit process
- Applied to: User profiles, OAuth tokens, financial data

### 4.2 Soft Delete

Used for data requiring recovery period:
- Mark record as deleted, exclude from queries
- Retain for specified grace period (typically 30 days)
- Permanently delete after grace period
- Applied to: User accounts, device registrations

### 4.3 Auto-Purge

Used for time-series and operational data:
- Automatic deletion based on timestamp
- Configured via database policies or scheduled jobs
- No recovery after deletion
- Applied to: Logs, analytics, session data

### 4.4 Anonymization

Used for data with ongoing analytical value:
- Remove or hash all personally identifiable information
- Aggregate data where possible
- Retain anonymized data indefinitely
- Applied to: Feedback data, usage patterns

### 4.5 Archive

Used for data with legal retention requirements:
- Move to cold storage with restricted access
- Maintain integrity verification
- Delete after archive retention period expires
- Applied to: Transaction records, legal acceptances

---

## 5. Data Storage Locations

### 5.1 Local Storage (User Device)

| Location | Data Types | Encryption |
|----------|------------|------------|
| SQLite Database | Communications, transactions, contacts | At-rest (OS-level) |
| OS Keychain | OAuth tokens, credentials | OS keychain encryption |
| Application Logs | Debug and error logs; email addresses and phone numbers are redacted before they are written (BACKLOG-3819) | Not encrypted; content redacted |
| Temporary Files | Processing cache | Deleted on application close |

### 5.2 Cloud Storage (Supabase)

| Location | Data Types | Encryption |
|----------|------------|------------|
| PostgreSQL Database | User profiles, subscriptions, device registry | AES-256 at rest, TLS in transit |
| Analytics Tables | Usage events, API tracking | AES-256 at rest, TLS in transit |
| Audit Logs | Authentication events, admin actions | AES-256 at rest, TLS in transit |

### 5.3 Third-Party Storage

| Provider | Data Types | Retention Control |
|----------|------------|-------------------|
| Google | OAuth tokens, Gmail API cache | Managed via Google account settings |
| Microsoft | OAuth tokens, Graph API cache | Managed via Microsoft account settings |
| GitHub | Application binaries, update metadata | Indefinite (public releases) |

---

## 6. User Rights and Requests

### 6.1 Right to Access

Users may request a copy of their data:
- Request method: Email to privacy@keeprcompliance.com
- Response time: Within 30 days
- Format: Machine-readable (JSON/CSV) or human-readable (PDF)
- Scope: All personal data, processing purposes, recipients

### 6.2 Right to Deletion

Users may request deletion of their data:
- Request method: In-app account deletion or email request
- Processing time: Within 30 days
- Exceptions: Data required for legal compliance (transaction records for 7 years)
- Confirmation: Written confirmation upon completion

### 6.3 Right to Portability

Users may request data export:
- Available formats: PDF, CSV, JSON, Excel
- Scope: Transactions, contacts, communications
- Self-service: Available in application settings
- Assisted: Via support request

### 6.4 Request Processing

All data subject requests are:
1. Logged in request tracking system
2. Verified for identity authentication
3. Processed within regulatory timelines
4. Documented for compliance records
5. Confirmed with requestor upon completion

---

## 7. Exceptions to Standard Retention

### 7.1 Legal Hold

When litigation or investigation is anticipated:
- Suspend automatic deletion for relevant data
- Preserve data regardless of retention schedule
- Document hold scope and duration
- Release hold only with legal approval

### 7.2 Regulatory Requirements

When regulations require extended retention:
- Document specific requirement and authority
- Extend retention period accordingly
- Review annually for continued applicability

### 7.3 User Requests

When users request extended retention:
- Document user consent
- Implement user-specific retention extension
- Honor subsequent deletion requests

### 7.4 Business Continuity

When data is needed for dispute resolution:
- Retain data for duration of dispute + 1 year
- Document business justification
- Delete upon resolution

---

## 8. Implementation and Enforcement

### 8.1 Technical Controls

| Control | Implementation |
|---------|----------------|
| Auto-deletion | Scheduled database jobs for time-based deletion |
| Retention tagging | Metadata tags indicating retention category |
| Access logging | Audit trail for all data access |
| Backup alignment | Backup retention aligned with data retention |

### 8.2 Responsibilities

| Role | Responsibility |
|------|----------------|
| Engineering | Implement and maintain deletion automation |
| Security | Monitor compliance, audit retention practices |
| Legal | Review retention periods, manage legal holds |
| Support | Process user data requests |

### 8.3 Monitoring and Audit

- Quarterly review of retention compliance
- Annual audit of deletion processes
- Incident review for retention violations
- Documentation of all retention decisions

---

## 9. Related Documents

- [Incident Response Plan](./INCIDENT_RESPONSE_PLAN.md)
- [Privacy Policy](./PRIVACY_POLICY_DRAFT.md)
- [Vendor Inventory](./VENDOR_INVENTORY.md)
- [SOC 2 Controls Matrix](./SOC2_CONTROLS_MATRIX.md)

---

## 10. Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2024-01-15 | Security Team | Initial version |

---

## Appendix A: Retention Quick Reference

### By Legal Basis

**Contract Performance** (until service termination):
- User profiles, authentication, contacts, communications

**Legal Requirement** (7 years):
- Transaction records, financial data, legal acceptances

**Legitimate Interest** (varies):
- Desktop logs (14 days), audit trails (2 years), analytics (90 days)

**User Consent** (user controlled):
- Communication archives, email content

### By Action Required

**Automatic Deletion:**
- Session data, logs, analytics, temporary files

**Manual/Requested Deletion:**
- User accounts, contacts, communications

**Archive then Delete:**
- Transaction records, legal documents

**Anonymize:**
- Feedback data, usage patterns

---

*This document is proprietary to Keepr. For questions, contact privacy@keeprcompliance.com.*
