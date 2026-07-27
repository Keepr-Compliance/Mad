# AI Tier — Foundation Decisions (P0)

**Author:** Architecture / Founder session
**Date:** 2026-07-27
**Status:** DRAFT — awaiting founder sign-off
**Related Backlog:** BACKLOG-2266 (this doc), project "AI Assistant Foundation"

---

## Purpose

Six decisions gate every later phase of the AI assistant work. They are recorded here so
engineering can proceed without re-litigating them, and so the commitments we make to early
users are deliberate rather than accidental.

All six are **decided**. This document exists for sign-off and reference, not for debate.

---

## Table of Contents

1. [Context](#1-context)
2. [Decision 1 — Privacy envelope is the tier ladder](#2-decision-1--privacy-envelope-is-the-tier-ladder)
3. [Decision 2 — LLM economics: hybrid escalation ladder](#3-decision-2--llm-economics-hybrid-escalation-ladder)
4. [Decision 3 — Timeline and schema discipline](#4-decision-3--timeline-and-schema-discipline)
5. [Decision 4 — First buyer: individual agents](#5-decision-4--first-buyer-individual-agents)
6. [Decision 5 — Autonomy ceiling: draft-for-approval](#6-decision-5--autonomy-ceiling-draft-for-approval)
7. [Decision 6 — Hardware strategy: per-device capability check](#7-decision-6--hardware-strategy-per-device-capability-check)
8. [Standards we adopt](#8-standards-we-adopt)
9. [What these decisions do NOT commit us to](#9-what-these-decisions-do-not-commit-us-to)
10. [Sign-off](#10-sign-off)

---

## 1. Context

Keepr today is a real estate transaction **compliance and audit** product: capture
communications, organize them into transactions, export audit packages. That product stays
exactly as it is.

The long-term goal is an **AI assistant** that does what a transaction coordinator does
(deadline tracking, document chasing, next actions) plus what a TC cannot — reasoning across
the agent's entire book of business over years, because it sees every channel.

The assistant is an **add-on tier**, never a replacement for the base product. The strategy
is to make the base product quietly accumulate the right substrate (observations, evidence,
corrections) so that when a user upgrades, the assistant works immediately on their real
history rather than starting cold.

These six decisions determine what that substrate may contain, where it may live, what it
may cost, and how far the assistant may act on its own.

---

## 2. Decision 1 — Privacy envelope is the tier ladder

**Decision:** privacy level, inference location, and price are a single axis. Three tiers:

| Tier | Privacy posture | Intelligence available |
|------|-----------------|------------------------|
| **Base** (compliance) | Strict local. Nothing leaves the device. | No AI. Observation ledger + user corrections still accumulate locally. |
| **AI tier** | Local inference by default. Cloud **processing-only** with explicit consent — content is processed, never stored server-side. | Contact matching, transaction detection, evidence, review flows. |
| **Premium** | Fully consented **encrypted cloud corpus**. | Any-device / on-the-go access, cross-device unification, background assistant. |

**Why this shape:** the base product's privacy promise is a genuine competitive
differentiator and must not be diluted. Making privacy the same axis as price means a user
never loses privacy silently — they trade it deliberately, for capability they asked for.

**Terms handling:** an updated-terms re-prompt flow already exists, so T&C can be updated at
AI-tier launch rather than before base onboarding. See BACKLOG-2266's consent epic
(`[P2] Tiered consent & T&C versioning`) for the mechanics.

**Residual action (wording only, no engineering):** keep outward marketing copy free of
absolute claims ("nothing ever leaves your machine", "never"). Use the consent-ready framing:
*"local by default, encrypted, AI features only with your explicit consent."* Re-consent
updates the terms; it does not update the narrative the first cohort bought into.

---

## 3. Decision 2 — LLM economics: hybrid escalation ladder

**Decision:** a three-rung escalation ladder, each rung handling only what the rung below
cannot.

```
1. Deterministic patterns / statistics   ← free, offline, explainable
2. Light LOCAL model                     ← private, zero marginal cost
3. Managed cloud model (metered)         ← consented, for hard tasks only
```

- **Rung 1** covers entity matching, linking, and anything structural. This is classic record
  linkage — it does not need an LLM and will not use one.
- **Rung 2** is the first *inference* rung we build, for content-understanding tasks
  (deal classification, role/stage extraction from text).
- **Rung 3** is for genuinely hard work — drafting, summarization, timeline Q&A — metered into
  the tier price.
- **BYO-key survives as an option**, not the default. BYO-key is why the existing LLM layer is
  dormant today; mainstream agents will not supply their own API keys.

**Sequencing constraint:** local-model packaging (runtime bundling, first-run download, memory
management) is its own epic, scheduled when content-understanding tasks arrive. It **must not
block** the first feature (contact matching), which needs no model at all.

**Do now, cheaply:** add `local` as a third provider behind the existing `electron/services/llm/`
abstraction so the seam exists before it is needed.

---

## 4. Decision 3 — Timeline and schema discipline

**Decision:**

- Base-product users onboard **soon**. From that point, all local schema changes are
  **additive-only** and follow the existing migration discipline.
- The **observation ledger ships in the first build those users install**, so history capture
  begins on day one and the AI tier has real accumulated data to reason over later.
- **AI-tier testing target: 1–3 months**, scoped to: contact matching flow, evidence-backed
  detection, and ledger accumulation.

**Explicitly out of scope for that first test window:** cloud corpus, knowledge graph,
outbound actions, the assistant proper.

**Why it matters:** the window in which breaking schema changes are free closes at first
onboarding. Anything structural we want cheaply must land before then; everything after is
additive.

---

## 5. Decision 4 — First buyer: individual agents

**Decision:** the first buyer of the AI tier is the **individual agent**, via the
TC-replacement wedge — deadline tracking, document chasing, next actions.

- **Price anchor:** agents already pay a transaction coordinator roughly $300–500 per closing.
  The tier is priced against a line item the customer already has, not against abstract "AI value."
- **Measurable roadmap:** a TC's duties are enumerable. That checklist becomes the eval suite —
  "we now cover N% of a TC's checklist autonomously" is a real metric.
- **Deferred:** the brokerage / compliance-intelligence wedge (gap detection, provenance and
  completeness surfaced in the broker portal). It fits the existing B2B motion and comes later.

---

## 6. Decision 5 — Autonomy ceiling: draft-for-approval

**Decision:** **draft-for-approval is the ceiling** at launch and for the foreseeable future.
The assistant proposes; the agent approves; nothing outward-facing sends itself.

Auto-send remains a **possible future graduation**, earned per action type by track record.
The architecture keeps that door open (actions are modeled with an approval state); the
product commits to nothing.

**Why:** an AI that silently sends a wrong message to a client, lender, or escrow officer
damages the agent's reputation and potentially their license. For a compliance brand, "the AI
drafts, you approve, everything is logged with evidence" is not a limitation — it is the trust
story.

---

## 7. Decision 6 — Hardware strategy: per-device capability check

**Decision:** a **runtime capability check** decides which inference rung a device uses. No
platform assumptions — each machine proves what it can run.

| Check result | Experience |
|--------------|------------|
| Capable | Local model. Private, included, nothing leaves the device. |
| Not capable | Informed and **rerouted, not walled**: consented cloud processing via the managed metered LLM, or bring-your-own-key. Same features, different rung. |

**Two requirements that make this work:**

1. **The check runs pre-purchase / pre-upgrade**, so the offer always matches what the device
   can actually deliver. Nobody buys an experience their laptop cannot run.
2. **Model choice and capability thresholds ship as a remote-updatable manifest**, not
   hardcoded. As lighter models arrive, the "capable" floor drops via a config push with no app
   release, and users previously routed to cloud silently gain local AI.

The second point encodes the founder's bet that models get lighter and devices get stronger —
the architecture collects the winnings automatically rather than requiring a rewrite.

---

## 8. Standards we adopt

We adopt vocabulary and models, not dependencies.

| Standard | What it is | How we use it |
|----------|-----------|---------------|
| **Fellegi–Sunter record linkage** | The classic statistical model for deciding whether two records are the same entity. Produces three zones: match / possible match / non-match. | Maps directly to our auto / suggest / ask thresholds for contact matching. Non-LLM by design. |
| **RESO Data Dictionary** | The real estate industry's standard vocabulary (properties, listings, participants, roles, milestones), spoken by MLSs and most real-estate software. | Prefer RESO names for roles and transaction fields where practical. Costs nothing now; removes a translation layer if we ever integrate with an MLS or transaction-management platform. |
| **W3C PROV** | The web standard's conceptual model for provenance: what was derived, from which source, by which process, when. | Shape of the evidence layer, so "why do we believe this" is modeled the way auditors and lawyers already understand. Concepts only — no ontology import. |
| **RFC 5545 (iCalendar)** | The calendar interchange standard. | Semantics for future calendar ingestion. Notably: cancellation is a **status**, not a deletion — a cancelled showing is business signal. |
| **SOC 2** | The audit-logging posture the product already maintains. | Extends to all new tables introduced by this work. |

---

## 9. What these decisions do NOT commit us to

Recorded so scope creep is visible when it happens:

- **Not** a rewrite. The existing ingestion plumbing, relational model, and export pipeline are
  kept and extended.
- **Not** a knowledge graph as a source of truth. If built, it is a **derived projection** off
  the observation ledger — disposable and rebuildable, never authoritative.
- **Not** LLM-first extraction. Deterministic where the signal is structural; a model only
  where the signal is semantic.
- **Not** a specific model or provider. The escalation ladder is provider-agnostic behind the
  existing abstraction.
- **Not** auto-merge of entities. Matching suggests; it does not merge until merges are
  reversible (see the non-destructive identity epic).
- **Not** autonomous outward action. See Decision 5.

---

## 10. Sign-off

Every epic in the "AI Assistant Foundation" project exits through a **founder testing gate** —
hands-on QA by the founder on a real build before the epic counts as complete. No phase begins
until the prior gate passes.

| Role | Name | Date | Status |
|------|------|------|--------|
| Founder | | | ☐ Approved |

**On approval:** BACKLOG-2266 moves to `completed`, and the first sprint begins —
characterization tests (BACKLOG-2267) and the contact-matching feasibility spike
(BACKLOG-2273) in parallel, followed by the observation ledger (BACKLOG-2268).
